use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tokio::sync::oneshot;

use crate::{Command, Store, StoreError, StoredSession, receive, sqlite_error};

#[derive(Debug, Clone)]
pub struct AgentToolInput {
    pub provider: String,
    pub parent_pid: i64,
    pub cwd: String,
    pub name: String,
    pub arguments: Value,
    pub now: String,
}

pub(crate) enum AgentToolCommand {
    Apply {
        input: Box<AgentToolInput>,
        reply: oneshot::Sender<Result<Value, StoreError>>,
    },
    BeginCheckpoint {
        provider: String,
        run_id: String,
        session_id: String,
        now: String,
        reply: oneshot::Sender<Result<(), StoreError>>,
    },
    FinalizeCheckpoint {
        provider: String,
        run_id: String,
        now: String,
        reply: oneshot::Sender<Result<(), StoreError>>,
    },
}

impl Store {
    pub async fn apply_agent_tool(&self, input: AgentToolInput) -> Result<Value, StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::AgentTool(AgentToolCommand::Apply {
            input: Box::new(input),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn begin_feed_checkpoint(
        &self,
        provider: impl Into<String>,
        run_id: impl Into<String>,
        session_id: impl Into<String>,
        now: impl Into<String>,
    ) -> Result<(), StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::AgentTool(AgentToolCommand::BeginCheckpoint {
            provider: provider.into(),
            run_id: run_id.into(),
            session_id: session_id.into(),
            now: now.into(),
            reply,
        }))?;
        receive(response).await
    }

    pub async fn finalize_feed_checkpoint(
        &self,
        provider: impl Into<String>,
        run_id: impl Into<String>,
        now: impl Into<String>,
    ) -> Result<(), StoreError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::AgentTool(AgentToolCommand::FinalizeCheckpoint {
            provider: provider.into(),
            run_id: run_id.into(),
            now: now.into(),
            reply,
        }))?;
        receive(response).await
    }
}

pub(crate) fn execute(connection: &mut Connection, command: AgentToolCommand) -> bool {
    match command {
        AgentToolCommand::Apply { input, reply } => {
            let result = apply(connection, &input);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        AgentToolCommand::BeginCheckpoint {
            provider,
            run_id,
            session_id,
            now,
            reply,
        } => {
            let result = begin_checkpoint(connection, &provider, &run_id, &session_id, &now);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
        AgentToolCommand::FinalizeCheckpoint {
            provider,
            run_id,
            now,
            reply,
        } => {
            let result = finalize_checkpoint(connection, &provider, &run_id, &now);
            let changed = result.is_ok();
            let _ = reply.send(result);
            changed
        }
    }
}

fn apply(connection: &mut Connection, input: &AgentToolInput) -> Result<Value, StoreError> {
    if !matches!(input.provider.as_str(), "codex" | "claude") {
        return Err(StoreError::InvalidMutation);
    }
    let transaction = connection.transaction().map_err(sqlite_error)?;
    let session = resolve_session(&transaction, input)?;
    let result = match input.name.as_str() {
        "feed.post" => post(&transaction, input, &session)?,
        "feed.skip" => skip(&transaction, input, &session)?,
        "signal.transition" => transition(&transaction, input, &session)?,
        _ => return Err(StoreError::InvalidMutation),
    };
    transaction.commit().map_err(sqlite_error)?;
    Ok(result)
}

fn resolve_session(
    connection: &Connection,
    input: &AgentToolInput,
) -> Result<StoredSession, StoreError> {
    let task_id = string(&input.arguments, "task_id", 160)?;
    let direct = connection
        .query_row(
            "SELECT * FROM sessions WHERE provider = ?1 AND provider_session_id = ?2",
            params![input.provider, task_id],
            super::session_from_row,
        )
        .optional()
        .map_err(sqlite_error)?;
    let checkpoint = if direct.is_none() {
        connection
            .query_row(
                "SELECT sessions.* FROM feed_checkpoints
                 JOIN sessions ON sessions.id = feed_checkpoints.session_id
                 WHERE feed_checkpoints.agent_id = ?1 AND feed_checkpoints.task_id = ?2
                 ORDER BY feed_checkpoints.started_at DESC LIMIT 1",
                params![input.provider, task_id],
                super::session_from_row,
            )
            .optional()
            .map_err(sqlite_error)?
            .filter(|session| !session.correlation_uncertain)
    } else {
        None
    };
    let by_pid = if direct.is_none() && checkpoint.is_none() && input.parent_pid > 0 {
        connection
            .query_row(
                "SELECT * FROM sessions WHERE provider = ?1 AND active_pid = ?2
                 ORDER BY last_activity_at DESC LIMIT 1",
                params![input.provider, input.parent_pid],
                super::session_from_row,
            )
            .optional()
            .map_err(sqlite_error)?
            .filter(|session| !session.correlation_uncertain)
    } else {
        None
    };
    let cutoff = chrono::DateTime::parse_from_rfc3339(&input.now)
        .map_err(|_| StoreError::InvalidMutation)?
        - chrono::Duration::hours(12);
    let open_checkpoint = if direct.is_none() && checkpoint.is_none() && by_pid.is_none() {
        let mut statement = connection
            .prepare(
                "SELECT sessions.* FROM feed_checkpoints
                 JOIN sessions ON sessions.id = feed_checkpoints.session_id
                 WHERE feed_checkpoints.agent_id = ?1 AND feed_checkpoints.decision_kind IS NULL
                   AND feed_checkpoints.started_at >= ?2
                 ORDER BY feed_checkpoints.started_at DESC LIMIT 2",
            )
            .map_err(sqlite_error)?;
        let matches = statement
            .query_map(
                params![
                    input.provider,
                    cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                ],
                super::session_from_row,
            )
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        (matches.len() == 1)
            .then(|| matches.into_iter().next())
            .flatten()
            .filter(|session| !session.correlation_uncertain)
    } else {
        None
    };
    let by_cwd = if direct.is_none()
        && checkpoint.is_none()
        && by_pid.is_none()
        && open_checkpoint.is_none()
        && !input.cwd.is_empty()
    {
        let mut statement = connection
            .prepare(
                "SELECT * FROM sessions
                 WHERE provider = ?1 AND cwd = ?2 AND active_pid IS NOT NULL
                 ORDER BY last_activity_at DESC LIMIT 2",
            )
            .map_err(sqlite_error)?;
        let matches = statement
            .query_map(params![input.provider, input.cwd], super::session_from_row)
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        (matches.len() == 1)
            .then(|| matches.into_iter().next())
            .flatten()
            .filter(|session| !session.correlation_uncertain)
    } else {
        None
    };
    let existing = direct
        .or(checkpoint)
        .or(by_pid)
        .or(open_checkpoint)
        .or(by_cwd);
    if let Some(mut session) = existing {
        session.last_activity_at = input.now.clone();
        session.status = "running".into();
        super::upsert_session(connection, &session)?;
        return Ok(session);
    }
    let provider_session_id = format!("tool:{task_id}");
    let session = StoredSession {
        id: stable_session_id(&input.provider, &provider_session_id),
        project_id: None,
        provider: input.provider.clone(),
        surface: "unknown".into(),
        provider_session_id,
        title: format!(
            "{} · {task_id}",
            if input.provider == "codex" {
                "Codex"
            } else {
                "Claude"
            }
        ),
        cwd: (!input.cwd.is_empty()).then(|| input.cwd.clone()),
        transcript_path: None,
        status: "running".into(),
        last_activity_at: input.now.clone(),
        created_at: input.now.clone(),
        active_pid: (input.parent_pid > 0).then_some(input.parent_pid),
        process_started_at: None,
        tty: None,
        correlation_uncertain: true,
        capabilities: json!({
            "discovered": false, "liveObserved": true, "replyable": false,
            "approvableOnce": false, "approvableSession": false,
            "approvablePersistent": false, "resumable": false, "diffAvailable": false,
        }),
    };
    super::upsert_session(connection, &session)
}

fn post(
    connection: &Connection,
    input: &AgentToolInput,
    session: &StoredSession,
) -> Result<Value, StoreError> {
    validate_allowed_keys(
        &input.arguments,
        &[
            "task_id",
            "kind",
            "presentation",
            "headline",
            "takeaway",
            "highlights",
            "blocks",
            "proof",
            "content",
            "dedupe_key",
            "state",
            "state_reason",
        ],
    )?;
    let task_id = string(&input.arguments, "task_id", 160)?;
    let kind = string(&input.arguments, "kind", 24)?;
    if !matches!(
        kind.as_str(),
        "progress" | "decision" | "attention" | "result" | "failure"
    ) {
        return Err(StoreError::InvalidMutation);
    }
    let headline = string(&input.arguments, "headline", 72)?;
    let takeaway = string(&input.arguments, "takeaway", 320)?;
    let dedupe_key = string(&input.arguments, "dedupe_key", 240)?;
    let proof = optional_string(&input.arguments, "proof", 160)?;
    let highlights = validate_highlights(input.arguments.get("highlights"))?;
    let blocks = validate_blocks(input.arguments.get("blocks"))?;
    let content = input
        .arguments
        .get("content")
        .map(|content| validate_content(connection, content))
        .transpose()?;
    let effective_content = content.clone().unwrap_or_else(|| json!({ "type": "text" }));
    let presentation = resolve_presentation(
        &kind,
        input.arguments.get("presentation"),
        &blocks,
        &effective_content,
    )?;
    if kind == "progress" && proof.is_none() && effective_content["type"] == "text" {
        return Err(StoreError::InvalidMutation);
    }
    let state = optional_string(&input.arguments, "state", 40)?;
    let state_reason = optional_string(&input.arguments, "state_reason", 500)?;
    if state.is_some() != state_reason.is_some() {
        return Err(StoreError::InvalidMutation);
    }
    if let Some(state) = state.as_deref() {
        if !matches!(
            state,
            "running" | "waiting_input" | "reviewing" | "user_review" | "failed" | "completed"
        ) {
            return Err(StoreError::InvalidMutation);
        }
        let required_kind = match state {
            "waiting_input" => Some("attention"),
            "user_review" | "completed" => Some("result"),
            "failed" => Some("failure"),
            _ => None,
        };
        if required_kind.is_some_and(|required| required != kind) {
            return Err(StoreError::InvalidMutation);
        }
    }
    let existing = connection.query_row(
        "SELECT id, created_at FROM feed_posts WHERE agent_id = ?1 AND run_id = ?2 AND dedupe_key = ?3",
        params![input.provider, session.provider_session_id, dedupe_key],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ).optional().map_err(sqlite_error)?;
    let mut stored_content = json!({
        "presentation": presentation,
        "headline": redact(&headline, 72),
        "takeaway": redact(&takeaway, 320),
        "highlights": highlights.into_iter().map(|value| redact(&value, 100)).collect::<Vec<_>>(),
        "blocks": blocks.into_iter().map(redact_value).collect::<Vec<_>>(),
    });
    if let Some(proof) = proof.as_deref() {
        stored_content["proof"] = redact(proof, 160).into();
    }
    if let Some(content) = content {
        stored_content["content"] = content;
    }
    let recent_progress = if kind == "progress" {
        let now = chrono::DateTime::parse_from_rfc3339(&input.now)
            .map_err(|_| StoreError::InvalidMutation)?;
        let window_start = (now - chrono::Duration::minutes(10))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        connection
            .query_row(
                "SELECT id FROM feed_posts WHERE agent_id = ?1 AND run_id = ?2
                         AND task_id = ?3 AND kind = 'progress' AND source = 'agent'
                         AND created_at >= ?4 ORDER BY created_at DESC LIMIT 1",
                params![
                    input.provider,
                    session.provider_session_id,
                    task_id,
                    window_start
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sqlite_error)?
    } else {
        None
    };
    let (post_id, created_at, inserted, coalesced) = if let Some((id, at)) = existing {
        (id, at, false, false)
    } else if let Some(id) = recent_progress {
        connection
            .execute(
                "UPDATE feed_posts SET project_id = ?1, session_id = ?2, title = ?3, body = ?4,
             dedupe_key = ?5, created_at = ?6, content_json = ?7 WHERE id = ?8",
                params![
                    session.project_id,
                    session.id,
                    redact(&headline, 72),
                    redact(&takeaway, 320),
                    dedupe_key,
                    input.now,
                    stored_content.to_string(),
                    id
                ],
            )
            .map_err(sqlite_error)?;
        (id, input.now.clone(), false, true)
    } else {
        let id = uuid::Uuid::now_v7().to_string();
        connection.execute(
            "INSERT INTO feed_posts(id, project_id, task_id, run_id, agent_id, session_id, kind, title, body, dedupe_key, source, created_at, content_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'agent', ?11, ?12)",
            params![id, session.project_id, task_id, session.provider_session_id, input.provider, session.id, kind, redact(&headline, 72), redact(&takeaway, 320), dedupe_key, input.now, stored_content.to_string()],
        ).map_err(sqlite_error)?;
        (id, input.now.clone(), true, false)
    };
    if (inserted || coalesced)
        && let Some(project_id) = session.project_id.as_deref()
    {
        connection
            .execute(
                "UPDATE projects SET last_used_at = CASE WHEN ?1 > last_used_at THEN ?1 ELSE last_used_at END WHERE id = ?2",
                params![input.now, project_id],
            )
            .map_err(sqlite_error)?;
    }
    record_decision(
        connection,
        DecisionArgs {
            provider: &input.provider,
            run_id: &session.provider_session_id,
            task_id: &task_id,
            session_id: &session.id,
            kind: "post",
            now: &input.now,
            reference: &post_id,
        },
    )?;
    if let (Some(state), Some(reason)) = (state.as_deref(), state_reason.as_deref()) {
        upsert_task(
            connection,
            TaskArgs {
                id: &task_id,
                run_id: &session.provider_session_id,
                provider: &input.provider,
                session_id: &session.id,
                state,
                reason,
                now: &input.now,
            },
        )?;
    }
    let mut result = json!({
        "post_id": post_id,
        "created_at": created_at,
        "deduplicated": !inserted && !coalesced,
        "coalesced": coalesced,
    });
    if let Some(state) = state {
        result["task_state"] = state.into();
    }
    Ok(result)
}

fn skip(
    connection: &Connection,
    input: &AgentToolInput,
    session: &StoredSession,
) -> Result<Value, StoreError> {
    validate_allowed_keys(&input.arguments, &["task_id", "reason"])?;
    let task_id = string(&input.arguments, "task_id", 160)?;
    let reason = string(&input.arguments, "reason", 500)?;
    record_decision(
        connection,
        DecisionArgs {
            provider: &input.provider,
            run_id: &session.provider_session_id,
            task_id: &task_id,
            session_id: &session.id,
            kind: "skip",
            now: &input.now,
            reference: &reason,
        },
    )?;
    Ok(json!({}))
}

fn transition(
    connection: &Connection,
    input: &AgentToolInput,
    session: &StoredSession,
) -> Result<Value, StoreError> {
    validate_allowed_keys(&input.arguments, &["task_id", "state", "reason"])?;
    let task_id = string(&input.arguments, "task_id", 160)?;
    let state = string(&input.arguments, "state", 40)?;
    let reason = string(&input.arguments, "reason", 500)?;
    if !matches!(
        state.as_str(),
        "running" | "waiting_input" | "reviewing" | "user_review" | "failed" | "completed"
    ) {
        return Err(StoreError::InvalidMutation);
    }
    let checkpoint = connection
        .query_row(
            "SELECT started_at, decision_kind FROM feed_checkpoints WHERE agent_id = ?1 AND run_id = ?2",
            params![input.provider, session.provider_session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(sqlite_error)?;
    let required_kind = match state.as_str() {
        "waiting_input" => Some("attention"),
        "user_review" => Some("result"),
        "failed" => Some("failure"),
        _ => None,
    };
    if let Some(required_kind) = required_kind {
        let started_at = checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.0.as_str())
            .unwrap_or("");
        let latest = connection
            .query_row(
                "SELECT kind FROM feed_posts WHERE agent_id = ?1 AND run_id = ?2
                 AND created_at >= ?3 ORDER BY created_at DESC LIMIT 1",
                params![input.provider, session.provider_session_id, started_at],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sqlite_error)?;
        if latest.as_deref() != Some(required_kind) {
            return Err(StoreError::InvalidMutation);
        }
    }
    if state == "completed" {
        let decision = checkpoint.and_then(|checkpoint| checkpoint.1);
        if decision.is_none() {
            return Err(StoreError::InvalidMutation);
        }
    }
    upsert_task(
        connection,
        TaskArgs {
            id: &task_id,
            run_id: &session.provider_session_id,
            provider: &input.provider,
            session_id: &session.id,
            state: &state,
            reason: &reason,
            now: &input.now,
        },
    )?;
    Ok(
        json!({ "id": task_id, "runId": session.provider_session_id, "agentId": input.provider, "sessionId": session.id, "state": state, "reason": reason, "updatedAt": input.now }),
    )
}

fn begin_checkpoint(
    connection: &Connection,
    provider: &str,
    run_id: &str,
    session_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO feed_checkpoints(agent_id, run_id, task_id, session_id, started_at, decision_kind, decision_at, decision_ref)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL)
         ON CONFLICT(agent_id, run_id) DO UPDATE SET task_id = excluded.task_id, session_id = excluded.session_id, started_at = excluded.started_at, decision_kind = NULL, decision_at = NULL, decision_ref = NULL",
        params![provider, run_id, format!("run:{run_id}"), session_id, now],
    ).map(|_| ()).map_err(sqlite_error)
}

fn finalize_checkpoint(
    connection: &Connection,
    provider: &str,
    run_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let checkpoint = connection
        .query_row(
            "SELECT task_id, decision_kind FROM feed_checkpoints WHERE agent_id = ?1 AND run_id = ?2",
            params![provider, run_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(sqlite_error)?;
    if checkpoint.as_ref().is_some_and(|value| value.1.is_some()) {
        return Ok(());
    }
    let task_id = checkpoint
        .map(|value| value.0)
        .unwrap_or_else(|| format!("run:{run_id}"));
    connection
        .execute(
            "INSERT INTO feed_checkpoints(agent_id, run_id, task_id, session_id, started_at, decision_kind, decision_at, decision_ref)
             VALUES (?1, ?2, ?3, NULL, ?4, 'implicit_skip', ?4, 'stop:implicit')
             ON CONFLICT(agent_id, run_id) DO UPDATE SET decision_kind = 'implicit_skip', decision_at = excluded.decision_at, decision_ref = excluded.decision_ref
             WHERE feed_checkpoints.decision_kind IS NULL",
            params![provider, run_id, task_id, now],
        )
        .map(|_| ())
        .map_err(sqlite_error)
}

struct DecisionArgs<'a> {
    provider: &'a str,
    run_id: &'a str,
    task_id: &'a str,
    session_id: &'a str,
    kind: &'a str,
    now: &'a str,
    reference: &'a str,
}

fn record_decision(connection: &Connection, input: DecisionArgs<'_>) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO feed_checkpoints(agent_id, run_id, task_id, session_id, started_at, decision_kind, decision_at, decision_ref)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?7)
         ON CONFLICT(agent_id, run_id) DO UPDATE SET task_id = excluded.task_id, session_id = excluded.session_id, decision_kind = excluded.decision_kind, decision_at = excluded.decision_at, decision_ref = excluded.decision_ref",
        params![input.provider, input.run_id, input.task_id, input.session_id, input.now, input.kind, input.reference],
    ).map(|_| ()).map_err(sqlite_error)
}

struct TaskArgs<'a> {
    id: &'a str,
    run_id: &'a str,
    provider: &'a str,
    session_id: &'a str,
    state: &'a str,
    reason: &'a str,
    now: &'a str,
}

fn upsert_task(connection: &Connection, input: TaskArgs<'_>) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO tasks(id, run_id, agent_id, session_id, state, reason, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, agent_id = excluded.agent_id, session_id = excluded.session_id, state = excluded.state, reason = excluded.reason, updated_at = excluded.updated_at",
        params![input.id, input.run_id, input.provider, input.session_id, input.state, input.reason, input.now],
    ).map(|_| ()).map_err(sqlite_error)
}

fn validate_allowed_keys(value: &Value, allowed: &[&str]) -> Result<(), StoreError> {
    let object = value.as_object().ok_or(StoreError::InvalidMutation)?;
    if object.keys().all(|key| allowed.contains(&key.as_str())) {
        Ok(())
    } else {
        Err(StoreError::InvalidMutation)
    }
}

fn optional_string(
    value: &Value,
    field: &str,
    maximum: usize,
) -> Result<Option<String>, StoreError> {
    match value.get(field) {
        None => Ok(None),
        Some(Value::String(value))
            if !value.is_empty() && value.encode_utf16().count() <= maximum =>
        {
            Ok(Some(value.clone()))
        }
        _ => Err(StoreError::InvalidMutation),
    }
}

fn validate_highlights(value: Option<&Value>) -> Result<Vec<String>, StoreError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or(StoreError::InvalidMutation)?;
    if values.len() > 3 {
        return Err(StoreError::InvalidMutation);
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 100)
                .map(str::to_owned)
                .ok_or(StoreError::InvalidMutation)
        })
        .collect()
}

fn validate_blocks(value: Option<&Value>) -> Result<Vec<Value>, StoreError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or(StoreError::InvalidMutation)?;
    if values.len() > 8 {
        return Err(StoreError::InvalidMutation);
    }
    values
        .iter()
        .map(|value| {
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidMutation)?;
            match kind {
                "fact" => {
                    validate_allowed_keys(value, &["type", "label", "detail", "value"])?;
                    required_text(value, "label", 32)?;
                    required_text(value, "detail", 120)?;
                    optional_text(value, "value", 32)?;
                }
                "metric" => {
                    validate_allowed_keys(value, &["type", "label", "value", "unit", "caption"])?;
                    required_text(value, "label", 24)?;
                    required_text(value, "value", 24)?;
                    optional_text(value, "unit", 12)?;
                    optional_text(value, "caption", 80)?;
                }
                "step" => {
                    validate_allowed_keys(value, &["type", "label", "detail", "phase"])?;
                    required_text(value, "label", 48)?;
                    optional_text(value, "detail", 120)?;
                    if !matches!(value["phase"].as_str(), Some("done" | "current" | "next")) {
                        return Err(StoreError::InvalidMutation);
                    }
                }
                "quote" => {
                    validate_allowed_keys(value, &["type", "text", "attribution"])?;
                    required_text(value, "text", 240)?;
                    optional_text(value, "attribution", 80)?;
                }
                "comparison" => {
                    validate_allowed_keys(value, &["type", "label", "left", "right"])?;
                    optional_text(value, "label", 48)?;
                    for item in [value.get("left"), value.get("right")] {
                        let item = item.ok_or(StoreError::InvalidMutation)?;
                        validate_allowed_keys(item, &["label", "value", "detail"])?;
                        required_text(item, "label", 32)?;
                        required_text(item, "value", 48)?;
                        optional_text(item, "detail", 100)?;
                    }
                }
                _ => return Err(StoreError::InvalidMutation),
            }
            Ok(value.clone())
        })
        .collect()
}

fn validate_content(connection: &Connection, value: &Value) -> Result<Value, StoreError> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or(StoreError::InvalidMutation)?;
    match kind {
        "text" => validate_allowed_keys(value, &["type"]),
        "image_album" => {
            validate_allowed_keys(value, &["type", "materialIds", "caption"])?;
            optional_text_allow_empty(value, "caption", 240)?;
            let ids = value
                .get("materialIds")
                .and_then(Value::as_array)
                .filter(|ids| (1..=10).contains(&ids.len()))
                .ok_or(StoreError::InvalidMutation)?;
            for id in ids {
                validate_material(connection, id.as_str(), &["image"])?;
            }
            Ok(())
        }
        "video" => {
            validate_allowed_keys(
                value,
                &["type", "materialId", "posterMaterialId", "caption"],
            )?;
            optional_text_allow_empty(value, "caption", 240)?;
            validate_material(connection, value["materialId"].as_str(), &["video"])?;
            if value.get("posterMaterialId").is_some() {
                validate_material(connection, value["posterMaterialId"].as_str(), &["image"])?;
            }
            Ok(())
        }
        "document" => {
            validate_allowed_keys(value, &["type", "materialId", "coverMaterialId", "summary"])?;
            optional_text_allow_empty(value, "summary", 320)?;
            validate_material(
                connection,
                value["materialId"].as_str(),
                &["pdf", "document"],
            )?;
            if value.get("coverMaterialId").is_some() {
                validate_material(connection, value["coverMaterialId"].as_str(), &["image"])?;
            }
            Ok(())
        }
        _ => Err(StoreError::InvalidMutation),
    }?;
    Ok(value.clone())
}

fn validate_material(
    connection: &Connection,
    id: Option<&str>,
    kinds: &[&str],
) -> Result<(), StoreError> {
    let id = id
        .filter(|id| !id.is_empty())
        .ok_or(StoreError::InvalidMutation)?;
    let material = connection
        .query_row(
            "SELECT kind, status FROM materials WHERE id = ?1",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(sqlite_error)?;
    match material {
        Some((kind, status)) if status == "ready" && kinds.contains(&kind.as_str()) => Ok(()),
        _ => Err(StoreError::InvalidMutation),
    }
}

fn resolve_presentation(
    kind: &str,
    value: Option<&Value>,
    blocks: &[Value],
    content: &Value,
) -> Result<Value, StoreError> {
    let value = value.ok_or(StoreError::InvalidMutation)?;
    validate_allowed_keys(
        value,
        &[
            "system",
            "theme",
            "layout",
            "typography",
            "density",
            "mediaPlacement",
        ],
    )?;
    let system = required_choice(value, "system", &["auto", "editorial", "swiss"])?;
    let theme = required_choice(
        value,
        "theme",
        &[
            "auto",
            "ink_classic",
            "indigo_porcelain",
            "forest_ink",
            "kraft_paper",
            "dune",
            "midnight_ink",
            "ikb",
            "lemon",
            "lemon_green",
            "safety_orange",
        ],
    )?;
    let layout = required_choice(
        value,
        "layout",
        &[
            "auto",
            "feature",
            "field_note",
            "quote",
            "story_split",
            "media_quiet_zone",
            "document_excerpt",
            "metric_grid",
            "status_board",
            "evidence_top",
            "comparison",
            "steps",
            "alert",
        ],
    )?;
    let typography = required_choice(
        value,
        "typography",
        &["auto", "serif", "sans", "mono", "rounded"],
    )?;
    let density = required_choice(value, "density", &["auto", "airy", "balanced", "compact"])?;
    let media = required_choice(
        value,
        "mediaPlacement",
        &["auto", "hero", "full_bleed", "split", "evidence", "inline"],
    )?;
    let theme_system = (theme != "auto").then(|| system_for_theme(theme)).flatten();
    let layout_system = (layout != "auto")
        .then(|| system_for_layout(layout))
        .flatten();
    if theme != "auto" && theme_system.is_none() || layout != "auto" && layout_system.is_none() {
        return Err(StoreError::InvalidMutation);
    }
    if theme_system.is_some() && layout_system.is_some() && theme_system != layout_system {
        return Err(StoreError::InvalidMutation);
    }
    let content_type = content["type"].as_str().unwrap_or("text");
    let block_count = |wanted: &str| {
        blocks
            .iter()
            .filter(|block| block["type"].as_str() == Some(wanted))
            .count()
    };
    let resolved_system = if system != "auto" {
        system
    } else if let Some(system) = layout_system.or(theme_system) {
        system
    } else if content_type == "document" || block_count("quote") > 0 {
        "editorial"
    } else if matches!(kind, "attention" | "failure" | "progress")
        || ["metric", "step", "comparison"]
            .iter()
            .any(|kind| block_count(kind) > 0)
    {
        "swiss"
    } else {
        "editorial"
    };
    if theme_system.is_some_and(|owner| owner != resolved_system)
        || layout_system.is_some_and(|owner| owner != resolved_system)
    {
        return Err(StoreError::InvalidMutation);
    }
    let visual_media = matches!(content_type, "image_album" | "video");
    let resolved_layout = if layout != "auto" {
        layout
    } else if resolved_system == "editorial" {
        if content_type == "document" {
            "document_excerpt"
        } else if visual_media {
            "media_quiet_zone"
        } else if block_count("quote") > 0 {
            "quote"
        } else if blocks.len() >= 4 {
            "story_split"
        } else if matches!(kind, "result" | "decision") {
            "field_note"
        } else {
            "feature"
        }
    } else if matches!(kind, "attention" | "failure") {
        "alert"
    } else if block_count("comparison") > 0 {
        "comparison"
    } else if block_count("step") > 0 {
        "steps"
    } else if visual_media {
        "evidence_top"
    } else if block_count("metric") > 0 {
        "metric_grid"
    } else {
        "status_board"
    };
    match resolved_layout {
        "quote" if block_count("quote") == 0 => return Err(StoreError::InvalidMutation),
        "media_quiet_zone" | "evidence_top" if !visual_media => {
            return Err(StoreError::InvalidMutation);
        }
        "document_excerpt" if content_type != "document" => {
            return Err(StoreError::InvalidMutation);
        }
        "metric_grid" if block_count("metric") == 0 => return Err(StoreError::InvalidMutation),
        "comparison" if block_count("comparison") == 0 => {
            return Err(StoreError::InvalidMutation);
        }
        "steps" if block_count("step") == 0 => return Err(StoreError::InvalidMutation),
        "alert" if !matches!(kind, "attention" | "failure") => {
            return Err(StoreError::InvalidMutation);
        }
        _ => {}
    }
    let resolved_media = if media != "auto" {
        if content_type == "text"
            || content_type == "document" && media != "inline"
            || visual_media && media == "inline"
        {
            return Err(StoreError::InvalidMutation);
        }
        media
    } else if content_type == "text" {
        "none"
    } else if content_type == "document" {
        "inline"
    } else {
        match resolved_layout {
            "media_quiet_zone" => "full_bleed",
            "evidence_top" => "evidence",
            "story_split" => "split",
            _ => "hero",
        }
    };
    Ok(json!({
        "system": resolved_system,
        "theme": if theme != "auto" { theme } else if resolved_system == "swiss" && matches!(kind, "attention" | "failure") { "safety_orange" } else if resolved_system == "swiss" { "lemon_green" } else { "ink_classic" },
        "layout": resolved_layout,
        "typography": if typography != "auto" { typography } else if resolved_system == "editorial" { "serif" } else { "sans" },
        "density": if density != "auto" { density } else if blocks.len() <= 2 { "airy" } else if blocks.len() >= 6 { "compact" } else { "balanced" },
        "mediaPlacement": resolved_media,
    }))
}

fn system_for_theme(theme: &str) -> Option<&'static str> {
    match theme {
        "ink_classic" | "indigo_porcelain" | "forest_ink" | "kraft_paper" | "dune"
        | "midnight_ink" => Some("editorial"),
        "ikb" | "lemon" | "lemon_green" | "safety_orange" => Some("swiss"),
        _ => None,
    }
}

fn system_for_layout(layout: &str) -> Option<&'static str> {
    match layout {
        "feature" | "field_note" | "quote" | "story_split" | "media_quiet_zone"
        | "document_excerpt" => Some("editorial"),
        "metric_grid" | "status_board" | "evidence_top" | "comparison" | "steps" | "alert" => {
            Some("swiss")
        }
        _ => None,
    }
}

fn required_choice<'a>(
    value: &'a Value,
    field: &str,
    allowed: &[&str],
) -> Result<&'a str, StoreError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .ok_or(StoreError::InvalidMutation)
}

fn required_text(value: &Value, field: &str, maximum: usize) -> Result<(), StoreError> {
    string(value, field, maximum).map(|_| ())
}

fn optional_text(value: &Value, field: &str, maximum: usize) -> Result<(), StoreError> {
    optional_string(value, field, maximum).map(|_| ())
}

fn optional_text_allow_empty(value: &Value, field: &str, maximum: usize) -> Result<(), StoreError> {
    match value.get(field) {
        None => Ok(()),
        Some(Value::String(value)) if value.encode_utf16().count() <= maximum => Ok(()),
        _ => Err(StoreError::InvalidMutation),
    }
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact(&value, 4_096)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, redact_value(value)))
                .collect(),
        ),
        value => value,
    }
}

fn redact(value: &str, maximum: usize) -> String {
    static PATTERNS: std::sync::OnceLock<Vec<(regex::Regex, &'static str)>> =
        std::sync::OnceLock::new();
    let mut redacted = value.to_owned();
    for (pattern, replacement) in PATTERNS.get_or_init(|| {
        vec![
            (
                regex::Regex::new(r"(?is)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
                    .expect("private key regex"),
                "[REDACTED_PRIVATE_KEY]",
            ),
            (
                regex::Regex::new(r"(?i)\b(?:sk|pk)-(?:live|test|proj)?[_-]?[A-Za-z0-9_-]{16,}\b")
                    .expect("API key regex"),
                "[REDACTED_API_KEY]",
            ),
            (
                regex::Regex::new(r"(?i)\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{16,}\b")
                    .expect("token regex"),
                "[REDACTED_TOKEN]",
            ),
            (
                regex::Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*\b")
                    .expect("bearer regex"),
                "Bearer [REDACTED]",
            ),
            (
                regex::Regex::new(r#"(?i)\b((?:API|ACCESS|AUTH|SECRET|PRIVATE|SESSION|DATABASE|DB|OPENAI|ANTHROPIC)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|URL)?)\s*=\s*([^\s"']+|"[^"]*"|'[^']*')"#)
                    .expect("secret assignment regex"),
                "$1=[REDACTED]",
            ),
            (
                regex::Regex::new(r#"\b([A-Z][A-Z0-9_]{1,})\s*=\s*([^\s"']+|"[^"]*"|'[^']*')"#)
                    .expect("environment assignment regex"),
                "$1=[REDACTED]",
            ),
            (
                regex::Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")
                    .expect("AWS key regex"),
                "[REDACTED_AWS_KEY]",
            ),
        ]
    }) {
        redacted = pattern.replace_all(&redacted, *replacement).into_owned();
    }
    if redacted.encode_utf16().count() <= maximum {
        return redacted;
    }
    let half = maximum.saturating_sub(32) / 2;
    let start = take_utf16(&redacted, half, false);
    let end = take_utf16(&redacted, half, true);
    format!("{start}\n… [TRUNCATED] …\n{end}")
}

fn take_utf16(value: &str, maximum: usize, from_end: bool) -> String {
    if from_end {
        let reversed = value
            .chars()
            .rev()
            .scan(0_usize, |length, character| {
                *length += character.len_utf16();
                (*length <= maximum).then_some(character)
            })
            .collect::<Vec<_>>();
        reversed.into_iter().rev().collect()
    } else {
        value
            .chars()
            .scan(0_usize, |length, character| {
                *length += character.len_utf16();
                (*length <= maximum).then_some(character)
            })
            .collect()
    }
}

fn string(value: &Value, field: &str, maximum: usize) -> Result<String, StoreError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.encode_utf16().count() <= maximum)
        .map(str::to_owned)
        .ok_or(StoreError::InvalidMutation)
}

fn stable_session_id(provider: &str, provider_session_id: &str) -> String {
    let digest = Sha256::digest(format!("{provider}\0{provider_session_id}"));
    format!("zim_{}", &format!("{digest:x}")[..24])
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::{AgentToolInput, Store, StoreError};
    use crate::StoreMode;

    fn post(arguments: serde_json::Value, now: &str) -> AgentToolInput {
        AgentToolInput {
            provider: "codex".into(),
            parent_pid: 0,
            cwd: "/tmp/zimlo-agent-tools".into(),
            name: "feed.post".into(),
            arguments,
            now: now.into(),
        }
    }

    fn valid_progress(dedupe_key: &str) -> serde_json::Value {
        json!({
            "task_id": "task-agent-tools",
            "kind": "progress",
            "presentation": {
                "system": "auto", "theme": "auto", "layout": "auto",
                "typography": "auto", "density": "auto", "mediaPlacement": "auto"
            },
            "headline": "完成验证",
            "takeaway": "OPENAI_API_KEY=secret-value 已被隐藏",
            "proof": "cargo test passed",
            "dedupe_key": dedupe_key,
        })
    }

    #[tokio::test]
    async fn validates_resolves_redacts_and_coalesces_feed_posts() {
        let directory = tempdir().expect("tempdir");
        let database = directory.path().join("zimlo.db");
        let store = Store::open(&database, StoreMode::ReadWriteCreate)
            .await
            .expect("store");
        let first = store
            .apply_agent_tool(post(
                valid_progress("progress-1"),
                "2026-09-02T10:00:00.000Z",
            ))
            .await
            .expect("first post");
        assert_eq!(first["deduplicated"], false);
        assert_eq!(first["coalesced"], false);
        let second = store
            .apply_agent_tool(post(
                valid_progress("progress-2"),
                "2026-09-02T10:05:00.000Z",
            ))
            .await
            .expect("coalesced post");
        assert_eq!(second["coalesced"], true);
        let invalid = store
            .apply_agent_tool(post(
                {
                    let mut value = valid_progress("progress-null");
                    value["proof"] = serde_json::Value::Null;
                    value
                },
                "2026-09-02T10:06:00.000Z",
            ))
            .await;
        assert_eq!(invalid, Err(StoreError::InvalidMutation));
        drop(store);

        let connection = rusqlite::Connection::open(database).expect("fixture connection");
        let content: String = connection
            .query_row("SELECT content_json FROM feed_posts", [], |row| row.get(0))
            .expect("content JSON");
        let content: serde_json::Value = serde_json::from_str(&content).expect("valid JSON");
        assert_eq!(content["presentation"]["system"], "swiss");
        assert_eq!(content["presentation"]["layout"], "status_board");
        assert_eq!(content["takeaway"], "OPENAI_API_KEY=[REDACTED] 已被隐藏");
        assert!(content.get("content").is_none());
    }
}
