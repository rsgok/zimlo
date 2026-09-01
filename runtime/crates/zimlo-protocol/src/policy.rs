use std::{cmp::Ordering, collections::HashMap};

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const FEED_MERGE_WINDOW_MS: i64 = 6 * 60 * 60 * 1_000;
pub const COVERED_PRIORITY_PENALTY: i32 = 6;
pub const READ_PRIORITY_PENALTY: i32 = 10;
pub const BACKOFF_DELAYS_MS: [u64; 6] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
pub const BACKOFF_JITTER_RATIO: f64 = 0.2;
pub const CANCELABLE_COMMAND_STATES: [&str; 1] = ["queued"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedPostKind {
    Failure,
    Result,
    Decision,
    Attention,
    Progress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPostSummary {
    pub id: String,
    pub kind: FeedPostKind,
    pub task_id: String,
    pub session_id: Option<String>,
    pub created_at: String,
    pub highlights: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedOrderable {
    pub id: String,
    pub priority: i32,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSummary {
    pub scope: String,
    pub risk: String,
    #[serde(default)]
    pub confirmation_phrase: Option<String>,
}

pub fn merge_routine_posts(posts: &[FeedPostSummary]) -> Vec<FeedPostSummary> {
    let mut sorted = posts.to_vec();
    sorted.sort_by(|left, right| right.created_at.cmp(&left.created_at));

    let mut merged: Vec<FeedPostSummary> = Vec::new();
    let mut latest_by_key: HashMap<String, usize> = HashMap::new();
    for post in sorted {
        if !matches!(post.kind, FeedPostKind::Progress | FeedPostKind::Decision) {
            merged.push(post);
            continue;
        }

        let owner = post.session_id.as_deref().unwrap_or(&post.task_id);
        let key = format!("{owner}:{:?}", post.kind);
        let Some(existing_index) = latest_by_key.get(&key).copied() else {
            latest_by_key.insert(key, merged.len());
            merged.push(post);
            continue;
        };

        let within_window =
            milliseconds_between(&merged[existing_index].created_at, &post.created_at)
                .is_some_and(|difference| difference <= FEED_MERGE_WINDOW_MS);
        if !within_window {
            latest_by_key.insert(key, merged.len());
            merged.push(post);
            continue;
        }

        for highlight in post.highlights {
            if merged[existing_index].highlights.len() >= 2 {
                break;
            }
            if !merged[existing_index].highlights.contains(&highlight) {
                merged[existing_index].highlights.push(highlight);
            }
        }
    }
    merged
}

pub fn is_post_covered(
    kind: FeedPostKind,
    created_at: &str,
    latest_outcome_created_at: Option<&str>,
) -> bool {
    matches!(
        kind,
        FeedPostKind::Progress | FeedPostKind::Decision | FeedPostKind::Attention
    ) && latest_outcome_created_at.is_some_and(|outcome| outcome > created_at)
}

pub fn post_priority(kind: FeedPostKind, needs_action: bool, covered: bool, unread: bool) -> i32 {
    if needs_action {
        return 0;
    }
    post_value(kind)
        + if covered { COVERED_PRIORITY_PENALTY } else { 0 }
        + if unread { 0 } else { READ_PRIORITY_PENALTY }
}

pub fn compare_feed_items(left: &FeedOrderable, right: &FeedOrderable) -> Ordering {
    left.priority
        .cmp(&right.priority)
        .then_with(|| right.created_at.cmp(&left.created_at))
}

pub fn semantic_command_key(command: &Value) -> String {
    let Some(command) = command.as_object() else {
        return String::new();
    };
    let command_type = text_field(command, "type");
    let host = text_field(command, "hostId");
    let local_key = match command_type.as_str() {
        "task.create" => with_material_ids(
            format!(
                "{}:{}:{}:{}",
                command_type,
                text_field(command, "provider"),
                text_field(command, "workspaceId"),
                text_field(command, "text")
            ),
            command.get("materialIds"),
        ),
        "task.follow_up" | "session.message" => with_material_ids(
            format!(
                "{}:{}:{}",
                command_type,
                text_field(command, "sessionId"),
                text_field(command, "text")
            ),
            command.get("materialIds"),
        ),
        "material.register" => format!(
            "{}:{}",
            command_type,
            command
                .get("material")
                .and_then(Value::as_object)
                .map_or_else(String::new, |material| text_field(material, "id"))
        ),
        "task.command.retry" => {
            format!("{}:{}", command_type, text_field(command, "commandId"))
        }
        "task.command.cancel" => {
            let command_id = text_field(command, "commandId");
            let identifier = if command_id.is_empty() {
                text_field(command, "idempotencyKey")
            } else {
                command_id
            };
            format!("{command_type}:{identifier}")
        }
        "action.decide" => format!(
            "{}:{}:{}:{}:{}",
            command_type,
            text_field(command, "actionId"),
            text_field(command, "decisionId"),
            text_field(command, "confirmationPhrase"),
            sorted_input(command.get("input"))
        ),
        "feed.dismiss" | "feed.dismiss.set" => {
            format!("{}:{}", command_type, text_field(command, "itemId"))
        }
        "feed.seen" => format!("{}:{}", command_type, text_field(command, "postId")),
        "task.timeline.seen" => format!(
            "{}:{}:{}",
            command_type,
            text_field(command, "sessionId"),
            text_field(command, "itemId")
        ),
        "agent.profile.update" | "trust.policy.update" => {
            format!("{}:{}", command_type, text_field(command, "projectId"))
        }
        "user.profile.update"
        | "notification.settings.update"
        | "notification.device.register"
        | "notification.device.unregister" => command_type.clone(),
        _ => {
            let fields = command
                .iter()
                .filter(|(key, _)| key.as_str() != "type" && key.as_str() != "hostId")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Map<String, Value>>();
            format!(
                "{}:{}",
                command_type,
                stable_stringify(&Value::Object(fields))
            )
        }
    };
    if host.is_empty() {
        local_key
    } else {
        format!("{host}:{local_key}")
    }
}

pub fn is_command_cancelable(state: &str) -> bool {
    CANCELABLE_COMMAND_STATES.contains(&state)
}

pub fn backoff_delay_ms(attempt: f64, random_value: f64) -> u64 {
    let index = (attempt.trunc() as isize).clamp(0, BACKOFF_DELAYS_MS.len() as isize - 1) as usize;
    let base = BACKOFF_DELAYS_MS[index] as f64;
    (base * (1.0 + (random_value * 2.0 - 1.0) * BACKOFF_JITTER_RATIO)).round() as u64
}

pub fn is_quick_approvable(kind: &str, decisions: &[DecisionSummary]) -> bool {
    if kind != "approval" {
        return false;
    }
    let allow_once = decisions.iter().find(|decision| decision.scope == "once");
    let deny = decisions.iter().find(|decision| decision.scope == "deny");
    allow_once
        .is_some_and(|decision| decision.risk == "low" && decision.confirmation_phrase.is_none())
        && deny.is_some_and(|decision| decision.confirmation_phrase.is_none())
}

fn post_value(kind: FeedPostKind) -> i32 {
    match kind {
        FeedPostKind::Failure => 1,
        FeedPostKind::Result => 2,
        FeedPostKind::Decision | FeedPostKind::Attention => 3,
        FeedPostKind::Progress => 4,
    }
}

fn milliseconds_between(newer: &str, older: &str) -> Option<i64> {
    let newer = DateTime::parse_from_rfc3339(newer).ok()?;
    let older = DateTime::parse_from_rfc3339(older).ok()?;
    Some((newer - older).num_milliseconds())
}

fn text_field(command: &Map<String, Value>, key: &str) -> String {
    command
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned()
}

fn with_material_ids(base: String, value: Option<&Value>) -> String {
    match value.and_then(Value::as_array) {
        Some(materials) if !materials.is_empty() => {
            format!(
                "{base}:{}",
                stable_stringify(&Value::Array(materials.clone()))
            )
        }
        _ => base,
    }
}

fn sorted_input(value: Option<&Value>) -> String {
    let Some(input) = value.and_then(Value::as_object) else {
        return "[]".to_owned();
    };
    let mut entries = input
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key, value)))
        .collect::<Vec<_>>();
    entries.sort_by(|(left, _), (right, _)| compare_code_units(left, right));
    serde_json::to_string(&entries).expect("string pairs always serialize")
}

fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| compare_code_units(left, right));
            let fields = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON object keys always serialize"),
                        stable_stringify(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
        _ => serde_json::to_string(value).expect("JSON values always serialize"),
    }
}

fn compare_code_units(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
