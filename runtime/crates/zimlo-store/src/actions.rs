use rusqlite::{Connection, OptionalExtension as _, Transaction, params, types::Type};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use super::{Command, Store, StoreError, receive, sqlite_error};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRecord {
    pub id: String,
    pub label: String,
    pub scope: String,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmation_phrase: Option<String>,
    pub risk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingActionRecord {
    pub action_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_request_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub available_decisions: Vec<DecisionRecord>,
    pub expires_at: String,
    pub state: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_context: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActionResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredActionResult {
    pub action_id: String,
    pub result: ActionResult,
}

pub(super) enum ActionCommand {
    Upsert {
        action: Box<PendingActionRecord>,
        reply: oneshot::Sender<Result<PendingActionRecord, StoreError>>,
    },
    Get {
        action_id: String,
        reply: oneshot::Sender<Result<Option<PendingActionRecord>, StoreError>>,
    },
    ListPending {
        at: String,
        reply: oneshot::Sender<Result<Vec<PendingActionRecord>, StoreError>>,
    },
    IdempotentResult {
        key: String,
        reply: oneshot::Sender<Result<Option<StoredActionResult>, StoreError>>,
    },
    Resolve {
        action_id: String,
        resolved_at: String,
        key: String,
        result: ActionResult,
        reply: oneshot::Sender<Result<Option<PendingActionRecord>, StoreError>>,
    },
    SaveResult {
        key: String,
        action_id: String,
        result: ActionResult,
        created_at: String,
        reply: oneshot::Sender<Result<ActionResult, StoreError>>,
    },
    Expire {
        action_id: String,
        resolved_at: String,
        reply: oneshot::Sender<Result<Option<PendingActionRecord>, StoreError>>,
    },
}

impl Store {
    pub async fn upsert_action(
        &self,
        action: PendingActionRecord,
    ) -> Result<PendingActionRecord, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Action(ActionCommand::Upsert {
            action: Box::new(action),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn get_action(
        &self,
        action_id: impl Into<String>,
    ) -> Result<Option<PendingActionRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Action(ActionCommand::Get {
            action_id: action_id.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn list_pending_actions(
        &self,
        at: impl Into<String>,
    ) -> Result<Vec<PendingActionRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Action(ActionCommand::ListPending {
            at: at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn get_action_result(
        &self,
        key: impl Into<String>,
    ) -> Result<Option<StoredActionResult>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Action(ActionCommand::IdempotentResult {
            key: key.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn resolve_action(
        &self,
        action_id: impl Into<String>,
        resolved_at: impl Into<String>,
        key: impl Into<String>,
        result: ActionResult,
    ) -> Result<Option<PendingActionRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Action(ActionCommand::Resolve {
            action_id: action_id.into(),
            resolved_at: resolved_at.into(),
            key: key.into(),
            result,
            reply,
        }))?;
        receive(response).await
    }

    pub async fn save_action_result(
        &self,
        key: impl Into<String>,
        action_id: impl Into<String>,
        result: ActionResult,
        created_at: impl Into<String>,
    ) -> Result<ActionResult, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Action(ActionCommand::SaveResult {
            key: key.into(),
            action_id: action_id.into(),
            result,
            created_at: created_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn expire_action(
        &self,
        action_id: impl Into<String>,
        resolved_at: impl Into<String>,
    ) -> Result<Option<PendingActionRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Action(ActionCommand::Expire {
            action_id: action_id.into(),
            resolved_at: resolved_at.into(),
            reply,
        }))?;
        receive(response).await
    }
}

pub(super) fn execute(connection: &mut Connection, command: ActionCommand) -> bool {
    match command {
        ActionCommand::Upsert { action, reply } => changed(reply, upsert(connection, &action)),
        ActionCommand::Get { action_id, reply } => {
            let _ = reply.send(get(connection, &action_id));
            false
        }
        ActionCommand::ListPending { at, reply } => {
            let _ = reply.send(list_pending(connection, &at));
            false
        }
        ActionCommand::IdempotentResult { key, reply } => {
            let _ = reply.send(idempotent_result(connection, &key));
            false
        }
        ActionCommand::Resolve {
            action_id,
            resolved_at,
            key,
            result,
            reply,
        } => changed(
            reply,
            resolve(connection, &action_id, &resolved_at, &key, &result),
        ),
        ActionCommand::SaveResult {
            key,
            action_id,
            result,
            created_at,
            reply,
        } => changed(
            reply,
            save_result(connection, &key, &action_id, &result, &created_at),
        ),
        ActionCommand::Expire {
            action_id,
            resolved_at,
            reply,
        } => changed(reply, expire(connection, &action_id, &resolved_at)),
    }
}

fn changed<T>(
    reply: oneshot::Sender<Result<T, StoreError>>,
    result: Result<T, StoreError>,
) -> bool {
    let changed = result.is_ok();
    let _ = reply.send(result);
    changed
}

fn upsert(
    connection: &Connection,
    action: &PendingActionRecord,
) -> Result<PendingActionRecord, StoreError> {
    connection.execute(
        "INSERT INTO actions (action_id, session_id, upstream_request_id, kind, title, detail, decisions_json, expires_at, state, created_at, resolved_at, approval_context_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(action_id) DO UPDATE SET decisions_json = excluded.decisions_json, expires_at = excluded.expires_at, \
           state = excluded.state, resolved_at = excluded.resolved_at, approval_context_json = excluded.approval_context_json",
        params![
            action.action_id,
            action.session_id,
            action.upstream_request_id,
            action.kind,
            action.title,
            action.detail,
            serde_json::to_string(&action.available_decisions).map_err(json_error)?,
            action.expires_at,
            action.state,
            action.created_at,
            action.resolved_at,
            action.approval_context.as_ref().map(Value::to_string),
        ],
    ).map_err(sqlite_error)?;
    get(connection, &action.action_id)?.ok_or(StoreError::InvalidMutation)
}

fn get(
    connection: &Connection,
    action_id: &str,
) -> Result<Option<PendingActionRecord>, StoreError> {
    connection
        .query_row(
            "SELECT * FROM actions WHERE action_id = ?1",
            [action_id],
            action_from_row,
        )
        .optional()
        .map_err(sqlite_error)
}

fn list_pending(connection: &Connection, at: &str) -> Result<Vec<PendingActionRecord>, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT * FROM actions WHERE state IN ('pending', 'submitted') AND expires_at > ?1 ORDER BY created_at DESC",
        )
        .map_err(sqlite_error)?;
    statement
        .query_map([at], action_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

fn idempotent_result(
    connection: &Connection,
    key: &str,
) -> Result<Option<StoredActionResult>, StoreError> {
    connection
        .query_row(
            "SELECT action_id, result_json FROM idempotency WHERE key = ?1",
            [key],
            |row| {
                let encoded: String = row.get(1)?;
                Ok(StoredActionResult {
                    action_id: row.get(0)?,
                    result: serde_json::from_str(&encoded).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
                    })?,
                })
            },
        )
        .optional()
        .map_err(sqlite_error)
}

fn resolve(
    connection: &mut Connection,
    action_id: &str,
    resolved_at: &str,
    key: &str,
    result: &ActionResult,
) -> Result<Option<PendingActionRecord>, StoreError> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let changed = transaction.execute(
        "UPDATE actions SET state = 'resolved', resolved_at = ?2 WHERE action_id = ?1 AND state = 'pending'",
        params![action_id, resolved_at],
    ).map_err(sqlite_error)?;
    if changed == 0 {
        transaction.rollback().map_err(sqlite_error)?;
        return Ok(None);
    }
    insert_result(&transaction, key, action_id, result, resolved_at)?;
    transaction.commit().map_err(sqlite_error)?;
    get(connection, action_id)
}

fn save_result(
    connection: &mut Connection,
    key: &str,
    action_id: &str,
    result: &ActionResult,
    created_at: &str,
) -> Result<ActionResult, StoreError> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    insert_result(&transaction, key, action_id, result, created_at)?;
    transaction.commit().map_err(sqlite_error)?;
    Ok(idempotent_result(connection, key)?
        .map(|stored| stored.result)
        .unwrap_or_else(|| result.clone()))
}

fn insert_result(
    transaction: &Transaction<'_>,
    key: &str,
    action_id: &str,
    result: &ActionResult,
    created_at: &str,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT OR IGNORE INTO idempotency(key, action_id, result_json, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![
            key,
            action_id,
            serde_json::to_string(result).map_err(json_error)?,
            created_at,
        ],
    ).map(|_| ()).map_err(sqlite_error)
}

fn expire(
    connection: &Connection,
    action_id: &str,
    resolved_at: &str,
) -> Result<Option<PendingActionRecord>, StoreError> {
    connection.execute(
        "UPDATE actions SET state = 'expired', resolved_at = ?2 WHERE action_id = ?1 AND state IN ('pending', 'submitted')",
        params![action_id, resolved_at],
    ).map_err(sqlite_error)?;
    get(connection, action_id)
}

fn action_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingActionRecord> {
    let decisions: String = row.get("decisions_json")?;
    let approval: Option<String> = row.get("approval_context_json")?;
    Ok(PendingActionRecord {
        action_id: row.get("action_id")?,
        host_id: None,
        session_id: row.get("session_id")?,
        upstream_request_id: row.get("upstream_request_id")?,
        kind: row.get("kind")?,
        title: row.get("title")?,
        detail: row.get("detail")?,
        available_decisions: serde_json::from_str(&decisions).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(6, Type::Text, Box::new(error))
        })?,
        expires_at: row.get("expires_at")?,
        state: row.get("state")?,
        created_at: row.get("created_at")?,
        resolved_at: row.get("resolved_at")?,
        approval_context: approval
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(11, Type::Text, Box::new(error))
            })?,
    })
}

fn json_error(error: serde_json::Error) -> StoreError {
    StoreError::Sqlite(format!("unable to encode action JSON: {error}"))
}
