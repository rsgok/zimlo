use super::{Command, Store, StoreError, receive, sqlite_error};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub request_id: String,
    #[serde(default)]
    pub query: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub after: Option<String>,
    #[serde(default = "all")]
    pub kind: String,
    pub cursor: Option<String>,
    #[serde(default = "page_size")]
    pub limit: usize,
}
fn all() -> String {
    "all".into()
}
const fn page_size() -> usize {
    30
}

pub(super) struct Search {
    pub query: HistoryQuery,
    pub reply: oneshot::Sender<Result<Value, StoreError>>,
}

impl Store {
    pub async fn search_history(&self, query: HistoryQuery) -> Result<Value, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::History(Search { query, reply }))?;
        receive(response).await
    }
}

pub(super) fn search(connection: &Connection, query: &HistoryQuery) -> Result<Value, StoreError> {
    if query.request_id.is_empty()
        || query.request_id.len() > 128
        || query.query.chars().count() > 200
        || !(1..=100).contains(&query.limit)
        || ![
            "all", "result", "failure", "image", "video", "pdf", "document",
        ]
        .contains(&query.kind.as_str())
        || [&query.project_id, &query.session_id, &query.after]
            .iter()
            .any(|value| value.as_ref().is_some_and(|text| text.len() > 256))
    {
        return Err(StoreError::InvalidMutation);
    }
    let host = super::get_metadata(connection, "host_identity_v1")?
        .ok_or(StoreError::MissingHostIdentity)?;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            json!([
                host,
                query.query,
                query.project_id,
                query.session_id,
                query.after,
                query.kind
            ])
            .to_string()
            .as_bytes()
        )
    );
    let (before_date, before_id) = if let Some(cursor) = &query.cursor {
        if cursor.len() > 2048 {
            return Err(StoreError::InvalidMutation);
        }
        let cursor: Value =
            serde_json::from_str(cursor).map_err(|_| StoreError::InvalidMutation)?;
        if cursor["filter"] != fingerprint {
            return Err(StoreError::InvalidMutation);
        }
        (
            cursor["date"]
                .as_str()
                .ok_or(StoreError::InvalidMutation)?
                .to_owned(),
            cursor["id"]
                .as_str()
                .ok_or(StoreError::InvalidMutation)?
                .to_owned(),
        )
    } else {
        ("9999".into(), "\u{10ffff}".into())
    };
    let pattern = format!(
        "%{}%",
        query
            .query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    // Keyset pagination is independent of the live snapshot's 200-post window.
    // Only editorial posts and Agent outputs are returned; file paths and user
    // instructions never enter this read model.
    let mut statement = connection.prepare(
        "WITH entries AS (
          SELECT 'post:' || p.id AS entry_id, p.kind,
            CASE WHEN json_valid(p.content_json) THEN CASE WHEN json_type(p.content_json,'$.headline')='text'
              THEN coalesce(nullif(json_extract(p.content_json,'$.headline'),''),p.title) ELSE p.title END ELSE p.title END AS title,
            substr(CASE WHEN json_valid(p.content_json) THEN CASE WHEN json_type(p.content_json,'$.takeaway')='text'
              THEN coalesce(nullif(json_extract(p.content_json,'$.takeaway'),''),p.body) ELSE p.body END ELSE p.body END,1,4000) AS summary,
            p.created_at, p.project_id, p.session_id, NULL AS material_id, NULL AS mime_type, NULL AS size_bytes,
            'ready' AS status, p.content_json AS content
          FROM feed_posts p WHERE p.source='agent' AND p.kind IN ('result','failure')
            AND (?1 IS NULL OR p.project_id=?1) AND (?2 IS NULL OR p.session_id=?2)
          UNION ALL
          SELECT 'material:' || m.id, m.kind, m.name, '', m.created_at, ?1, ?2, m.id, m.mime_type, m.size_bytes, m.status, NULL
          FROM materials m WHERE m.origin='agent' AND ((?1 IS NULL AND ?2 IS NULL) OR EXISTS (
            SELECT 1 FROM history_material_links l WHERE l.material_id=m.id
              AND (?1 IS NULL OR l.project_id=?1) AND (?2 IS NULL OR l.session_id=?2)))
        ) SELECT * FROM entries WHERE (?3='all' OR kind=?3)
          AND (title LIKE ?4 ESCAPE '\\' OR summary LIKE ?4 ESCAPE '\\')
          AND (?5 IS NULL OR created_at>=?5)
          AND (created_at<?6 OR (created_at=?6 AND entry_id<?7))
        ORDER BY created_at DESC, entry_id DESC LIMIT ?8"
    ).map_err(sqlite_error)?;
    let rows = statement.query_map(params![query.project_id,query.session_id,query.kind,pattern,query.after,before_date,before_id,query.limit+1], |row| {
        let content: Option<String> = row.get("content")?;
        let content = content.and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let mut material_ids = vec![];
        if let Some(content) = content.as_ref().and_then(|value| value.get("content")) {
            if let Some(ids) = content["materialIds"].as_array() { material_ids.extend(ids.iter().filter_map(Value::as_str).map(str::to_owned)); }
            if let Some(id) = content["materialId"].as_str() { material_ids.push(id.to_owned()); }
        }
        Ok(json!({"id":row.get::<_,String>("entry_id")?,"hostId":host,"kind":row.get::<_,String>("kind")?,
            "title":row.get::<_,String>("title")?,"summary":row.get::<_,String>("summary")?,"createdAt":row.get::<_,String>("created_at")?,
            "projectId":row.get::<_,Option<String>>("project_id")?,"sessionId":row.get::<_,Option<String>>("session_id")?,
            "materialId":row.get::<_,Option<String>>("material_id")?,"mimeType":row.get::<_,Option<String>>("mime_type")?,
            "sizeBytes":row.get::<_,Option<i64>>("size_bytes")?,"status":row.get::<_,String>("status")?,"materialIds":material_ids}))
    }).map_err(sqlite_error)?;
    let mut items = rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)?;
    let has_more = items.len() > query.limit;
    items.truncate(query.limit);
    let cursor = if has_more {
        items.last().map(|item| {
            json!({"date":item["createdAt"],"id":item["id"],"filter":fingerprint}).to_string()
        })
    } else {
        None
    };
    let mut materials = std::collections::BTreeMap::new();
    for item in &items {
        let ids = item["materialIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .chain(item["materialId"].as_str());
        for id in ids {
            if let Some(mut material) = super::materials::get(connection, id)? {
                // Runtime errors can contain local paths. History exports only safe metadata.
                material.error = None;
                let mut value =
                    serde_json::to_value(&material).map_err(|_| StoreError::InvalidMutation)?;
                value["hostId"] = json!(host);
                materials.insert(id.to_owned(), value);
            }
        }
    }
    Ok(
        json!({"requestId":query.request_id,"hostId":host,"items":items,"materials":materials.into_values().collect::<Vec<_>>(),"nextCursor":cursor}),
    )
}

/// Persist associations once, then maintain them on editorial changes. Searches
/// never scan every post's JSON for every material.
pub(super) fn initialize(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS history_material_links (
        material_id TEXT NOT NULL, post_id TEXT NOT NULL, project_id TEXT, session_id TEXT,
        PRIMARY KEY(material_id, post_id));
        CREATE INDEX IF NOT EXISTS history_links_project_idx ON history_material_links(project_id, material_id);
        CREATE INDEX IF NOT EXISTS history_links_session_idx ON history_material_links(session_id, material_id);
        CREATE INDEX IF NOT EXISTS history_links_post_idx ON history_material_links(post_id);
        CREATE INDEX IF NOT EXISTS materials_history_idx ON materials(origin, created_at DESC, id DESC);
        CREATE TRIGGER IF NOT EXISTS history_links_insert AFTER INSERT ON feed_posts BEGIN
          INSERT OR IGNORE INTO history_material_links SELECT j.value, NEW.id, NEW.project_id, NEW.session_id
          FROM json_tree(CASE WHEN json_valid(NEW.content_json) THEN NEW.content_json ELSE '{}' END) j
          WHERE NEW.source='agent' AND j.type='text' AND (j.key='materialId' OR j.path='$.content.materialIds');
        END;
        CREATE TRIGGER IF NOT EXISTS history_links_update AFTER UPDATE OF content_json,project_id,session_id,source ON feed_posts BEGIN
          DELETE FROM history_material_links WHERE post_id=OLD.id;
          INSERT OR IGNORE INTO history_material_links SELECT j.value, NEW.id, NEW.project_id, NEW.session_id
          FROM json_tree(CASE WHEN json_valid(NEW.content_json) THEN NEW.content_json ELSE '{}' END) j
          WHERE NEW.source='agent' AND j.type='text' AND (j.key='materialId' OR j.path='$.content.materialIds');
        END;
        CREATE TRIGGER IF NOT EXISTS history_links_delete AFTER DELETE ON feed_posts BEGIN
          DELETE FROM history_material_links WHERE post_id=OLD.id;
        END;").map_err(sqlite_error)?;
    if super::get_metadata(connection, "history_links_v1")?.is_none() {
        connection.execute_batch("INSERT OR IGNORE INTO history_material_links
          SELECT j.value, p.id, p.project_id, p.session_id FROM feed_posts p,
          json_tree(CASE WHEN json_valid(p.content_json) THEN p.content_json ELSE '{}' END) j
          WHERE p.source='agent' AND j.type='text' AND (j.key='materialId' OR j.path='$.content.materialIds');").map_err(sqlite_error)?;
        super::set_metadata(connection, "history_links_v1", "ready")?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
