use serde_json::{Map, Value, json};
use zimlo_store::{CancelTaskCommandResult, Store, StoreError};

use crate::dispatcher::DispatchResult;

pub(super) async fn cancel(
    store: &Store,
    device_id: &str,
    writable: bool,
    input: &Value,
) -> Result<DispatchResult, StoreError> {
    let command_id = optional_string(input, "commandId")?;
    let idempotency_key = optional_string(input, "idempotencyKey")?;
    if command_id.is_some() == idempotency_key.is_some() {
        return Ok(DispatchResult::Invalid);
    }
    if !writable {
        return Ok(DispatchResult::Message(json!({
            "type": "error",
            "code": "runtime_read_only",
            "message": "Rust Runtime 当前以只读模式运行。",
        })));
    }

    let scoped_key = idempotency_key
        .as_ref()
        .map(|key| format!("{device_id}:{key}"));
    let result = store
        .cancel_task_command(command_id.clone(), scoped_key, now())
        .await?;
    let reference = command_reference(command_id, idempotency_key);
    Ok(match result {
        CancelTaskCommandResult::Canceled(command) => DispatchResult::Messages(vec![
            json!({ "type": "task.command.updated", "command": command }),
            cancel_result(reference, true, "指令已撤回。"),
        ]),
        CancelTaskCommandResult::NotFound => DispatchResult::Messages(vec![cancel_result(
            reference,
            true,
            "指令未执行，已从队列撤回。",
        )]),
        CancelTaskCommandResult::NotCancelable(command) => DispatchResult::Messages(vec![
            json!({ "type": "task.command.updated", "command": command }),
            cancel_result(reference, false, "指令已在执行或已结束，无法取消。"),
        ]),
    })
}

fn command_reference(
    command_id: Option<String>,
    idempotency_key: Option<String>,
) -> Map<String, Value> {
    let mut reference = Map::new();
    if let Some(command_id) = command_id {
        reference.insert("commandId".into(), Value::String(command_id));
    }
    if let Some(idempotency_key) = idempotency_key {
        reference.insert("idempotencyKey".into(), Value::String(idempotency_key));
    }
    reference
}

fn cancel_result(mut reference: Map<String, Value>, ok: bool, message: &str) -> Value {
    reference.insert(
        "type".into(),
        Value::String("task.command.cancel.result".into()),
    );
    reference.insert("ok".into(), Value::Bool(ok));
    reference.insert("message".into(), Value::String(message.into()));
    Value::Object(reference)
}

fn optional_string(input: &Value, field: &str) -> Result<Option<String>, StoreError> {
    match input.get(field) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(StoreError::InvalidMutation),
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use zimlo_store::{StoreMode, TaskCommandRecord};

    use super::*;

    fn command(id: &str, key: &str) -> TaskCommandRecord {
        TaskCommandRecord {
            id: id.into(),
            idempotency_key: key.into(),
            kind: "create".into(),
            provider: "codex".into(),
            session_id: None,
            workspace_id: None,
            cwd: "/tmp/zimlo".into(),
            text: "continue".into(),
            material_ids: Vec::new(),
            state: "queued".into(),
            created_at: "2026-09-02T00:00:00.000Z".into(),
            updated_at: "2026-09-02T00:00:00.000Z".into(),
            error: None,
        }
    }

    #[tokio::test]
    async fn cancels_by_device_scoped_idempotency_and_replays_successfully() {
        let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
            .await
            .expect("store");
        store
            .insert_task_command(command("queued", "device-1:client-key"))
            .await
            .expect("insert");
        let request = json!({
            "type": "task.command.cancel",
            "idempotencyKey": "client-key",
        });

        for _ in 0..2 {
            let DispatchResult::Messages(messages) = cancel(&store, "device-1", true, &request)
                .await
                .expect("cancel")
            else {
                panic!("expected cancellation messages");
            };
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[0]["type"], "task.command.updated");
            assert_eq!(messages[0]["command"]["state"], "canceled");
            assert_eq!(messages[1]["type"], "task.command.cancel.result");
            assert_eq!(messages[1]["idempotencyKey"], "client-key");
            assert_eq!(messages[1]["ok"], true);
        }
    }

    #[tokio::test]
    async fn missing_is_idempotent_but_running_and_read_only_commands_are_not_canceled() {
        let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
            .await
            .expect("store");
        let DispatchResult::Messages(missing) = cancel(
            &store,
            "device-1",
            true,
            &json!({ "type": "task.command.cancel", "commandId": "missing" }),
        )
        .await
        .expect("missing") else {
            panic!("expected missing receipt");
        };
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0]["ok"], true);

        store
            .insert_task_command(command("running", "device-1:running"))
            .await
            .expect("insert");
        store
            .claim_task_command("running", "2026-09-02T00:00:01.000Z")
            .await
            .expect("claim");
        store
            .mark_task_command_running("running", "2026-09-02T00:00:02.000Z")
            .await
            .expect("running");
        let DispatchResult::Messages(messages) = cancel(
            &store,
            "device-1",
            true,
            &json!({ "type": "task.command.cancel", "commandId": "running" }),
        )
        .await
        .expect("cancel running") else {
            panic!("expected rejection messages");
        };
        assert_eq!(messages[0]["command"]["state"], "running");
        assert_eq!(messages[1]["ok"], false);

        let DispatchResult::Message(read_only) = cancel(
            &store,
            "device-1",
            false,
            &json!({ "type": "task.command.cancel", "commandId": "running" }),
        )
        .await
        .expect("read-only") else {
            panic!("expected read-only error");
        };
        assert_eq!(read_only["code"], "runtime_read_only");
        assert!(matches!(
            cancel(
                &store,
                "device-1",
                true,
                &json!({ "type": "task.command.cancel" })
            )
            .await
            .expect("invalid"),
            DispatchResult::Invalid
        ));
    }
}
