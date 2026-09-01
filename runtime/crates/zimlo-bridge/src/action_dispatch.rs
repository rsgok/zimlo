use serde_json::{Value, json};
use zimlo_store::StoreError;

use crate::{ActionBroker, DecisionSubmission, dispatcher::DispatchResult};

pub(super) async fn decide(
    broker: &ActionBroker,
    device_id: &str,
    is_local_admin: bool,
    can_approve: bool,
    writable: bool,
    command: &Value,
) -> Result<DispatchResult, StoreError> {
    let action_id = command
        .get("actionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_local_admin && !can_approve {
        return Ok(message(
            action_id,
            false,
            "这台手机尚未获得 Mac 的审批授权。",
        ));
    }
    if !writable {
        return Ok(DispatchResult::Message(json!({
            "type": "error",
            "code": "runtime_read_only",
            "message": "Rust Runtime 当前以只读模式运行。",
        })));
    }
    let action_id = required_string(command, "actionId")?;
    let result = broker
        .decide(DecisionSubmission {
            device_id: device_id.into(),
            action_id: action_id.clone(),
            session_id: required_string(command, "sessionId")?,
            decision_id: required_string(command, "decisionId")?,
            idempotency_key: required_string(command, "idempotencyKey")?,
            confirmation_phrase: optional_string(command, "confirmationPhrase")?,
            input: optional_string_map(command, "input")?,
        })
        .await?;
    Ok(message(&action_id, result.ok, &result.message))
}

fn message(action_id: &str, ok: bool, message: &str) -> DispatchResult {
    DispatchResult::Message(json!({
        "type": "action.result",
        "actionId": action_id,
        "ok": ok,
        "message": message,
    }))
}

fn required_string(command: &Value, field: &str) -> Result<String, StoreError> {
    command
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(StoreError::InvalidMutation)
}

fn optional_string(command: &Value, field: &str) -> Result<Option<String>, StoreError> {
    match command.get(field) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(StoreError::InvalidMutation),
    }
}

fn optional_string_map(
    command: &Value,
    field: &str,
) -> Result<Option<std::collections::HashMap<String, String>>, StoreError> {
    let Some(value) = command.get(field) else {
        return Ok(None);
    };
    let Some(values) = value.as_object() else {
        return Err(StoreError::InvalidMutation);
    };
    values
        .iter()
        .map(|(key, value)| {
            value
                .as_str()
                .map(|value| (key.clone(), value.to_owned()))
                .ok_or(StoreError::InvalidMutation)
        })
        .collect::<Result<_, _>>()
        .map(Some)
}
