use std::{path::Path, time::Duration};

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
    net::{UnixListener, UnixStream},
    sync::watch,
};
use uuid::Uuid;
use zimlo_protocol::{ZIMLO_PROTOCOL_VERSION, ZIMLO_VERSION};
use zimlo_store::{AgentToolInput, DecisionRecord, Store, StoredSession, UnifiedEvent};

use crate::{ActionBroker, DecisionResolution, NewAction, PushService, materials, trust_policy};

const LEGACY_FEED_DECISION_REASON: &str = "本轮尚未做 Feed 编辑决策。请调用 Zimlo 的 feed.post 发布值得说的内容，或调用 feed.skip 明确保持沉默，然后再结束。";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentToolRequest {
    id: String,
    provider: String,
    parent_pid: i64,
    cwd: String,
    name: String,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct HookRequest {
    id: String,
    provider: String,
    surface: String,
    payload: Value,
}

pub async fn run_until_shutdown(
    socket_path: &Path,
    store: Store,
    broker: ActionBroker,
    push: Option<PushService>,
    mut stop: watch::Receiver<bool>,
) -> std::io::Result<()> {
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;
    }
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() { break; }
            }
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let store = store.clone();
                let broker = broker.clone();
                let push = push.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle(stream, store, broker, push).await {
                        eprintln!("[zimlo:rust-hook] local socket request failed: {error}");
                    }
                });
            }
        }
    }
    let _ = std::fs::remove_file(socket_path);
    Ok(())
}

async fn handle(
    stream: UnixStream,
    store: Store,
    broker: ActionBroker,
    push: Option<PushService>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let length = reader.read_line(&mut line).await.map_err(display)?;
    if length == 0 || line.len() > 2 * 1024 * 1024 {
        return Err("invalid local request".into());
    }
    let request: Value = serde_json::from_str(&line).map_err(display)?;
    let response = match request.get("type").and_then(Value::as_str) {
        Some("bridge_info") => json!({
            "type": "bridge_info",
            "version": ZIMLO_VERSION,
            "protocolVersion": ZIMLO_PROTOCOL_VERSION,
        }),
        Some("agent_tool") => {
            let request = serde_json::from_value::<AgentToolRequest>(request).map_err(display)?;
            handle_agent_tool(&store, push.as_ref(), request).await
        }
        _ => {
            let request = serde_json::from_value::<HookRequest>(request).map_err(display)?;
            let (cancel, cancellation) = watch::channel(false);
            let response = handle_hook(&store, &broker, request, cancellation);
            tokio::pin!(response);
            tokio::select! {
                response = &mut response => response,
                _ = wait_for_peer_close(&mut reader) => {
                    let _ = cancel.send(true);
                    response.await
                }
            }
        }
    };
    let mut encoded = serde_json::to_vec(&response).map_err(display)?;
    encoded.push(b'\n');
    reader.get_mut().write_all(&encoded).await.map_err(display)
}

async fn wait_for_peer_close(reader: &mut BufReader<UnixStream>) {
    let mut discard = [0_u8; 1_024];
    loop {
        match reader.read(&mut discard).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

async fn handle_agent_tool(
    store: &Store,
    push: Option<&PushService>,
    request: AgentToolRequest,
) -> Value {
    let result = if request.name == "material.publish" {
        let path = request.arguments.get("path").and_then(Value::as_str);
        match path {
            Some(path) => materials::publish_agent_material(
                store,
                &request.cwd,
                path,
                request.arguments.get("name").and_then(Value::as_str),
            )
            .await
            .map(|material| json!({ "material_id": material.id, "kind": material.kind, "name": material.name })),
            None => Err("material.publish 字段无效。".into()),
        }
    } else {
        let result = store
            .apply_agent_tool(AgentToolInput {
                provider: request.provider.clone(),
                parent_pid: request.parent_pid,
                cwd: request.cwd.clone(),
                name: request.name.clone(),
                arguments: request.arguments.clone(),
                now: now(),
            })
            .await
            .map_err(|error| match error {
                zimlo_store::StoreError::InvalidMutation => {
                    format!("{} 字段或状态无效。", request.name)
                }
                _ => "Zimlo 本地数据暂时不可用。".into(),
            });
        if let (Ok(data), Some(push)) = (&result, push)
            && request.name == "feed.post"
            && data["deduplicated"] == false
            && matches!(
                request.arguments["kind"].as_str(),
                Some("result" | "failure")
            )
        {
            let sessions = store.list_sessions().await.unwrap_or_default();
            let session = sessions
                .iter()
                .find(|session| {
                    session.provider == request.provider
                        && session.active_pid == Some(request.parent_pid)
                })
                .or_else(|| {
                    sessions.iter().find(|session| {
                        session.provider == request.provider
                            && session.cwd.as_deref() == Some(request.cwd.as_str())
                    })
                });
            if let Some(session) = session {
                let summary = [
                    request.arguments["headline"].as_str(),
                    request.arguments["takeaway"].as_str(),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("：");
                push.schedule_status(
                    request.arguments["kind"].as_str().expect("validated kind"),
                    session.id.clone(),
                    Some(session.title.clone()),
                    (!summary.is_empty()).then_some(summary),
                )
                .await;
            }
        }
        result
    };
    match result {
        Ok(data) => {
            json!({ "id": request.id, "ok": true, "message": success_message(&request.name, &data), "data": data })
        }
        Err(message) => json!({ "id": request.id, "ok": false, "message": message }),
    }
}

async fn handle_hook(
    store: &Store,
    broker: &ActionBroker,
    request: HookRequest,
    mut cancellation: watch::Receiver<bool>,
) -> Value {
    let payload = request.payload.as_object().cloned().unwrap_or_default();
    let run_id = payload
        .get("session_id")
        .or_else(|| payload.get("thread_id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("hook-{}", request.id));
    let session_id = stable_session_id(&request.provider, &run_id);
    let existing = store.get_session(&session_id).await.ok().flatten();
    let hook_name = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let tool_name = payload
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let is_input =
        hook_name == "PreToolUse" && matches!(tool_name, "AskUserQuestion" | "request_user_input");
    let trusted = request.provider == "codex"
        && hook_name == "PermissionRequest"
        && matches!(
            tool_name,
            "mcp__zimlo__feed_post"
                | "mcp__zimlo__feed_skip"
                | "mcp__zimlo__signal_transition"
                | "mcp__zimlo__material_publish"
        );
    let timestamp = now();
    let status = if (hook_name == "PermissionRequest" && !trusted) || is_input {
        "waiting"
    } else {
        match hook_name {
            "Stop" => "completed",
            "SessionEnd" => "ended",
            "PostToolUseFailure" => "failed",
            _ => existing
                .as_ref()
                .map(|value| value.status.as_str())
                .unwrap_or("running"),
        }
    };
    let session = StoredSession {
        id: session_id.clone(),
        project_id: existing.as_ref().and_then(|value| value.project_id.clone()),
        provider: request.provider.clone(),
        surface: if matches!(request.surface.as_str(), "gui" | "cli" | "managed") {
            request.surface.clone()
        } else {
            "unknown".into()
        },
        provider_session_id: run_id.clone(),
        title: existing
            .as_ref()
            .map(|value| value.title.clone())
            .unwrap_or_else(|| {
                format!(
                    "{} · {}",
                    if request.provider == "codex" {
                        "Codex"
                    } else {
                        "Claude"
                    },
                    run_id.chars().take(8).collect::<String>()
                )
            }),
        cwd: payload
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| existing.as_ref().and_then(|value| value.cwd.clone())),
        transcript_path: payload
            .get("transcript_path")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|value| value.transcript_path.clone())
            }),
        status: status.into(),
        last_activity_at: timestamp.clone(),
        created_at: existing
            .as_ref()
            .map(|value| value.created_at.clone())
            .unwrap_or_else(|| timestamp.clone()),
        active_pid: existing.as_ref().and_then(|value| value.active_pid),
        process_started_at: existing
            .as_ref()
            .and_then(|value| value.process_started_at.clone()),
        tty: existing.as_ref().and_then(|value| value.tty.clone()),
        correlation_uncertain: false,
        capabilities: json!({
            "discovered": existing.as_ref().is_some_and(|value| value.capabilities["discovered"] == true),
            "liveObserved": true,
            "replyable": existing.as_ref().is_some_and(|value| value.capabilities["replyable"] == true),
            "approvableOnce": true,
            "approvableSession": request.provider == "claude" && payload.get("permission_suggestions").is_some_and(Value::is_array),
            "approvablePersistent": request.provider == "claude" && payload.get("permission_suggestions").is_some_and(Value::is_array),
            "resumable": existing.as_ref().is_some_and(|value| value.capabilities["resumable"] == true),
            "diffAvailable": existing.as_ref().is_some_and(|value| value.capabilities["diffAvailable"] == true),
        }),
    };
    if store.upsert_session(session.clone()).await.is_err() {
        return json!({ "id": request.id, "output": null });
    }
    if trusted {
        return json!({ "id": request.id, "output": { "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } } });
    }
    if matches!(hook_name, "SessionStart" | "UserPromptSubmit") {
        let _ = store
            .begin_feed_checkpoint(&request.provider, &run_id, &session_id, &timestamp)
            .await;
    }
    if hook_name == "UserPromptSubmit" {
        let prompt = payload
            .get("prompt")
            .or_else(|| payload.get("message"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty() && *prompt != LEGACY_FEED_DECISION_REASON);
        if let Some(prompt) = prompt {
            let prompt = crate::discovery::sanitize(Value::String(prompt.to_owned()))
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let _ = insert_hook_event(
                store,
                &request,
                &session,
                "user_instruction",
                json!({ "prompt": prompt }),
            )
            .await;
        }
        return json!({ "id": request.id, "output": null });
    }
    if hook_name == "Stop" {
        let _ = store
            .finalize_feed_checkpoint(&request.provider, &run_id, &timestamp)
            .await;
    }
    let kind = event_kind(hook_name, tool_name, &payload);
    let is_approval = hook_name == "PermissionRequest";
    if !is_approval && !is_input {
        if let Some(kind) = kind {
            let sanitized = crate::discovery::sanitize(Value::Object(payload));
            let _ = insert_hook_event(store, &request, &session, kind, sanitized).await;
        }
        return json!({ "id": request.id, "output": null });
    }

    let decisions = if is_input {
        input_decisions()
    } else {
        approval_decisions(&request.provider, &payload)
    };
    let detail = crate::discovery::sanitize(Value::String(action_detail(
        tool_name,
        payload.get("tool_input"),
    )))
    .as_str()
    .unwrap_or_default()
    .chars()
    .take(800)
    .collect();
    let approval_context = if is_input {
        None
    } else {
        approval_context(store, &session, tool_name, payload.get("tool_input")).await
    };
    let ticket = match broker
        .create(NewAction {
            session_id: session_id.clone(),
            upstream_request_id: payload
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some(request.id.clone())),
            kind: if is_input {
                "input".into()
            } else {
                "approval".into()
            },
            title: if is_input {
                "Agent 正在等待输入".into()
            } else {
                approval_title(tool_name)
            },
            detail,
            available_decisions: decisions,
            approval_context,
            timeout: Some(Duration::from_secs(8 * 60)),
        })
        .await
    {
        Ok(ticket) => ticket,
        Err(_) => return json!({ "id": request.id, "output": null }),
    };
    if let Some(kind) = kind {
        let mut event_payload = crate::discovery::sanitize(Value::Object(payload.clone()));
        event_payload["actionId"] = Value::String(ticket.action.action_id.clone());
        let _ = insert_hook_event(store, &request, &session, kind, event_payload).await;
    }
    let action_id = ticket.action.action_id.clone();
    let resolution = tokio::select! {
        resolution = ticket.result() => resolution,
        _ = cancellation.changed() => {
            let _ = broker.expire(&action_id).await;
            None
        }
    };
    json!({ "id": request.id, "output": format_resolution(&request.provider, hook_name, payload.get("tool_input"), resolution) })
}

async fn insert_hook_event(
    store: &Store,
    request: &HookRequest,
    session: &StoredSession,
    kind: &str,
    payload: Value,
) -> Result<(), zimlo_store::StoreError> {
    store
        .insert_event(UnifiedEvent {
            id: Uuid::now_v7().to_string(),
            sequence: 0,
            provider: request.provider.clone(),
            session_id: session.id.clone(),
            provider_session_id: session.provider_session_id.clone(),
            turn_id: payload
                .get("turn_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            item_id: payload
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            kind: kind.into(),
            source: "hook".into(),
            occurred_at: now(),
            payload,
            provenance: "verified".into(),
        })
        .await
        .map(|_| ())
}

async fn approval_context(
    store: &Store,
    session: &StoredSession,
    tool_name: &str,
    input: Option<&Value>,
) -> Option<Value> {
    let input = input.and_then(Value::as_object);
    let project_root = match session.project_id.as_deref() {
        Some(project_id) => store.workspace_path(project_id).await.ok().flatten(),
        None => None,
    };
    let context = if tool_name == "Bash" {
        trust_policy::approval_context_for_command(
            input?.get("command")?.as_str()?,
            session.cwd.as_deref(),
            session.project_id.as_deref(),
            project_root.as_deref(),
        )
    } else {
        trust_policy::approval_context_for_file(
            input
                .and_then(|value| value.get("file_path"))
                .and_then(Value::as_str),
            session.cwd.as_deref(),
            session.project_id.as_deref(),
            project_root.as_deref(),
        )
    };
    serde_json::to_value(context).ok()
}

fn approval_decisions(
    provider: &str,
    payload: &serde_json::Map<String, Value>,
) -> Vec<DecisionRecord> {
    let command = payload
        .get("tool_input")
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let risk = trust_policy::risk_for_command(command).to_owned();
    let confirmation = (risk == "high").then(|| "确认执行".to_owned());
    let mut decisions = vec![DecisionRecord {
        id: "allow-once".into(),
        label: "允许一次".into(),
        scope: "once".into(),
        value: json!({ "behavior": "allow" }),
        confirmation_phrase: confirmation,
        risk,
    }];
    if provider == "claude" {
        for (index, suggestion) in payload
            .get("permission_suggestions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let persistent = suggestion["destination"] != "session";
            decisions.push(DecisionRecord {
                id: format!("upstream-{index}"),
                label: if persistent {
                    "永久允许此规则".into()
                } else {
                    "本 Session 允许".into()
                },
                scope: if persistent {
                    "persistent".into()
                } else {
                    "session".into()
                },
                value: json!({ "behavior": "allow", "updatedPermissions": [suggestion] }),
                confirmation_phrase: Some(if persistent {
                    "永久允许".into()
                } else {
                    "本次会话允许".into()
                }),
                risk: if persistent {
                    "high".into()
                } else {
                    "medium".into()
                },
            });
        }
    }
    decisions.push(DecisionRecord {
        id: "deny".into(),
        label: "拒绝".into(),
        scope: "deny".into(),
        value: json!({ "behavior": "deny" }),
        confirmation_phrase: None,
        risk: "low".into(),
    });
    decisions
}

fn input_decisions() -> Vec<DecisionRecord> {
    vec![DecisionRecord {
        id: "submit-input".into(),
        label: "提交回复".into(),
        scope: "input".into(),
        value: json!({}),
        confirmation_phrase: None,
        risk: "low".into(),
    }]
}

fn format_resolution(
    provider: &str,
    hook_name: &str,
    input: Option<&Value>,
    resolution: Option<DecisionResolution>,
) -> Value {
    let Some(resolution) = resolution else {
        return Value::Null;
    };
    if hook_name == "PreToolUse" {
        let mut updated = input.cloned().unwrap_or_else(|| json!({}));
        let answer = resolution
            .input
            .as_ref()
            .and_then(|values| values.get("answer"))
            .cloned();
        if let (Some(answer), Some(questions)) =
            (answer, updated.get("questions").and_then(Value::as_array))
        {
            let answers = questions
                .iter()
                .enumerate()
                .map(|(index, question)| {
                    let key = if provider == "codex" {
                        question.get("id")
                    } else {
                        question.get("question")
                    }
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("question-{}", index + 1));
                    (key, Value::String(answer.clone()))
                })
                .collect::<serde_json::Map<_, _>>();
            updated["answers"] = Value::Object(answers);
        }
        return json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": updated } });
    }
    let mut decision = resolution.decision.value;
    if decision["behavior"] == "deny" {
        decision["message"] = Value::String("Denied from Zimlo".into());
    }
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
}

fn action_detail(tool_name: &str, input: Option<&Value>) -> String {
    let input = input.cloned().unwrap_or(Value::Null);
    let detail = input
        .get("description")
        .or_else(|| input.get("reason"))
        .and_then(Value::as_str)
        .or_else(|| input.get("command").and_then(Value::as_str))
        .or_else(|| input.get("file_path").and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("工具：{tool_name}\n{input}"));
    detail.chars().take(800).collect()
}

fn approval_title(tool_name: &str) -> String {
    match tool_name {
        "Bash" => "批准执行命令".into(),
        "Edit" | "Write" | "apply_patch" => "批准修改文件".into(),
        value if !value.is_empty() => format!("批准使用 {}", value.trim_start_matches("mcp__")),
        _ => "批准受保护操作".into(),
    }
}

fn event_kind(
    hook: &str,
    tool: &str,
    payload: &serde_json::Map<String, Value>,
) -> Option<&'static str> {
    match (hook, tool) {
        ("SessionStart", _) => Some("session_started"),
        ("SessionEnd", _) => Some("session_ended"),
        ("PermissionRequest", _) => Some("needs_approval"),
        ("Stop", _) => Some("completed"),
        ("PostToolUseFailure", _) => Some("failed"),
        ("PreToolUse", "AskUserQuestion" | "request_user_input") => Some("needs_input"),
        ("PreToolUse", "Bash") => Some("command_started"),
        ("PreToolUse" | "PostToolUse", "Edit" | "Write" | "apply_patch") => Some("files_changed"),
        ("PostToolUse", "Bash") => {
            let command = payload
                .get("tool_input")
                .and_then(Value::as_object)
                .and_then(|input| {
                    ["command", "cmd", "script"]
                        .into_iter()
                        .find_map(|key| input.get(key).and_then(Value::as_str))
                });
            let exit_code = payload.get("tool_response").and_then(find_exit_code);
            if command.is_some_and(is_test_command) && exit_code.is_some() {
                if exit_code == Some(0) {
                    Some("tests_passed")
                } else {
                    Some("tests_failed")
                }
            } else {
                Some("command_completed")
            }
        }
        _ => None,
    }
}

fn is_test_command(command: &str) -> bool {
    static TEST_COMMAND: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    TEST_COMMAND
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)(?:^|\s|/)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|\s)(?:pytest|jest|vitest|mocha|cargo\s+test|swift\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b",
            )
            .expect("test command regex")
        })
        .is_match(command)
}

fn find_exit_code(value: &Value) -> Option<i64> {
    match value {
        Value::Number(value) => value.as_i64(),
        Value::String(value) => serde_json::from_str::<Value>(value)
            .ok()
            .as_ref()
            .and_then(find_exit_code)
            .or_else(|| {
                static EXIT_CODE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
                EXIT_CODE
                    .get_or_init(|| {
                        regex::Regex::new(
                            r"(?i)(?:exit(?:_code| code)?|process exited with code)\D{0,8}(-?\d+)",
                        )
                        .expect("exit code regex")
                    })
                    .captures(value)
                    .and_then(|capture| capture.get(1))
                    .and_then(|value| value.as_str().parse().ok())
            }),
        Value::Array(values) => values.iter().find_map(find_exit_code),
        Value::Object(values) => ["exit_code", "exitCode", "code"]
            .into_iter()
            .find_map(|key| values.get(key).and_then(Value::as_i64))
            .or_else(|| values.values().find_map(find_exit_code)),
        _ => None,
    }
}

fn success_message(name: &str, data: &Value) -> &'static str {
    match name {
        "feed.post" if data["deduplicated"] == true => "重复调用已去重，返回原帖。",
        "feed.post" if data["coalesced"] == true => "已合并到最近的阶段成果，避免重复刷屏。",
        "feed.post" => "Feed 已发布。",
        "feed.skip" => "本轮已记录为不发帖，可以结束。",
        "signal.transition" => "任务状态已更新。",
        "material.publish" => "物料已注册，可以在 Feed 媒体卡中引用。",
        _ => "操作完成。",
    }
}

fn stable_session_id(provider: &str, provider_session_id: &str) -> String {
    let digest = Sha256::digest(format!("{provider}\0{provider_session_id}"));
    format!("zim_{}", &format!("{digest:x}")[..24])
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tempfile::tempdir;
    use tokio::{io::AsyncWriteExt as _, net::UnixStream, sync::watch};
    use zimlo_store::{Store, StoreMode};

    use super::{event_kind, run_until_shutdown};
    use crate::ActionBroker;

    #[test]
    fn classifies_test_hook_results_like_the_node_runtime() {
        let passed = json!({
            "tool_input": { "command": "cargo test --workspace" },
            "tool_response": { "exit_code": 0 },
        });
        let failed = json!({
            "tool_input": { "cmd": "pnpm test" },
            "tool_response": "process exited with code 1",
        });
        assert_eq!(
            event_kind("PostToolUse", "Bash", passed.as_object().expect("object")),
            Some("tests_passed")
        );
        assert_eq!(
            event_kind("PostToolUse", "Bash", failed.as_object().expect("object")),
            Some("tests_failed")
        );
    }

    #[tokio::test]
    async fn expires_a_pending_hook_action_when_the_client_disconnects() {
        let directory = tempdir().expect("tempdir");
        let database = directory.path().join("zimlo.db");
        let socket = directory.path().join("bridge.sock");
        let store = Store::open(&database, StoreMode::ReadWriteCreate)
            .await
            .expect("store");
        let broker = ActionBroker::new(store.clone());
        let (stop, receiver) = watch::channel(false);
        let server = tokio::spawn({
            let socket = socket.clone();
            async move {
                run_until_shutdown(&socket, store, broker, None, receiver)
                    .await
                    .expect("local control");
            }
        });
        let mut stream = loop {
            match UnixStream::connect(&socket).await {
                Ok(stream) => break stream,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        };
        stream
            .write_all(
                format!(
                    "{}\n",
                    json!({
                        "type": "hook",
                        "id": "disconnect-hook",
                        "provider": "codex",
                        "surface": "cli",
                        "payload": {
                            "session_id": "disconnect-session",
                            "hook_event_name": "PermissionRequest",
                            "tool_name": "Bash",
                            "tool_input": { "command": "git push" },
                        },
                    })
                )
                .as_bytes(),
            )
            .await
            .expect("write hook");
        wait_for_action_state(&database, "pending").await;
        drop(stream);
        wait_for_action_state(&database, "expired").await;
        let _ = stop.send(true);
        server.await.expect("server task");
    }

    async fn wait_for_action_state(database: &std::path::Path, expected: &str) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let state = rusqlite::Connection::open(database)
                    .ok()
                    .and_then(|connection| {
                        connection
                            .query_row(
                                "SELECT state FROM actions ORDER BY created_at DESC LIMIT 1",
                                [],
                                |row| row.get::<_, String>(0),
                            )
                            .ok()
                    });
                if state.as_deref() == Some(expected) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("action state timeout");
    }
}
