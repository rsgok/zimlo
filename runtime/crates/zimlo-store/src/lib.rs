use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension as _, params, types::Type};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::oneshot;

mod actions;
mod agent_tools;
mod devices;
mod discovery;
mod materials;
mod mutations;
mod push;
mod snapshot;
mod task_commands;
mod trust;

pub use actions::{ActionResult, DecisionRecord, PendingActionRecord, StoredActionResult};
pub use agent_tools::AgentToolInput;
pub use devices::{DeviceAuthRecord, DeviceRecord};
pub use discovery::ClearedProcesses;
pub use materials::MaterialRecord;
pub use mutations::{MutationResult, NotificationSettingsInput, SafeMutation};
pub use push::{ActivePushDevice, NotificationSettingsRecord, PushDeviceRecord};
pub use snapshot::{SnapshotFeatures, SnapshotOptions};
pub use task_commands::{
    CancelTaskCommandResult, InsertTaskCommandResult, RetryTaskCommandResult, TaskCommandRecord,
};
pub use trust::{
    ApprovalContextRecord, TrustAuditRecord, TrustPolicyRecord, UpdateTrustPolicyResult,
};

const BOOTSTRAP_SCHEMA: &str = include_str!("bootstrap.sql");
const MAX_EVENT_LIMIT: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreMode {
    ReadOnly,
    ReadWriteExisting,
    ReadWriteCreate,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum StoreError {
    #[error("SQLite operation failed: {0}")]
    Sqlite(String),
    #[error("store actor is no longer available")]
    ActorStopped,
    #[error("event limit must be between 1 and {MAX_EVENT_LIMIT}")]
    InvalidEventLimit,
    #[error("store actor thread panicked")]
    ActorPanicked,
    #[error("unable to prepare database path: {0}")]
    PreparePath(String),
    #[error("existing database has no host identity")]
    MissingHostIdentity,
    #[error("existing database has no active local administrator")]
    MissingLocalAdmin,
    #[error("device is missing or revoked")]
    MissingDevice,
    #[error("session is missing")]
    MissingSession,
    #[error("project is missing")]
    MissingProject,
    #[error("mutation payload is invalid")]
    InvalidMutation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id: String,
    pub project_id: Option<String>,
    pub provider: String,
    pub surface: String,
    pub provider_session_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub transcript_path: Option<String>,
    pub status: String,
    pub last_activity_at: String,
    pub created_at: String,
    pub active_pid: Option<i64>,
    pub process_started_at: Option<String>,
    pub tty: Option<String>,
    pub correlation_uncertain: bool,
    pub capabilities: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedEvent {
    pub id: String,
    pub sequence: i64,
    pub provider: String,
    pub session_id: String,
    pub provider_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub kind: String,
    pub source: String,
    pub occurred_at: String,
    pub payload: Value,
    pub provenance: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InsertEventResult {
    pub event: UnifiedEvent,
    pub inserted: bool,
}

#[derive(Clone)]
pub struct Store {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    commands: mpsc::Sender<Command>,
    actor: Mutex<Option<thread::JoinHandle<()>>>,
    revision: Arc<AtomicU64>,
    storage_root: Option<std::path::PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreVersion {
    pub sqlite: i64,
    pub local: u64,
}

enum Command {
    GetMetadata {
        key: String,
        reply: oneshot::Sender<Result<Option<String>, StoreError>>,
    },
    SetMetadata {
        key: String,
        value: String,
        reply: oneshot::Sender<Result<(), StoreError>>,
    },
    DeleteMetadata {
        key: String,
        reply: oneshot::Sender<Result<(), StoreError>>,
    },
    SessionExists {
        session_id: String,
        reply: oneshot::Sender<Result<bool, StoreError>>,
    },
    GetSession {
        session_id: String,
        reply: oneshot::Sender<Result<Option<StoredSession>, StoreError>>,
    },
    WorkspacePath {
        workspace_id: String,
        reply: oneshot::Sender<Result<Option<String>, StoreError>>,
    },
    ListSessions {
        reply: oneshot::Sender<Result<Vec<StoredSession>, StoreError>>,
    },
    UpsertSession {
        session: StoredSession,
        reply: oneshot::Sender<Result<StoredSession, StoreError>>,
    },
    ListEvents {
        session_id: String,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<UnifiedEvent>, StoreError>>,
    },
    InsertEvent {
        event: UnifiedEvent,
        reply: oneshot::Sender<Result<InsertEventResult, StoreError>>,
    },
    Snapshot {
        options: SnapshotOptions,
        reply: oneshot::Sender<Result<Value, StoreError>>,
    },
    Discovery(discovery::DiscoveryCommand),
    Action(actions::ActionCommand),
    AgentTool(agent_tools::AgentToolCommand),
    Device(devices::DeviceCommand),
    Material(materials::MaterialCommand),
    Mutation(mutations::MutationCommand),
    Push(push::PushCommand),
    TaskCommand(task_commands::TaskCommand),
    Trust(trust::TrustCommand),
    Shutdown,
}

impl Store {
    pub async fn open(path: impl AsRef<Path>, mode: StoreMode) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        let storage_root = (path != Path::new(":memory:")).then(|| {
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf()
        });
        prepare_path(&path, mode)?;
        let (commands, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let revision = Arc::new(AtomicU64::new(0));
        let actor_revision = Arc::clone(&revision);
        let actor = thread::Builder::new()
            .name("zimlo-sqlite-owner".into())
            .spawn(move || match open_connection(&path, mode) {
                Ok(connection) => {
                    let _ = ready_tx.send(Ok(()));
                    run_actor(connection, receiver, actor_revision);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .map_err(|error| StoreError::PreparePath(error.to_string()))?;

        match ready_rx.await {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(StoreInner {
                    commands,
                    actor: Mutex::new(Some(actor)),
                    revision,
                    storage_root,
                }),
            }),
            Ok(Err(error)) => {
                actor.join().map_err(|_| StoreError::ActorPanicked)?;
                Err(error)
            }
            Err(_) => {
                actor.join().map_err(|_| StoreError::ActorPanicked)?;
                Err(StoreError::ActorStopped)
            }
        }
    }

    pub async fn get_metadata(&self, key: impl Into<String>) -> Result<Option<String>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::GetMetadata {
            key: key.into(),
            reply,
        })?;
        receive(response).await
    }

    pub async fn set_metadata(
        &self,
        key: impl Into<String>,
        value: impl Into<String>,
    ) -> Result<(), StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::SetMetadata {
            key: key.into(),
            value: value.into(),
            reply,
        })?;
        receive(response).await
    }

    pub async fn delete_metadata(&self, key: impl Into<String>) -> Result<(), StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::DeleteMetadata {
            key: key.into(),
            reply,
        })?;
        receive(response).await
    }

    pub async fn session_exists(&self, session_id: impl Into<String>) -> Result<bool, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::SessionExists {
            session_id: session_id.into(),
            reply,
        })?;
        receive(response).await
    }

    pub async fn get_session(
        &self,
        session_id: impl Into<String>,
    ) -> Result<Option<StoredSession>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::GetSession {
            session_id: session_id.into(),
            reply,
        })?;
        receive(response).await
    }

    pub async fn workspace_path(
        &self,
        workspace_id: impl Into<String>,
    ) -> Result<Option<String>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::WorkspacePath {
            workspace_id: workspace_id.into(),
            reply,
        })?;
        receive(response).await
    }

    pub async fn list_sessions(&self) -> Result<Vec<StoredSession>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::ListSessions { reply })?;
        receive(response).await
    }

    pub async fn upsert_session(
        &self,
        session: StoredSession,
    ) -> Result<StoredSession, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::UpsertSession { session, reply })?;
        receive(response).await
    }

    pub async fn list_events(
        &self,
        session_id: impl Into<String>,
        limit: usize,
    ) -> Result<Vec<UnifiedEvent>, StoreError> {
        if !(1..=MAX_EVENT_LIMIT).contains(&limit) {
            return Err(StoreError::InvalidEventLimit);
        }
        let (reply, response) = oneshot::channel();
        self.send(Command::ListEvents {
            session_id: session_id.into(),
            limit,
            reply,
        })?;
        receive(response).await
    }

    pub async fn insert_event(&self, event: UnifiedEvent) -> Result<InsertEventResult, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::InsertEvent { event, reply })?;
        receive(response).await
    }

    pub async fn snapshot(&self, options: SnapshotOptions) -> Result<Value, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Snapshot { options, reply })?;
        receive(response).await
    }

    pub async fn get_offset(&self, path: impl Into<String>) -> Result<Option<i64>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Discovery(discovery::DiscoveryCommand::GetOffset {
            path: path.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn set_offset(
        &self,
        path: impl Into<String>,
        offset: i64,
        size: i64,
        modified_at: impl Into<String>,
    ) -> Result<(), StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Discovery(discovery::DiscoveryCommand::SetOffset {
            path: path.into(),
            offset,
            size,
            modified_at: modified_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn get_session_by_provider_id(
        &self,
        provider: impl Into<String>,
        provider_session_id: impl Into<String>,
    ) -> Result<Option<StoredSession>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Discovery(
            discovery::DiscoveryCommand::GetSessionByProviderId {
                provider: provider.into(),
                provider_session_id: provider_session_id.into(),
                reply,
            },
        ))?;
        receive(response).await
    }

    pub async fn clear_inactive_processes(
        &self,
        active_pids: std::collections::HashSet<i64>,
    ) -> Result<ClearedProcesses, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Discovery(
            discovery::DiscoveryCommand::ClearInactiveProcesses { active_pids, reply },
        ))?;
        receive(response).await
    }

    pub async fn prune(&self, retention_days: i64) -> Result<(), StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Discovery(discovery::DiscoveryCommand::Prune {
            retention_days,
            reply,
        }))?;
        receive(response).await
    }

    pub fn storage_root(&self) -> Option<std::path::PathBuf> {
        self.inner.storage_root.clone()
    }

    fn send(&self, command: Command) -> Result<(), StoreError> {
        self.inner
            .commands
            .send(command)
            .map_err(|_| StoreError::ActorStopped)
    }
}

impl Drop for StoreInner {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Ok(mut actor) = self.actor.lock()
            && let Some(actor) = actor.take()
        {
            let _ = actor.join();
        }
    }
}

async fn receive<T>(response: oneshot::Receiver<Result<T, StoreError>>) -> Result<T, StoreError> {
    response.await.map_err(|_| StoreError::ActorStopped)?
}

fn prepare_path(path: &Path, mode: StoreMode) -> Result<(), StoreError> {
    if mode != StoreMode::ReadWriteCreate || path == Path::new(":memory:") {
        return Ok(());
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| StoreError::PreparePath(error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| StoreError::PreparePath(error.to_string()))?;
        }
    }
    Ok(())
}

fn open_connection(path: &Path, mode: StoreMode) -> Result<Connection, StoreError> {
    let flags = match mode {
        StoreMode::ReadOnly => OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        StoreMode::ReadWriteExisting => {
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX
        }
        StoreMode::ReadWriteCreate => {
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
        }
    };
    let connection = Connection::open_with_flags(path, flags).map_err(sqlite_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sqlite_error)?;
    match mode {
        StoreMode::ReadOnly => connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA query_only=ON;")
            .map_err(sqlite_error)?,
        StoreMode::ReadWriteExisting | StoreMode::ReadWriteCreate => {
            connection
                .execute_batch(
                    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;",
                )
                .map_err(sqlite_error)?;
            if mode == StoreMode::ReadWriteExisting {
                connection
                    .execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN IMMEDIATE; COMMIT;")
                    .map_err(sqlite_error)?;
            }
            initialize_current_schema(&connection)?;
            recover_runtime_state(&connection)?;
            secure_database_file(path)?;
        }
    }
    Ok(connection)
}

fn initialize_current_schema(connection: &Connection) -> Result<(), StoreError> {
    connection
        .execute_batch(BOOTSTRAP_SCHEMA)
        .map_err(sqlite_error)?;
    for (table, column, definition) in [
        ("feed_posts", "content_json", "content_json TEXT"),
        (
            "feed_posts",
            "project_id",
            "project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
        ),
        (
            "task_commands",
            "material_ids_json",
            "material_ids_json TEXT NOT NULL DEFAULT '[]'",
        ),
        ("projects", "identity_key", "identity_key TEXT"),
        ("projects", "agent_display_name", "agent_display_name TEXT"),
        ("projects", "agent_avatar", "agent_avatar TEXT"),
        ("projects", "agent_bio", "agent_bio TEXT"),
        (
            "projects",
            "agent_default_provider",
            "agent_default_provider TEXT",
        ),
        ("projects", "agent_updated_at", "agent_updated_at TEXT"),
        (
            "sessions",
            "project_id",
            "project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
        ),
        (
            "sessions",
            "surface",
            "surface TEXT NOT NULL DEFAULT 'unknown'",
        ),
        (
            "devices",
            "can_approve",
            "can_approve INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "devices",
            "can_manage_trust",
            "can_manage_trust INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "actions",
            "approval_context_json",
            "approval_context_json TEXT",
        ),
        (
            "notification_settings",
            "results",
            "results INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "notification_settings",
            "critical_only",
            "critical_only INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "notification_settings",
            "quiet_hours_enabled",
            "quiet_hours_enabled INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "notification_settings",
            "timezone_offset_minutes",
            "timezone_offset_minutes INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "push_devices",
            "environment",
            "environment TEXT NOT NULL DEFAULT 'production'",
        ),
    ] {
        ensure_column(connection, table, column, definition)?;
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS projects_identity_idx ON projects(identity_key);",
        )
        .map_err(sqlite_error)
}

fn recover_runtime_state(connection: &Connection) -> Result<(), StoreError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    connection
        .execute(
            "UPDATE task_commands SET state = 'queued', updated_at = ?1, error = NULL
             WHERE state = 'dispatching'",
            [&now],
        )
        .map_err(sqlite_error)?;
    connection
        .execute(
            "UPDATE task_commands SET state = 'failed', updated_at = ?1,
             error = 'Runtime 中断了正在执行的指令；结果状态不确定，请确认后再重试。'
             WHERE state = 'running'",
            [&now],
        )
        .map_err(sqlite_error)?;
    connection
        .execute(
            "UPDATE sessions SET status = 'failed', active_pid = NULL, process_started_at = NULL,
             tty = NULL, last_activity_at = ?1
             WHERE surface = 'managed' AND status IN ('running', 'waiting')",
            [&now],
        )
        .map_err(sqlite_error)?;
    connection
        .execute(
            "UPDATE actions SET state = 'expired' WHERE state IN ('pending', 'submitted')",
            [],
        )
        .map(|_| ())
        .map_err(sqlite_error)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), StoreError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(sqlite_error)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    if !names.iter().any(|name| name == column) {
        connection
            .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition}"))
            .map_err(sqlite_error)?;
    }
    Ok(())
}

fn secure_database_file(path: &Path) -> Result<(), StoreError> {
    if path == Path::new(":memory:") {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| StoreError::PreparePath(error.to_string()))?;
    }
    Ok(())
}

fn run_actor(
    mut connection: Connection,
    receiver: mpsc::Receiver<Command>,
    revision: Arc<AtomicU64>,
) {
    while let Ok(command) = receiver.recv() {
        match command {
            Command::GetMetadata { key, reply } => {
                let _ = reply.send(get_metadata(&connection, &key));
            }
            Command::SetMetadata { key, value, reply } => {
                let _ = reply.send(set_metadata(&connection, &key, &value));
            }
            Command::DeleteMetadata { key, reply } => {
                let result = delete_metadata(&connection, &key);
                if result.is_ok() {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(result);
            }
            Command::SessionExists { session_id, reply } => {
                let _ = reply.send(session_exists(&connection, &session_id));
            }
            Command::GetSession { session_id, reply } => {
                let _ = reply.send(get_session(&connection, &session_id));
            }
            Command::WorkspacePath {
                workspace_id,
                reply,
            } => {
                let _ = reply.send(workspace_path(&connection, &workspace_id));
            }
            Command::ListSessions { reply } => {
                let _ = reply.send(list_sessions(&connection));
            }
            Command::UpsertSession { session, reply } => {
                let result = upsert_session(&connection, &session);
                if result.is_ok() {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(result);
            }
            Command::ListEvents {
                session_id,
                limit,
                reply,
            } => {
                let _ = reply.send(list_events(&connection, &session_id, limit));
            }
            Command::InsertEvent { event, reply } => {
                let result = insert_event(&connection, &event);
                if result.as_ref().is_ok_and(|result| result.inserted) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(result);
            }
            Command::Snapshot { options, reply } => {
                let _ = reply.send(snapshot::build(&connection, &options));
            }
            Command::Discovery(command) => {
                if discovery::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Action(command) => {
                if actions::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::AgentTool(command) => {
                if agent_tools::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Device(command) => {
                if devices::execute(&connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Material(command) => {
                if materials::execute(&connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Mutation(command) => {
                if mutations::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Push(command) => {
                if push::execute(&connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::TaskCommand(command) => {
                if task_commands::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Trust(command) => {
                if trust::execute(&mut connection, command) {
                    revision.fetch_add(1, Ordering::Relaxed);
                }
            }
            Command::Shutdown => break,
        }
    }
}

fn get_metadata(connection: &Connection, key: &str) -> Result<Option<String>, StoreError> {
    connection
        .query_row("SELECT value FROM metadata WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(sqlite_error)
}

fn set_metadata(connection: &Connection, key: &str, value: &str) -> Result<(), StoreError> {
    connection
        .execute(
            "INSERT INTO metadata(key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map(|_| ())
        .map_err(sqlite_error)
}

fn delete_metadata(connection: &Connection, key: &str) -> Result<(), StoreError> {
    connection
        .execute("DELETE FROM metadata WHERE key = ?1", [key])
        .map(|_| ())
        .map_err(sqlite_error)
}

fn session_exists(connection: &Connection, session_id: &str) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists == 1)
        .map_err(sqlite_error)
}

fn get_session(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<StoredSession>, StoreError> {
    connection
        .query_row(
            "SELECT * FROM sessions WHERE id = ?1",
            [session_id],
            session_from_row,
        )
        .optional()
        .map_err(sqlite_error)
}

fn workspace_path(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT path FROM project_locations WHERE project_id = ?1 \
             ORDER BY last_seen_at DESC LIMIT 1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)
}

fn list_sessions(connection: &Connection) -> Result<Vec<StoredSession>, StoreError> {
    let mut statement = connection
        .prepare("SELECT * FROM sessions ORDER BY last_activity_at DESC")
        .map_err(sqlite_error)?;
    statement
        .query_map([], session_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredSession> {
    let capabilities: String = row.get("capabilities_json")?;
    Ok(StoredSession {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        provider: row.get("provider")?,
        surface: row.get("surface")?,
        provider_session_id: row.get("provider_session_id")?,
        title: row.get("title")?,
        cwd: row.get("cwd")?,
        transcript_path: row.get("transcript_path")?,
        status: row.get("status")?,
        last_activity_at: row.get("last_activity_at")?,
        created_at: row.get("created_at")?,
        active_pid: row.get("active_pid")?,
        process_started_at: row.get("process_started_at")?,
        tty: row.get("tty")?,
        correlation_uncertain: row.get::<_, i64>("correlation_uncertain")? == 1,
        capabilities: decode_json(capabilities, 15)?,
    })
}

fn upsert_session(
    connection: &Connection,
    session: &StoredSession,
) -> Result<StoredSession, StoreError> {
    connection
        .execute(
            "INSERT INTO sessions (\
               id, project_id, provider, surface, provider_session_id, title, cwd, transcript_path, \
               status, last_activity_at, created_at, active_pid, process_started_at, tty, \
               correlation_uncertain, capabilities_json\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) \
             ON CONFLICT(id) DO UPDATE SET \
               project_id = COALESCE(excluded.project_id, sessions.project_id), \
               surface = CASE WHEN excluded.surface = 'unknown' THEN sessions.surface ELSE excluded.surface END, \
               title = excluded.title, cwd = COALESCE(excluded.cwd, sessions.cwd), \
               transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path), \
               status = excluded.status, \
               last_activity_at = MAX(excluded.last_activity_at, sessions.last_activity_at), \
               active_pid = excluded.active_pid, process_started_at = excluded.process_started_at, \
               tty = excluded.tty, correlation_uncertain = excluded.correlation_uncertain, \
               capabilities_json = excluded.capabilities_json",
            params![
                session.id,
                session.project_id,
                session.provider,
                session.surface,
                session.provider_session_id,
                session.title,
                session.cwd,
                session.transcript_path,
                session.status,
                session.last_activity_at,
                session.created_at,
                session.active_pid,
                session.process_started_at,
                session.tty,
                i64::from(session.correlation_uncertain),
                session.capabilities.to_string(),
            ],
        )
        .map_err(sqlite_error)?;
    connection
        .query_row(
            "SELECT * FROM sessions WHERE id = ?1",
            [&session.id],
            session_from_row,
        )
        .map_err(sqlite_error)
}

fn list_events(
    connection: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<UnifiedEvent>, StoreError> {
    let mut statement = connection
        .prepare("SELECT * FROM events WHERE session_id = ?1 ORDER BY sequence DESC LIMIT ?2")
        .map_err(sqlite_error)?;
    let mut events = statement
        .query_map(params![session_id, limit as i64], event_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    events.reverse();
    Ok(events)
}

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UnifiedEvent> {
    let payload: String = row.get("payload_json")?;
    Ok(UnifiedEvent {
        id: row.get("id")?,
        sequence: row.get("sequence")?,
        provider: row.get("provider")?,
        session_id: row.get("session_id")?,
        provider_session_id: row.get("provider_session_id")?,
        turn_id: row.get("turn_id")?,
        item_id: row.get("item_id")?,
        kind: row.get("kind")?,
        source: row.get("source")?,
        occurred_at: row.get("occurred_at")?,
        payload: decode_json(payload, 10)?,
        provenance: row.get("provenance")?,
    })
}

fn insert_event(
    connection: &Connection,
    event: &UnifiedEvent,
) -> Result<InsertEventResult, StoreError> {
    let changes = connection
        .execute(
            "INSERT OR IGNORE INTO events (\
               id, provider, session_id, provider_session_id, turn_id, item_id, kind, source, \
               occurred_at, payload_json, provenance\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                event.id,
                event.provider,
                event.session_id,
                event.provider_session_id,
                event.turn_id,
                event.item_id,
                event.kind,
                event.source,
                event.occurred_at,
                event.payload.to_string(),
                event.provenance,
            ],
        )
        .map_err(sqlite_error)?;
    let stored = connection
        .query_row(
            "SELECT * FROM events WHERE id = ?1",
            [&event.id],
            event_from_row,
        )
        .map_err(sqlite_error)?;
    Ok(InsertEventResult {
        event: stored,
        inserted: changes > 0,
    })
}

fn decode_json(value: String, column: usize) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
    })
}

fn sqlite_error(error: rusqlite::Error) -> StoreError {
    StoreError::Sqlite(error.to_string())
}

#[cfg(test)]
mod task_command_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod trust_tests;
