use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use zimlo_store::{Store, StoreError, UpdateTrustPolicyResult};

use crate::dispatcher::DispatchResult;

pub(super) async fn update(
    store: &Store,
    device_id: &str,
    is_local_admin: bool,
    can_manage_trust: bool,
    writable: bool,
    command: &Value,
) -> Result<DispatchResult, StoreError> {
    let Some(project_id) = command.get("projectId").and_then(Value::as_str) else {
        return Ok(DispatchResult::Invalid);
    };
    let Some(preset) = command.get("preset").and_then(Value::as_str) else {
        return Ok(DispatchResult::Invalid);
    };
    let Some(idempotency_key) = command.get("idempotencyKey").and_then(Value::as_str) else {
        return Ok(DispatchResult::Invalid);
    };
    if !matches!(preset, "ask" | "safe_automation") {
        return Ok(DispatchResult::Invalid);
    }
    if !is_local_admin && !can_manage_trust {
        return Ok(command_error(
            "forbidden",
            "这台设备没有修改自动化策略的权限。",
            idempotency_key,
        ));
    }
    if !writable {
        return Ok(command_error(
            "runtime_read_only",
            "Rust Runtime 当前以只读模式运行。",
            idempotency_key,
        ));
    }
    let scoped_key = format!("{device_id}:{idempotency_key}");
    match store
        .update_trust_policy(project_id, preset, device_id, scoped_key, now())
        .await?
    {
        UpdateTrustPolicyResult::Updated(policy) => Ok(DispatchResult::Message(json!({
            "type": "trust.policy.updated",
            "policy": policy,
        }))),
        UpdateTrustPolicyResult::ProjectNotFound => Ok(command_error(
            "project_not_found",
            "这个 Project 已不存在。",
            idempotency_key,
        )),
    }
}

fn command_error(code: &str, message: &str, idempotency_key: &str) -> DispatchResult {
    DispatchResult::Message(json!({
        "type": "error",
        "code": code,
        "message": message,
        "commandType": "trust.policy.update",
        "idempotencyKey": idempotency_key,
    }))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
