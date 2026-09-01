use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::{Command, Store, StoreError, receive, sqlite_error};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRecord {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub preview_material_id: Option<String>,
    pub origin: String,
    pub status: String,
    #[serde(skip_serializing)]
    pub local_path: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(super) enum MaterialCommand {
    Get {
        material_id: String,
        reply: oneshot::Sender<Result<Option<MaterialRecord>, StoreError>>,
    },
    Upsert {
        material: Box<MaterialRecord>,
        reply: oneshot::Sender<Result<MaterialRecord, StoreError>>,
    },
}

impl Store {
    pub async fn get_material(
        &self,
        material_id: impl Into<String>,
    ) -> Result<Option<MaterialRecord>, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Material(MaterialCommand::Get {
            material_id: material_id.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn upsert_material(
        &self,
        material: MaterialRecord,
    ) -> Result<MaterialRecord, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::Material(MaterialCommand::Upsert {
            material: Box::new(material),
            reply,
        }))?;
        receive(response).await
    }
}

pub(super) fn execute(connection: &Connection, command: MaterialCommand) -> bool {
    match command {
        MaterialCommand::Get { material_id, reply } => {
            let _ = reply.send(get(connection, &material_id));
            false
        }
        MaterialCommand::Upsert { material, reply } => {
            let result = upsert(connection, &material);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
    }
}

fn get(connection: &Connection, material_id: &str) -> Result<Option<MaterialRecord>, StoreError> {
    connection
        .query_row(
            "SELECT * FROM materials WHERE id = ?1",
            [material_id],
            material_from_row,
        )
        .optional()
        .map_err(sqlite_error)
}

fn upsert(
    connection: &Connection,
    material: &MaterialRecord,
) -> Result<MaterialRecord, StoreError> {
    connection
        .execute(
            "INSERT INTO materials (
               id, kind, name, mime_type, size_bytes, sha256, width, height, duration_ms,
               preview_material_id, origin, status, local_path, created_at, error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind, name = excluded.name, mime_type = excluded.mime_type,
               size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
               width = excluded.width, height = excluded.height,
               duration_ms = excluded.duration_ms,
               preview_material_id = excluded.preview_material_id, origin = excluded.origin,
               status = excluded.status, local_path = excluded.local_path, error = excluded.error",
            params![
                material.id,
                material.kind,
                material.name,
                material.mime_type,
                material.size_bytes,
                material.sha256,
                material.width,
                material.height,
                material.duration_ms,
                material.preview_material_id,
                material.origin,
                material.status,
                material.local_path,
                material.created_at,
                material.error,
            ],
        )
        .map_err(sqlite_error)?;
    get(connection, &material.id)?
        .ok_or_else(|| StoreError::Sqlite("material write succeeded but row is unavailable".into()))
}

fn material_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MaterialRecord> {
    Ok(MaterialRecord {
        id: row.get("id")?,
        kind: row.get("kind")?,
        name: row.get("name")?,
        mime_type: row.get("mime_type")?,
        size_bytes: row.get("size_bytes")?,
        sha256: row.get("sha256")?,
        width: row.get("width")?,
        height: row.get("height")?,
        duration_ms: row.get("duration_ms")?,
        preview_material_id: row.get("preview_material_id")?,
        origin: row.get("origin")?,
        status: row.get("status")?,
        local_path: row.get("local_path")?,
        created_at: row.get("created_at")?,
        error: row.get("error")?,
    })
}
