use std::{collections::HashMap, path::Path, process::Stdio, sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, RwLock, mpsc},
    task::JoinHandle,
};
use zimlo_protocol::ZIMLO_VERSION;
use zimlo_store::{Store, StoredSession, UnifiedEvent};

use crate::{ActionBroker, ResolvedMaterial, codex_approval::handle_server_request};

pub(crate) struct CodexAppServer {
    store: Store,
    broker: ActionBroker,
    child: Child,
    writer: Arc<Mutex<ChildStdin>>,
    incoming: mpsc::Receiver<Result<Value, String>>,
    stderr: Arc<Mutex<String>>,
    reader: JoinHandle<()>,
    stderr_reader: JoinHandle<()>,
    handlers: Vec<JoinHandle<()>>,
    session: Arc<RwLock<Option<StoredSession>>>,
    server_actions: Arc<Mutex<HashMap<String, String>>>,
    completed_turns: HashMap<String, Value>,
    active_turn_id: Option<String>,
    next_id: u64,
}

impl CodexAppServer {
    pub(crate) async fn start(
        store: Store,
        broker: ActionBroker,
        executable: &Path,
        cwd: &Path,
        session: Option<StoredSession>,
    ) -> Result<Self, String> {
        let mut child = Command::new(executable)
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Codex app-server 启动失败：{error}"))?;
        let writer = Arc::new(Mutex::new(
            child.stdin.take().ok_or("无法写入 Codex app-server。")?,
        ));
        let stdout = child.stdout.take().ok_or("无法读取 Codex app-server。")?;
        let stderr_pipe = child.stderr.take().ok_or("无法读取 Codex 错误输出。")?;
        let (send, incoming) = mpsc::channel(128);
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if let Ok(message) = serde_json::from_str::<Value>(&line)
                            && send.send(Ok(message)).await.is_err()
                        {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = send.send(Err("Codex app-server 已关闭输出。".into())).await;
                        break;
                    }
                    Err(error) => {
                        let _ = send
                            .send(Err(format!("读取 Codex app-server 输出失败：{error}")))
                            .await;
                        break;
                    }
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_output = Arc::clone(&stderr);
        let stderr_reader = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr_pipe);
            let mut buffer = [0_u8; 1_024];
            while let Ok(count) = reader.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                let mut output = stderr_output.lock().await;
                output.push_str(&String::from_utf8_lossy(&buffer[..count]));
                if output.chars().count() > 8_000 {
                    *output = output
                        .chars()
                        .rev()
                        .take(4_000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                }
            }
        });
        let mut server = Self {
            store,
            broker,
            child,
            writer,
            incoming,
            stderr,
            reader,
            stderr_reader,
            handlers: Vec::new(),
            session: Arc::new(RwLock::new(session)),
            server_actions: Arc::new(Mutex::new(HashMap::new())),
            completed_turns: HashMap::new(),
            active_turn_id: None,
            next_id: 1,
        };
        server
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "zimlo", "title": "Zimlo", "version": ZIMLO_VERSION },
                    "capabilities": { "experimentalApi": true },
                }),
            )
            .await?;
        server.notify("initialized", json!({})).await?;
        Ok(server)
    }

    pub(crate) fn pid(&self) -> Option<i64> {
        self.child.id().map(i64::from)
    }

    pub(crate) async fn set_session(&self, session: StoredSession) {
        *self.session.write().await = Some(session);
    }

    pub(crate) async fn start_thread(&mut self, cwd: &str) -> Result<String, String> {
        let response = self
            .request(
                "thread/start",
                json!({
                    "model": null,
                    "modelProvider": null,
                    "profile": null,
                    "cwd": cwd,
                    "approvalPolicy": null,
                    "sandbox": null,
                    "config": null,
                    "baseInstructions": null,
                    "developerInstructions": null,
                    "compactPrompt": null,
                    "includeApplyPatchTool": null,
                    "experimentalRawEvents": false,
                    "persistExtendedHistory": true,
                }),
            )
            .await?;
        string(&response["thread"]["id"])
            .or_else(|| string(&response["threadId"]))
            .ok_or_else(|| "Codex app-server 未返回新 thread id。".into())
    }

    pub(crate) async fn ensure_resumable(&mut self, thread_id: &str) -> Result<(), String> {
        let response = self
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
        if string(&response["thread"]["status"]["type"]).as_deref() == Some("active") {
            return Err(
                "Codex app-server 报告该 Session 仍处于活跃状态，Zimlo 不会并发恢复。".into(),
            );
        }
        let cwd = self
            .session
            .read()
            .await
            .as_ref()
            .and_then(|session| session.cwd.clone());
        self.request(
            "thread/resume",
            json!({ "threadId": thread_id, "cwd": cwd }),
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn run_turn(
        &mut self,
        thread_id: &str,
        text: &str,
        materials: &[ResolvedMaterial],
    ) -> Result<Value, String> {
        let cwd = self
            .session
            .read()
            .await
            .as_ref()
            .and_then(|session| session.cwd.clone());
        let response = self
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": turn_input(text, materials),
                    "cwd": cwd,
                }),
            )
            .await?;
        let turn_id = string(&response["turn"]["id"])
            .ok_or_else(|| "Codex app-server 未返回 turn id。".to_owned())?;
        self.active_turn_id = Some(turn_id.clone());
        self.wait_for_turn(&turn_id).await
    }

    pub(crate) async fn close(mut self) {
        let actions = std::mem::take(&mut *self.server_actions.lock().await);
        for action_id in actions.into_values() {
            let _ = self.broker.expire(&action_id).await;
        }
        for handler in self.handlers.drain(..) {
            handler.abort();
        }
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(1), self.child.wait()).await;
        self.reader.abort();
        self.stderr_reader.abort();
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        write(
            &self.writer,
            &json!({ "method": method, "id": id, "params": params }),
        )
        .await?;
        tokio::time::timeout(Duration::from_secs(20), self.wait_for_response(id))
            .await
            .map_err(|_| format!("Codex app-server 请求超时：{method}"))?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        write(&self.writer, &json!({ "method": method, "params": params })).await
    }

    async fn wait_for_response(&mut self, expected_id: u64) -> Result<Value, String> {
        loop {
            let message = self.next_message().await?;
            if message.get("method").is_some() {
                self.handle_method(message).await?;
                continue;
            }
            if message["id"].as_u64() != Some(expected_id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(string(&error["message"]).unwrap_or_else(|| error.to_string()));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn wait_for_turn(&mut self, turn_id: &str) -> Result<Value, String> {
        if let Some(turn) = self.completed_turns.remove(turn_id) {
            return Ok(turn);
        }
        loop {
            let message = self.next_message().await?;
            if message.get("method").is_some() {
                self.handle_method(message).await?;
                if let Some(turn) = self.completed_turns.remove(turn_id) {
                    return Ok(turn);
                }
            }
        }
    }

    async fn next_message(&mut self) -> Result<Value, String> {
        match self.incoming.recv().await {
            Some(Ok(message)) => Ok(message),
            Some(Err(error)) => Err(self.with_stderr(error).await),
            None => Err(self.with_stderr("Codex app-server 已退出。".into()).await),
        }
    }

    async fn with_stderr(&self, error: String) -> String {
        let stderr = self.stderr.lock().await.trim().to_owned();
        if stderr.is_empty() {
            error
        } else {
            format!("{error} {}", redact(&stderr, 800))
        }
    }

    async fn handle_method(&mut self, message: Value) -> Result<(), String> {
        let method = string(&message["method"]).unwrap_or_default();
        if message.get("id").is_some() {
            self.spawn_server_request(message);
            return Ok(());
        }
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        if method == "serverRequest/resolved" {
            if let Some(request_id) = scalar_string(&params["requestId"])
                && let Some(action_id) = self.server_actions.lock().await.remove(&request_id)
            {
                self.broker.expire(&action_id).await.map_err(store_error)?;
            }
            return Ok(());
        }
        let Some(session) = self.session.read().await.clone() else {
            return Ok(());
        };
        if string(&params["threadId"]).is_some_and(|id| id != session.provider_session_id) {
            return Ok(());
        }
        let turn = params.get("turn").cloned().unwrap_or_else(|| json!({}));
        let turn_id = string(&params["turnId"])
            .or_else(|| string(&turn["id"]))
            .or_else(|| self.active_turn_id.clone());
        match method.as_str() {
            "turn/started" => {
                self.ingest(&session, "session_started", params, turn_id, None)
                    .await?
            }
            "turn/plan/updated" => {
                self.ingest(&session, "plan_updated", params, turn_id, None)
                    .await?
            }
            "turn/diff/updated" => {
                self.ingest(&session, "files_changed", params, turn_id, None)
                    .await?
            }
            "item/started" | "item/completed" => {
                self.ingest_item(&session, &method, params, turn_id).await?
            }
            "turn/completed" => {
                let status = string(&turn["status"])
                    .or_else(|| string(&turn["status"]["type"]))
                    .unwrap_or_else(|| "failed".into());
                self.ingest(
                    &session,
                    if status == "completed" {
                        "completed"
                    } else {
                        "failed"
                    },
                    params,
                    turn_id.clone(),
                    None,
                )
                .await?;
                if let Some(turn_id) = turn_id {
                    self.completed_turns.insert(turn_id, turn);
                }
            }
            "error" => {
                self.ingest(&session, "failed", params, turn_id, None)
                    .await?
            }
            _ => {}
        }
        Ok(())
    }

    fn spawn_server_request(&mut self, message: Value) {
        let store = self.store.clone();
        let broker = self.broker.clone();
        let writer = Arc::clone(&self.writer);
        let session = Arc::clone(&self.session);
        let actions = Arc::clone(&self.server_actions);
        self.handlers.push(tokio::spawn(async move {
            let response = handle_server_request(store, broker, session, actions, &message).await;
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            let payload = match response {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(error) => json!({ "id": id, "error": { "code": -32603, "message": error } }),
            };
            let _ = write(&writer, &payload).await;
        }));
    }

    async fn ingest_item(
        &self,
        session: &StoredSession,
        method: &str,
        params: Value,
        turn_id: Option<String>,
    ) -> Result<(), String> {
        let item = params.get("item").cloned().unwrap_or_else(|| json!({}));
        let item_id = string(&item["id"]);
        match string(&item["type"]).as_deref() {
            Some("commandExecution") => {
                let completed = method == "item/completed";
                self.ingest(
                    session,
                    if completed {
                        "command_completed"
                    } else {
                        "command_started"
                    },
                    item.clone(),
                    turn_id.clone(),
                    item_id.clone(),
                )
                .await?;
                if completed
                    && string(&item["command"]).is_some_and(|command| is_test_command(&command))
                    && item["exitCode"].as_i64().is_some()
                {
                    self.ingest(
                        session,
                        if item["exitCode"].as_i64() == Some(0) {
                            "tests_passed"
                        } else {
                            "tests_failed"
                        },
                        item,
                        turn_id,
                        item_id,
                    )
                    .await?;
                }
            }
            Some("fileChange") => {
                self.ingest(session, "files_changed", item, turn_id, item_id)
                    .await?;
            }
            _ => {}
        }
        Ok(())
    }

    async fn ingest(
        &self,
        session: &StoredSession,
        kind: &str,
        payload: Value,
        turn_id: Option<String>,
        item_id: Option<String>,
    ) -> Result<(), String> {
        self.store
            .insert_event(UnifiedEvent {
                id: uuid::Uuid::now_v7().to_string(),
                sequence: 0,
                provider: "codex".into(),
                session_id: session.id.clone(),
                provider_session_id: session.provider_session_id.clone(),
                turn_id,
                item_id,
                kind: kind.into(),
                source: "app_server".into(),
                occurred_at: now(),
                payload: sanitize(payload),
                provenance: "verified".into(),
            })
            .await
            .map_err(store_error)?;
        Ok(())
    }
}

async fn write(writer: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut writer = writer.lock().await;
    writer
        .write_all(message.to_string().as_bytes())
        .await
        .map_err(|error| format!("写入 Codex app-server 失败：{error}"))?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|error| format!("写入 Codex app-server 失败：{error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("写入 Codex app-server 失败：{error}"))
}

fn turn_input(text: &str, materials: &[ResolvedMaterial]) -> Vec<Value> {
    let other = materials
        .iter()
        .filter(|item| item.material.kind != "image")
        .collect::<Vec<_>>();
    let text = if other.is_empty() {
        text.into()
    } else {
        format!(
            "{text}\n\nZimlo 已将用户物料保存到以下本机路径，请按需读取且不要在回复中泄露绝对路径：\n{}",
            other
                .iter()
                .map(|item| format!(
                    "- {} ({}): {}",
                    item.material.name,
                    item.material.mime_type,
                    item.path.display()
                ))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    std::iter::once(json!({ "type": "text", "text": text }))
        .chain(
            materials
                .iter()
                .filter(|item| item.material.kind == "image")
                .map(|item| json!({ "type": "localImage", "path": item.path })),
        )
        .collect()
}

fn is_test_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    [" test", "test ", "pytest", "cargo test", "vitest", "jest"]
        .iter()
        .any(|part| lower.contains(part))
}

pub(super) fn sanitize(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact(&value, 4_096)),
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let value =
                        if matches!(key.as_str(), "env" | "environment" | "secret" | "secrets") {
                            Value::String("[REDACTED]".into())
                        } else {
                            sanitize(value)
                        };
                    (key, value)
                })
                .collect(),
        ),
        value => value,
    }
}

pub(super) fn redact(value: &str, maximum: usize) -> String {
    let value = regex::Regex::new(r"(?i)\b(?:sk|pk)-(?:live|test|proj)?[_-]?[A-Za-z0-9_-]{16,}\b")
        .expect("secret regex")
        .replace_all(value, "[REDACTED_API_KEY]")
        .into_owned();
    value.chars().take(maximum).collect()
}

pub(super) fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn scalar_string(value: &Value) -> Option<String> {
    string(value)
        .or_else(|| value.as_i64().map(|value| value.to_string()))
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

pub(super) fn store_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
