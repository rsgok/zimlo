use std::collections::HashMap;

use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClaudeEventDraft {
    pub kind: String,
    pub occurred_at: String,
    pub payload: Value,
    pub provenance: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ParsedClaudeLine {
    pub provider_session_id: Option<String>,
    pub cwd: Option<String>,
    pub events: Vec<ClaudeEventDraft>,
}

#[derive(Debug, Clone)]
struct ToolCall {
    name: String,
    command: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ClaudeStreamParser {
    provider_session_id: String,
    current_turn_id: Option<String>,
    tool_calls: HashMap<String, ToolCall>,
}

impl ClaudeStreamParser {
    pub(crate) fn new(provider_session_id: impl Into<String>) -> Self {
        Self {
            provider_session_id: provider_session_id.into(),
            current_turn_id: None,
            tool_calls: HashMap::new(),
        }
    }

    pub(crate) fn parse(&mut self, line: &str) -> ParsedClaudeLine {
        let Ok(Value::Object(record)) = serde_json::from_str(line) else {
            return ParsedClaudeLine::default();
        };
        if let Some(turn_id) = string(&record, "uuid") {
            self.current_turn_id = Some(turn_id.into());
        }
        if let Some(session_id) =
            string(&record, "sessionId").or_else(|| string(&record, "session_id"))
        {
            self.provider_session_id = session_id.into();
        }
        let at = string(&record, "timestamp")
            .map(str::to_owned)
            .unwrap_or_else(now);
        let mut parsed = ParsedClaudeLine {
            provider_session_id: (!self.provider_session_id.starts_with("pending:"))
                .then(|| self.provider_session_id.clone()),
            cwd: string(&record, "cwd").map(str::to_owned),
            events: Vec::new(),
        };
        match string(&record, "type").unwrap_or_default() {
            "system" => self.parse_system(&record, &at, &mut parsed.events),
            "assistant" => self.parse_assistant(&record, &at, &mut parsed.events),
            "user" => self.parse_user(&record, &at, &mut parsed.events),
            _ => {}
        }
        parsed
    }

    fn parse_system(
        &self,
        record: &Map<String, Value>,
        at: &str,
        events: &mut Vec<ClaudeEventDraft>,
    ) {
        match string(record, "subtype").unwrap_or_default() {
            "init" => events.push(self.event(
                "session_started",
                at,
                json!({ "cwd": record.get("cwd"), "model": record.get("model") }),
                "verified",
                None,
            )),
            "session_end" => {
                events.push(self.event("session_ended", at, Value::Null, "verified", None))
            }
            subtype if subtype.contains("error") || subtype.contains("failure") => {
                events.push(self.event("failed", at, Value::Null, "verified", None));
            }
            _ => {}
        }
    }

    fn parse_assistant(
        &mut self,
        record: &Map<String, Value>,
        at: &str,
        events: &mut Vec<ClaudeEventDraft>,
    ) {
        let message = object(record.get("message"));
        for block in content(message) {
            let block = object(Some(block));
            if string(block, "type") != Some("tool_use") {
                continue;
            }
            let id = string(block, "id")
                .map(str::to_owned)
                .unwrap_or_else(|| format!("tool-{}", self.tool_calls.len() + 1));
            let name = string(block, "name").unwrap_or("unknown").to_owned();
            let input = object(block.get("input"));
            let command = ["command", "cmd", "script"]
                .into_iter()
                .find_map(|key| string(input, key).map(str::to_owned));
            self.tool_calls.insert(
                id.clone(),
                ToolCall {
                    name: name.clone(),
                    command: command.clone(),
                },
            );
            let event = match name.as_str() {
                "AskUserQuestion" => Some(("needs_input", json!({ "name": name }))),
                "Edit" | "Write" | "NotebookEdit" => Some((
                    "files_changed",
                    json!({ "name": name, "phase": "proposed" }),
                )),
                "Bash" => Some((
                    "command_started",
                    json!({ "name": name, "command": command }),
                )),
                _ => None,
            };
            if let Some((kind, payload)) = event {
                events.push(self.event(kind, at, payload, "verified", Some(id)));
            }
        }
        if string(message, "stop_reason") == Some("end_turn") {
            let text = content(message)
                .filter_map(|block| {
                    let block = object(Some(block));
                    (string(block, "type") == Some("text"))
                        .then(|| string(block, "text"))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                events.push(self.event(
                    "completed",
                    at,
                    json!({ "message": text }),
                    "agent_reported",
                    None,
                ));
            }
        }
    }

    fn parse_user(
        &mut self,
        record: &Map<String, Value>,
        at: &str,
        events: &mut Vec<ClaudeEventDraft>,
    ) {
        let message = object(record.get("message"));
        let prompt = user_instruction(message.get("content"));
        if !prompt.is_empty() {
            events.push(self.event(
                "user_instruction",
                at,
                json!({ "prompt": prompt }),
                "verified",
                None,
            ));
        }
        for block in content(message) {
            let block = object(Some(block));
            if string(block, "type") != Some("tool_result") {
                continue;
            }
            let call_id = string(block, "tool_use_id").unwrap_or("unknown");
            let call = self.tool_calls.remove(call_id);
            let exit_code = if block.get("is_error") == Some(&Value::Bool(true)) {
                Some(1)
            } else {
                block.get("content").and_then(find_exit_code)
            };
            let kind = if call
                .as_ref()
                .and_then(|call| call.command.as_deref())
                .is_some_and(is_test_command)
                && exit_code.is_some()
            {
                if exit_code == Some(0) {
                    "tests_passed"
                } else {
                    "tests_failed"
                }
            } else {
                "command_completed"
            };
            events.push(self.event(
                kind,
                at,
                json!({ "name": call.map(|call| call.name), "exitCode": exit_code }),
                "verified",
                Some(call_id.into()),
            ));
        }
    }

    fn event(
        &self,
        kind: &str,
        at: &str,
        payload: Value,
        provenance: &str,
        item_id: Option<String>,
    ) -> ClaudeEventDraft {
        ClaudeEventDraft {
            kind: kind.into(),
            occurred_at: at.into(),
            payload,
            provenance: provenance.into(),
            turn_id: self.current_turn_id.clone(),
            item_id,
        }
    }
}

fn object(value: Option<&Value>) -> &Map<String, Value> {
    match value.and_then(Value::as_object) {
        Some(value) => value,
        None => empty_object(),
    }
}

fn empty_object() -> &'static Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(Map::new)
}

fn content(record: &Map<String, Value>) -> impl Iterator<Item = &Value> {
    record
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn string<'a>(record: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str)
}

fn user_instruction(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_owned(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| user_instruction(Some(value)))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Object(record)) if string(record, "type") == Some("tool_result") => {
            String::new()
        }
        Some(Value::Object(record)) => {
            user_instruction(record.get("text").or_else(|| record.get("content")))
        }
        _ => String::new(),
    }
}

fn find_exit_code(value: &Value) -> Option<i64> {
    match value {
        Value::Number(value) => value.as_i64(),
        Value::Array(values) => values.iter().find_map(find_exit_code),
        Value::Object(record) => ["exit_code", "exitCode", "code"]
            .into_iter()
            .find_map(|key| record.get(key).and_then(Value::as_i64))
            .or_else(|| record.values().find_map(find_exit_code)),
        _ => None,
    }
}

fn is_test_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    [
        "pnpm test",
        "npm test",
        "yarn test",
        "bun test",
        "pytest",
        "jest",
        "vitest",
        "mocha",
        "cargo test",
        "swift test",
        "go test",
        "dotnet test",
        "mvn test",
        "gradle test",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::ClaudeStreamParser;

    #[test]
    fn matches_the_typescript_claude_fixture_event_contract() {
        let mut parser = ClaudeStreamParser::new("pending:fixture");
        let parsed = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/adapters/test/fixtures/claude-2.1.207.jsonl"
        ))
        .lines()
        .map(|line| parser.parse(line))
        .collect::<Vec<_>>();
        assert_eq!(
            parsed[0].provider_session_id.as_deref(),
            Some("claude-fixture-session")
        );
        assert_eq!(parsed[0].cwd.as_deref(), Some("/tmp/zimlo-fixture"));
        assert_eq!(
            parsed
                .iter()
                .flat_map(|line| line.events.iter())
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            [
                "session_started",
                "command_started",
                "tests_failed",
                "completed"
            ]
        );
        assert_eq!(parsed[3].events[0].provenance, "agent_reported");
    }

    #[test]
    fn ignores_truncated_and_unknown_records() {
        let mut parser = ClaudeStreamParser::new("pending:fixture");
        assert!(parser.parse("{not-complete").events.is_empty());
        assert!(
            parser
                .parse(r#"{"type":"future_record","payload":{"x":1}}"#)
                .events
                .is_empty()
        );
    }
}
