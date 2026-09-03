use std::{collections::HashMap, path::Path, sync::LazyLock};

use regex::Regex;
use rusqlite::{Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{StoreError, StoredSession, decode_json, list_sessions, sqlite_error};

const EPOCH: &str = "1970-01-01T00:00:00.000Z";
const DEFAULT_USER_AVATAR: &str = "user-01";
const USER_AVATARS: [&str; 24] = [
    "user-01", "user-02", "user-03", "user-04", "user-05", "user-06", "user-07", "user-08",
    "user-09", "user-10", "user-11", "user-12", "user-13", "user-14", "user-15", "user-16",
    "user-17", "user-18", "user-19", "user-20", "user-21", "user-22", "user-23", "user-24",
];

fn host_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        "windows" => "windows",
        _ => "unknown",
    }
}

static ACTIVE_PROCESS_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:Codex|Claude) · 活跃进程 \d+$").expect("active process title regex")
});
static HEX_TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}$").expect("hex title regex"));
static COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?iu)(?:^|\n)Comment:\s*([^\n]+)").expect("comment regex"));
static REQUEST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?isu)##\s*My request for (?:Codex|Claude(?: Code)?):\s*(.+)")
        .expect("request regex")
});
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?u)<[^>]+>").expect("tag regex"));
static PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?u)^[\s#>*`\-\d.)]+").expect("title prefix regex"));
static WHITESPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?u)\s+").expect("whitespace regex"));

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFeatures {
    pub project_trust_policy: bool,
    pub push_notifications: bool,
    pub remote_sync: bool,
    pub multi_host: bool,
}

impl SnapshotFeatures {
    pub const fn local_foundation() -> Self {
        Self {
            project_trust_policy: true,
            push_notifications: false,
            remote_sync: false,
            multi_host: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotOptions {
    pub host_name: String,
    pub now: String,
    pub features: SnapshotFeatures,
    pub device_id: Option<String>,
}

impl SnapshotOptions {
    pub fn local(host_name: impl Into<String>, now: impl Into<String>) -> Self {
        Self {
            host_name: host_name.into(),
            now: now.into(),
            features: SnapshotFeatures::local_foundation(),
            device_id: None,
        }
    }

    pub fn for_device(
        host_name: impl Into<String>,
        now: impl Into<String>,
        device_id: impl Into<String>,
    ) -> Self {
        Self {
            host_name: host_name.into(),
            now: now.into(),
            features: SnapshotFeatures::local_foundation(),
            device_id: Some(device_id.into()),
        }
    }
}

#[derive(Debug)]
struct LocalDevice {
    id: String,
    is_local_admin: bool,
    can_approve: bool,
    can_manage_trust: bool,
}

pub(super) fn build(
    connection: &Connection,
    options: &SnapshotOptions,
) -> Result<Value, StoreError> {
    let host_id = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'host_identity_v1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sqlite_error)?
        .filter(|value| !value.is_empty())
        .ok_or(StoreError::MissingHostIdentity)?;
    let device = snapshot_device(connection, options.device_id.as_deref())?.ok_or_else(|| {
        if options.device_id.is_some() {
            StoreError::MissingDevice
        } else {
            StoreError::MissingLocalAdmin
        }
    })?;
    let projects = projects(connection, &host_id)?;
    let project_names = projects
        .iter()
        .filter_map(|project| {
            Some((
                project.get("id")?.as_str()?.to_owned(),
                project.get("name")?.as_str()?.to_owned(),
            ))
        })
        .collect::<HashMap<_, _>>();
    let project_ids = projects
        .iter()
        .filter_map(|project| project.get("id")?.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let sessions = sessions(connection, &host_id, &project_names)?;
    let workspaces = workspaces(&projects, &host_id);

    Ok(json!({
        "host": {
            "id": host_id,
            "name": options.host_name,
            "platform": host_platform(),
            "lastSeenAt": options.now,
        },
        "userProfile": user_profile(connection)?,
        "projects": projects,
        "sessions": sessions,
        "cards": [],
        "posts": feed_posts(connection, &host_id)?,
        "materials": materials(connection, &host_id)?,
        "tasks": tasks(connection, &host_id)?,
        "commands": task_commands(connection, &host_id)?,
        "workspaces": workspaces,
        "seenPostIds": device_strings(connection, "feed_seen", "post_id", &device.id)?,
        "dismissedFeedItemIds": device_strings(connection, "feed_dismissed", "item_id", &device.id)?,
        "taskTimelineCursors": timeline_cursors(connection, &device.id)?,
        "taskPreferences": task_preferences(connection, &host_id)?,
        "actions": actions(connection, &host_id)?,
        "trustPolicies": trust_policies(connection, &host_id, &project_ids)?,
        "trustAudit": trust_audit(connection, &host_id)?,
        "notificationSettings": notification_settings(connection, &device.id)?,
        "pushDevices": push_devices(connection, &device.id)?,
        "features": options.features,
        "sequence": latest_sequence(connection)?,
        "lanApprovalsEnabled": device.is_local_admin || device.can_approve,
        "trustManagementEnabled": device.is_local_admin || device.can_manage_trust,
    }))
}

fn snapshot_device(
    connection: &Connection,
    device_id: Option<&str>,
) -> Result<Option<LocalDevice>, StoreError> {
    let read = |row: &rusqlite::Row<'_>| {
        Ok(LocalDevice {
            id: row.get(0)?,
            is_local_admin: row.get::<_, i64>(1)? == 1,
            can_approve: row.get::<_, i64>(2)? == 1,
            can_manage_trust: row.get::<_, i64>(3)? == 1,
        })
    };
    if let Some(device_id) = device_id {
        connection
            .query_row(
                "SELECT id, is_local_admin, can_approve, can_manage_trust FROM devices \
                 WHERE id = ?1 AND revoked_at IS NULL",
                [device_id],
                read,
            )
            .optional()
            .map_err(sqlite_error)
    } else {
        connection
            .query_row(
                "SELECT id, is_local_admin, can_approve, can_manage_trust FROM devices \
                 WHERE is_local_admin = 1 AND revoked_at IS NULL ORDER BY created_at ASC LIMIT 1",
                [],
                read,
            )
            .optional()
            .map_err(sqlite_error)
    }
}

fn user_profile(connection: &Connection) -> Result<Value, StoreError> {
    let row = connection
        .query_row(
            "SELECT avatar_id, updated_at FROM user_profile WHERE id = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(sqlite_error)?;
    let (avatar_id, updated_at) = row.unwrap_or_else(|| (DEFAULT_USER_AVATAR.into(), EPOCH.into()));
    let avatar_id = if USER_AVATARS.contains(&avatar_id.as_str()) {
        avatar_id
    } else {
        DEFAULT_USER_AVATAR.into()
    };
    Ok(json!({ "avatarId": avatar_id, "updatedAt": updated_at }))
}

fn projects(connection: &Connection, host_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut locations = HashMap::<String, Vec<String>>::new();
    let mut statement = connection
        .prepare(
            "SELECT project_id, path FROM project_locations ORDER BY project_id, last_seen_at DESC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;
    for row in rows {
        let (project_id, path) = row.map_err(sqlite_error)?;
        locations.entry(project_id).or_default().push(path);
    }

    let mut providers = HashMap::<String, Vec<String>>::new();
    let mut statement = connection
        .prepare(
            "SELECT project_id, provider FROM sessions WHERE project_id IS NOT NULL \
             GROUP BY project_id, provider ORDER BY project_id, provider",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;
    for row in rows {
        let (project_id, provider) = row.map_err(sqlite_error)?;
        providers.entry(project_id).or_default().push(provider);
    }

    let session_counts = grouped_counts(
        connection,
        "SELECT project_id, COUNT(*) FROM sessions WHERE project_id IS NOT NULL GROUP BY project_id",
    )?;
    let post_counts = grouped_counts(
        connection,
        "SELECT project_id, COUNT(*) FROM feed_posts WHERE source = 'agent' AND project_id IS NOT NULL GROUP BY project_id",
    )?;

    let mut statement = connection
        .prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE, id")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("name")?,
                row.get::<_, Option<String>>("agent_display_name")?,
                row.get::<_, Option<String>>("agent_avatar")?,
                row.get::<_, Option<String>>("agent_bio")?,
                row.get::<_, Option<String>>("agent_default_provider")?,
                row.get::<_, Option<String>>("agent_updated_at")?,
                row.get::<_, String>("created_at")?,
                row.get::<_, String>("last_used_at")?,
            ))
        })
        .map_err(sqlite_error)?;
    let mut result = Vec::new();
    for row in rows {
        let (
            id,
            name,
            display_name,
            avatar,
            bio,
            default_provider,
            agent_updated_at,
            created_at,
            last_used_at,
        ) = row.map_err(sqlite_error)?;
        let paths = locations.remove(&id).unwrap_or_default();
        let primary_path = paths.first().cloned().unwrap_or_default();
        let default_provider = default_provider
            .filter(|provider| provider == "codex" || provider == "claude")
            .map(Value::String)
            .unwrap_or(Value::Null);
        result.push(json!({
            "id": id,
            "hostId": host_id,
            "name": name,
            "primaryPath": primary_path,
            "paths": paths,
            "providers": providers.remove(&id).unwrap_or_default(),
            "sessionCount": session_counts.get(&id).copied().unwrap_or(0),
            "postCount": post_counts.get(&id).copied().unwrap_or(0),
            "agentProfile": {
                "displayName": display_name.filter(|value| !value.is_empty()).unwrap_or_else(|| name.clone()),
                "avatar": avatar.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| DEFAULT_USER_AVATAR.into()),
                "bio": bio.filter(|value| !value.is_empty()).unwrap_or_else(|| format!("负责 {name} 项目的长期工作与上下文。")),
                "defaultProvider": default_provider,
                "updatedAt": agent_updated_at.unwrap_or_else(|| created_at.clone()),
            },
            "createdAt": created_at,
            "lastUsedAt": last_used_at,
        }));
    }
    Ok(result)
}

fn grouped_counts(connection: &Connection, sql: &str) -> Result<HashMap<String, i64>, StoreError> {
    let mut statement = connection.prepare(sql).map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(sqlite_error)?;
    let mut result = HashMap::new();
    for row in rows {
        let (key, count) = row.map_err(sqlite_error)?;
        result.insert(key, count);
    }
    Ok(result)
}

fn workspaces(projects: &[Value], host_id: &str) -> Vec<Value> {
    projects
        .iter()
        .filter_map(|project| {
            let path = project.get("primaryPath")?.as_str()?;
            if path.is_empty() {
                return None;
            }
            Some(json!({
                "id": project.get("id")?,
                "hostId": host_id,
                "label": project.get("name")?,
                "path": path,
                "providers": project.get("providers")?,
                "lastUsedAt": project.get("lastUsedAt")?,
            }))
        })
        .collect()
}

fn sessions(
    connection: &Connection,
    host_id: &str,
    project_names: &HashMap<String, String>,
) -> Result<Vec<Value>, StoreError> {
    let inputs = first_task_inputs(connection)?;
    list_sessions(connection)?
        .into_iter()
        .map(|mut session| {
            if let Some(input) = inputs.get(&session.id)
                && has_generated_title(&session)
                && let Some(title) = task_title_from_input(input)
            {
                session.title = title;
            }
            let project_name = session
                .project_id
                .as_ref()
                .and_then(|project_id| project_names.get(project_id))
                .cloned();
            let mut value = serde_json::to_value(session)
                .map_err(|error| StoreError::Sqlite(error.to_string()))?;
            let object = value
                .as_object_mut()
                .ok_or_else(|| StoreError::Sqlite("session JSON is not an object".into()))?;
            object.insert("hostId".into(), Value::String(host_id.into()));
            object.insert(
                "projectName".into(),
                project_name.map(Value::String).unwrap_or(Value::Null),
            );
            Ok(value)
        })
        .collect()
}

fn first_task_inputs(connection: &Connection) -> Result<HashMap<String, String>, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT session_id, payload_json FROM events WHERE kind = 'user_instruction' ORDER BY sequence ASC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;
    let mut inputs = HashMap::new();
    for row in rows {
        let (session_id, payload) = row.map_err(sqlite_error)?;
        if inputs.contains_key(&session_id) {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(&payload) else {
            continue;
        };
        let input = payload
            .as_str()
            .map(str::to_owned)
            .or_else(|| payload.get("prompt")?.as_str().map(str::to_owned));
        if let Some(input) = input {
            inputs.insert(session_id, input);
        }
    }
    Ok(inputs)
}

fn has_generated_title(session: &StoredSession) -> bool {
    if ACTIVE_PROCESS_TITLE.is_match(&session.title) {
        return true;
    }
    let provider = if session.provider == "codex" {
        "Codex"
    } else {
        "Claude"
    };
    let Some(suffix) = session.title.strip_prefix(&format!("{provider} · ")) else {
        return false;
    };
    let cwd_name = session
        .cwd
        .as_deref()
        .and_then(|cwd| Path::new(cwd).file_name())
        .and_then(|name| name.to_str());
    suffix == truncate_utf16(&session.provider_session_id, 8)
        || cwd_name == Some(suffix)
        || HEX_TITLE.is_match(suffix)
}

fn task_title_from_input(input: &str) -> Option<String> {
    let selected = COMMENT
        .captures(input)
        .and_then(|captures| captures.get(1))
        .or_else(|| REQUEST.captures(input).and_then(|captures| captures.get(1)))
        .map_or(input, |value| value.as_str());
    let without_tags = TAG.replace_all(selected, " ");
    let without_prefix = PREFIX.replace(&without_tags, "");
    let compact = WHITESPACE.replace_all(without_prefix.trim(), " ");
    if compact.is_empty() {
        None
    } else if compact.encode_utf16().count() > 56 {
        Some(format!(
            "{}…",
            truncate_utf16(compact.trim_end(), 56).trim_end()
        ))
    } else {
        Some(compact.into_owned())
    }
}

fn truncate_utf16(value: &str, maximum: usize) -> String {
    let units = value.encode_utf16().take(maximum).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

fn feed_posts(connection: &Connection, host_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT * FROM feed_posts WHERE source = 'agent' AND kind <> 'instruction' \
             ORDER BY created_at DESC LIMIT 200",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, Option<String>>("project_id")?,
                row.get::<_, String>("task_id")?,
                row.get::<_, String>("run_id")?,
                row.get::<_, String>("agent_id")?,
                row.get::<_, Option<String>>("session_id")?,
                row.get::<_, String>("kind")?,
                row.get::<_, String>("title")?,
                row.get::<_, String>("body")?,
                row.get::<_, String>("dedupe_key")?,
                row.get::<_, String>("created_at")?,
                row.get::<_, Option<String>>("content_json")?,
            ))
        })
        .map_err(sqlite_error)?;
    let mut result = Vec::new();
    for row in rows {
        let (
            id,
            project_id,
            task_id,
            run_id,
            agent_id,
            session_id,
            kind,
            title,
            body,
            dedupe_key,
            created_at,
            content_json,
        ) = row.map_err(sqlite_error)?;
        let stored = content_json
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .and_then(|value| value.as_object().cloned());
        let content = stored
            .as_ref()
            .and_then(|value| value.get("content"))
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({ "type": "text" }));
        let blocks = stored
            .as_ref()
            .and_then(|value| value.get("blocks"))
            .and_then(Value::as_array)
            .filter(|blocks| blocks.len() <= 8)
            .cloned()
            .unwrap_or_default();
        let presentation = stored
            .as_ref()
            .and_then(|value| value.get("presentation"))
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| default_presentation(&kind));
        let headline = stored
            .as_ref()
            .and_then(|value| value.get("headline"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| truncate_utf16(&title, 72));
        let takeaway = stored
            .as_ref()
            .and_then(|value| value.get("takeaway"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| truncate_utf16(&body, 320));
        let highlights = stored
            .as_ref()
            .and_then(|value| value.get("highlights"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut post = json!({
            "id": id,
            "hostId": host_id,
            "projectId": project_id,
            "taskId": task_id,
            "runId": run_id,
            "agentId": agent_id,
            "sessionId": session_id,
            "kind": kind,
            "presentation": presentation,
            "headline": headline,
            "takeaway": takeaway,
            "highlights": highlights,
            "blocks": blocks,
            "content": content,
            "dedupeKey": dedupe_key,
            "source": "agent",
            "createdAt": created_at,
        });
        if let Some(proof) = stored
            .as_ref()
            .and_then(|value| value.get("proof"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            post.as_object_mut()
                .expect("post object")
                .insert("proof".into(), Value::String(proof.into()));
        }
        result.push(post);
    }
    Ok(result)
}

fn default_presentation(kind: &str) -> Value {
    let swiss = matches!(kind, "progress" | "attention" | "failure");
    json!({
        "system": if swiss { "swiss" } else { "editorial" },
        "theme": if matches!(kind, "attention" | "failure") { "safety_orange" } else if swiss { "lemon_green" } else { "ink_classic" },
        "layout": if matches!(kind, "attention" | "failure") { "alert" } else if swiss { "status_board" } else if matches!(kind, "result" | "decision") { "field_note" } else { "feature" },
        "typography": if swiss { "sans" } else { "serif" },
        "density": "airy",
        "mediaPlacement": "none",
    })
}

fn materials(connection: &Connection, host_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut statement = connection
        .prepare("SELECT * FROM materials ORDER BY created_at DESC LIMIT 500")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            let mut material = Map::new();
            material.insert("id".into(), Value::String(row.get("id")?));
            material.insert("hostId".into(), Value::String(host_id.into()));
            material.insert("kind".into(), Value::String(row.get("kind")?));
            material.insert("name".into(), Value::String(row.get("name")?));
            material.insert("mimeType".into(), Value::String(row.get("mime_type")?));
            material.insert(
                "sizeBytes".into(),
                Value::from(row.get::<_, i64>("size_bytes")?),
            );
            material.insert("sha256".into(), Value::String(row.get("sha256")?));
            insert_optional_i64(&mut material, "width", row.get("width")?);
            insert_optional_i64(&mut material, "height", row.get("height")?);
            insert_optional_i64(&mut material, "durationMs", row.get("duration_ms")?);
            insert_nonempty_string(
                &mut material,
                "previewMaterialId",
                row.get("preview_material_id")?,
            );
            material.insert("origin".into(), Value::String(row.get("origin")?));
            material.insert("status".into(), Value::String(row.get("status")?));
            material.insert("createdAt".into(), Value::String(row.get("created_at")?));
            insert_nonempty_string(&mut material, "error", row.get("error")?);
            Ok(Value::Object(material))
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn tasks(connection: &Connection, host_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut statement = connection
        .prepare("SELECT * FROM tasks ORDER BY updated_at DESC")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>("id")?,
                "hostId": host_id,
                "runId": row.get::<_, String>("run_id")?,
                "agentId": row.get::<_, String>("agent_id")?,
                "sessionId": row.get::<_, Option<String>>("session_id")?,
                "state": row.get::<_, String>("state")?,
                "reason": row.get::<_, String>("reason")?,
                "updatedAt": row.get::<_, String>("updated_at")?,
            }))
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn task_commands(connection: &Connection, host_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut statement = connection
        .prepare("SELECT * FROM task_commands ORDER BY created_at DESC LIMIT 200")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            let material_ids: Option<String> = row.get("material_ids_json")?;
            let material_ids = material_ids
                .filter(|value| !value.is_empty())
                .map(|value| decode_json(value, 8))
                .transpose()?
                .unwrap_or_else(|| json!([]));
            let mut command = json!({
                "id": row.get::<_, String>("id")?,
                "hostId": host_id,
                "idempotencyKey": row.get::<_, String>("idempotency_key")?,
                "kind": row.get::<_, String>("kind")?,
                "provider": row.get::<_, String>("provider")?,
                "sessionId": row.get::<_, Option<String>>("session_id")?,
                "workspaceId": row.get::<_, Option<String>>("workspace_id")?,
                "cwd": row.get::<_, String>("cwd")?,
                "text": row.get::<_, String>("text")?,
                "materialIds": material_ids,
                "state": row.get::<_, String>("state")?,
                "createdAt": row.get::<_, String>("created_at")?,
                "updatedAt": row.get::<_, String>("updated_at")?,
            });
            if let Some(error) = row.get::<_, Option<String>>("error")? {
                command
                    .as_object_mut()
                    .expect("command object")
                    .insert("error".into(), Value::String(error));
            }
            Ok(command)
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn device_strings(
    connection: &Connection,
    table: &str,
    column: &str,
    device_id: &str,
) -> Result<Vec<String>, StoreError> {
    let sql = format!("SELECT {column} FROM {table} WHERE device_id = ?1");
    let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
    let rows = statement
        .query_map([device_id], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn timeline_cursors(connection: &Connection, device_id: &str) -> Result<Value, StoreError> {
    let mut statement = connection
        .prepare("SELECT session_id, item_id FROM task_timeline_cursors WHERE device_id = ?1")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([device_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;
    let mut cursors = Map::new();
    for row in rows {
        let (session_id, item_id) = row.map_err(sqlite_error)?;
        cursors.insert(session_id, Value::String(item_id));
    }
    Ok(Value::Object(cursors))
}

fn task_preferences(connection: &Connection, host_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut statement = connection
        .prepare("SELECT session_id, pinned_at, archived_at FROM task_preferences")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "hostId": host_id,
                "sessionId": row.get::<_, String>(0)?,
                "pinnedAt": row.get::<_, Option<String>>(1)?,
                "archivedAt": row.get::<_, Option<String>>(2)?,
            }))
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn actions(connection: &Connection, host_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut statement = connection
        .prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT 200")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            let decisions: String = row.get("decisions_json")?;
            let mut action = json!({
                "actionId": row.get::<_, String>("action_id")?,
                "hostId": host_id,
                "sessionId": row.get::<_, String>("session_id")?,
                "kind": row.get::<_, String>("kind")?,
                "title": row.get::<_, String>("title")?,
                "detail": row.get::<_, String>("detail")?,
                "availableDecisions": decode_json(decisions, 6)?,
                "expiresAt": row.get::<_, String>("expires_at")?,
                "state": row.get::<_, String>("state")?,
                "createdAt": row.get::<_, String>("created_at")?,
            });
            let object = action.as_object_mut().expect("action object");
            insert_optional_string(object, "upstreamRequestId", row.get("upstream_request_id")?);
            insert_optional_string(object, "resolvedAt", row.get("resolved_at")?);
            if let Some(context) = row.get::<_, Option<String>>("approval_context_json")? {
                object.insert("approvalContext".into(), decode_json(context, 11)?);
            }
            Ok(action)
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn trust_policies(
    connection: &Connection,
    host_id: &str,
    project_ids: &[String],
) -> Result<Vec<Value>, StoreError> {
    let mut stored = HashMap::<String, Value>::new();
    let mut statement = connection
        .prepare("SELECT * FROM project_trust_policies")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            let project_id: String = row.get("project_id")?;
            let auto_allow: String = row.get("auto_allow_json")?;
            Ok((
                project_id.clone(),
                json!({
                    "hostId": host_id,
                    "projectId": project_id,
                    "preset": row.get::<_, String>("preset")?,
                    "autoAllow": decode_json(auto_allow, 2)?,
                    "updatedAt": row.get::<_, String>("updated_at")?,
                    "updatedByDeviceId": row.get::<_, String>("updated_by_device_id")?,
                }),
            ))
        })
        .map_err(sqlite_error)?;
    for row in rows {
        let (project_id, policy) = row.map_err(sqlite_error)?;
        stored.insert(project_id, policy);
    }
    Ok(project_ids
        .iter()
        .map(|project_id| {
            stored.remove(project_id).unwrap_or_else(|| {
                json!({
                    "hostId": host_id,
                    "projectId": project_id,
                    "preset": "ask",
                    "autoAllow": [],
                    "updatedAt": EPOCH,
                    "updatedByDeviceId": "",
                })
            })
        })
        .collect())
}

fn trust_audit(connection: &Connection, host_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut statement = connection
        .prepare("SELECT * FROM trust_audit ORDER BY created_at DESC LIMIT 100")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>("id")?,
                "hostId": host_id,
                "projectId": row.get::<_, String>("project_id")?,
                "sessionId": row.get::<_, String>("session_id")?,
                "deviceId": row.get::<_, String>("device_id")?,
                "category": row.get::<_, String>("category")?,
                "decision": row.get::<_, String>("decision")?,
                "reason": row.get::<_, String>("reason")?,
                "actionSummary": row.get::<_, String>("action_summary")?,
                "createdAt": row.get::<_, String>("created_at")?,
            }))
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn notification_settings(connection: &Connection, device_id: &str) -> Result<Value, StoreError> {
    connection
        .query_row(
            "SELECT * FROM notification_settings WHERE device_id = ?1",
            [device_id],
            |row| {
                Ok(json!({
                    "enabled": row.get::<_, i64>("enabled")? == 1,
                    "approvals": row.get::<_, i64>("approvals")? == 1,
                    "results": row.get::<_, i64>("results")? == 1,
                    "failures": row.get::<_, i64>("failures")? == 1,
                    "criticalOnly": row.get::<_, i64>("critical_only")? == 1,
                    "quietHoursEnabled": row.get::<_, i64>("quiet_hours_enabled")? == 1,
                    "timeZoneOffsetMinutes": row.get::<_, i64>("timezone_offset_minutes")?,
                    "showTaskTitle": row.get::<_, i64>("show_task_title")? == 1,
                    "updatedAt": row.get::<_, String>("updated_at")?,
                }))
            },
        )
        .optional()
        .map_err(sqlite_error)
        .map(|settings| {
            settings.unwrap_or_else(|| {
                json!({
                    "enabled": false,
                    "approvals": true,
                    "results": true,
                    "failures": true,
                    "criticalOnly": false,
                    "quietHoursEnabled": false,
                    "timeZoneOffsetMinutes": 0,
                    "showTaskTitle": false,
                    "updatedAt": EPOCH,
                })
            })
        })
}

fn push_devices(connection: &Connection, device_id: &str) -> Result<Vec<Value>, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT push_devices.*, push_delivery_status.kind AS last_delivery_kind, \
               push_delivery_status.status AS last_delivery_status, \
               push_delivery_status.attempted_at AS last_delivery_at \
             FROM push_devices LEFT JOIN push_delivery_status USING (device_id) \
             WHERE push_devices.device_id = ?1",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([device_id], |row| {
            let environment: String = row.get("environment")?;
            let mut registration = json!({
                "deviceId": row.get::<_, String>("device_id")?,
                "platform": "ios",
                "endpoint": row.get::<_, String>("endpoint")?,
                "publicKey": row.get::<_, String>("public_key")?,
                "active": row.get::<_, i64>("active")? == 1,
                "environment": if environment == "development" { "development" } else { "production" },
                "registeredAt": row.get::<_, String>("registered_at")?,
                "updatedAt": row.get::<_, String>("updated_at")?,
            });
            let object = registration.as_object_mut().expect("push registration object");
            insert_optional_string(object, "lastDeliveryKind", row.get("last_delivery_kind")?);
            insert_optional_i64(object, "lastDeliveryStatus", row.get("last_delivery_status")?);
            insert_optional_string(object, "lastDeliveryAt", row.get("last_delivery_at")?);
            Ok(registration)
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn latest_sequence(connection: &Connection) -> Result<i64, StoreError> {
    connection
        .query_row("SELECT COALESCE(MAX(sequence), 0) FROM events", [], |row| {
            row.get(0)
        })
        .map_err(sqlite_error)
}

fn insert_optional_string(target: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        target.insert(key.into(), Value::String(value));
    }
}

fn insert_nonempty_string(target: &mut Map<String, Value>, key: &str, value: Option<String>) {
    insert_optional_string(target, key, value.filter(|value| !value.is_empty()));
}

fn insert_optional_i64(target: &mut Map<String, Value>, key: &str, value: Option<i64>) {
    if let Some(value) = value {
        target.insert(key.into(), Value::from(value));
    }
}
