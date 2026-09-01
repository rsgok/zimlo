use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use zimlo_store::{
    MutationResult, NotificationSettingsInput, SafeMutation, SnapshotOptions, Store, StoreError,
};

use crate::{
    ActionBroker, action_dispatch, management, materials, pairing::PairingManager, trust_dispatch,
};

pub(super) enum DispatchResult {
    Message(Value),
    Messages(Vec<Value>),
    Snapshot,
    Invalid,
}

pub(super) struct DispatchContext<'a> {
    pub store: &'a Store,
    pub device_id: &'a str,
    pub is_local_admin: bool,
    pub can_approve: bool,
    pub can_manage_trust: bool,
    pub writable: bool,
    pub pairing: Option<&'a PairingManager>,
    pub action_broker: &'a ActionBroker,
    pub host_name: &'a str,
}

pub(super) fn valid_snapshot_request(command: &Value) -> bool {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    command.get("afterSequence").is_none_or(|value| {
        value
            .as_i64()
            .is_some_and(|number| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&number))
            || value
                .as_u64()
                .is_some_and(|number| number <= MAX_SAFE_INTEGER as u64)
    })
}

pub(super) async fn dispatch(
    context: DispatchContext<'_>,
    command: &Value,
) -> Result<DispatchResult, StoreError> {
    let DispatchContext {
        store,
        device_id,
        is_local_admin,
        can_approve,
        can_manage_trust,
        writable,
        pairing,
        action_broker,
        host_name,
    } = context;
    let Some(command_type) = command.get("type").and_then(Value::as_str) else {
        return Ok(DispatchResult::Invalid);
    };
    match command_type {
        "action.decide" => {
            action_dispatch::decide(
                action_broker,
                device_id,
                is_local_admin,
                can_approve,
                writable,
                command,
            )
            .await
        }
        "devices.request" => {
            if !is_local_admin {
                return Ok(message_error("forbidden", "仅 Mac 本机管理页可查看设备。"));
            }
            Ok(DispatchResult::Message(json!({
                "type": "devices.list",
                "devices": redacted_devices(store).await?,
            })))
        }
        "notification.settings.get" => {
            let snapshot = snapshot(store, host_name, device_id).await?;
            Ok(DispatchResult::Message(json!({
                "type": "notification.settings.updated",
                "settings": snapshot["notificationSettings"],
            })))
        }
        "trust.policy.get" => {
            let snapshot = snapshot(store, host_name, device_id).await?;
            let project_id = optional_string(command, "projectId")?;
            let policies = snapshot["trustPolicies"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|policy| {
                    project_id
                        .as_deref()
                        .is_none_or(|id| policy["projectId"].as_str() == Some(id))
                })
                .collect::<Vec<_>>();
            let audit = snapshot["trustAudit"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|entry| {
                    project_id
                        .as_deref()
                        .is_none_or(|id| entry["projectId"].as_str() == Some(id))
                })
                .collect::<Vec<_>>();
            Ok(DispatchResult::Message(json!({
                "type": "trust.policies",
                "policies": policies,
                "audit": audit,
            })))
        }
        "trust.policy.update" => {
            trust_dispatch::update(
                store,
                device_id,
                is_local_admin,
                can_manage_trust,
                writable,
                command,
            )
            .await
        }
        "feed.seen" => {
            let post_id = required_string(command, "postId", None)?;
            mutate(
                store,
                device_id,
                writable,
                SafeMutation::FeedSeen { post_id, at: now() },
            )
            .await
        }
        "feed.dismiss" => {
            let item_id = required_string(command, "itemId", Some(240))?;
            mutate(
                store,
                device_id,
                writable,
                SafeMutation::FeedDismiss {
                    item_id,
                    dismissed: true,
                    idempotency_key: None,
                    at: now(),
                },
            )
            .await
        }
        "feed.dismiss.set" => {
            let item_id = required_string(command, "itemId", Some(240))?;
            let Some(dismissed) = command.get("dismissed").and_then(Value::as_bool) else {
                return Ok(DispatchResult::Invalid);
            };
            let idempotency_key = required_string(command, "idempotencyKey", None)?;
            mutate(
                store,
                device_id,
                writable,
                SafeMutation::FeedDismiss {
                    item_id,
                    dismissed,
                    idempotency_key: Some(idempotency_key),
                    at: now(),
                },
            )
            .await
        }
        "task.timeline.seen" => {
            let session_id = required_string(command, "sessionId", None)?;
            let item_id = required_string(command, "itemId", Some(240))?;
            mutate(
                store,
                device_id,
                writable,
                SafeMutation::TaskTimelineSeen {
                    session_id,
                    item_id,
                    at: now(),
                },
            )
            .await
        }
        "task.pin" | "task.archive" => {
            let session_id = required_string(command, "sessionId", None)?;
            let field = if command_type == "task.pin" {
                "pinned"
            } else {
                "archived"
            };
            let Some(enabled) = command.get(field).and_then(Value::as_bool) else {
                return Ok(DispatchResult::Invalid);
            };
            let idempotency_key = optional_string(command, "idempotencyKey")?;
            mutate(
                store,
                device_id,
                writable,
                SafeMutation::TaskPreference {
                    session_id,
                    pinned: (command_type == "task.pin").then_some(enabled),
                    archived: (command_type == "task.archive").then_some(enabled),
                    idempotency_key,
                    at: now(),
                },
            )
            .await
        }
        "notification.settings.update" => {
            let Some(settings) = command.get("settings") else {
                return Ok(DispatchResult::Invalid);
            };
            let Ok(settings) =
                serde_json::from_value::<NotificationSettingsInput>(settings.clone())
            else {
                return Ok(DispatchResult::Invalid);
            };
            if !(-840..=840).contains(&settings.time_zone_offset_minutes) {
                return Ok(DispatchResult::Invalid);
            }
            let idempotency_key = required_string(command, "idempotencyKey", None)?;
            mutate(
                store,
                device_id,
                writable,
                SafeMutation::NotificationSettings {
                    settings,
                    idempotency_key,
                    at: now(),
                },
            )
            .await
        }
        "user.profile.update" => {
            let avatar_id = required_string(command, "avatarId", None)?;
            if !matches!(
                avatar_id.as_str(),
                "user-01"
                    | "user-02"
                    | "user-03"
                    | "user-04"
                    | "user-05"
                    | "user-06"
                    | "user-07"
                    | "user-08"
                    | "user-09"
                    | "user-10"
                    | "user-11"
                    | "user-12"
                    | "user-13"
                    | "user-14"
                    | "user-15"
                    | "user-16"
                    | "user-17"
                    | "user-18"
                    | "user-19"
                    | "user-20"
                    | "user-21"
                    | "user-22"
                    | "user-23"
                    | "user-24"
            ) {
                return Ok(DispatchResult::Invalid);
            }
            mutate(
                store,
                device_id,
                writable,
                SafeMutation::UserProfile {
                    avatar_id,
                    at: now(),
                },
            )
            .await
        }
        "agent.profile.update" => {
            management::update_agent_profile(store, device_id, writable, host_name, command).await
        }
        "material.register" => {
            if !writable {
                return Ok(read_only());
            }
            match materials::register(store, device_id, command).await? {
                materials::RegistrationResult::Material(material) => {
                    Ok(DispatchResult::Message(json!({
                        "type": "material.updated",
                        "material": material,
                    })))
                }
                materials::RegistrationResult::Invalid => Ok(DispatchResult::Invalid),
                materials::RegistrationResult::CloudNotMigrated => Ok(message_error(
                    "runtime_not_migrated",
                    "Cloud 物料传输尚未迁移到 Rust Runtime。",
                )),
            }
        }
        "task.command.cancel" => {
            crate::task_commands::cancel(store, device_id, writable, command).await
        }
        "task.create" => crate::task_enqueue::create(store, device_id, writable, command).await,
        "task.follow_up" | "session.message" => {
            crate::task_enqueue::follow_up(store, device_id, writable, command).await
        }
        "task.command.retry" => crate::task_enqueue::retry(store, writable, command).await,
        "device.revoke" | "device.approvals.set" | "device.trust.set" => {
            if !is_local_admin {
                return Ok(message_error("forbidden", "仅 Mac 本机管理页可管理设备。"));
            }
            if !writable {
                return Ok(read_only());
            }
            let target = required_string(command, "deviceId", None)?;
            match command_type {
                "device.revoke" => {
                    if !store.revoke_device(&target, now()).await? {
                        return Ok(message_error(
                            "device_not_found",
                            "这台设备不存在或不能撤销。",
                        ));
                    }
                }
                "device.approvals.set" => {
                    let Some(enabled) = command.get("enabled").and_then(Value::as_bool) else {
                        return Ok(DispatchResult::Invalid);
                    };
                    store.set_device_approval(&target, enabled).await?;
                }
                "device.trust.set" => {
                    let Some(enabled) = command.get("enabled").and_then(Value::as_bool) else {
                        return Ok(DispatchResult::Invalid);
                    };
                    store.set_device_trust(&target, enabled).await?;
                }
                _ => unreachable!(),
            }
            Ok(DispatchResult::Message(json!({
                "type": "devices.list",
                "devices": redacted_devices(store).await?,
            })))
        }
        "pairing.create" => {
            if !is_local_admin {
                return Ok(message_error("forbidden", "仅 Mac 本机管理页可创建配对。"));
            }
            if !writable {
                return Ok(read_only());
            }
            match pairing.and_then(|pairing| pairing.create().ok()) {
                Some(payload) => Ok(DispatchResult::Message(json!({
                    "type": "pairing.created",
                    "pairingId": payload.pairing_id,
                    "pairUrl": payload.pair_url,
                    "qrDataUrl": payload.qr_data_url,
                    "expiresAt": payload.expires_at,
                }))),
                None => Ok(message_error(
                    "pairing_unavailable",
                    "请以 --lan --write 启动 Rust Runtime 后再创建配对。",
                )),
            }
        }
        "lan.approvals.set" => {
            management::set_lan_approvals(store, is_local_admin, writable, command).await
        }
        _ => Ok(message_error(
            "runtime_not_migrated",
            "这类命令尚未迁移到 Rust Runtime。",
        )),
    }
}

async fn mutate(
    store: &Store,
    device_id: &str,
    writable: bool,
    mutation: SafeMutation,
) -> Result<DispatchResult, StoreError> {
    if !writable {
        return Ok(read_only());
    }
    match store.apply_safe_mutation(device_id, mutation).await? {
        MutationResult::Message(message) => Ok(DispatchResult::Message(message)),
        MutationResult::Snapshot => Ok(DispatchResult::Snapshot),
    }
}

async fn snapshot(store: &Store, host_name: &str, device_id: &str) -> Result<Value, StoreError> {
    store
        .snapshot(SnapshotOptions::for_device(host_name, now(), device_id))
        .await
}

async fn redacted_devices(store: &Store) -> Result<Vec<Value>, StoreError> {
    store
        .list_devices()
        .await?
        .into_iter()
        .map(|device| {
            let mut value = serde_json::to_value(device).map_err(|error| {
                StoreError::Sqlite(format!("unable to encode device record: {error}"))
            })?;
            value
                .as_object_mut()
                .expect("device serializes as object")
                .remove("keyBase64");
            Ok(value)
        })
        .collect()
}

fn required_string(
    command: &Value,
    field: &str,
    maximum: Option<usize>,
) -> Result<String, StoreError> {
    let Some(value) = command.get(field).and_then(Value::as_str) else {
        return Err(StoreError::InvalidMutation);
    };
    if maximum.is_some_and(|maximum| value.is_empty() || value.chars().count() > maximum) {
        return Err(StoreError::InvalidMutation);
    }
    Ok(value.to_owned())
}

fn optional_string(command: &Value, field: &str) -> Result<Option<String>, StoreError> {
    match command.get(field) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(StoreError::InvalidMutation),
    }
}

fn message_error(code: &str, message: &str) -> DispatchResult {
    DispatchResult::Message(json!({ "type": "error", "code": code, "message": message }))
}

fn read_only() -> DispatchResult {
    message_error("runtime_read_only", "Rust Runtime 当前以只读模式运行。")
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
