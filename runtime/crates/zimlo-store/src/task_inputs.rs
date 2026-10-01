use super::{StoreError, sqlite_error};
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashMap;

pub(super) fn first_task_inputs(
    connection: &Connection,
) -> Result<HashMap<String, String>, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT s.id, (SELECT e.payload_json FROM events e
                WHERE e.session_id = s.id AND e.kind = 'user_instruction'
                AND CASE WHEN json_valid(e.payload_json) THEN
                    json_type(e.payload_json) = 'text' OR json_type(e.payload_json, '$.prompt') = 'text'
                    ELSE 0 END
                ORDER BY e.sequence ASC LIMIT 1)
             FROM sessions s WHERE s.title LIKE 'Codex · %' OR s.title LIKE 'Claude · %'",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(sqlite_error)?;
    let mut inputs = HashMap::new();
    for row in rows {
        let (session_id, payload) = row.map_err(sqlite_error)?;
        let Some(payload) = payload else { continue };
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
