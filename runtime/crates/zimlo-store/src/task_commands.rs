use rusqlite::{Connection, OptionalExtension as _, params, types::Type};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::{Command, Store, StoreError, receive, sqlite_error};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommandRecord {
    pub id: String,
    pub idempotency_key: String,
    pub kind: String,
    pub provider: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub cwd: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_ids: Vec<String>,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsertTaskCommandResult {
    pub command: TaskCommandRecord,
    pub inserted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelTaskCommandResult {
    Canceled(TaskCommandRecord),
    NotFound,
    NotCancelable(TaskCommandRecord),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryTaskCommandResult {
    Queued(TaskCommandRecord),
    NotFound,
    NotRetryable(TaskCommandRecord),
}

pub(super) enum TaskCommand {
    Insert {
        command: Box<TaskCommandRecord>,
        reply: oneshot::Sender<Result<InsertTaskCommandResult, StoreError>>,
    },
    Get {
        command_id: String,
        reply: oneshot::Sender<Result<Option<TaskCommandRecord>, StoreError>>,
    },
    ListQueued {
        reply: oneshot::Sender<Result<Vec<TaskCommandRecord>, StoreError>>,
    },
    Claim {
        command_id: String,
        updated_at: String,
        reply: oneshot::Sender<Result<Option<TaskCommandRecord>, StoreError>>,
    },
    MarkRunning {
        command_id: String,
        updated_at: String,
        reply: oneshot::Sender<Result<Option<TaskCommandRecord>, StoreError>>,
    },
    AttachSession {
        command_id: String,
        session_id: String,
        updated_at: String,
        reply: oneshot::Sender<Result<Option<TaskCommandRecord>, StoreError>>,
    },
    SetFailedError {
        command_id: String,
        updated_at: String,
        error: String,
        reply: oneshot::Sender<Result<Option<TaskCommandRecord>, StoreError>>,
    },
    Finish {
        command_id: String,
        state: String,
        session_id: Option<String>,
        updated_at: String,
        error: Option<String>,
        reply: oneshot::Sender<Result<Option<TaskCommandRecord>, StoreError>>,
    },
    Cancel {
        command_id: Option<String>,
        scoped_idempotency_key: Option<String>,
        updated_at: String,
        reply: oneshot::Sender<Result<CancelTaskCommandResult, StoreError>>,
    },
    Retry {
        command_id: String,
        updated_at: String,
        reply: oneshot::Sender<Result<RetryTaskCommandResult, StoreError>>,
    },
}

impl Store {
    pub async fn insert_task_command(
        &self,
        command: TaskCommandRecord,
    ) -> Result<InsertTaskCommandResult, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::Insert {
            command: Box::new(command),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn get_task_command(
        &self,
        command_id: impl Into<String>,
    ) -> Result<Option<TaskCommandRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::Get {
            command_id: command_id.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn list_queued_task_commands(&self) -> Result<Vec<TaskCommandRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::ListQueued { reply }))?;
        receive(response).await
    }

    pub async fn claim_task_command(
        &self,
        command_id: impl Into<String>,
        updated_at: impl Into<String>,
    ) -> Result<Option<TaskCommandRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::Claim {
            command_id: command_id.into(),
            updated_at: updated_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn mark_task_command_running(
        &self,
        command_id: impl Into<String>,
        updated_at: impl Into<String>,
    ) -> Result<Option<TaskCommandRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::MarkRunning {
            command_id: command_id.into(),
            updated_at: updated_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn finish_task_command(
        &self,
        command_id: impl Into<String>,
        state: impl Into<String>,
        session_id: Option<String>,
        updated_at: impl Into<String>,
        error: Option<String>,
    ) -> Result<Option<TaskCommandRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::Finish {
            command_id: command_id.into(),
            state: state.into(),
            session_id,
            updated_at: updated_at.into(),
            error,
            reply,
        }))?;
        receive(response).await
    }

    pub async fn attach_task_command_session(
        &self,
        command_id: impl Into<String>,
        session_id: impl Into<String>,
        updated_at: impl Into<String>,
    ) -> Result<Option<TaskCommandRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::AttachSession {
            command_id: command_id.into(),
            session_id: session_id.into(),
            updated_at: updated_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn set_failed_task_command_error(
        &self,
        command_id: impl Into<String>,
        updated_at: impl Into<String>,
        error: impl Into<String>,
    ) -> Result<Option<TaskCommandRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::SetFailedError {
            command_id: command_id.into(),
            updated_at: updated_at.into(),
            error: error.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn cancel_task_command(
        &self,
        command_id: Option<String>,
        scoped_idempotency_key: Option<String>,
        updated_at: impl Into<String>,
    ) -> Result<CancelTaskCommandResult, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::Cancel {
            command_id,
            scoped_idempotency_key,
            updated_at: updated_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn retry_task_command(
        &self,
        command_id: impl Into<String>,
        updated_at: impl Into<String>,
    ) -> Result<RetryTaskCommandResult, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TaskCommand(TaskCommand::Retry {
            command_id: command_id.into(),
            updated_at: updated_at.into(),
            reply,
        }))?;
        receive(response).await
    }
}

pub(super) fn execute(connection: &mut Connection, command: TaskCommand) -> bool {
    match command {
        TaskCommand::Insert { command, reply } => {
            let result = insert(connection, &command);
            let changed = result.as_ref().is_ok_and(|result| result.inserted);
            let _ = reply.send(result);
            changed
        }
        TaskCommand::Get { command_id, reply } => {
            let _ = reply.send(get(connection, &command_id));
            false
        }
        TaskCommand::ListQueued { reply } => {
            let _ = reply.send(list_queued(connection));
            false
        }
        TaskCommand::Claim {
            command_id,
            updated_at,
            reply,
        } => transition(
            connection,
            &command_id,
            "queued",
            "dispatching",
            &updated_at,
            None,
            None,
            reply,
        ),
        TaskCommand::MarkRunning {
            command_id,
            updated_at,
            reply,
        } => transition(
            connection,
            &command_id,
            "dispatching",
            "running",
            &updated_at,
            None,
            None,
            reply,
        ),
        TaskCommand::AttachSession {
            command_id,
            session_id,
            updated_at,
            reply,
        } => transition(
            connection,
            &command_id,
            "running",
            "running",
            &updated_at,
            Some(session_id),
            None,
            reply,
        ),
        TaskCommand::SetFailedError {
            command_id,
            updated_at,
            error,
            reply,
        } => transition(
            connection,
            &command_id,
            "failed",
            "failed",
            &updated_at,
            None,
            Some(error),
            reply,
        ),
        TaskCommand::Finish {
            command_id,
            state,
            session_id,
            updated_at,
            error,
            reply,
        } => {
            let valid = matches!(state.as_str(), "completed" | "failed");
            if !valid {
                let _ = reply.send(Err(StoreError::InvalidMutation));
                return false;
            }
            transition(
                connection,
                &command_id,
                "running",
                &state,
                &updated_at,
                session_id,
                error,
                reply,
            )
        }
        TaskCommand::Cancel {
            command_id,
            scoped_idempotency_key,
            updated_at,
            reply,
        } => {
            let (result, changed) = cancel(
                connection,
                command_id.as_deref(),
                scoped_idempotency_key.as_deref(),
                &updated_at,
            );
            let _ = reply.send(result);
            changed
        }
        TaskCommand::Retry {
            command_id,
            updated_at,
            reply,
        } => {
            let (result, changed) = retry(connection, &command_id, &updated_at);
            let _ = reply.send(result);
            changed
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn transition(
    connection: &Connection,
    command_id: &str,
    expected: &str,
    next: &str,
    updated_at: &str,
    session_id: Option<String>,
    error: Option<String>,
    reply: oneshot::Sender<Result<Option<TaskCommandRecord>, StoreError>>,
) -> bool {
    let result = connection
        .execute(
            "UPDATE task_commands SET
               state = ?1, updated_at = ?2,
               session_id = COALESCE(?3, session_id), error = ?4
             WHERE id = ?5 AND state = ?6",
            params![next, updated_at, session_id, error, command_id, expected],
        )
        .map_err(sqlite_error)
        .and_then(|changes| {
            if changes == 0 {
                Ok(None)
            } else {
                get(connection, command_id)
            }
        });
    let changed = result.as_ref().is_ok_and(Option::is_some);
    let _ = reply.send(result);
    changed
}

fn insert(
    connection: &mut Connection,
    command: &TaskCommandRecord,
) -> Result<InsertTaskCommandResult, StoreError> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let changes = transaction
        .execute(
            "INSERT OR IGNORE INTO task_commands (
               id, idempotency_key, kind, provider, session_id, workspace_id, cwd,
               text, material_ids_json, state, created_at, updated_at, error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                command.id,
                command.idempotency_key,
                command.kind,
                command.provider,
                command.session_id,
                command.workspace_id,
                command.cwd,
                command.text,
                serde_json::to_string(&command.material_ids)
                    .map_err(|error| StoreError::Sqlite(error.to_string()))?,
                command.state,
                command.created_at,
                command.updated_at,
                command.error,
            ],
        )
        .map_err(sqlite_error)?;
    let stored = get_by_idempotency(&transaction, &command.idempotency_key)?.ok_or_else(|| {
        StoreError::Sqlite("task command write succeeded but row is unavailable".into())
    })?;
    transaction.commit().map_err(sqlite_error)?;
    Ok(InsertTaskCommandResult {
        command: stored,
        inserted: changes > 0,
    })
}

fn get(connection: &Connection, command_id: &str) -> Result<Option<TaskCommandRecord>, StoreError> {
    connection
        .query_row(
            "SELECT * FROM task_commands WHERE id = ?1",
            [command_id],
            task_command_from_row,
        )
        .optional()
        .map_err(sqlite_error)
}

fn get_by_idempotency(
    connection: &Connection,
    key: &str,
) -> Result<Option<TaskCommandRecord>, StoreError> {
    connection
        .query_row(
            "SELECT * FROM task_commands WHERE idempotency_key = ?1",
            [key],
            task_command_from_row,
        )
        .optional()
        .map_err(sqlite_error)
}

fn list_queued(connection: &Connection) -> Result<Vec<TaskCommandRecord>, StoreError> {
    let mut statement = connection
        .prepare("SELECT * FROM task_commands WHERE state = 'queued' ORDER BY created_at ASC")
        .map_err(sqlite_error)?;
    statement
        .query_map([], task_command_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

fn cancel(
    connection: &mut Connection,
    command_id: Option<&str>,
    scoped_idempotency_key: Option<&str>,
    updated_at: &str,
) -> (Result<CancelTaskCommandResult, StoreError>, bool) {
    if command_id.is_some() == scoped_idempotency_key.is_some() {
        return (Err(StoreError::InvalidMutation), false);
    }
    let result = (|| {
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let command = match command_id {
            Some(command_id) => get(&transaction, command_id)?,
            None => get_by_idempotency(&transaction, scoped_idempotency_key.unwrap_or_default())?,
        };
        let Some(command) = command else {
            transaction.commit().map_err(sqlite_error)?;
            return Ok((CancelTaskCommandResult::NotFound, false));
        };
        let (result, changed) = match command.state.as_str() {
            "canceled" => (CancelTaskCommandResult::Canceled(command), false),
            "queued" => {
                let changes = transaction
                    .execute(
                        "UPDATE task_commands SET state = 'canceled', updated_at = ?1, error = NULL
                         WHERE id = ?2 AND state = 'queued'",
                        params![updated_at, command.id],
                    )
                    .map_err(sqlite_error)?;
                let current = get(&transaction, &command.id)?.ok_or_else(|| {
                    StoreError::Sqlite("canceled command row is unavailable".into())
                })?;
                if changes == 0 {
                    (CancelTaskCommandResult::NotCancelable(current), false)
                } else {
                    (CancelTaskCommandResult::Canceled(current), true)
                }
            }
            _ => (CancelTaskCommandResult::NotCancelable(command), false),
        };
        transaction.commit().map_err(sqlite_error)?;
        Ok((result, changed))
    })();
    match result {
        Ok((result, changed)) => (Ok(result), changed),
        Err(error) => (Err(error), false),
    }
}

fn retry(
    connection: &Connection,
    command_id: &str,
    updated_at: &str,
) -> (Result<RetryTaskCommandResult, StoreError>, bool) {
    let result = (|| {
        let Some(command) = get(connection, command_id)? else {
            return Ok((RetryTaskCommandResult::NotFound, false));
        };
        if command.state != "failed" {
            return Ok((RetryTaskCommandResult::NotRetryable(command), false));
        }
        let changes = connection
            .execute(
                "UPDATE task_commands SET state = 'queued', updated_at = ?1, error = NULL
                 WHERE id = ?2 AND state = 'failed'",
                params![updated_at, command_id],
            )
            .map_err(sqlite_error)?;
        let command = get(connection, command_id)?
            .ok_or_else(|| StoreError::Sqlite("retried command row is unavailable".into()))?;
        if changes == 0 {
            Ok((RetryTaskCommandResult::NotRetryable(command), false))
        } else {
            Ok((RetryTaskCommandResult::Queued(command), true))
        }
    })();
    match result {
        Ok((result, changed)) => (Ok(result), changed),
        Err(error) => (Err(error), false),
    }
}

fn task_command_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskCommandRecord> {
    let material_ids: String = row.get("material_ids_json")?;
    let material_ids = serde_json::from_str(&material_ids).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(8, Type::Text, Box::new(error))
    })?;
    Ok(TaskCommandRecord {
        id: row.get("id")?,
        idempotency_key: row.get("idempotency_key")?,
        kind: row.get("kind")?,
        provider: row.get("provider")?,
        session_id: row.get("session_id")?,
        workspace_id: row.get("workspace_id")?,
        cwd: row.get("cwd")?,
        text: row.get("text")?,
        material_ids,
        state: row.get("state")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        error: row.get("error")?,
    })
}
