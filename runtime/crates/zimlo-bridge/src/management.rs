use serde_json::{Value, json};
use zimlo_store::{MutationResult, SafeMutation, SnapshotOptions, Store, StoreError};

use crate::dispatcher::DispatchResult;

pub(super) async fn update_agent_profile(
    store: &Store,
    device_id: &str,
    writable: bool,
    host_name: &str,
    command: &Value,
) -> Result<DispatchResult, StoreError> {
    let Some(project_id) = string(command, "projectId") else {
        return Ok(DispatchResult::Invalid);
    };
    let Some(display_name) = bounded_string(command, "displayName", 1, 80) else {
        return Ok(DispatchResult::Invalid);
    };
    let Some(avatar) = bounded_string(command, "avatar", 1, 16) else {
        return Ok(DispatchResult::Invalid);
    };
    let Some(bio) = bounded_string(command, "bio", 0, 280) else {
        return Ok(DispatchResult::Invalid);
    };
    let default_provider = match command.get("defaultProvider") {
        Some(Value::Null) => None,
        Some(Value::String(provider)) if matches!(provider.as_str(), "codex" | "claude") => {
            Some(provider.clone())
        }
        _ => return Ok(DispatchResult::Invalid),
    };
    let idempotency_key = match command.get("idempotencyKey") {
        None => None,
        Some(Value::String(key)) => Some(key.clone()),
        Some(_) => return Ok(DispatchResult::Invalid),
    };
    if !writable {
        return Ok(read_only());
    }
    let updated_at = now();
    let mutation = SafeMutation::AgentProfile {
        project_id: project_id.clone(),
        display_name,
        avatar,
        bio,
        default_provider,
        idempotency_key: idempotency_key.clone(),
        at: updated_at.clone(),
    };
    match store.apply_safe_mutation(device_id, mutation).await {
        Ok(MutationResult::Snapshot) => {}
        Ok(MutationResult::Message(_)) => return Err(StoreError::InvalidMutation),
        Err(StoreError::MissingProject) => {
            return Ok(command_error(
                "project_not_found",
                "这个 Project 已不存在。",
                idempotency_key.as_deref(),
            ));
        }
        Err(error) => return Err(error),
    }
    let snapshot = store
        .snapshot(SnapshotOptions::for_device(
            host_name, updated_at, device_id,
        ))
        .await?;
    let project = snapshot["projects"]
        .as_array()
        .and_then(|projects| {
            projects
                .iter()
                .find(|project| project["id"].as_str() == Some(&project_id))
        })
        .cloned()
        .ok_or(StoreError::MissingProject)?;
    Ok(DispatchResult::Message(json!({
        "type": "project.updated",
        "project": project,
    })))
}

pub(super) async fn set_lan_approvals(
    store: &Store,
    is_local_admin: bool,
    writable: bool,
    command: &Value,
) -> Result<DispatchResult, StoreError> {
    let Some(enabled) = command.get("enabled").and_then(Value::as_bool) else {
        return Ok(DispatchResult::Invalid);
    };
    if !is_local_admin {
        return Ok(message_error(
            "forbidden",
            "仅 Mac 本机管理页可开启 LAN 审批。",
        ));
    }
    if !writable {
        return Ok(read_only());
    }
    store
        .set_metadata("lan_approvals_enabled", if enabled { "1" } else { "0" })
        .await?;
    for device in store.list_devices().await? {
        if !device.is_local_admin && device.revoked_at.is_none() {
            store.set_device_approval(device.id, enabled).await?;
        }
    }
    Ok(DispatchResult::Messages(vec![
        json!({ "type": "lan.approvals.changed", "enabled": enabled }),
        json!({ "type": "devices.list", "devices": redacted_devices(store).await? }),
    ]))
}

async fn redacted_devices(store: &Store) -> Result<Vec<Value>, StoreError> {
    store
        .list_devices()
        .await?
        .into_iter()
        .map(|device| {
            let mut value = serde_json::to_value(device)
                .map_err(|error| StoreError::Sqlite(format!("unable to encode device: {error}")))?;
            value
                .as_object_mut()
                .expect("device object")
                .remove("keyBase64");
            Ok(value)
        })
        .collect()
}

fn bounded_string(command: &Value, field: &str, minimum: usize, maximum: usize) -> Option<String> {
    let value = string(command, field)?;
    (minimum..=maximum)
        .contains(&value.chars().count())
        .then_some(value)
}

fn string(command: &Value, field: &str) -> Option<String> {
    command
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn command_error(code: &str, message: &str, idempotency_key: Option<&str>) -> DispatchResult {
    let mut error = json!({
        "type": "error", "code": code, "message": message,
        "commandType": "agent.profile.update",
    });
    if let Some(key) = idempotency_key {
        error["idempotencyKey"] = json!(key);
    }
    DispatchResult::Message(error)
}

fn message_error(code: &str, message: &str) -> DispatchResult {
    DispatchResult::Message(json!({ "type": "error", "code": code, "message": message }))
}

fn read_only() -> DispatchResult {
    message_error("runtime_read_only", "Rust Runtime 当前以只读模式运行。")
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
