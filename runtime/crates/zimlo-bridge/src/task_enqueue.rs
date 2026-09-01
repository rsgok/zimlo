use serde_json::{Value, json};
use zimlo_store::{RetryTaskCommandResult, Store, StoreError, StoredSession, TaskCommandRecord};

use crate::dispatcher::DispatchResult;

pub(super) async fn create(
    store: &Store,
    device_id: &str,
    writable: bool,
    input: &Value,
) -> Result<DispatchResult, StoreError> {
    let provider = required_string(input, "provider")?;
    let workspace_id = required_string(input, "workspaceId")?;
    let text = task_text(input)?;
    let material_ids = material_ids(input)?;
    let idempotency_key = required_string(input, "idempotencyKey")?;
    if !matches!(provider.as_str(), "codex" | "claude") {
        return Ok(DispatchResult::Invalid);
    }
    if !writable {
        return Ok(read_only(input, &idempotency_key));
    }
    let workspace = store.workspace_path(&workspace_id).await?;
    let error = workspace
        .is_none()
        .then(|| "所选项目不在 Mac 的可信 workspace 列表中。".to_owned());
    let command = new_command(
        format!("{device_id}:{idempotency_key}"),
        "create",
        &provider,
        None,
        Some(workspace_id),
        workspace.unwrap_or_default(),
        text,
        material_ids,
        error,
    );
    let stored = store.insert_task_command(command).await?.command;
    Ok(DispatchResult::Message(updated(stored)))
}

pub(super) async fn follow_up(
    store: &Store,
    device_id: &str,
    writable: bool,
    input: &Value,
) -> Result<DispatchResult, StoreError> {
    let session_id = required_string(input, "sessionId")?;
    let text = task_text(input)?;
    let material_ids = material_ids(input)?;
    let idempotency_key = required_string(input, "idempotencyKey")?;
    let session = store.get_session(&session_id).await?;
    if !writable {
        return Ok(read_only(input, &idempotency_key));
    }
    let error = follow_up_invalid(session.as_ref());
    let command = new_command(
        format!("{device_id}:{idempotency_key}"),
        "follow_up",
        session
            .as_ref()
            .map(|session| session.provider.as_str())
            .unwrap_or("codex"),
        session.as_ref().map(|session| session.id.clone()),
        None,
        session
            .as_ref()
            .and_then(|session| session.cwd.clone())
            .unwrap_or_default(),
        text,
        material_ids,
        error,
    );
    let stored = store.insert_task_command(command).await?.command;
    let message = updated(stored.clone());
    if input["type"] == "session.message" {
        Ok(DispatchResult::Messages(vec![
            message,
            json!({
                "type": "session.message.result",
                "sessionId": session_id,
                "ok": stored.state != "failed",
                "message": if stored.state == "failed" {
                    stored.error.as_deref().unwrap_or("任务无法继续。")
                } else {
                    "指令已进入任务队列。"
                },
            }),
        ]))
    } else {
        Ok(DispatchResult::Message(message))
    }
}

pub(super) async fn retry(
    store: &Store,
    writable: bool,
    input: &Value,
) -> Result<DispatchResult, StoreError> {
    let command_id = required_string(input, "commandId")?;
    let idempotency_key = required_string(input, "idempotencyKey")?;
    let Some(command) = store.get_task_command(&command_id).await? else {
        return Ok(command_error(
            "task.command.retry",
            &idempotency_key,
            "task_command_not_found",
            "这条任务指令已不存在。",
        ));
    };
    if !writable {
        return Ok(read_only(input, &idempotency_key));
    }
    if command.state != "failed" {
        return Ok(DispatchResult::Message(updated(command)));
    }
    if let Some(error) = retry_invalid(store, &command).await? {
        let command = store
            .set_failed_task_command_error(&command.id, now(), error)
            .await?
            .ok_or(StoreError::InvalidMutation)?;
        return Ok(DispatchResult::Message(updated(command)));
    }
    Ok(match store.retry_task_command(&command_id, now()).await? {
        RetryTaskCommandResult::Queued(command) | RetryTaskCommandResult::NotRetryable(command) => {
            DispatchResult::Message(updated(command))
        }
        RetryTaskCommandResult::NotFound => command_error(
            "task.command.retry",
            &idempotency_key,
            "task_command_not_found",
            "这条任务指令已不存在。",
        ),
    })
}

#[allow(clippy::too_many_arguments)]
fn new_command(
    idempotency_key: String,
    kind: &str,
    provider: &str,
    session_id: Option<String>,
    workspace_id: Option<String>,
    cwd: String,
    text: String,
    material_ids: Vec<String>,
    error: Option<String>,
) -> TaskCommandRecord {
    let at = now();
    TaskCommandRecord {
        id: uuid::Uuid::now_v7().to_string(),
        idempotency_key,
        kind: kind.into(),
        provider: provider.into(),
        session_id,
        workspace_id,
        cwd,
        text,
        material_ids,
        state: if error.is_some() { "failed" } else { "queued" }.into(),
        created_at: at.clone(),
        updated_at: at,
        error,
    }
}

async fn retry_invalid(
    store: &Store,
    command: &TaskCommandRecord,
) -> Result<Option<String>, StoreError> {
    if command.kind == "create" {
        if command.session_id.is_some() {
            return Ok(Some(
                "任务已创建但执行中断；请打开已有任务确认结果，再通过追问继续。".into(),
            ));
        }
        let valid = match command.workspace_id.as_deref() {
            Some(workspace_id) => store.workspace_path(workspace_id).await?.is_some(),
            None => false,
        };
        return Ok((!valid).then(|| "所选项目已不在 Mac 的可信 workspace 列表中。".into()));
    }
    let session = match command.session_id.as_deref() {
        Some(session_id) => store.get_session(session_id).await?,
        None => None,
    };
    Ok(follow_up_invalid(session.as_ref()))
}

fn follow_up_invalid(session: Option<&StoredSession>) -> Option<String> {
    let Some(session) = session else {
        return Some("找不到要继续的任务。".into());
    };
    if session.correlation_uncertain || session.provider_session_id.starts_with("pending:") {
        return Some("任务关联仍不确定，无法安全发送指令。".into());
    }
    if session.cwd.is_none() {
        return Some("任务缺少工作目录，无法安全恢复。".into());
    }
    None
}

fn task_text(input: &Value) -> Result<String, StoreError> {
    let text = required_string(input, "text")?;
    if text.is_empty() || text.chars().count() > 20_000 {
        return Err(StoreError::InvalidMutation);
    }
    Ok(text.trim().to_owned())
}

fn material_ids(input: &Value) -> Result<Vec<String>, StoreError> {
    let Some(values) = input.get("materialIds") else {
        return Ok(Vec::new());
    };
    let Some(values) = values.as_array() else {
        return Err(StoreError::InvalidMutation);
    };
    if values.len() > 10 {
        return Err(StoreError::InvalidMutation);
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or(StoreError::InvalidMutation)
        })
        .collect()
}

fn required_string(input: &Value, field: &str) -> Result<String, StoreError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(StoreError::InvalidMutation)
}

fn updated(command: TaskCommandRecord) -> Value {
    json!({ "type": "task.command.updated", "command": command })
}

fn read_only(input: &Value, idempotency_key: &str) -> DispatchResult {
    command_error(
        input["type"].as_str().unwrap_or("unknown"),
        idempotency_key,
        "runtime_read_only",
        "Rust Runtime 当前以只读模式运行。",
    )
}

fn command_error(
    command_type: &str,
    idempotency_key: &str,
    code: &str,
    message: &str,
) -> DispatchResult {
    DispatchResult::Message(json!({
        "type": "error",
        "code": code,
        "message": message,
        "commandType": command_type,
        "idempotencyKey": idempotency_key,
    }))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
