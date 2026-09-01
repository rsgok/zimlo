use std::{future::Future, path::PathBuf, time::Duration};

use tokio::time::{Instant, MissedTickBehavior};
use zimlo_store::{MaterialRecord, Store, StoreError, StoredSession, TaskCommandRecord};

const DEFAULT_MATERIAL_WAIT: Duration = Duration::from_secs(30);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_MATERIALS: usize = 10;
const MAX_MATERIAL_BYTES: i64 = 80 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMaterial {
    pub material: MaterialRecord,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskExecutionResult {
    pub ok: bool,
    pub message: String,
    pub session_id: Option<String>,
}

#[allow(async_fn_in_trait)]
pub trait TaskExecutor: Send + Sync {
    fn supports(&self, _command: &TaskCommandRecord) -> bool {
        true
    }

    async fn execute(
        &self,
        command: TaskCommandRecord,
        materials: Vec<ResolvedMaterial>,
    ) -> TaskExecutionResult;
}

pub struct TaskCommandRunner<E> {
    store: Store,
    executor: E,
    material_wait: Duration,
    poll_interval: Duration,
}

impl<E: TaskExecutor> TaskCommandRunner<E> {
    pub fn new(store: Store, executor: E) -> Self {
        Self {
            store,
            executor,
            material_wait: DEFAULT_MATERIAL_WAIT,
            poll_interval: DEFAULT_POLL_INTERVAL,
        }
    }

    pub fn with_timing(mut self, material_wait: Duration, poll_interval: Duration) -> Self {
        self.material_wait = material_wait;
        self.poll_interval = poll_interval.max(Duration::from_millis(1));
        self
    }

    pub async fn run_until_shutdown(
        &self,
        shutdown: impl Future<Output = ()>,
    ) -> Result<(), StoreError> {
        tokio::pin!(shutdown);
        let mut interval = tokio::time::interval(self.poll_interval);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = &mut shutdown => return Ok(()),
                _ = interval.tick() => {
                    loop {
                        tokio::select! {
                            _ = &mut shutdown => return Ok(()),
                            result = self.run_once() => {
                                if result?.is_none() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pub async fn run_once(&self) -> Result<Option<TaskCommandRecord>, StoreError> {
        let sessions = self.store.list_sessions().await?;
        let command = self.next_eligible_command(&sessions).await?;
        let Some(command) = command else {
            return Ok(None);
        };
        let Some(command) = self
            .store
            .mark_task_command_running(&command.id, now())
            .await?
        else {
            return Ok(None);
        };

        let materials = match self.prepare(&command, &sessions).await {
            Ok(materials) => materials,
            Err(error) => return self.fail(&command, error).await.map(Some),
        };
        let result = self.executor.execute(command.clone(), materials).await;
        let valid_session = match result.session_id.as_deref() {
            Some(session_id) => self.store.session_exists(session_id).await?,
            None => true,
        };
        let ok = result.ok && valid_session;
        let state = if ok { "completed" } else { "failed" };
        let error = (!ok).then(|| {
            if valid_session {
                redact(&result.message)
            } else {
                "执行器返回了尚未持久化的任务。".into()
            }
        });
        let session_id = valid_session.then_some(result.session_id).flatten();
        self.finish(&command, state, session_id, error)
            .await
            .map(Some)
    }

    async fn next_eligible_command(
        &self,
        sessions: &[StoredSession],
    ) -> Result<Option<TaskCommandRecord>, StoreError> {
        for command in self.store.list_queued_task_commands().await? {
            if !self.executor.supports(&command) {
                continue;
            }
            if command.kind == "follow_up"
                && command
                    .session_id
                    .as_deref()
                    .and_then(|id| sessions.iter().find(|session| session.id == id))
                    .is_some_and(session_is_active)
            {
                continue;
            }
            if let Some(command) = self.store.claim_task_command(&command.id, now()).await? {
                return Ok(Some(command));
            }
        }
        Ok(None)
    }

    async fn prepare(
        &self,
        command: &TaskCommandRecord,
        sessions: &[StoredSession],
    ) -> Result<Vec<ResolvedMaterial>, String> {
        if !matches!(command.provider.as_str(), "codex" | "claude") {
            return Err("不支持这个任务执行器。".into());
        }
        match command.kind.as_str() {
            "create" if command.cwd.trim().is_empty() => {
                return Err("任务缺少工作目录，无法安全创建。".into());
            }
            "create" => {}
            "follow_up" => validate_follow_up(command, sessions)?,
            _ => return Err("不支持这类任务指令。".into()),
        }
        self.wait_for_materials(&command.material_ids).await
    }

    async fn wait_for_materials(&self, ids: &[String]) -> Result<Vec<ResolvedMaterial>, String> {
        if ids.len() > MAX_MATERIALS {
            return Err("单个任务最多 10 个物料，总大小不能超过 80MB。".into());
        }
        let deadline = Instant::now() + self.material_wait;
        loop {
            let mut resolved = Vec::with_capacity(ids.len());
            let mut pending = false;
            let mut total_bytes = 0_u64;
            for id in ids {
                let material = self
                    .store
                    .get_material(id)
                    .await
                    .map_err(|error| error.to_string())?;
                let Some(material) = material else {
                    pending = true;
                    continue;
                };
                if material.status == "failed" {
                    return Err("有物料上传失败，请在物料卡片中重试。".into());
                }
                let Some(path) = material.local_path.as_deref().map(PathBuf::from) else {
                    pending = true;
                    continue;
                };
                if material.status != "ready" {
                    pending = true;
                    continue;
                }
                let Ok(metadata) = tokio::fs::metadata(&path).await else {
                    pending = true;
                    continue;
                };
                if !metadata.is_file()
                    || material.size_bytes < 0
                    || metadata.len() != material.size_bytes as u64
                {
                    return Err("物料文件校验失败，请重新上传。".into());
                }
                total_bytes = total_bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| "物料总大小无效，请重新选择。".to_owned())?;
                resolved.push(ResolvedMaterial { material, path });
            }
            if !pending {
                if total_bytes > MAX_MATERIAL_BYTES as u64 {
                    return Err("单个任务最多 10 个物料，总大小不能超过 80MB。".into());
                }
                return Ok(resolved);
            }
            if Instant::now() >= deadline {
                return Err("有物料尚未上传完成，请在物料卡片中重试。".into());
            }
            tokio::time::sleep(
                self.poll_interval
                    .min(deadline.saturating_duration_since(Instant::now())),
            )
            .await;
        }
    }

    async fn fail(
        &self,
        command: &TaskCommandRecord,
        error: String,
    ) -> Result<TaskCommandRecord, StoreError> {
        self.finish(command, "failed", None, Some(redact(&error)))
            .await
    }

    async fn finish(
        &self,
        command: &TaskCommandRecord,
        state: &str,
        session_id: Option<String>,
        error: Option<String>,
    ) -> Result<TaskCommandRecord, StoreError> {
        self.store
            .finish_task_command(&command.id, state, session_id, now(), error)
            .await?
            .ok_or(StoreError::InvalidMutation)
    }
}

fn validate_follow_up(
    command: &TaskCommandRecord,
    sessions: &[StoredSession],
) -> Result<(), String> {
    let Some(session) = command
        .session_id
        .as_deref()
        .and_then(|id| sessions.iter().find(|session| session.id == id))
    else {
        return Err("找不到要继续的任务。".into());
    };
    if session.provider != command.provider
        || session.correlation_uncertain
        || session.provider_session_id.starts_with("pending:")
    {
        return Err("任务关联仍不确定，无法安全发送指令。".into());
    }
    if session.cwd.is_none() {
        return Err("任务缺少工作目录，无法安全恢复。".into());
    }
    Ok(())
}

fn session_is_active(session: &StoredSession) -> bool {
    session.active_pid.is_some() || matches!(session.status.as_str(), "running" | "waiting")
}

fn redact(value: &str) -> String {
    value.chars().take(800).collect()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
