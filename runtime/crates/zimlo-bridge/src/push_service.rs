use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{Timelike as _, Utc};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use zimlo_protocol::crypto::{fixed_bytes, from_base64_url, seal_push_route};
use zimlo_store::{NotificationSettingsRecord, PendingActionRecord, PushDeviceRecord, Store};

use crate::CloudService;

const QUICK_APPROVE_CATEGORY: &str = "ZIMLO_LOW_RISK_APPROVAL";

#[derive(Debug, Clone)]
struct PendingStatus {
    kind: String,
    task_title: Option<String>,
    summary: Option<String>,
}

#[derive(Clone)]
pub struct PushService {
    store: Store,
    cloud: CloudService,
    status: Arc<Mutex<HashMap<String, PendingStatus>>>,
}

impl PushService {
    pub fn new(store: Store, cloud: CloudService) -> Self {
        Self {
            store,
            cloud,
            status: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn notify_approval(
        &self,
        action: PendingActionRecord,
        task_title: Option<String>,
        reminder: bool,
    ) {
        let kind = if reminder {
            "approval_reminder"
        } else {
            "approval"
        };
        let summary = Some(notification_summary_for_action(&action, reminder));
        let session_id = action.session_id.clone();
        self.notify(kind, &session_id, task_title, Some(action), summary)
            .await;
    }

    pub async fn schedule_status(
        &self,
        kind: &str,
        session_id: String,
        task_title: Option<String>,
        summary: Option<String>,
    ) {
        let mut pending = self.status.lock().await;
        if let Some(existing) = pending.get_mut(&session_id) {
            if kind == "failure" {
                existing.kind = "failure".into();
                if summary.is_some() {
                    existing.summary = summary;
                }
            } else if existing.kind != "failure" && summary.is_some() {
                existing.summary = summary;
            }
            if task_title.is_some() {
                existing.task_title = task_title;
            }
            return;
        }
        pending.insert(
            session_id.clone(),
            PendingStatus {
                kind: kind.into(),
                task_title,
                summary,
            },
        );
        drop(pending);
        let service = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let pending = service.status.lock().await.remove(&session_id);
            if let Some(pending) = pending {
                service
                    .notify(
                        &pending.kind,
                        &session_id,
                        pending.task_title,
                        None,
                        pending.summary,
                    )
                    .await;
            }
        });
    }

    async fn notify(
        &self,
        kind: &str,
        session_id: &str,
        task_title: Option<String>,
        action: Option<PendingActionRecord>,
        summary: Option<String>,
    ) {
        if !self.cloud.enabled() {
            return;
        }
        let Ok(devices) = self.store.list_active_push_devices().await else {
            return;
        };
        for device in devices {
            if !should_deliver(kind, &device.settings) {
                continue;
            }
            let quick = action.as_ref().and_then(quick_approve_ids);
            let private_display = if device.settings.show_task_title {
                json!({
                    "taskTitle": task_title.as_deref().map(|value| compact(value, 80)),
                    "summary": summary.as_deref().map(|value| compact(value, 120)),
                })
            } else {
                json!({})
            };
            let mut route = json!({ "sessionId": session_id });
            merge_object(&mut route, private_display);
            if let (Some(action), Some((allow, deny))) = (action.as_ref(), quick.as_ref()) {
                route["version"] = 1.into();
                route["actionId"] = action.action_id.clone().into();
                route["decision"] = allow.clone().into();
                route["denyDecision"] = deny.clone().into();
                route["expiresAt"] = action.expires_at.clone().into();
                if let Some(category) = action
                    .approval_context
                    .as_ref()
                    .and_then(|context| context.get("category"))
                    .and_then(Value::as_str)
                {
                    route["category"] = category.into();
                }
            }
            let Ok(public_key) = from_base64_url(&device.registration.public_key)
                .and_then(|value| fixed_bytes::<32>("push route key", &value))
            else {
                continue;
            };
            let Ok(route) = seal_push_route(&public_key, &route) else {
                continue;
            };
            let badge = self
                .store
                .notification_unread_count(
                    &device.registration.device_id,
                    device.settings.clone(),
                    now(),
                )
                .await
                .unwrap_or_default();
            let mut payload = json!({
                "deviceId": device.registration.device_id,
                "kind": kind,
                "collapseId": format!("{session_id}:{}", if kind.starts_with("approval") { "action" } else { "status" }),
                "badge": badge,
                "alert": {
                    "title": "Zimlo",
                    "body": match kind {
                        "failure" => "一项任务需要你查看",
                        "result" => "一项任务有了新结果",
                        "approval_reminder" => "仍有一项等待你处理",
                        _ => "有一项需要你处理",
                    },
                },
                "route": route,
            });
            if quick.is_some() {
                payload["category"] = QUICK_APPROVE_CATEGORY.into();
            }
            self.send(device.registration, kind.into(), payload).await;
        }
    }

    async fn send(&self, registration: PushDeviceRecord, kind: String, payload: Value) {
        let status = self
            .cloud
            .send_push(&payload)
            .await
            .map(i64::from)
            .unwrap_or(-1);
        let _ = self
            .store
            .record_push_delivery(&registration.device_id, kind, status, now())
            .await;
        if status == 410 {
            let _ = self
                .store
                .unregister_push_device(&registration.device_id, now())
                .await;
        }
    }
}

fn should_deliver(kind: &str, settings: &NotificationSettingsRecord) -> bool {
    if !settings.enabled {
        return false;
    }
    let subscribed = if kind.starts_with("approval") {
        settings.approvals
    } else if kind == "result" {
        settings.results
    } else {
        settings.failures
    };
    subscribed && !((settings.critical_only || in_quiet_hours(settings)) && kind == "result")
}

fn in_quiet_hours(settings: &NotificationSettingsRecord) -> bool {
    if !settings.quiet_hours_enabled {
        return false;
    }
    let now = Utc::now();
    let utc_minutes = i64::from(now.hour()) * 60 + i64::from(now.minute());
    let local_minutes = (utc_minutes + settings.time_zone_offset_minutes).rem_euclid(1_440);
    !(8 * 60..22 * 60).contains(&local_minutes)
}

fn quick_approve_ids(action: &PendingActionRecord) -> Option<(String, String)> {
    if action.kind != "approval" || action.state != "pending" {
        return None;
    }
    if chrono::DateTime::parse_from_rfc3339(&action.expires_at).ok()? <= Utc::now() {
        return None;
    }
    let allow = action.available_decisions.iter().find(|decision| {
        decision.scope == "once" && decision.risk == "low" && decision.confirmation_phrase.is_none()
    })?;
    let deny = action
        .available_decisions
        .iter()
        .find(|decision| decision.scope == "deny" && decision.confirmation_phrase.is_none())?;
    Some((allow.id.clone(), deny.id.clone()))
}

fn notification_summary_for_action(action: &PendingActionRecord, reminder: bool) -> String {
    if action.kind == "input" {
        return if reminder {
            "仍有一个问题等待你回复"
        } else {
            "需要你回复一个问题"
        }
        .into();
    }
    let operation = action
        .approval_context
        .as_ref()
        .and_then(|context| context.get("category"))
        .and_then(Value::as_str)
        .and_then(category_label);
    let prefix = if reminder {
        "仍待批准"
    } else {
        "需要批准"
    };
    operation.map_or_else(
        || format!("{prefix}一项操作"),
        |value| format!("{prefix}：{value}"),
    )
}

fn category_label(category: &str) -> Option<&'static str> {
    match category {
        "read" => Some("读取项目文件"),
        "search" => Some("搜索项目内容"),
        "test" => Some("运行测试"),
        "build" => Some("构建项目"),
        "write" => Some("修改文件"),
        "install" => Some("安装或更新依赖"),
        "network" => Some("访问网络"),
        "git_publish" => Some("发布 Git 变更"),
        "destructive" => Some("执行可能破坏数据的操作"),
        "unknown" => Some("执行一项操作"),
        _ => None,
    }
}

fn compact(value: &str, limit: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let characters = compact.chars().collect::<Vec<_>>();
    if characters.len() <= limit {
        compact
    } else {
        format!(
            "{}…",
            characters[..limit.saturating_sub(1)]
                .iter()
                .collect::<String>()
        )
    }
}

fn merge_object(target: &mut Value, source: Value) {
    let Some(target) = target.as_object_mut() else {
        return;
    };
    for (key, value) in source.as_object().into_iter().flatten() {
        if !value.is_null() {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use zimlo_store::NotificationSettingsRecord;

    use super::should_deliver;

    #[test]
    fn notification_filters_match_node_contract() {
        let settings = NotificationSettingsRecord {
            enabled: true,
            approvals: true,
            results: true,
            failures: true,
            critical_only: true,
            quiet_hours_enabled: false,
            time_zone_offset_minutes: 0,
            show_task_title: false,
            updated_at: String::new(),
        };
        assert!(!should_deliver("result", &settings));
        assert!(should_deliver("failure", &settings));
        assert!(should_deliver("approval", &settings));
    }
}
