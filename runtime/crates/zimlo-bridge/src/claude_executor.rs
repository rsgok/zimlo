use std::{path::PathBuf, process::Stdio, sync::OnceLock};

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, BufReader},
    process::Command,
};
use zimlo_store::{Store, StoreError, StoredSession, TaskCommandRecord, UnifiedEvent};

use crate::{
    ResolvedMaterial, TaskExecutionResult, TaskExecutor,
    agent_command::{self, AgentProvider},
    claude_stream::{ClaudeEventDraft, ClaudeStreamParser},
};

#[derive(Clone)]
pub struct ClaudeTaskExecutor {
    store: Store,
    command: Option<PathBuf>,
}

impl ClaudeTaskExecutor {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            command: None,
        }
    }

    pub fn with_command(store: Store, command: impl Into<PathBuf>) -> Self {
        Self {
            store,
            command: Some(command.into()),
        }
    }

    async fn run(
        &self,
        task: &TaskCommandRecord,
        materials: &[ResolvedMaterial],
    ) -> Result<TaskExecutionResult, String> {
        if task.provider != "claude" {
            return Err("Claude 执行器不支持这个任务 Provider。".into());
        }
        let executable = match self.command.clone() {
            Some(command) => command,
            None => agent_command::resolve(AgentProvider::Claude)
                .await
                .ok_or_else(|| {
                    "未找到 Claude Code Runtime。请确认应用已安装，或在 Zimlo 设置中检查 Runtime 接入。"
                        .to_owned()
                })?,
        };
        let existing = match task.kind.as_str() {
            "create" => None,
            "follow_up" => Some(
                self.store
                    .get_session(task.session_id.clone().unwrap_or_default())
                    .await
                    .map_err(store_error)?
                    .ok_or_else(|| "找不到要继续的任务。".to_owned())?,
            ),
            _ => return Err("不支持这类 Claude 任务指令。".into()),
        };
        let cwd = existing
            .as_ref()
            .and_then(|session| session.cwd.as_deref())
            .unwrap_or(&task.cwd);
        if !tokio::fs::metadata(cwd)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            return Err("任务工作目录不存在，无法安全启动 Claude。".into());
        }

        let prompt = prompt_with_materials(&task.text, materials);
        let mut process = Command::new(&executable);
        process.arg("-p").arg(prompt).args([
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-hook-events",
        ]);
        if let Some(session) = &existing {
            process.args(["--resume", &session.provider_session_id]);
        }
        let mut child = process
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Claude Code 启动失败：{error}"))?;
        let pid = child.id().map(i64::from);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 Claude Code 输出。".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法读取 Claude Code 错误输出。".to_owned())?;
        let stderr_task = tokio::spawn(read_tail(stderr, 4_000));
        let mut lines = BufReader::new(stdout).lines();
        let mut session = existing;
        if let Some(existing) = session.as_mut() {
            *existing = self.begin_session(existing, pid).await?;
        }
        let parser_id = session
            .as_ref()
            .map(|session| session.provider_session_id.clone())
            .unwrap_or_else(|| format!("pending:{}", uuid::Uuid::now_v7()));
        let mut parser = ClaudeStreamParser::new(parser_id);

        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|error| format!("读取 Claude Code 输出失败：{error}"))?
        {
            let parsed = parser.parse(&line);
            if let (Some(existing), Some(reported)) =
                (session.as_ref(), parsed.provider_session_id.as_deref())
                && existing.provider_session_id != reported
            {
                return Err("Claude Code 返回了不匹配的 session id，已停止归属。".into());
            }
            if session.is_none()
                && let Some(provider_session_id) = parsed.provider_session_id.as_deref()
            {
                if provider_session_id.is_empty() || provider_session_id.chars().count() > 512 {
                    return Err("Claude Code 返回了无效的 session id。".into());
                }
                let created = self.create_session(task, provider_session_id, pid).await?;
                self.store
                    .attach_task_command_session(&task.id, &created.id, now())
                    .await
                    .map_err(store_error)?
                    .ok_or_else(|| "Claude 任务指令已不在执行状态。".to_owned())?;
                self.insert_instruction(&created, &task.text).await?;
                session = Some(created);
            }
            if let Some(current) = session.as_mut() {
                for event in parsed.events {
                    *current = self.insert_event(current, event).await?;
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|error| format!("等待 Claude Code 退出失败：{error}"))?;
        let stderr = stderr_task
            .await
            .map_err(|error| format!("读取 Claude Code 错误输出失败：{error}"))?
            .map_err(|error| format!("读取 Claude Code 错误输出失败：{error}"))?;
        let Some(session) = session else {
            return Err(if stderr.trim().is_empty() {
                "Claude 未返回 session id。".into()
            } else {
                redact_text(stderr.trim(), 800)
            });
        };
        let ok = status.success();
        let session = self.finish_session(&session, ok).await?;
        Ok(TaskExecutionResult {
            ok,
            session_id: Some(session.id),
            message: if ok {
                if task.kind == "create" {
                    "Claude 新任务已完成首轮执行。".into()
                } else {
                    "消息已发送，任务已完成本轮执行。".into()
                }
            } else if stderr.trim().is_empty() {
                format!("Agent 退出状态：{status}")
            } else {
                redact_text(stderr.trim(), 800)
            },
        })
    }

    async fn create_session(
        &self,
        task: &TaskCommandRecord,
        provider_session_id: &str,
        pid: Option<i64>,
    ) -> Result<StoredSession, String> {
        let at = now();
        self.store
            .upsert_session(StoredSession {
                id: stable_session_id(provider_session_id),
                project_id: task.workspace_id.clone(),
                provider: "claude".into(),
                surface: "managed".into(),
                provider_session_id: provider_session_id.into(),
                title: title(&task.text, "Claude 新任务"),
                cwd: Some(task.cwd.clone()),
                transcript_path: None,
                status: "running".into(),
                last_activity_at: at.clone(),
                created_at: at.clone(),
                active_pid: pid,
                process_started_at: Some(at),
                tty: None,
                correlation_uncertain: false,
                capabilities: running_capabilities(false),
            })
            .await
            .map_err(store_error)
    }

    async fn begin_session(
        &self,
        session: &StoredSession,
        pid: Option<i64>,
    ) -> Result<StoredSession, String> {
        let mut next = session.clone();
        next.surface = "managed".into();
        next.status = "running".into();
        next.active_pid = pid;
        next.process_started_at = Some(now());
        next.capabilities = running_capabilities(capability(&next, "diffAvailable"));
        self.store.upsert_session(next).await.map_err(store_error)
    }

    async fn finish_session(
        &self,
        session: &StoredSession,
        ok: bool,
    ) -> Result<StoredSession, String> {
        let latest = self
            .store
            .get_session(&session.id)
            .await
            .map_err(store_error)?
            .unwrap_or_else(|| session.clone());
        let mut next = latest;
        next.status = if ok { "idle" } else { "failed" }.into();
        next.active_pid = None;
        next.process_started_at = None;
        next.tty = None;
        next.last_activity_at = now();
        next.capabilities = idle_capabilities(capability(&next, "diffAvailable"));
        self.store.upsert_session(next).await.map_err(store_error)
    }

    async fn insert_instruction(&self, session: &StoredSession, text: &str) -> Result<(), String> {
        self.insert_event(
            session,
            ClaudeEventDraft {
                kind: "user_instruction".into(),
                occurred_at: now(),
                payload: json!({ "prompt": text, "source": "zimlo" }),
                provenance: "verified".into(),
                turn_id: None,
                item_id: None,
            },
        )
        .await
        .map(|_| ())
    }

    async fn insert_event(
        &self,
        session: &StoredSession,
        draft: ClaudeEventDraft,
    ) -> Result<StoredSession, String> {
        let event = self
            .store
            .insert_event(UnifiedEvent {
                id: uuid::Uuid::now_v7().to_string(),
                sequence: 0,
                provider: "claude".into(),
                session_id: session.id.clone(),
                provider_session_id: session.provider_session_id.clone(),
                turn_id: draft.turn_id,
                item_id: draft.item_id,
                kind: draft.kind,
                source: "managed_runner".into(),
                occurred_at: draft.occurred_at,
                payload: sanitize(draft.payload),
                provenance: draft.provenance,
            })
            .await
            .map_err(store_error)?
            .event;
        let mut next = session.clone();
        next.last_activity_at = event.occurred_at;
        next.status = match event.kind.as_str() {
            "needs_input" | "needs_approval" => "waiting",
            "failed" => "failed",
            "completed" => "completed",
            "session_ended" => "ended",
            _ => &next.status,
        }
        .into();
        let diff = capability(&next, "diffAvailable") || event.kind == "files_changed";
        next.capabilities = running_capabilities(diff);
        self.store.upsert_session(next).await.map_err(store_error)
    }
}

impl TaskExecutor for ClaudeTaskExecutor {
    fn supports(&self, command: &TaskCommandRecord) -> bool {
        command.provider == "claude"
    }

    async fn execute(
        &self,
        command: TaskCommandRecord,
        materials: Vec<ResolvedMaterial>,
    ) -> TaskExecutionResult {
        match self.run(&command, &materials).await {
            Ok(result) => result,
            Err(error) => {
                let session = self
                    .store
                    .get_task_command(&command.id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|command| command.session_id);
                if let Some(session_id) = session.as_deref()
                    && let Ok(Some(session)) = self.store.get_session(session_id).await
                {
                    let _ = self.finish_session(&session, false).await;
                }
                TaskExecutionResult {
                    ok: false,
                    message: redact_text(&error, 800),
                    session_id: session,
                }
            }
        }
    }
}

async fn read_tail(mut reader: impl AsyncRead + Unpin, maximum: usize) -> std::io::Result<String> {
    let mut output = String::new();
    let mut buffer = [0_u8; 1_024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        output.push_str(&String::from_utf8_lossy(&buffer[..count]));
        if output.chars().count() > maximum * 2 {
            output = output
                .chars()
                .rev()
                .take(maximum)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
        }
    }
    Ok(output)
}

fn prompt_with_materials(text: &str, materials: &[ResolvedMaterial]) -> String {
    if materials.is_empty() {
        return text.into();
    }
    let lines = materials
        .iter()
        .map(|resolved| {
            format!(
                "- {}: {} ({})\n  path: {}",
                resolved.material.kind,
                resolved.material.name,
                resolved.material.mime_type,
                resolved.path.display()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{text}\n\nZimlo 已将用户物料安全保存到以下本机路径。请按任务需要读取，回复中不要泄露绝对路径：\n{lines}"
    )
}

fn stable_session_id(provider_session_id: &str) -> String {
    let digest = Sha256::digest(format!("claude\0{provider_session_id}"));
    format!("zim_{}", &hex(&digest)[..24])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn title(text: &str, fallback: &str) -> String {
    let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = title.chars().take(72).collect::<String>();
    if title.is_empty() {
        fallback.into()
    } else {
        title
    }
}

fn capability(session: &StoredSession, key: &str) -> bool {
    session
        .capabilities
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn running_capabilities(diff_available: bool) -> Value {
    capabilities(true, false, false, diff_available)
}

fn idle_capabilities(diff_available: bool) -> Value {
    capabilities(false, true, true, diff_available)
}

fn capabilities(live: bool, replyable: bool, resumable: bool, diff: bool) -> Value {
    json!({
        "discovered": true,
        "liveObserved": live,
        "replyable": replyable,
        "approvableOnce": false,
        "approvableSession": false,
        "approvablePersistent": false,
        "resumable": resumable,
        "diffAvailable": diff,
    })
}

fn sanitize(value: Value) -> Value {
    let value = redact_value(value);
    let encoded = value.to_string();
    if encoded.len() <= 4_096 {
        value
    } else {
        let mut preview = encoded;
        loop {
            let result = json!({
                "truncated": true,
                "preview": format!("{preview}\n… [TRUNCATED] …"),
            });
            if result.to_string().len() <= 4_096 || preview.chars().count() <= 64 {
                return result;
            }
            preview = preview
                .chars()
                .take(preview.chars().count() * 4 / 5)
                .collect();
        }
    }
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact_text(&value, 4_096)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    if matches!(key.as_str(), "env" | "environment" | "secret" | "secrets") {
                        (key, Value::String("[REDACTED]".into()))
                    } else {
                        (key, redact_value(value))
                    }
                })
                .collect(),
        ),
        value => value,
    }
}

fn redact_text(value: &str, maximum: usize) -> String {
    let mut output = value.to_owned();
    for (pattern, replacement) in secret_patterns() {
        output = pattern.replace_all(&output, *replacement).into_owned();
    }
    if output.chars().count() <= maximum {
        output
    } else {
        output.chars().take(maximum).collect()
    }
}

fn secret_patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (
                Regex::new(r"(?is)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----").expect("private key regex"),
                "[REDACTED_PRIVATE_KEY]",
            ),
            (
                Regex::new(r"(?i)\b(?:sk|pk)-(?:live|test|proj)?[_-]?[A-Za-z0-9_-]{16,}\b").expect("api key regex"),
                "[REDACTED_API_KEY]",
            ),
            (
                Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*\b").expect("bearer regex"),
                "Bearer [REDACTED]",
            ),
            (
                Regex::new(r"(?i)\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{16,}\b").expect("token regex"),
                "[REDACTED_TOKEN]",
            ),
            (
                Regex::new(r#"(?i)\b((?:API|ACCESS|AUTH|SECRET|PRIVATE|SESSION|DATABASE|DB|OPENAI|ANTHROPIC)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|URL)?)\s*=\s*([^\s"']+|"[^"]*"|'[^']*')"#).expect("environment regex"),
                "$1=[REDACTED]",
            ),
            (
                Regex::new(r#"\b([A-Z][A-Z0-9_]{1,})\s*=\s*([^\s"']+|"[^"]*"|'[^']*')"#).expect("generic environment regex"),
                "$1=[REDACTED]",
            ),
            (
                Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").expect("aws key regex"),
                "[REDACTED_AWS_KEY]",
            ),
        ]
    })
}

fn store_error(error: StoreError) -> String {
    error.to_string()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::{redact_text, stable_session_id};

    #[test]
    fn stable_ids_match_the_typescript_sha256_contract() {
        assert_eq!(
            stable_session_id("claude-fixture-session"),
            "zim_c6d755f2726500f0e0013066"
        );
    }

    #[test]
    fn redacts_secrets_before_event_persistence() {
        let value = redact_text(
            "OPENAI_API_KEY=sk-proj_abcdefghijklmnop Bearer abc.def.ghi",
            800,
        );
        assert!(!value.contains("abcdefghijklmnop"));
        assert!(!value.contains("abc.def.ghi"));
    }
}
