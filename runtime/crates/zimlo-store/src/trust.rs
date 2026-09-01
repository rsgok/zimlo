use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::{Command, Store, StoreError, receive, sqlite_error};

const EPOCH: &str = "1970-01-01T00:00:00.000Z";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalContextRecord {
    pub category: String,
    pub project_id: Option<String>,
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub segments: Vec<String>,
    pub within_project: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustPolicyRecord {
    pub project_id: String,
    pub preset: String,
    pub auto_allow: Vec<String>,
    pub updated_at: String,
    pub updated_by_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustAuditRecord {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub device_id: String,
    pub category: String,
    pub decision: String,
    pub reason: String,
    pub action_summary: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateTrustPolicyResult {
    Updated(TrustPolicyRecord),
    ProjectNotFound,
}

pub(super) enum TrustCommand {
    GetPolicy {
        project_id: String,
        reply: oneshot::Sender<Result<TrustPolicyRecord, StoreError>>,
    },
    UpdatePolicy {
        project_id: String,
        preset: String,
        device_id: String,
        scoped_idempotency_key: String,
        updated_at: String,
        reply: oneshot::Sender<Result<UpdateTrustPolicyResult, StoreError>>,
    },
    ProjectRoot {
        project_id: String,
        reply: oneshot::Sender<Result<Option<String>, StoreError>>,
    },
    InsertAudit {
        audit: Box<TrustAuditRecord>,
        reply: oneshot::Sender<Result<TrustAuditRecord, StoreError>>,
    },
    ListAudit {
        project_id: Option<String>,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<TrustAuditRecord>, StoreError>>,
    },
}

impl Store {
    pub async fn get_trust_policy(
        &self,
        project_id: impl Into<String>,
    ) -> Result<TrustPolicyRecord, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Trust(TrustCommand::GetPolicy {
            project_id: project_id.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn update_trust_policy(
        &self,
        project_id: impl Into<String>,
        preset: impl Into<String>,
        device_id: impl Into<String>,
        scoped_idempotency_key: impl Into<String>,
        updated_at: impl Into<String>,
    ) -> Result<UpdateTrustPolicyResult, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Trust(TrustCommand::UpdatePolicy {
            project_id: project_id.into(),
            preset: preset.into(),
            device_id: device_id.into(),
            scoped_idempotency_key: scoped_idempotency_key.into(),
            updated_at: updated_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn project_primary_path(
        &self,
        project_id: impl Into<String>,
    ) -> Result<Option<String>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Trust(TrustCommand::ProjectRoot {
            project_id: project_id.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn insert_trust_audit(
        &self,
        audit: TrustAuditRecord,
    ) -> Result<TrustAuditRecord, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Trust(TrustCommand::InsertAudit {
            audit: Box::new(audit),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn list_trust_audit(
        &self,
        project_id: Option<String>,
        limit: usize,
    ) -> Result<Vec<TrustAuditRecord>, StoreError> {
        if limit == 0 || limit > 1_000 {
            return Err(StoreError::InvalidMutation);
        }
        let (reply, response) = oneshot::channel();
        self.send(Command::Trust(TrustCommand::ListAudit {
            project_id,
            limit,
            reply,
        }))?;
        receive(response).await
    }
}

pub(super) fn execute(connection: &mut Connection, command: TrustCommand) -> bool {
    match command {
        TrustCommand::GetPolicy { project_id, reply } => {
            let _ = reply.send(get_policy(connection, &project_id));
            false
        }
        TrustCommand::UpdatePolicy {
            project_id,
            preset,
            device_id,
            scoped_idempotency_key,
            updated_at,
            reply,
        } => changed(
            reply,
            update_policy(
                connection,
                &project_id,
                &preset,
                &device_id,
                &scoped_idempotency_key,
                &updated_at,
            ),
        ),
        TrustCommand::ProjectRoot { project_id, reply } => {
            let _ = reply.send(project_root(connection, &project_id));
            false
        }
        TrustCommand::InsertAudit { audit, reply } => {
            changed(reply, insert_audit(connection, &audit))
        }
        TrustCommand::ListAudit {
            project_id,
            limit,
            reply,
        } => {
            let _ = reply.send(list_audit(connection, project_id.as_deref(), limit));
            false
        }
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

fn get_policy(connection: &Connection, project_id: &str) -> Result<TrustPolicyRecord, StoreError> {
    connection
        .query_row(
            "SELECT project_id, preset, auto_allow_json, updated_at, updated_by_device_id FROM project_trust_policies WHERE project_id = ?1",
            [project_id],
            policy_from_row,
        )
        .optional()
        .map_err(sqlite_error)
        .map(|policy| policy.unwrap_or_else(|| default_policy(project_id)))
}

fn update_policy(
    connection: &mut Connection,
    project_id: &str,
    preset: &str,
    device_id: &str,
    scoped_idempotency_key: &str,
    updated_at: &str,
) -> Result<UpdateTrustPolicyResult, StoreError> {
    if !matches!(preset, "ask" | "safe_automation") {
        return Err(StoreError::InvalidMutation);
    }
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)?
        == 1;
    if !exists {
        transaction.rollback().map_err(sqlite_error)?;
        return Ok(UpdateTrustPolicyResult::ProjectNotFound);
    }
    let replay = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM idempotency WHERE key = ?1)",
            [scoped_idempotency_key],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)?
        == 1;
    if !replay {
        let auto_allow = if preset == "safe_automation" {
            r#"["read","search","test","build"]"#
        } else {
            "[]"
        };
        transaction.execute(
            "INSERT INTO project_trust_policies(project_id, preset, auto_allow_json, updated_at, updated_by_device_id) \
             VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(project_id) DO UPDATE SET preset = excluded.preset, \
             auto_allow_json = excluded.auto_allow_json, updated_at = excluded.updated_at, updated_by_device_id = excluded.updated_by_device_id",
            params![project_id, preset, auto_allow, updated_at, device_id],
        ).map_err(sqlite_error)?;
        transaction.execute(
            "INSERT INTO idempotency(key, action_id, result_json, created_at) VALUES (?1, ?2, '{\"ok\":true}', ?3)",
            params![scoped_idempotency_key, project_id, updated_at],
        ).map_err(sqlite_error)?;
    }
    transaction.commit().map_err(sqlite_error)?;
    Ok(UpdateTrustPolicyResult::Updated(get_policy(
        connection, project_id,
    )?))
}

fn project_root(connection: &Connection, project_id: &str) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT path FROM project_locations WHERE project_id = ?1 ORDER BY last_seen_at DESC LIMIT 1",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)
}

fn insert_audit(
    connection: &Connection,
    audit: &TrustAuditRecord,
) -> Result<TrustAuditRecord, StoreError> {
    connection.execute(
        "INSERT OR IGNORE INTO trust_audit(id, project_id, session_id, device_id, category, decision, reason, action_summary, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![audit.id, audit.project_id, audit.session_id, audit.device_id, audit.category,
            audit.decision, audit.reason, audit.action_summary, audit.created_at],
    ).map_err(sqlite_error)?;
    Ok(audit.clone())
}

fn list_audit(
    connection: &Connection,
    project_id: Option<&str>,
    limit: usize,
) -> Result<Vec<TrustAuditRecord>, StoreError> {
    let (query, parameter): (&str, Box<dyn rusqlite::ToSql>) = match project_id {
        Some(project_id) => (
            "SELECT * FROM trust_audit WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            Box::new(project_id.to_owned()),
        ),
        None => (
            "SELECT * FROM trust_audit WHERE ?1 IS NULL ORDER BY created_at DESC LIMIT ?2",
            Box::new(rusqlite::types::Null),
        ),
    };
    let mut statement = connection.prepare(query).map_err(sqlite_error)?;
    statement
        .query_map(params![parameter, limit as i64], audit_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

fn policy_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrustPolicyRecord> {
    let auto_allow: String = row.get(2)?;
    Ok(TrustPolicyRecord {
        project_id: row.get(0)?,
        preset: row.get(1)?,
        auto_allow: serde_json::from_str(&auto_allow).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        updated_at: row.get(3)?,
        updated_by_device_id: row.get(4)?,
    })
}

fn audit_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrustAuditRecord> {
    Ok(TrustAuditRecord {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        session_id: row.get("session_id")?,
        device_id: row.get("device_id")?,
        category: row.get("category")?,
        decision: row.get("decision")?,
        reason: row.get("reason")?,
        action_summary: row.get("action_summary")?,
        created_at: row.get("created_at")?,
    })
}

fn default_policy(project_id: &str) -> TrustPolicyRecord {
    TrustPolicyRecord {
        project_id: project_id.into(),
        preset: "ask".into(),
        auto_allow: Vec::new(),
        updated_at: EPOCH.into(),
        updated_by_device_id: String::new(),
    }
}
