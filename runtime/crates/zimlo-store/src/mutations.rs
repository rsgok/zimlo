use rusqlite::{Connection, OptionalExtension as _, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::{Command, Store, StoreError, receive, sqlite_error};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettingsInput {
    pub enabled: bool,
    pub approvals: bool,
    #[serde(default = "enabled_by_default")]
    pub results: bool,
    pub failures: bool,
    #[serde(default)]
    pub critical_only: bool,
    #[serde(default)]
    pub quiet_hours_enabled: bool,
    #[serde(default)]
    pub time_zone_offset_minutes: i64,
    pub show_task_title: bool,
}

const fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SafeMutation {
    FeedSeen {
        post_id: String,
        at: String,
    },
    FeedDismiss {
        item_id: String,
        dismissed: bool,
        idempotency_key: Option<String>,
        at: String,
    },
    TaskTimelineSeen {
        session_id: String,
        item_id: String,
        at: String,
    },
    TaskPreference {
        session_id: String,
        pinned: Option<bool>,
        archived: Option<bool>,
        idempotency_key: Option<String>,
        at: String,
    },
    NotificationSettings {
        settings: NotificationSettingsInput,
        idempotency_key: String,
        at: String,
    },
    UserProfile {
        avatar_id: String,
        at: String,
    },
    AgentProfile {
        project_id: String,
        display_name: String,
        avatar: String,
        bio: String,
        default_provider: Option<String>,
        idempotency_key: Option<String>,
        at: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum MutationResult {
    Message(Value),
    Snapshot,
}

pub(super) struct MutationCommand {
    device_id: String,
    mutation: SafeMutation,
    reply: oneshot::Sender<Result<MutationResult, StoreError>>,
}

impl Store {
    pub async fn apply_safe_mutation(
        &self,
        device_id: impl Into<String>,
        mutation: SafeMutation,
    ) -> Result<MutationResult, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Mutation(MutationCommand {
            device_id: device_id.into(),
            mutation,
            reply,
        }))?;
        receive(response).await
    }
}

pub(super) fn execute(connection: &mut Connection, command: MutationCommand) -> bool {
    let result = apply(connection, &command.device_id, command.mutation);
    let changed = result.is_ok();
    let _ = command.reply.send(result);
    changed
}

fn apply(
    connection: &mut Connection,
    device_id: &str,
    mutation: SafeMutation,
) -> Result<MutationResult, StoreError> {
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let active = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM devices WHERE id = ?1 AND revoked_at IS NULL)",
            [device_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)?
        == 1;
    if !active {
        return Err(StoreError::MissingDevice);
    }
    let result = match mutation {
        SafeMutation::FeedSeen { post_id, at } => {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO feed_seen(device_id, post_id, seen_at)
                     SELECT ?1, ?2, ?3 WHERE EXISTS(SELECT 1 FROM feed_posts WHERE id = ?2)",
                    (device_id, &post_id, at),
                )
                .map_err(sqlite_error)?;
            MutationResult::Message(json!({ "type": "feed.seen.updated", "postId": post_id }))
        }
        SafeMutation::FeedDismiss {
            item_id,
            dismissed,
            idempotency_key,
            at,
        } => {
            let storage_key = idempotency_key.map(|key| format!("{device_id}:{key}"));
            let duplicated = match storage_key.as_deref() {
                Some(key) => idempotency_exists(&transaction, key)?,
                None => false,
            };
            if !duplicated {
                if dismissed {
                    transaction
                        .execute(
                            "INSERT OR IGNORE INTO feed_dismissed(device_id, item_id, dismissed_at)
                             VALUES (?1, ?2, ?3)",
                            (device_id, &item_id, &at),
                        )
                        .map_err(sqlite_error)?;
                } else {
                    transaction
                        .execute(
                            "DELETE FROM feed_dismissed WHERE device_id = ?1 AND item_id = ?2",
                            (device_id, &item_id),
                        )
                        .map_err(sqlite_error)?;
                }
                if let Some(key) = storage_key.as_deref() {
                    save_idempotency(&transaction, key, &item_id, &at)?;
                }
            }
            let current = is_dismissed(&transaction, device_id, &item_id)?;
            if current {
                MutationResult::Message(
                    json!({ "type": "feed.dismissed.updated", "itemId": item_id }),
                )
            } else {
                MutationResult::Snapshot
            }
        }
        SafeMutation::TaskTimelineSeen {
            session_id,
            item_id,
            at,
        } => {
            transaction
                .execute(
                    "INSERT INTO task_timeline_cursors(device_id, session_id, item_id, seen_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(device_id, session_id) DO UPDATE SET
                        item_id = excluded.item_id, seen_at = excluded.seen_at",
                    (device_id, &session_id, &item_id, at),
                )
                .map_err(sqlite_error)?;
            MutationResult::Message(json!({
                "type": "task.timeline.seen.updated",
                "sessionId": session_id,
                "itemId": item_id,
            }))
        }
        SafeMutation::TaskPreference {
            session_id,
            pinned,
            archived,
            idempotency_key,
            at,
        } => {
            require_session(&transaction, &session_id)?;
            let storage_key = idempotency_key.map(|key| format!("{device_id}:{key}"));
            let duplicated = match storage_key.as_deref() {
                Some(key) => idempotency_exists(&transaction, key)?,
                None => false,
            };
            if !duplicated {
                if let Some(pinned) = pinned {
                    let pinned_at = pinned.then_some(at.as_str());
                    transaction
                        .execute(
                            "INSERT INTO task_preferences(session_id, pinned_at, archived_at)
                             VALUES (?1, ?2, NULL)
                             ON CONFLICT(session_id) DO UPDATE SET pinned_at = excluded.pinned_at",
                            (&session_id, pinned_at),
                        )
                        .map_err(sqlite_error)?;
                }
                if let Some(archived) = archived {
                    let archived_at = archived.then_some(at.as_str());
                    transaction
                        .execute(
                            "INSERT INTO task_preferences(session_id, pinned_at, archived_at)
                             VALUES (?1, NULL, ?2)
                             ON CONFLICT(session_id) DO UPDATE SET archived_at = excluded.archived_at",
                            (&session_id, archived_at),
                        )
                        .map_err(sqlite_error)?;
                }
                if let Some(key) = storage_key.as_deref() {
                    save_idempotency(&transaction, key, &session_id, &at)?;
                }
            }
            MutationResult::Message(json!({
                "type": "task.preference.updated",
                "preference": task_preference(&transaction, &session_id)?,
            }))
        }
        SafeMutation::NotificationSettings {
            settings,
            idempotency_key,
            at,
        } => {
            let storage_key = format!("{device_id}:{idempotency_key}");
            if !idempotency_exists(&transaction, &storage_key)? {
                transaction
                    .execute(
                        "INSERT INTO notification_settings(
                            device_id, enabled, approvals, results, failures, critical_only,
                            quiet_hours_enabled, timezone_offset_minutes, show_task_title, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                         ON CONFLICT(device_id) DO UPDATE SET
                            enabled = excluded.enabled, approvals = excluded.approvals,
                            results = excluded.results, failures = excluded.failures,
                            critical_only = excluded.critical_only,
                            quiet_hours_enabled = excluded.quiet_hours_enabled,
                            timezone_offset_minutes = excluded.timezone_offset_minutes,
                            show_task_title = excluded.show_task_title,
                            updated_at = excluded.updated_at",
                        rusqlite::params![
                            device_id,
                            i64::from(settings.enabled),
                            i64::from(settings.approvals),
                            i64::from(settings.results),
                            i64::from(settings.failures),
                            i64::from(settings.critical_only),
                            i64::from(settings.quiet_hours_enabled),
                            settings.time_zone_offset_minutes,
                            i64::from(settings.show_task_title),
                            at,
                        ],
                    )
                    .map_err(sqlite_error)?;
                save_idempotency(&transaction, &storage_key, device_id, &at)?;
            }
            MutationResult::Message(json!({
                "type": "notification.settings.updated",
                "settings": notification_settings(&transaction, device_id)?,
            }))
        }
        SafeMutation::UserProfile { avatar_id, at } => {
            transaction
                .execute(
                    "INSERT INTO user_profile(id, avatar_id, updated_at) VALUES (1, ?1, ?2)
                     ON CONFLICT(id) DO UPDATE SET
                        avatar_id = excluded.avatar_id, updated_at = excluded.updated_at",
                    (&avatar_id, &at),
                )
                .map_err(sqlite_error)?;
            MutationResult::Message(json!({
                "type": "user.profile.updated",
                "userProfile": { "avatarId": avatar_id, "updatedAt": at },
            }))
        }
        SafeMutation::AgentProfile {
            project_id,
            display_name,
            avatar,
            bio,
            default_provider,
            idempotency_key,
            at,
        } => {
            require_project(&transaction, &project_id)?;
            let storage_key = idempotency_key.map(|key| format!("{device_id}:{key}"));
            let duplicated = match storage_key.as_deref() {
                Some(key) => idempotency_exists(&transaction, key)?,
                None => false,
            };
            if !duplicated {
                transaction
                    .execute(
                        "UPDATE projects SET agent_display_name = ?2, agent_avatar = ?3,
                         agent_bio = ?4, agent_default_provider = ?5, agent_updated_at = ?6
                         WHERE id = ?1",
                        (
                            &project_id,
                            display_name.trim(),
                            avatar.trim(),
                            bio.trim(),
                            default_provider.as_deref(),
                            &at,
                        ),
                    )
                    .map_err(sqlite_error)?;
                if let Some(key) = storage_key.as_deref() {
                    save_idempotency(&transaction, key, &project_id, &at)?;
                }
            }
            MutationResult::Snapshot
        }
    };
    transaction.commit().map_err(sqlite_error)?;
    Ok(result)
}

fn idempotency_exists(transaction: &Transaction<'_>, key: &str) -> Result<bool, StoreError> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM idempotency WHERE key = ?1)",
            [key],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists == 1)
        .map_err(sqlite_error)
}

fn save_idempotency(
    transaction: &Transaction<'_>,
    key: &str,
    action_id: &str,
    at: &str,
) -> Result<(), StoreError> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO idempotency(key, action_id, result_json, created_at)
             VALUES (?1, ?2, '{\"ok\":true}', ?3)",
            (key, action_id, at),
        )
        .map(|_| ())
        .map_err(sqlite_error)
}

fn is_dismissed(
    transaction: &Transaction<'_>,
    device_id: &str,
    item_id: &str,
) -> Result<bool, StoreError> {
    transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM feed_dismissed WHERE device_id = ?1 AND item_id = ?2
             )",
            (device_id, item_id),
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists == 1)
        .map_err(sqlite_error)
}

fn require_session(transaction: &Transaction<'_>, session_id: &str) -> Result<(), StoreError> {
    require_entity(
        transaction,
        "sessions",
        session_id,
        StoreError::MissingSession,
    )
}

fn require_project(transaction: &Transaction<'_>, project_id: &str) -> Result<(), StoreError> {
    require_entity(
        transaction,
        "projects",
        project_id,
        StoreError::MissingProject,
    )
}

fn require_entity(
    transaction: &Transaction<'_>,
    table: &str,
    id: &str,
    missing: StoreError,
) -> Result<(), StoreError> {
    transaction
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
            [id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)?
        .eq(&1)
        .then_some(())
        .ok_or(missing)
}

fn task_preference(transaction: &Transaction<'_>, session_id: &str) -> Result<Value, StoreError> {
    let row = transaction
        .query_row(
            "SELECT pinned_at, archived_at FROM task_preferences WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_error)?;
    let (pinned_at, archived_at) = row.unwrap_or((None, None));
    Ok(json!({
        "sessionId": session_id,
        "pinnedAt": pinned_at,
        "archivedAt": archived_at,
    }))
}

fn notification_settings(
    transaction: &Transaction<'_>,
    device_id: &str,
) -> Result<Value, StoreError> {
    let row = transaction
        .query_row(
            "SELECT enabled, approvals, results, failures, critical_only,
                    quiet_hours_enabled, timezone_offset_minutes, show_task_title, updated_at
             FROM notification_settings WHERE device_id = ?1",
            [device_id],
            |row| {
                Ok(json!({
                    "enabled": row.get::<_, i64>(0)? == 1,
                    "approvals": row.get::<_, i64>(1)? == 1,
                    "results": row.get::<_, i64>(2)? == 1,
                    "failures": row.get::<_, i64>(3)? == 1,
                    "criticalOnly": row.get::<_, i64>(4)? == 1,
                    "quietHoursEnabled": row.get::<_, i64>(5)? == 1,
                    "timeZoneOffsetMinutes": row.get::<_, i64>(6)?,
                    "showTaskTitle": row.get::<_, i64>(7)? == 1,
                    "updatedAt": row.get::<_, String>(8)?,
                }))
            },
        )
        .optional()
        .map_err(sqlite_error)?;
    Ok(row.unwrap_or_else(|| {
        json!({
            "enabled": false,
            "approvals": true,
            "results": true,
            "failures": true,
            "criticalOnly": false,
            "quietHoursEnabled": false,
            "timeZoneOffsetMinutes": 0,
            "showTaskTitle": false,
            "updatedAt": "1970-01-01T00:00:00.000Z",
        })
    }))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rusqlite::Connection;
    use serde_json::json;

    use super::{NotificationSettingsInput, SafeMutation};
    use crate::{DeviceRecord, SnapshotOptions, Store, StoreMode, StoredSession};

    fn device() -> DeviceRecord {
        DeviceRecord {
            id: "device-mutation".into(),
            name: "Mutation Device".into(),
            key_base64: "fixture-key".into(),
            created_at: "2026-09-01T10:00:00.000Z".into(),
            last_seen_at: "2026-09-01T10:00:00.000Z".into(),
            revoked_at: None,
            is_local_admin: true,
            can_approve: true,
            can_manage_trust: true,
        }
    }

    fn session() -> StoredSession {
        StoredSession {
            id: "session-mutation".into(),
            project_id: None,
            provider: "codex".into(),
            surface: "cli".into(),
            provider_session_id: "provider-mutation".into(),
            title: "Mutation session".into(),
            cwd: Some("/tmp/zimlo".into()),
            transcript_path: None,
            status: "idle".into(),
            last_activity_at: "2026-09-01T10:00:00.000Z".into(),
            created_at: "2026-09-01T10:00:00.000Z".into(),
            active_pid: None,
            process_started_at: None,
            tty: None,
            correlation_uncertain: false,
            capabilities: json!({
                "discovered": true,
                "liveObserved": false,
                "replyable": true,
                "approvableOnce": false,
                "approvableSession": false,
                "approvablePersistent": false,
                "resumable": true,
                "diffAvailable": false
            }),
        }
    }

    #[tokio::test]
    async fn safe_mutations_are_persisted_and_idempotent() {
        let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
            .await
            .expect("store");
        store
            .set_metadata("host_identity_v1", "host-mutation")
            .await
            .expect("host");
        store.upsert_device(device()).await.expect("device");
        store.upsert_session(session()).await.expect("session");

        store
            .apply_safe_mutation(
                "device-mutation",
                SafeMutation::TaskPreference {
                    session_id: "session-mutation".into(),
                    pinned: Some(true),
                    archived: None,
                    idempotency_key: Some("pin-once".into()),
                    at: "2026-09-01T10:01:00.000Z".into(),
                },
            )
            .await
            .expect("pin task");
        store
            .apply_safe_mutation(
                "device-mutation",
                SafeMutation::TaskPreference {
                    session_id: "session-mutation".into(),
                    pinned: Some(false),
                    archived: None,
                    idempotency_key: Some("pin-once".into()),
                    at: "2026-09-01T10:02:00.000Z".into(),
                },
            )
            .await
            .expect("replay pin");

        let settings = NotificationSettingsInput {
            enabled: true,
            approvals: false,
            results: true,
            failures: true,
            critical_only: true,
            quiet_hours_enabled: true,
            time_zone_offset_minutes: 480,
            show_task_title: true,
        };
        store
            .apply_safe_mutation(
                "device-mutation",
                SafeMutation::NotificationSettings {
                    settings: settings.clone(),
                    idempotency_key: "settings-once".into(),
                    at: "2026-09-01T10:03:00.000Z".into(),
                },
            )
            .await
            .expect("notification settings");
        store
            .apply_safe_mutation(
                "device-mutation",
                SafeMutation::NotificationSettings {
                    settings: NotificationSettingsInput {
                        enabled: false,
                        ..settings
                    },
                    idempotency_key: "settings-once".into(),
                    at: "2026-09-01T10:04:00.000Z".into(),
                },
            )
            .await
            .expect("replay notification settings");
        store
            .apply_safe_mutation(
                "device-mutation",
                SafeMutation::UserProfile {
                    avatar_id: "user-08".into(),
                    at: "2026-09-01T10:05:00.000Z".into(),
                },
            )
            .await
            .expect("profile");

        let snapshot = store
            .snapshot(SnapshotOptions::for_device(
                "Mutation Mac",
                "2026-09-01T10:06:00.000Z",
                "device-mutation",
            ))
            .await
            .expect("snapshot");
        assert_eq!(
            snapshot["taskPreferences"][0]["pinnedAt"],
            "2026-09-01T10:01:00.000Z"
        );
        assert_eq!(snapshot["notificationSettings"]["enabled"], true);
        assert_eq!(
            snapshot["notificationSettings"]["updatedAt"],
            "2026-09-01T10:03:00.000Z"
        );
        assert_eq!(snapshot["userProfile"]["avatarId"], "user-08");
    }

    #[tokio::test]
    async fn write_ownership_recovers_runtime_state_and_excludes_other_writers() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("zimlo.db");
        let store = Store::open(&path, StoreMode::ReadWriteCreate)
            .await
            .expect("initialize store");
        drop(store);
        let connection = Connection::open(&path).expect("fixture connection");
        connection
            .execute_batch(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/protocol/test-vectors/snapshot-compat.sql"
            )))
            .expect("seed fixture");
        connection
            .execute(
                "UPDATE task_commands SET state = 'running', error = 'stale' WHERE id = 'command-snapshot'",
                [],
            )
            .expect("running command");
        connection
            .execute(
                "UPDATE actions SET state = 'submitted' WHERE action_id = 'action-snapshot'",
                [],
            )
            .expect("submitted action");
        drop(connection);

        let store = Store::open(&path, StoreMode::ReadWriteExisting)
            .await
            .expect("exclusive writer");
        let snapshot = store
            .snapshot(SnapshotOptions::local(
                "Recovery Mac",
                "2026-09-01T11:00:00.000Z",
            ))
            .await
            .expect("recovered snapshot");
        assert_eq!(snapshot["commands"][0]["state"], "failed");
        assert!(
            snapshot["commands"][0]["error"]
                .as_str()
                .is_some_and(|error| error.contains("状态不确定"))
        );
        assert_eq!(snapshot["actions"][0]["state"], "expired");

        let competing = Connection::open(&path).expect("competing connection");
        competing
            .busy_timeout(Duration::from_millis(50))
            .expect("busy timeout");
        assert!(
            competing
                .execute(
                    "UPDATE user_profile SET avatar_id = 'user-09' WHERE id = 1",
                    [],
                )
                .is_err()
        );
        drop(competing);
        drop(store);

        let writer = Connection::open(&path).expect("writer after release");
        assert_eq!(
            writer
                .execute(
                    "UPDATE user_profile SET avatar_id = 'user-09' WHERE id = 1",
                    [],
                )
                .expect("write after release"),
            1
        );
    }
}
