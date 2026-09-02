use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::{Store, StoreError, receive, sqlite_error};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushDeviceRecord {
    pub device_id: String,
    pub platform: String,
    pub endpoint: String,
    pub public_key: String,
    pub active: bool,
    pub environment: String,
    pub registered_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_delivery_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_delivery_status: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_delivery_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettingsRecord {
    pub enabled: bool,
    pub approvals: bool,
    pub results: bool,
    pub failures: bool,
    pub critical_only: bool,
    pub quiet_hours_enabled: bool,
    pub time_zone_offset_minutes: i64,
    pub show_task_title: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivePushDevice {
    pub registration: PushDeviceRecord,
    pub settings: NotificationSettingsRecord,
}

pub(crate) enum PushCommand {
    Upsert {
        device_id: String,
        endpoint: String,
        public_key: String,
        environment: String,
        now: String,
        reply: oneshot::Sender<Result<PushDeviceRecord, StoreError>>,
    },
    Unregister {
        device_id: String,
        now: String,
        reply: oneshot::Sender<Result<(), StoreError>>,
    },
    ListActive {
        reply: oneshot::Sender<Result<Vec<ActivePushDevice>, StoreError>>,
    },
    UnreadCount {
        device_id: String,
        settings: NotificationSettingsRecord,
        now: String,
        reply: oneshot::Sender<Result<i64, StoreError>>,
    },
    RecordDelivery {
        device_id: String,
        kind: String,
        status: i64,
        now: String,
        reply: oneshot::Sender<Result<(), StoreError>>,
    },
}

impl Store {
    pub async fn upsert_push_device(
        &self,
        device_id: impl Into<String>,
        endpoint: impl Into<String>,
        public_key: impl Into<String>,
        environment: impl Into<String>,
        now: impl Into<String>,
    ) -> Result<PushDeviceRecord, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(crate::Command::Push(PushCommand::Upsert {
            device_id: device_id.into(),
            endpoint: endpoint.into(),
            public_key: public_key.into(),
            environment: environment.into(),
            now: now.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn unregister_push_device(
        &self,
        device_id: impl Into<String>,
        now: impl Into<String>,
    ) -> Result<(), StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(crate::Command::Push(PushCommand::Unregister {
            device_id: device_id.into(),
            now: now.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn list_active_push_devices(&self) -> Result<Vec<ActivePushDevice>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(crate::Command::Push(PushCommand::ListActive { reply }))?;
        receive(response).await
    }

    pub async fn notification_unread_count(
        &self,
        device_id: impl Into<String>,
        settings: NotificationSettingsRecord,
        now: impl Into<String>,
    ) -> Result<i64, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(crate::Command::Push(PushCommand::UnreadCount {
            device_id: device_id.into(),
            settings,
            now: now.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn record_push_delivery(
        &self,
        device_id: impl Into<String>,
        kind: impl Into<String>,
        status: i64,
        now: impl Into<String>,
    ) -> Result<(), StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(crate::Command::Push(PushCommand::RecordDelivery {
            device_id: device_id.into(),
            kind: kind.into(),
            status,
            now: now.into(),
            reply,
        }))?;
        receive(response).await
    }
}

pub(crate) fn execute(connection: &Connection, command: PushCommand) -> bool {
    match command {
        PushCommand::Upsert {
            device_id,
            endpoint,
            public_key,
            environment,
            now,
            reply,
        } => {
            let result = upsert(
                connection,
                &device_id,
                &endpoint,
                &public_key,
                &environment,
                &now,
            );
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        PushCommand::Unregister {
            device_id,
            now,
            reply,
        } => {
            let result = connection
                .execute(
                    "UPDATE push_devices SET active = 0, updated_at = ?2 WHERE device_id = ?1",
                    params![device_id, now],
                )
                .map(|_| ())
                .map_err(sqlite_error);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        PushCommand::ListActive { reply } => {
            let _ = reply.send(list_active(connection));
            false
        }
        PushCommand::UnreadCount {
            device_id,
            settings,
            now,
            reply,
        } => {
            let _ = reply.send(unread_count(connection, &device_id, &settings, &now));
            false
        }
        PushCommand::RecordDelivery {
            device_id,
            kind,
            status,
            now,
            reply,
        } => {
            let result = connection
                .execute(
                    "INSERT INTO push_delivery_status(device_id, kind, status, attempted_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(device_id) DO UPDATE SET kind = excluded.kind,
                     status = excluded.status, attempted_at = excluded.attempted_at",
                    params![device_id, kind, status, now],
                )
                .map(|_| ())
                .map_err(sqlite_error);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
    }
}

fn upsert(
    connection: &Connection,
    device_id: &str,
    endpoint: &str,
    public_key: &str,
    environment: &str,
    now: &str,
) -> Result<PushDeviceRecord, StoreError> {
    let registered_at = connection
        .query_row(
            "SELECT registered_at FROM push_devices WHERE device_id = ?1",
            [device_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sqlite_error)?
        .unwrap_or_else(|| now.to_owned());
    connection
        .execute(
            "INSERT INTO push_devices(
               device_id, platform, endpoint, public_key, active, environment, registered_at, updated_at
             ) VALUES (?1, 'ios', ?2, ?3, 1, ?4, ?5, ?6)
             ON CONFLICT(device_id) DO UPDATE SET
               endpoint = excluded.endpoint,
               public_key = excluded.public_key,
               active = 1,
               environment = excluded.environment,
               updated_at = excluded.updated_at",
            params![device_id, endpoint, public_key, environment, registered_at, now],
        )
        .map_err(sqlite_error)?;
    get(connection, device_id)?.ok_or(StoreError::MissingDevice)
}

fn get(connection: &Connection, device_id: &str) -> Result<Option<PushDeviceRecord>, StoreError> {
    connection
        .query_row(
            "SELECT push_devices.*,
               push_delivery_status.kind AS last_delivery_kind,
               push_delivery_status.status AS last_delivery_status,
               push_delivery_status.attempted_at AS last_delivery_at
             FROM push_devices
             LEFT JOIN push_delivery_status USING (device_id)
             WHERE push_devices.device_id = ?1",
            [device_id],
            |row| {
                Ok(PushDeviceRecord {
                    device_id: row.get("device_id")?,
                    platform: row.get("platform")?,
                    endpoint: row.get("endpoint")?,
                    public_key: row.get("public_key")?,
                    active: row.get::<_, i64>("active")? != 0,
                    environment: row.get("environment")?,
                    registered_at: row.get("registered_at")?,
                    updated_at: row.get("updated_at")?,
                    last_delivery_kind: row.get("last_delivery_kind")?,
                    last_delivery_status: row.get("last_delivery_status")?,
                    last_delivery_at: row.get("last_delivery_at")?,
                })
            },
        )
        .optional()
        .map_err(sqlite_error)
}

fn list_active(connection: &Connection) -> Result<Vec<ActivePushDevice>, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT push_devices.device_id FROM push_devices
             JOIN devices ON devices.id = push_devices.device_id
             WHERE push_devices.active = 1 AND devices.revoked_at IS NULL",
        )
        .map_err(sqlite_error)?;
    let device_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    device_ids
        .into_iter()
        .map(|device_id| {
            Ok(ActivePushDevice {
                registration: get(connection, &device_id)?.ok_or(StoreError::MissingDevice)?,
                settings: notification_settings(connection, &device_id)?,
            })
        })
        .collect()
}

fn notification_settings(
    connection: &Connection,
    device_id: &str,
) -> Result<NotificationSettingsRecord, StoreError> {
    connection
        .query_row(
            "SELECT enabled, approvals, results, failures, critical_only,
                    quiet_hours_enabled, timezone_offset_minutes, show_task_title, updated_at
             FROM notification_settings WHERE device_id = ?1",
            [device_id],
            |row| {
                Ok(NotificationSettingsRecord {
                    enabled: row.get::<_, i64>(0)? == 1,
                    approvals: row.get::<_, i64>(1)? == 1,
                    results: row.get::<_, i64>(2)? == 1,
                    failures: row.get::<_, i64>(3)? == 1,
                    critical_only: row.get::<_, i64>(4)? == 1,
                    quiet_hours_enabled: row.get::<_, i64>(5)? == 1,
                    time_zone_offset_minutes: row.get(6)?,
                    show_task_title: row.get::<_, i64>(7)? == 1,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(sqlite_error)
        .map(|settings| {
            settings.unwrap_or(NotificationSettingsRecord {
                enabled: false,
                approvals: true,
                results: true,
                failures: true,
                critical_only: false,
                quiet_hours_enabled: false,
                time_zone_offset_minutes: 0,
                show_task_title: false,
                updated_at: "1970-01-01T00:00:00.000Z".into(),
            })
        })
}

fn unread_count(
    connection: &Connection,
    device_id: &str,
    settings: &NotificationSettingsRecord,
    now: &str,
) -> Result<i64, StoreError> {
    let actions = if settings.approvals {
        connection
            .query_row(
                "SELECT COUNT(*) FROM actions WHERE state = 'pending' AND expires_at > ?1",
                [now],
                |row| row.get::<_, i64>(0),
            )
            .map_err(sqlite_error)?
    } else {
        0
    };
    let posts = match (
        settings.results && !settings.critical_only,
        settings.failures,
    ) {
        (true, true) => connection.query_row(
            "SELECT COUNT(*) FROM feed_posts LEFT JOIN feed_seen
             ON feed_seen.post_id = feed_posts.id AND feed_seen.device_id = ?1
             WHERE feed_seen.post_id IS NULL AND feed_posts.kind IN ('result', 'failure')",
            [device_id],
            |row| row.get::<_, i64>(0),
        ),
        (true, false) => connection.query_row(
            "SELECT COUNT(*) FROM feed_posts LEFT JOIN feed_seen
             ON feed_seen.post_id = feed_posts.id AND feed_seen.device_id = ?1
             WHERE feed_seen.post_id IS NULL AND feed_posts.kind = 'result'",
            [device_id],
            |row| row.get::<_, i64>(0),
        ),
        (false, true) => connection.query_row(
            "SELECT COUNT(*) FROM feed_posts LEFT JOIN feed_seen
             ON feed_seen.post_id = feed_posts.id AND feed_seen.device_id = ?1
             WHERE feed_seen.post_id IS NULL AND feed_posts.kind = 'failure'",
            [device_id],
            |row| row.get::<_, i64>(0),
        ),
        (false, false) => Ok(0),
    }
    .map_err(sqlite_error)?;
    Ok((actions + posts).min(99))
}
