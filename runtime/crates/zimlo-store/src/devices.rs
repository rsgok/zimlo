use rusqlite::{Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::{Command, Store, StoreError, StoreVersion, receive, sqlite_error};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    pub key_base64: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub revoked_at: Option<String>,
    pub is_local_admin: bool,
    pub can_approve: bool,
    pub can_manage_trust: bool,
}

pub type DeviceAuthRecord = DeviceRecord;

pub(super) enum DeviceCommand {
    Active {
        device_id: String,
        reply: oneshot::Sender<Result<Option<DeviceRecord>, StoreError>>,
    },
    List {
        reply: oneshot::Sender<Result<Vec<DeviceRecord>, StoreError>>,
    },
    Upsert {
        device: DeviceRecord,
        reply: oneshot::Sender<Result<DeviceRecord, StoreError>>,
    },
    EnsureLocalAdmin {
        candidate: DeviceRecord,
        reply: oneshot::Sender<Result<DeviceRecord, StoreError>>,
    },
    Revoke {
        device_id: String,
        revoked_at: String,
        reply: oneshot::Sender<Result<bool, StoreError>>,
    },
    SetApproval {
        device_id: String,
        enabled: bool,
        reply: oneshot::Sender<Result<Option<DeviceRecord>, StoreError>>,
    },
    SetTrust {
        device_id: String,
        enabled: bool,
        reply: oneshot::Sender<Result<Option<DeviceRecord>, StoreError>>,
    },
    Touch {
        device_id: String,
        seen_at: String,
        reply: oneshot::Sender<Result<Option<DeviceRecord>, StoreError>>,
    },
    DataVersion {
        reply: oneshot::Sender<Result<i64, StoreError>>,
    },
}

impl Store {
    pub async fn active_device(
        &self,
        device_id: impl Into<String>,
    ) -> Result<Option<DeviceAuthRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::Active {
            device_id: device_id.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn list_devices(&self) -> Result<Vec<DeviceRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::List { reply }))?;
        receive(response).await
    }

    pub async fn upsert_device(&self, device: DeviceRecord) -> Result<DeviceRecord, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::Upsert { device, reply }))?;
        receive(response).await
    }

    pub async fn ensure_local_admin(
        &self,
        candidate: DeviceRecord,
    ) -> Result<DeviceRecord, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::EnsureLocalAdmin {
            candidate,
            reply,
        }))?;
        receive(response).await
    }

    pub async fn revoke_device(
        &self,
        device_id: impl Into<String>,
        revoked_at: impl Into<String>,
    ) -> Result<bool, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::Revoke {
            device_id: device_id.into(),
            revoked_at: revoked_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn set_device_approval(
        &self,
        device_id: impl Into<String>,
        enabled: bool,
    ) -> Result<Option<DeviceRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::SetApproval {
            device_id: device_id.into(),
            enabled,
            reply,
        }))?;
        receive(response).await
    }

    pub async fn set_device_trust(
        &self,
        device_id: impl Into<String>,
        enabled: bool,
    ) -> Result<Option<DeviceRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::SetTrust {
            device_id: device_id.into(),
            enabled,
            reply,
        }))?;
        receive(response).await
    }

    pub async fn touch_device(
        &self,
        device_id: impl Into<String>,
        seen_at: impl Into<String>,
    ) -> Result<Option<DeviceRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::Touch {
            device_id: device_id.into(),
            seen_at: seen_at.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn data_version(&self) -> Result<StoreVersion, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Device(DeviceCommand::DataVersion { reply }))?;
        let sqlite = receive(response).await?;
        Ok(StoreVersion {
            sqlite,
            local: self
                .inner
                .revision
                .load(std::sync::atomic::Ordering::Relaxed),
        })
    }
}

pub(super) fn execute(connection: &Connection, command: DeviceCommand) -> bool {
    match command {
        DeviceCommand::Active { device_id, reply } => {
            let _ = reply.send(active_device(connection, &device_id));
            false
        }
        DeviceCommand::List { reply } => {
            let _ = reply.send(list_devices(connection));
            false
        }
        DeviceCommand::Upsert { device, reply } => {
            let result = upsert_device(connection, &device).map(|()| device);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        DeviceCommand::EnsureLocalAdmin { candidate, reply } => {
            let result = ensure_local_admin(connection, candidate);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        DeviceCommand::Revoke {
            device_id,
            revoked_at,
            reply,
        } => {
            let result = revoke_device(connection, &device_id, &revoked_at);
            let changed = result.as_ref().is_ok_and(|changed| *changed);
            let _ = reply.send(result);
            changed
        }
        DeviceCommand::SetApproval {
            device_id,
            enabled,
            reply,
        } => {
            let result = set_permission(connection, &device_id, "can_approve", enabled);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        DeviceCommand::SetTrust {
            device_id,
            enabled,
            reply,
        } => {
            let result = set_permission(connection, &device_id, "can_manage_trust", enabled);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        DeviceCommand::Touch {
            device_id,
            seen_at,
            reply,
        } => {
            let result = connection
                .execute(
                    "UPDATE devices SET last_seen_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
                    (&device_id, &seen_at),
                )
                .map_err(sqlite_error)
                .and_then(|_| active_device(connection, &device_id));
            let _ = reply.send(result);
            false
        }
        DeviceCommand::DataVersion { reply } => {
            let _ = reply.send(data_version(connection));
            false
        }
    }
}

fn active_device(
    connection: &Connection,
    device_id: &str,
) -> Result<Option<DeviceRecord>, StoreError> {
    device_query(
        connection,
        "WHERE id = ?1 AND revoked_at IS NULL",
        [device_id],
    )
    .map(|mut devices| devices.pop())
}

fn list_devices(connection: &Connection) -> Result<Vec<DeviceRecord>, StoreError> {
    device_query(connection, "ORDER BY created_at DESC", [])
}

fn device_query<const N: usize>(
    connection: &Connection,
    suffix: &str,
    params: [&str; N],
) -> Result<Vec<DeviceRecord>, StoreError> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT id, name, key_base64, created_at, last_seen_at, revoked_at, \
             is_local_admin, can_approve, can_manage_trust FROM devices {suffix}"
        ))
        .map_err(sqlite_error)?;
    statement
        .query_map(rusqlite::params_from_iter(params), device_from_row)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)
}

fn device_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeviceRecord> {
    Ok(DeviceRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        key_base64: row.get(2)?,
        created_at: row.get(3)?,
        last_seen_at: row.get(4)?,
        revoked_at: row.get(5)?,
        is_local_admin: row.get::<_, i64>(6)? == 1,
        can_approve: row.get::<_, i64>(7)? == 1,
        can_manage_trust: row.get::<_, i64>(8)? == 1,
    })
}

fn upsert_device(connection: &Connection, device: &DeviceRecord) -> Result<(), StoreError> {
    connection
        .execute(
            "INSERT INTO devices(
                id, name, key_base64, created_at, last_seen_at, revoked_at,
                is_local_admin, can_approve, can_manage_trust
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, key_base64 = excluded.key_base64,
                last_seen_at = excluded.last_seen_at, revoked_at = excluded.revoked_at,
                is_local_admin = excluded.is_local_admin,
                can_approve = excluded.can_approve,
                can_manage_trust = excluded.can_manage_trust",
            rusqlite::params![
                device.id,
                device.name,
                device.key_base64,
                device.created_at,
                device.last_seen_at,
                device.revoked_at,
                i64::from(device.is_local_admin),
                i64::from(device.can_approve),
                i64::from(device.can_manage_trust),
            ],
        )
        .map(|_| ())
        .map_err(sqlite_error)
}

fn ensure_local_admin(
    connection: &Connection,
    candidate: DeviceRecord,
) -> Result<DeviceRecord, StoreError> {
    let existing = connection
        .query_row(
            "SELECT id, name, key_base64, created_at, last_seen_at, revoked_at,
                    is_local_admin, can_approve, can_manage_trust
             FROM devices WHERE is_local_admin = 1 AND revoked_at IS NULL
             ORDER BY created_at ASC LIMIT 1",
            [],
            device_from_row,
        )
        .optional()
        .map_err(sqlite_error)?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    upsert_device(connection, &candidate)?;
    Ok(candidate)
}

fn revoke_device(
    connection: &Connection,
    device_id: &str,
    revoked_at: &str,
) -> Result<bool, StoreError> {
    connection
        .execute(
            "UPDATE devices SET revoked_at = ?2
             WHERE id = ?1 AND revoked_at IS NULL AND is_local_admin = 0",
            (device_id, revoked_at),
        )
        .map(|changed| changed > 0)
        .map_err(sqlite_error)
}

fn set_permission(
    connection: &Connection,
    device_id: &str,
    column: &str,
    enabled: bool,
) -> Result<Option<DeviceRecord>, StoreError> {
    debug_assert!(matches!(column, "can_approve" | "can_manage_trust"));
    connection
        .execute(
            &format!(
                "UPDATE devices SET {column} = ?2
                 WHERE id = ?1 AND revoked_at IS NULL AND is_local_admin = 0"
            ),
            (device_id, i64::from(enabled)),
        )
        .map_err(sqlite_error)?;
    active_device(connection, device_id)
}

fn data_version(connection: &Connection) -> Result<i64, StoreError> {
    connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(sqlite_error)
}
