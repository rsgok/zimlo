use std::collections::HashMap;

use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CodexEventDraft {
    pub kind: String,
    pub occurred_at: String,
    pub payload: Value,
    pub provenance: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ParsedCodexLine {
    pub provider_session_id: Option<String>,
    pub cwd: Option<String>,
    pub created_at: Option<String>,
    pub events: Vec<CodexEventDraft>,
}

#[derive(Debug, Clone)]
struct ToolCall {
    name: String,
    command: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct CodexStreamParser {
    provider_session_id: String,
    current_turn_id: Option<String>,
    tool_calls: HashMap<String, ToolCall>,
}

impl CodexStreamParser {
    pub(crate) fn new(provider_session_id: impl Into<String>) -> Self {
        Self {
            provider_session_id: provider_session_id.into(),
            current_turn_id: None,
            tool_calls: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn provider_session_id(&self) -> &str {
        &self.provider_session_id
    }

    pub(crate) fn parse(&mut self, line: &str) -> ParsedCodexLine {
        let Ok(Value::Object(record)) = serde_json::from_str(line) else {
            return ParsedCodexLine::default();
        };
        let at = string(&record, "timestamp")
            .map(str::to_owned)
            .unwrap_or_else(now);
        let payload = object(record.get("payload"));
        let mut parsed = ParsedCodexLine::default();

        match string(&record, "type").unwrap_or_default() {
            "session_meta" => {
                if let Some(id) = string(payload, "id") {
                    self.provider_session_id = id.into();
                }
                parsed.provider_session_id = Some(self.provider_session_id.clone());
                parsed.cwd = string(payload, "cwd").map(str::to_owned);
                parsed.created_at = string(payload, "timestamp").map(str::to_owned);
                parsed.events.push(self.event(
                    "session_started",
                    &at,
                    json!({ "cwd": payload.get("cwd"), "source": payload.get("source") }),
                    "verified",
                    None,
                ));
            }
            "turn_context" => {
                if let Some(turn_id) = string(payload, "turn_id") {
                    self.current_turn_id = Some(turn_id.into());
                }
                parsed.cwd = string(payload, "cwd").map(str::to_owned);
            }
            "event_msg" => self.parse_event_message(payload, &at, &mut parsed.events),
            "response_item" => self.parse_response_item(payload, &at, &mut parsed.events),
            _ => {}
        }
        parsed
    }

    fn parse_event_message(
        &mut self,
        payload: &Map<String, Value>,
        at: &str,
        events: &mut Vec<CodexEventDraft>,
    ) {
        if let Some(turn_id) = string(payload, "turn_id") {
            self.current_turn_id = Some(turn_id.into());
        }
        let kind = match string(payload, "type").unwrap_or_default() {
            "task_started" | "turn_started" => Some("session_started"),
            "plan_update" | "plan_updated" => Some("plan_updated"),
            "task_complete" | "turn_complete" => Some("completed"),
            "turn_aborted" | "error" => Some("failed"),
            _ => None,
        };
        if let Some(kind) = kind {
            events.push(self.event(kind, at, Value::Object(payload.clone()), "verified", None));
        }
    }

    fn parse_response_item(
        &mut self,
        payload: &Map<String, Value>,
        at: &str,
        events: &mut Vec<CodexEventDraft>,
    ) {
        let item_type = string(payload, "type").unwrap_or_default();
        if item_type == "message" && string(payload, "role") == Some("user") {
            let prompt = user_instruction(payload.get("content"));
            if !prompt.is_empty() {
                events.push(self.event(
                    "user_instruction",
                    at,
                    json!({ "prompt": prompt }),
                    "verified",
                    None,
                ));
            }
        }
        if matches!(item_type, "function_call" | "custom_tool_call") {
            self.parse_tool_call(payload, at, events);
        }
        if matches!(
            item_type,
            "function_call_output" | "custom_tool_call_output"
        ) {
            self.parse_tool_output(payload, at, events);
        }
        if item_type == "message"
            && string(payload, "role") == Some("assistant")
            && string(payload, "phase") == Some("final_answer")
        {
            events.push(self.event(
                "completed",
                at,
                json!({ "message": payload.get("content") }),
                "agent_reported",
                None,
            ));
        }
    }

    fn parse_tool_call(
        &mut self,
        payload: &Map<String, Value>,
        at: &str,
        events: &mut Vec<CodexEventDraft>,
    ) {
        let name = string(payload, "name").unwrap_or("unknown").to_owned();
        let call_id = scalar(payload.get("call_id").or_else(|| payload.get("id")))
            .unwrap_or_else(|| format!("call-{}", self.tool_calls.len() + 1));
        let input = parse_arguments(payload.get("arguments").or_else(|| payload.get("input")));
        let command = ["command", "cmd", "script"]
            .into_iter()
            .find_map(|key| string(&input, key).map(str::to_owned));
        self.tool_calls.insert(
            call_id.clone(),
            ToolCall {
                name: name.clone(),
                command: command.clone(),
            },
        );
        let lower = name.to_ascii_lowercase();
        let event = if lower.contains("request_user_input") || lower.contains("ask_user") {
            Some(("needs_input", json!({ "name": name, "input": input })))
        } else if is_file_mutation_tool(&name) {
            Some((
                "files_changed",
                json!({ "name": name, "input": input, "phase": "proposed" }),
            ))
        } else if ["exec", "shell", "command", "bash"]
            .iter()
            .any(|needle| lower.contains(needle))
        {
            Some((
                "command_started",
                json!({ "name": name, "command": command, "input": input }),
            ))
        } else {
            None
        };
        if let Some((kind, event_payload)) = event {
            events.push(self.event(kind, at, event_payload, "verified", Some(call_id)));
        }
    }

    fn parse_tool_output(
        &mut self,
        payload: &Map<String, Value>,
        at: &str,
        events: &mut Vec<CodexEventDraft>,
    ) {
        let call_id = scalar(payload.get("call_id").or_else(|| payload.get("id")))
            .unwrap_or_else(|| "unknown".into());
        let call = self.tool_calls.remove(&call_id);
        let output = payload
            .get("output")
            .or_else(|| payload.get("result"))
            .cloned()
            .unwrap_or_else(|| Value::Object(payload.clone()));
        let exit_code = find_exit_code(&output);
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
            json!({
                "name": call.as_ref().map(|call| &call.name),
                "command": call.as_ref().and_then(|call| call.command.as_deref()),
                "exitCode": exit_code,
                "output": output,
            }),
            "verified",
            Some(call_id),
        ));
    }

    fn event(
        &self,
        kind: &str,
        at: &str,
        payload: Value,
        provenance: &str,
        item_id: Option<String>,
    ) -> CodexEventDraft {
        CodexEventDraft {
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

fn string<'a>(record: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str)
}

fn scalar(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

fn parse_arguments(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(value)) => value.clone(),
        Some(Value::String(value)) => serde_json::from_str(value)
            .ok()
            .and_then(|value: Value| value.as_object().cloned())
            .unwrap_or_else(|| Map::from_iter([("raw".into(), Value::String(value.clone()))])),
        _ => Map::new(),
    }
}

fn user_instruction(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) if is_context(value) => String::new(),
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

fn is_context(value: &str) -> bool {
    let value = value.trim_start().to_ascii_lowercase();
    [
        "<recommended_plugins",
        "<environment_context",
        "<codex_internal_context",
        "<permissions instructions",
        "<app-context",
        "<skills_instructions",
        "<plugins_instructions",
        "<apps_instructions",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
}

fn is_file_mutation_tool(name: &str) -> bool {
    name == "apply_patch"
        || ["write_file", "edit_file", "create_file", "delete_file"]
            .iter()
            .any(|suffix| name == *suffix || name.ends_with(&format!("__{suffix}")))
}

fn find_exit_code(value: &Value) -> Option<i64> {
    match value {
        Value::Number(value) => value.as_i64(),
        Value::String(value) => serde_json::from_str(value)
            .ok()
            .and_then(|nested| find_exit_code(&nested))
            .or_else(|| {
                static EXIT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
                EXIT.get_or_init(|| {
                    regex::Regex::new(
                        r"(?i)(?:exit(?:_code| code)?|process exited with code)\D{0,8}(-?\d+)",
                    )
                    .expect("exit code regex")
                })
                .captures(value)
                .and_then(|captures| captures.get(1))
                .and_then(|value| value.as_str().parse().ok())
            }),
        Value::Array(values) => values.iter().find_map(find_exit_code),
        Value::Object(values) => ["exit_code", "exitCode", "code"]
            .iter()
            .find_map(|key| values.get(*key).and_then(Value::as_i64))
            .or_else(|| values.values().find_map(find_exit_code)),
        _ => None,
    }
}

fn is_test_command(command: &str) -> bool {
    static TEST: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    TEST.get_or_init(|| {
        regex::Regex::new(r"(?i)(?:^|\s|/)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|\s)(?:pytest|jest|vitest|mocha|cargo\s+test|swift\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b")
            .expect("test command regex")
    })
    .is_match(command)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::CodexStreamParser;

    #[test]
    fn parses_codex_fixture_contract() {
        let fixture =
            include_str!("../../../../packages/adapters/test/fixtures/codex-0.144.6.jsonl");
        let mut parser = CodexStreamParser::new("pending");
        let parsed = fixture
            .lines()
            .flat_map(|line| parser.parse(line).events)
            .collect::<Vec<_>>();
        assert_eq!(parser.provider_session_id(), "codex-fixture-session");
        assert_eq!(
            parsed
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            [
                "session_started",
                "command_started",
                "tests_passed",
                "completed"
            ]
        );
    }

    #[test]
    fn ignores_context_as_user_instruction() {
        let mut parser = CodexStreamParser::new("session");
        let parsed = parser.parse(
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd=/tmp</environment_context>"}]}}"#,
        );
        assert!(parsed.events.is_empty());
    }
}
