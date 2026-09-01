use std::path::PathBuf;

use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use zimlo_store::{Store, StoredSession, TaskCommandRecord, UnifiedEvent};

use crate::{
    ActionBroker, ResolvedMaterial, TaskExecutionResult, TaskExecutor,
    agent_command::{self, AgentProvider},
    codex_app_server::CodexAppServer,
};

#[derive(Clone)]
pub struct CodexTaskExecutor {
    store: Store,
    broker: ActionBroker,
    command: Option<PathBuf>,
}

impl CodexTaskExecutor {
    pub fn new(store: Store, broker: ActionBroker) -> Self {
        Self {
            store,
            broker,
            command: None,
        }
    }

    pub fn with_command(store: Store, broker: ActionBroker, command: impl Into<PathBuf>) -> Self {
        Self {
            store,
            broker,
            command: Some(command.into()),
        }
    }

    async fn run(
        &self,
        task: &TaskCommandRecord,
        materials: &[ResolvedMaterial],
    ) -> Result<TaskExecutionResult, String> {
        if task.provider != "codex" {
            return Err("不支持这个任务执行器。".into());
        }
        let executable = match self.command.clone() {
            Some(command) => command,
            None => agent_command::resolve(AgentProvider::Codex)
                .await
                .ok_or_else(|| {
                    "未找到 Codex Runtime。请确认 Codex 已安装，或在 Zimlo 设置中检查 Runtime 接入。"
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
            _ => return Err("不支持这类 Codex 任务指令。".into()),
        };
        let cwd = existing
            .as_ref()
            .and_then(|session| session.cwd.as_deref())
            .unwrap_or(&task.cwd);
        if !tokio::fs::metadata(cwd)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            return Err("任务工作目录不存在，无法安全启动 Codex。".into());
        }

        let mut server = CodexAppServer::start(
            self.store.clone(),
            self.broker.clone(),
            &executable,
            cwd.as_ref(),
            existing.clone(),
        )
        .await?;
        let result = self
            .run_with_server(task, materials, existing, &mut server)
            .await;
        server.close().await;
        result
    }

    async fn run_with_server(
        &self,
        task: &TaskCommandRecord,
        materials: &[ResolvedMaterial],
        existing: Option<StoredSession>,
        server: &mut CodexAppServer,
    ) -> Result<TaskExecutionResult, String> {
        let session = if let Some(existing) = existing {
            server
                .ensure_resumable(&existing.provider_session_id)
                .await?;
            let session = self.begin_session(existing, server.pid()).await?;
            self.insert_instruction(&session, &task.text).await?;
            server.set_session(session.clone()).await;
            session
        } else {
            let thread_id = server.start_thread(&task.cwd).await?;
            if thread_id.is_empty() || thread_id.chars().count() > 512 {
                return Err("Codex app-server 返回了无效的 thread id。".into());
            }
            let session = self.create_session(task, &thread_id, server.pid()).await?;
            self.store
                .attach_task_command_session(&task.id, &session.id, now())
                .await
                .map_err(store_error)?
                .ok_or_else(|| "Codex 任务指令已不在执行状态。".to_owned())?;
            self.insert_instruction(&session, &task.text).await?;
            server.set_session(session.clone()).await;
            session
        };
        let turn = server
            .run_turn(&session.provider_session_id, &task.text, materials)
            .await?;
        let success = turn_status(&turn) == "completed";
        let session = self.finish_session(&session.id, success).await?;
        Ok(TaskExecutionResult {
            ok: success,
            session_id: Some(session.id),
            message: if success {
                if task.kind == "create" {
                    "Codex 新任务已完成首轮执行。".into()
                } else {
                    "消息已发送，任务已完成本轮执行。".into()
                }
            } else {
                "Codex 本轮执行未成功完成。".into()
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
                provider: "codex".into(),
                surface: "managed".into(),
                provider_session_id: provider_session_id.into(),
                title: title(&task.text, "Codex 新任务"),
                cwd: Some(task.cwd.clone()),
                transcript_path: None,
                status: "running".into(),
                last_activity_at: at.clone(),
                created_at: at.clone(),
                active_pid: pid,
                process_started_at: Some(at),
                tty: None,
                correlation_uncertain: false,
                capabilities: running_capabilities(),
            })
            .await
            .map_err(store_error)
    }

    async fn begin_session(
        &self,
        mut session: StoredSession,
        pid: Option<i64>,
    ) -> Result<StoredSession, String> {
        let at = now();
        session.status = "running".into();
        session.last_activity_at = at.clone();
        session.active_pid = pid;
        session.process_started_at = Some(at);
        session.surface = "managed".into();
        session.capabilities = running_capabilities();
        self.store
            .upsert_session(session)
            .await
            .map_err(store_error)
    }

    async fn finish_session(
        &self,
        session_id: &str,
        success: bool,
    ) -> Result<StoredSession, String> {
        let mut session = self
            .store
            .get_session(session_id)
            .await
            .map_err(store_error)?
            .ok_or_else(|| "Codex Session 已不存在。".to_owned())?;
        session.status = if success { "idle" } else { "failed" }.into();
        session.last_activity_at = now();
        session.active_pid = None;
        session.process_started_at = None;
        session.capabilities = idle_capabilities();
        self.store
            .upsert_session(session)
            .await
            .map_err(store_error)
    }

    async fn insert_instruction(&self, session: &StoredSession, text: &str) -> Result<(), String> {
        self.store
            .insert_event(UnifiedEvent {
                id: uuid::Uuid::now_v7().to_string(),
                sequence: 0,
                provider: "codex".into(),
                session_id: session.id.clone(),
                provider_session_id: session.provider_session_id.clone(),
                turn_id: None,
                item_id: None,
                kind: "user_instruction".into(),
                source: "app_server".into(),
                occurred_at: now(),
                payload: json!({ "prompt": redact(text, 4_096), "source": "zimlo" }),
                provenance: "verified".into(),
            })
            .await
            .map_err(store_error)?;
        Ok(())
    }
}

impl TaskExecutor for CodexTaskExecutor {
    fn supports(&self, command: &TaskCommandRecord) -> bool {
        command.provider == "codex"
    }

    async fn execute(
        &self,
        command: TaskCommandRecord,
        materials: Vec<ResolvedMaterial>,
    ) -> TaskExecutionResult {
        match self.run(&command, &materials).await {
            Ok(result) => result,
            Err(error) => {
                let session_id = self
                    .store
                    .get_task_command(&command.id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|command| command.session_id);
                if let Some(session_id) = session_id.as_deref() {
                    let _ = self.finish_session(session_id, false).await;
                }
                TaskExecutionResult {
                    ok: false,
                    message: redact(&error, 800),
                    session_id,
                }
            }
        }
    }
}

fn stable_session_id(provider_session_id: &str) -> String {
    let digest = Sha256::digest(format!("codex\0{provider_session_id}"));
    format!("zim_{}", hex(&digest)[..24].to_owned())
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

fn turn_status(turn: &Value) -> String {
    turn["status"]
        .as_str()
        .or_else(|| turn["status"]["type"].as_str())
        .unwrap_or("failed")
        .into()
}

fn running_capabilities() -> Value {
    capabilities(true, false, false)
}

fn idle_capabilities() -> Value {
    capabilities(false, true, true)
}

fn capabilities(live: bool, replyable: bool, resumable: bool) -> Value {
    json!({
        "discovered": true,
        "liveObserved": live,
        "replyable": replyable,
        "approvableOnce": false,
        "approvableSession": false,
        "approvablePersistent": false,
        "resumable": resumable,
        "diffAvailable": false,
    })
}

fn redact(value: &str, maximum: usize) -> String {
    regex::Regex::new(r"(?i)\b(?:sk|pk)-(?:live|test|proj)?[_-]?[A-Za-z0-9_-]{16,}\b")
        .expect("secret regex")
        .replace_all(value, "[REDACTED_API_KEY]")
        .chars()
        .take(maximum)
        .collect()
}

fn store_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::stable_session_id;

    #[test]
    fn stable_ids_match_the_typescript_sha256_contract() {
        assert_eq!(
            stable_session_id("codex-fixture-thread"),
            "zim_441da59eafd2822d4e2ccfd3"
        );
    }
}
