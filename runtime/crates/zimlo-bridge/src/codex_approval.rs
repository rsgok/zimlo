use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, RwLock};
use zimlo_store::{ApprovalContextRecord, DecisionRecord, Store, StoredSession, UnifiedEvent};

use crate::{
    ActionBroker, NewAction,
    codex_app_server::{now, redact, sanitize, scalar_string, store_error, string},
    trust_policy,
};

struct ApprovalRequest {
    store: Store,
    broker: ActionBroker,
    session: Arc<RwLock<Option<StoredSession>>>,
    actions: Arc<Mutex<HashMap<String, String>>>,
    message: Value,
    params: Value,
}

pub(super) async fn handle_server_request(
    store: Store,
    broker: ActionBroker,
    session: Arc<RwLock<Option<StoredSession>>>,
    actions: Arc<Mutex<HashMap<String, String>>>,
    message: &Value,
) -> Result<Value, String> {
    let method = string(&message["method"]).unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let current = session
        .read()
        .await
        .clone()
        .ok_or("Codex Session 尚未建立。")?;
    if string(&params["threadId"]).as_deref() != Some(&current.provider_session_id) {
        return Err("Session mismatch".into());
    }
    let request = ApprovalRequest {
        store,
        broker,
        session,
        actions,
        message: message.clone(),
        params,
    };
    match method.as_str() {
        "item/commandExecution/requestApproval" => {
            resolve_approval(request, "命令执行审批", "decision").await
        }
        "item/fileChange/requestApproval" => {
            resolve_approval(request, "文件修改审批", "decision").await
        }
        "item/permissions/requestApproval" => {
            resolve_approval(request, "额外能力审批", "direct").await
        }
        "item/tool/requestUserInput" => resolve_input(request).await,
        _ => Err(format!("Zimlo 不支持服务端请求：{method}")),
    }
}

async fn resolve_approval(
    request: ApprovalRequest,
    title: &str,
    response_shape: &str,
) -> Result<Value, String> {
    let ApprovalRequest {
        store,
        broker,
        session,
        actions,
        message,
        params,
    } = request;
    let decisions = approval_decisions(title, &params);
    let current = session
        .read()
        .await
        .clone()
        .ok_or("Codex Session 尚未建立。")?;
    let detail = approval_detail(&params);
    let approval_context = approval_context(&store, &current, title, &params).await?;
    let ticket = broker
        .create(NewAction {
            session_id: current.id.clone(),
            upstream_request_id: Some(scalar_string(&message["id"]).unwrap_or_default()),
            kind: "approval".into(),
            title: title.into(),
            detail: detail.clone(),
            available_decisions: decisions.clone(),
            approval_context: Some(
                serde_json::to_value(approval_context)
                    .map_err(|error| format!("无法编码审批上下文：{error}"))?,
            ),
            timeout: None,
        })
        .await
        .map_err(store_error)?;
    let request_id = scalar_string(&message["id"]).unwrap_or_default();
    actions
        .lock()
        .await
        .insert(request_id.clone(), ticket.action.action_id.clone());
    set_waiting(&store, &session, &ticket.action).await?;
    insert_need_event(&store, &current, "needs_approval", &params).await?;
    let resolution = ticket.result().await;
    actions.lock().await.remove(&request_id);
    set_running(&store, &session).await?;
    let fallback = decisions
        .iter()
        .find(|decision| decision.value == json!("cancel"))
        .or_else(|| decisions.iter().find(|decision| decision.scope == "deny"));
    let value = resolution
        .map(|resolution| resolution.decision.value)
        .or_else(|| fallback.map(|decision| decision.value.clone()))
        .unwrap_or_else(|| json!({ "permissions": {}, "scope": "turn" }));
    Ok(if response_shape == "decision" {
        json!({ "decision": value })
    } else {
        value
    })
}

async fn resolve_input(request: ApprovalRequest) -> Result<Value, String> {
    let ApprovalRequest {
        store,
        broker,
        session,
        actions,
        message,
        params,
    } = request;
    let current = session
        .read()
        .await
        .clone()
        .ok_or("Codex Session 尚未建立。")?;
    let questions = params["questions"].as_array().cloned().unwrap_or_default();
    let detail = questions
        .iter()
        .map(|question| {
            [string(&question["header"]), string(&question["question"])]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(": ")
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let timeout = params["autoResolutionMs"]
        .as_u64()
        .map(|value| Duration::from_millis(value.min(8 * 60 * 1_000)));
    let ticket = broker
        .create(NewAction {
            session_id: current.id.clone(),
            upstream_request_id: Some(scalar_string(&message["id"]).unwrap_or_default()),
            kind: "input".into(),
            title: "Agent 正在等待输入".into(),
            detail: redact(
                if detail.is_empty() {
                    "Codex 正在等待输入。"
                } else {
                    &detail
                },
                800,
            ),
            available_decisions: vec![DecisionRecord {
                id: "submit-input".into(),
                label: "提交回复".into(),
                scope: "input".into(),
                value: json!({}),
                confirmation_phrase: None,
                risk: "low".into(),
            }],
            approval_context: None,
            timeout,
        })
        .await
        .map_err(store_error)?;
    let request_id = scalar_string(&message["id"]).unwrap_or_default();
    actions
        .lock()
        .await
        .insert(request_id.clone(), ticket.action.action_id.clone());
    set_waiting(&store, &session, &ticket.action).await?;
    insert_need_event(&store, &current, "needs_input", &params).await?;
    let answer = ticket
        .result()
        .await
        .and_then(|resolution| resolution.input)
        .and_then(|input| input.get("answer").cloned())
        .unwrap_or_default();
    actions.lock().await.remove(&request_id);
    set_running(&store, &session).await?;
    let answers = questions
        .iter()
        .enumerate()
        .map(|(index, question)| {
            let id = string(&question["id"]).unwrap_or_else(|| format!("question-{}", index + 1));
            (id, json!({ "answers": [answer] }))
        })
        .collect::<Map<_, _>>();
    Ok(json!({ "answers": answers }))
}

pub(super) fn approval_decisions(title: &str, params: &Value) -> Vec<DecisionRecord> {
    if title == "额外能力审批" {
        let permissions = params
            .get("permissions")
            .cloned()
            .unwrap_or_else(|| json!({}));
        return vec![
            decision(
                "permissions-turn",
                "本轮允许所请求的权限",
                "once",
                json!({ "permissions": permissions, "scope": "turn" }),
                "medium",
                None,
            ),
            decision(
                "permissions-session",
                "本 Session 允许所请求的权限",
                "session",
                json!({ "permissions": permissions, "scope": "session" }),
                "high",
                Some("本次会话允许"),
            ),
            decision(
                "permissions-deny",
                "拒绝",
                "deny",
                json!({ "permissions": {}, "scope": "turn" }),
                "low",
                None,
            ),
        ];
    }
    let risk = if title == "文件修改审批" {
        "medium"
    } else {
        trust_policy::risk_for_command(&approval_detail(params))
    };
    let supplied = params["availableDecisions"].as_array();
    let mut upstream = supplied.cloned().unwrap_or_else(|| {
        vec![
            json!("accept"),
            json!("acceptForSession"),
            json!("decline"),
            json!("cancel"),
        ]
    });
    if supplied.is_none() {
        if let Some(amendment) = params.get("proposedExecpolicyAmendment") {
            upstream.insert(
                2,
                json!({
                    "acceptWithExecpolicyAmendment": { "execpolicy_amendment": amendment }
                }),
            );
        }
        if let Some(amendments) = params["proposedNetworkPolicyAmendments"].as_array() {
            for amendment in amendments {
                upstream.insert(
                    2,
                    json!({
                        "applyNetworkPolicyAmendment": { "network_policy_amendment": amendment }
                    }),
                );
            }
        }
    }
    upstream
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| upstream_decision(index, value, risk))
        .collect()
}

fn upstream_decision(index: usize, value: Value, risk: &str) -> Option<DecisionRecord> {
    if value["acceptWithExecpolicyAmendment"].is_object() {
        return Some(decision(
            &format!("upstream-{index}-execpolicy"),
            "永久允许上游提出的精确命令规则",
            "persistent",
            value,
            "high",
            Some("永久允许"),
        ));
    }
    if value["applyNetworkPolicyAmendment"].is_object() {
        return Some(decision(
            &format!("upstream-{index}-network-policy"),
            "永久应用上游提出的网络规则",
            "persistent",
            value,
            "high",
            Some("永久允许"),
        ));
    }
    let text = value.as_str()?.to_owned();
    Some(match text.as_str() {
        "accept" => decision(
            &format!("upstream-{index}-accept"),
            "允许一次",
            "once",
            value,
            risk,
            (risk == "high").then_some("确认执行"),
        ),
        "acceptForSession" => decision(
            &format!("upstream-{index}-session"),
            "本 Session 允许",
            "session",
            value,
            if risk == "low" { "medium" } else { risk },
            Some("本次会话允许"),
        ),
        "decline" => decision(
            &format!("upstream-{index}-decline"),
            "拒绝",
            "deny",
            value,
            "low",
            None,
        ),
        "cancel" => decision(
            &format!("upstream-{index}-cancel"),
            "取消任务",
            "deny",
            value,
            "low",
            None,
        ),
        _ => return None,
    })
}

fn decision(
    id: &str,
    label: &str,
    scope: &str,
    value: Value,
    risk: &str,
    phrase: Option<&str>,
) -> DecisionRecord {
    DecisionRecord {
        id: id.into(),
        label: label.into(),
        scope: scope.into(),
        value,
        confirmation_phrase: phrase.map(str::to_owned),
        risk: risk.into(),
    }
}

async fn set_waiting(
    store: &Store,
    session: &Arc<RwLock<Option<StoredSession>>>,
    action: &zimlo_store::PendingActionRecord,
) -> Result<(), String> {
    let mut guard = session.write().await;
    let Some(current) = guard.as_mut() else {
        return Err("Codex Session 尚未建立。".into());
    };
    current.status = "waiting".into();
    current.last_activity_at = now();
    current.capabilities = capabilities(
        true,
        false,
        false,
        action.available_decisions.iter().any(|d| d.scope == "once"),
        action
            .available_decisions
            .iter()
            .any(|d| d.scope == "session"),
        action
            .available_decisions
            .iter()
            .any(|d| d.scope == "persistent"),
    );
    *current = store
        .upsert_session(current.clone())
        .await
        .map_err(store_error)?;
    Ok(())
}

async fn set_running(
    store: &Store,
    session: &Arc<RwLock<Option<StoredSession>>>,
) -> Result<(), String> {
    let mut guard = session.write().await;
    let Some(current) = guard.as_mut() else {
        return Ok(());
    };
    current.status = "running".into();
    current.last_activity_at = now();
    current.capabilities = capabilities(true, false, false, false, false, false);
    *current = store
        .upsert_session(current.clone())
        .await
        .map_err(store_error)?;
    Ok(())
}

async fn insert_need_event(
    store: &Store,
    session: &StoredSession,
    kind: &str,
    params: &Value,
) -> Result<(), String> {
    store
        .insert_event(UnifiedEvent {
            id: uuid::Uuid::now_v7().to_string(),
            sequence: 0,
            provider: "codex".into(),
            session_id: session.id.clone(),
            provider_session_id: session.provider_session_id.clone(),
            turn_id: string(&params["turnId"]),
            item_id: string(&params["itemId"]),
            kind: kind.into(),
            source: "app_server".into(),
            occurred_at: now(),
            payload: sanitize(params.clone()),
            provenance: "verified".into(),
        })
        .await
        .map_err(store_error)?;
    Ok(())
}

fn approval_detail(params: &Value) -> String {
    let network = &params["networkApprovalContext"];
    if let Some(host) = string(&network["host"]) {
        return format!(
            "网络访问：{}://{}{}",
            string(&network["protocol"]).unwrap_or_else(|| "network".into()),
            host,
            network["port"]
                .as_u64()
                .map(|port| format!(":{port}"))
                .unwrap_or_default()
        );
    }
    redact(
        &string(&params["command"])
            .or_else(|| string(&params["reason"]))
            .unwrap_or_else(|| params.to_string()),
        800,
    )
}

async fn approval_context(
    store: &Store,
    session: &StoredSession,
    title: &str,
    params: &Value,
) -> Result<ApprovalContextRecord, String> {
    let project_root = match session.project_id.as_deref() {
        Some(project_id) => store
            .project_primary_path(project_id)
            .await
            .map_err(store_error)?,
        None => None,
    };
    let cwd = session.cwd.as_deref();
    let project_id = session.project_id.as_deref();
    if params["networkApprovalContext"]["host"].is_string() {
        return Ok(ApprovalContextRecord {
            category: "network".into(),
            project_id: session.project_id.clone(),
            cwd: session.cwd.clone(),
            command: None,
            segments: Vec::new(),
            within_project: false,
            reason: "网络访问始终需要确认".into(),
        });
    }
    if title == "文件修改审批" {
        let path = string(&params["filePath"]).or_else(|| string(&params["path"]));
        return Ok(trust_policy::approval_context_for_file(
            path.as_deref(),
            cwd,
            project_id,
            project_root.as_deref(),
        ));
    }
    if let Some(command) = string(&params["command"]) {
        return Ok(trust_policy::approval_context_for_command(
            &command,
            cwd,
            project_id,
            project_root.as_deref(),
        ));
    }
    Ok(ApprovalContextRecord {
        category: "unknown".into(),
        project_id: session.project_id.clone(),
        cwd: session.cwd.clone(),
        command: None,
        segments: Vec::new(),
        within_project: false,
        reason: "无法可靠识别审批动作".into(),
    })
}

fn capabilities(
    live: bool,
    replyable: bool,
    resumable: bool,
    once: bool,
    session: bool,
    persistent: bool,
) -> Value {
    json!({ "discovered": true, "liveObserved": live, "replyable": replyable,
        "approvableOnce": once, "approvableSession": session, "approvablePersistent": persistent,
        "resumable": resumable, "diffAvailable": false })
}
