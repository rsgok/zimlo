use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension as _, params};
use tokio::sync::oneshot;

use crate::{StoreError, StoredSession, session_from_row, sqlite_error, upsert_session};

#[derive(Debug, Clone, PartialEq)]
pub struct ClearedProcesses {
    pub changed: Vec<StoredSession>,
    pub removed: Vec<String>,
}

pub(crate) enum DiscoveryCommand {
    GetOffset {
        path: String,
        reply: oneshot::Sender<Result<Option<i64>, StoreError>>,
    },
    SetOffset {
        path: String,
        offset: i64,
        size: i64,
        modified_at: String,
        reply: oneshot::Sender<Result<(), StoreError>>,
    },
    GetSessionByProviderId {
        provider: String,
        provider_session_id: String,
        reply: oneshot::Sender<Result<Option<StoredSession>, StoreError>>,
    },
    ClearInactiveProcesses {
        active_pids: HashSet<i64>,
        reply: oneshot::Sender<Result<ClearedProcesses, StoreError>>,
    },
    Prune {
        retention_days: i64,
        reply: oneshot::Sender<Result<(), StoreError>>,
    },
}

pub(crate) fn execute(connection: &mut Connection, command: DiscoveryCommand) -> bool {
    match command {
        DiscoveryCommand::GetOffset { path, reply } => {
            let _ = reply.send(get_offset(connection, &path));
            false
        }
        DiscoveryCommand::SetOffset {
            path,
            offset,
            size,
            modified_at,
            reply,
        } => {
            let result = set_offset(connection, &path, offset, size, &modified_at);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        DiscoveryCommand::GetSessionByProviderId {
            provider,
            provider_session_id,
            reply,
        } => {
            let _ = reply.send(get_session_by_provider_id(
                connection,
                &provider,
                &provider_session_id,
            ));
            false
        }
        DiscoveryCommand::ClearInactiveProcesses { active_pids, reply } => {
            let result = clear_inactive_processes(connection, &active_pids);
            let changed = result
                .as_ref()
                .is_ok_and(|result| !result.changed.is_empty() || !result.removed.is_empty());
            let _ = reply.send(result);
            changed
        }
        DiscoveryCommand::Prune {
            retention_days,
            reply,
        } => {
            let result = prune(connection, retention_days);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
    }
}

fn get_offset(connection: &Connection, path: &str) -> Result<Option<i64>, StoreError> {
    connection
        .query_row(
            "SELECT offset FROM file_offsets WHERE path = ?1",
            [path],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)
}

fn set_offset(
    connection: &Connection,
    path: &str,
    offset: i64,
    size: i64,
    modified_at: &str,
) -> Result<(), StoreError> {
    connection
        .execute(
            "INSERT INTO file_offsets(path, offset, size, modified_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size,
             modified_at = excluded.modified_at",
            params![path, offset, size, modified_at],
        )
        .map(|_| ())
        .map_err(sqlite_error)
}

fn get_session_by_provider_id(
    connection: &Connection,
    provider: &str,
    provider_session_id: &str,
) -> Result<Option<StoredSession>, StoreError> {
    connection
        .query_row(
            "SELECT * FROM sessions WHERE provider = ?1 AND provider_session_id = ?2",
            params![provider, provider_session_id],
            session_from_row,
        )
        .optional()
        .map_err(sqlite_error)
}

fn clear_inactive_processes(
    connection: &mut Connection,
    active_pids: &HashSet<i64>,
) -> Result<ClearedProcesses, StoreError> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let sessions = {
        let mut statement = transaction
            .prepare("SELECT * FROM sessions WHERE active_pid IS NOT NULL")
            .map_err(sqlite_error)?;
        statement
            .query_map([], session_from_row)
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?
    };
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    for mut session in sessions {
        let Some(pid) = session.active_pid else {
            continue;
        };
        if active_pids.contains(&pid) {
            continue;
        }
        if session.provider_session_id.starts_with("process:") {
            transaction
                .execute("DELETE FROM sessions WHERE id = ?1", [&session.id])
                .map_err(sqlite_error)?;
            removed.push(session.id);
            continue;
        }
        session.active_pid = None;
        session.process_started_at = None;
        session.tty = None;
        session.status = "idle".into();
        if let Some(capabilities) = session.capabilities.as_object_mut() {
            capabilities.insert("liveObserved".into(), false.into());
            let can_resume = session.cwd.is_some();
            capabilities.insert("replyable".into(), can_resume.into());
            capabilities.insert("resumable".into(), can_resume.into());
        }
        changed.push(upsert_session(&transaction, &session)?);
    }
    transaction.commit().map_err(sqlite_error)?;
    Ok(ClearedProcesses { changed, removed })
}

fn prune(connection: &mut Connection, retention_days: i64) -> Result<(), StoreError> {
    let retention_days = retention_days.max(1);
    let event_cutoff = (chrono::Utc::now() - chrono::Duration::days(retention_days))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let audit_cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let transaction = connection.transaction().map_err(sqlite_error)?;
    transaction
        .execute(
            "DELETE FROM events WHERE occurred_at < ?1 AND kind != 'user_instruction'",
            [&event_cutoff],
        )
        .map_err(sqlite_error)?;
    for (table, column) in [
        ("cards", "updated_at"),
        ("feed_posts", "created_at"),
        ("feed_checkpoints", "started_at"),
        ("actions", "created_at"),
        ("idempotency", "created_at"),
    ] {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE {column} < ?1"),
                [&event_cutoff],
            )
            .map_err(sqlite_error)?;
    }
    transaction
        .execute(
            "DELETE FROM trust_audit WHERE created_at < ?1",
            [&audit_cutoff],
        )
        .map_err(sqlite_error)?;
    transaction.commit().map_err(sqlite_error)
}
