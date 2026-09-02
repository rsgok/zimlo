use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use chrono::{Local, TimeZone as _, Utc};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use tokio::{
    fs::File,
    io::{AsyncReadExt as _, AsyncSeekExt as _},
    process::Command,
    sync::watch,
    time::{MissedTickBehavior, interval},
};
use walkdir::WalkDir;
use zimlo_store::{Store, StoredSession, UnifiedEvent};

use crate::{
    claude_stream::{ClaudeEventDraft, ClaudeStreamParser},
    codex_stream::{CodexEventDraft, CodexStreamParser},
};

const INITIAL_HEAD_BYTES: u64 = 64 * 1_024;
const INITIAL_TAIL_BYTES: u64 = 512 * 1_024;
const INCREMENTAL_BYTES: u64 = 2 * 1_024 * 1_024;
const RETENTION_DAYS: i64 = 7;
const LIMIT_PER_PROVIDER: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Codex,
    Claude,
}

impl Provider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude",
        }
    }
}

#[derive(Debug, Clone)]
struct TranscriptCandidate {
    provider: Provider,
    path: PathBuf,
    provider_session_id: String,
    modified_at: String,
    modified: SystemTime,
    size: u64,
}

#[derive(Debug, Clone)]
enum ParserState {
    Codex(CodexStreamParser),
    Claude(ClaudeStreamParser),
}

#[derive(Debug, Clone)]
struct FileState {
    parser: ParserState,
    provider_session_id: String,
    created_at: String,
    cwd: Option<String>,
    title: String,
}

#[derive(Debug)]
struct ProcessSnapshot {
    pid: i64,
    provider: Provider,
    started_at: String,
    tty: Option<String>,
    provider_session_id: Option<String>,
    session_bearing: bool,
    cwd: Option<String>,
    transcript_paths: Vec<PathBuf>,
}

pub struct DiscoveryService {
    store: Store,
    codex_root: PathBuf,
    claude_root: PathBuf,
    files: HashMap<PathBuf, TranscriptCandidate>,
    states: HashMap<PathBuf, FileState>,
}

impl DiscoveryService {
    pub fn new(store: Store) -> io::Result<Self> {
        let home = dirs::home_dir().ok_or_else(|| io::Error::other("无法定位用户目录"))?;
        Ok(Self::with_roots(
            store,
            home.join(".codex/sessions"),
            home.join(".claude/projects"),
        ))
    }

    pub fn with_roots(store: Store, codex_root: PathBuf, claude_root: PathBuf) -> Self {
        Self {
            store,
            codex_root,
            claude_root,
            files: HashMap::new(),
            states: HashMap::new(),
        }
    }

    pub async fn run_until_shutdown(mut self, mut shutdown: watch::Receiver<bool>) {
        if let Err(error) = self.refresh_candidates(true).await {
            eprintln!("[zimlo:rust-discovery] 初始 transcript 扫描失败: {error}");
        }
        if let Err(error) = self.store.prune(RETENTION_DAYS).await {
            eprintln!("[zimlo:rust-discovery] 清理历史数据失败: {error}");
        }
        if let Err(error) = self.scan_processes().await {
            eprintln!("[zimlo:rust-discovery] 初始进程扫描失败: {error}");
        }

        let mut tick = interval(Duration::from_secs(2));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        tick.tick().await;
        let mut prune_ticks = 0_u32;
        loop {
            tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        return;
                    }
                }
                _ = tick.tick() => {
                    if let Err(error) = self.refresh_candidates(true).await {
                        eprintln!("[zimlo:rust-discovery] transcript 扫描失败: {error}");
                    }
                    if let Err(error) = self.tail_known_files().await {
                        eprintln!("[zimlo:rust-discovery] transcript 增量读取失败: {error}");
                    }
                    if let Err(error) = self.scan_processes().await {
                        eprintln!("[zimlo:rust-discovery] 进程扫描失败: {error}");
                    }
                    prune_ticks += 1;
                    if prune_ticks >= 10_800 {
                        prune_ticks = 0;
                        if let Err(error) = self.store.prune(RETENTION_DAYS).await {
                            eprintln!("[zimlo:rust-discovery] 清理历史数据失败: {error}");
                        }
                    }
                }
            }
        }
    }

    async fn refresh_candidates(&mut self, ingest_new: bool) -> Result<(), io::Error> {
        let codex_root = self.codex_root.clone();
        let claude_root = self.claude_root.clone();
        let candidates =
            tokio::task::spawn_blocking(move || discover_candidates(&codex_root, &claude_root))
                .await
                .map_err(io::Error::other)?;
        for candidate in candidates {
            let is_new = !self.files.contains_key(&candidate.path);
            self.files.insert(candidate.path.clone(), candidate.clone());
            if is_new && ingest_new {
                self.ingest_candidate(&candidate).await?;
            }
        }
        Ok(())
    }

    async fn tail_known_files(&mut self) -> Result<(), io::Error> {
        let paths = self.files.keys().cloned().collect::<Vec<_>>();
        for path in paths {
            let Ok(metadata) = tokio::fs::metadata(&path).await else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let changed = self.files.get(&path).is_some_and(|candidate| {
                candidate.size != metadata.len() || candidate.modified != modified
            });
            if !changed {
                continue;
            }
            let candidate = {
                let candidate = self.files.get_mut(&path).expect("known candidate");
                candidate.size = metadata.len();
                candidate.modified = modified;
                candidate.modified_at = system_time_iso(modified);
                candidate.clone()
            };
            self.ingest_candidate(&candidate).await?;
        }
        Ok(())
    }

    fn state_for(&mut self, candidate: &TranscriptCandidate) -> &mut FileState {
        self.states
            .entry(candidate.path.clone())
            .or_insert_with(|| {
                let title = default_title(candidate, None);
                FileState {
                    parser: match candidate.provider {
                        Provider::Codex => ParserState::Codex(CodexStreamParser::new(
                            &candidate.provider_session_id,
                        )),
                        Provider::Claude => ParserState::Claude(ClaudeStreamParser::new(
                            &candidate.provider_session_id,
                        )),
                    },
                    provider_session_id: candidate.provider_session_id.clone(),
                    created_at: candidate.modified_at.clone(),
                    cwd: None,
                    title,
                }
            })
    }

    async fn ingest_candidate(&mut self, candidate: &TranscriptCandidate) -> Result<(), io::Error> {
        let path = candidate.path.to_string_lossy().into_owned();
        let prior_offset = self
            .store
            .get_offset(path.clone())
            .await
            .map_err(io::Error::other)?;
        let mut file = File::open(&candidate.path).await?;
        if prior_offset.is_none() {
            let head_length = candidate.size.min(INITIAL_HEAD_BYTES);
            self.read_and_parse(&mut file, candidate, 0, head_length, false)
                .await?;
            if candidate.size > head_length {
                let tail_start = head_length.max(candidate.size.saturating_sub(INITIAL_TAIL_BYTES));
                self.read_and_parse(
                    &mut file,
                    candidate,
                    tail_start,
                    candidate.size - tail_start,
                    tail_start > 0,
                )
                .await?;
            }
            self.store
                .set_offset(
                    path,
                    candidate.size as i64,
                    candidate.size as i64,
                    &candidate.modified_at,
                )
                .await
                .map_err(io::Error::other)?;
        } else {
            let prior_offset = prior_offset.unwrap_or_default().max(0) as u64;
            let start = if candidate.size < prior_offset {
                0
            } else {
                prior_offset
            };
            let length = (candidate.size - start).min(INCREMENTAL_BYTES);
            if length > 0 {
                let consumed = self
                    .read_and_parse(&mut file, candidate, start, length, start > 0)
                    .await?;
                self.store
                    .set_offset(
                        path,
                        (start + consumed) as i64,
                        candidate.size as i64,
                        &candidate.modified_at,
                    )
                    .await
                    .map_err(io::Error::other)?;
            }
        }
        self.ensure_session(candidate, &candidate.modified_at)
            .await?;
        Ok(())
    }

    async fn read_and_parse(
        &mut self,
        file: &mut File,
        candidate: &TranscriptCandidate,
        start: u64,
        length: u64,
        skip_partial_first_line: bool,
    ) -> Result<u64, io::Error> {
        if length == 0 {
            return Ok(0);
        }
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let mut buffer = vec![0_u8; length as usize];
        let bytes_read = file.read(&mut buffer).await?;
        buffer.truncate(bytes_read);
        let Some(last_newline) = buffer.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(0);
        };
        let complete = &buffer[..=last_newline];
        let mut byte_offset = start;
        for (index, line_bytes) in complete.split(|byte| *byte == b'\n').enumerate() {
            let line_length = line_bytes.len() as u64 + 1;
            if !(skip_partial_first_line && index == 0) && !line_bytes.is_empty() {
                let line = String::from_utf8_lossy(line_bytes);
                let events = self.parse_line(candidate, &line);
                let session = self
                    .ensure_session(candidate, &candidate.modified_at)
                    .await?;
                for (event_index, event) in events.into_iter().enumerate() {
                    let event = event.into_event(
                        candidate,
                        &session,
                        stable_event_id(&candidate.path, byte_offset, event_index, &line),
                    );
                    self.ingest_event(event).await?;
                }
            }
            byte_offset += line_length;
        }
        Ok(complete.len() as u64)
    }

    fn parse_line(&mut self, candidate: &TranscriptCandidate, line: &str) -> Vec<ParsedEvent> {
        let default_title = default_title(candidate, None);
        let state = self.state_for(candidate);
        match &mut state.parser {
            ParserState::Codex(parser) => {
                let parsed = parser.parse(line);
                if let Some(provider_session_id) = parsed.provider_session_id {
                    state.provider_session_id = provider_session_id;
                }
                if let Some(cwd) = parsed.cwd {
                    state.cwd = Some(cwd);
                    if state.title == default_title {
                        state.title = default_title_for(
                            candidate.provider,
                            state.cwd.as_deref(),
                            &state.provider_session_id,
                        );
                    }
                }
                if let Some(created_at) = parsed.created_at {
                    state.created_at = created_at;
                }
                parsed.events.into_iter().map(ParsedEvent::Codex).collect()
            }
            ParserState::Claude(parser) => {
                let parsed = parser.parse(line);
                if let Some(provider_session_id) = parsed.provider_session_id {
                    state.provider_session_id = provider_session_id;
                }
                if let Some(cwd) = parsed.cwd {
                    state.cwd = Some(cwd);
                    if state.title == default_title {
                        state.title = default_title_for(
                            candidate.provider,
                            state.cwd.as_deref(),
                            &state.provider_session_id,
                        );
                    }
                }
                parsed.events.into_iter().map(ParsedEvent::Claude).collect()
            }
        }
    }

    async fn ensure_session(
        &self,
        candidate: &TranscriptCandidate,
        last_activity_at: &str,
    ) -> Result<StoredSession, io::Error> {
        let state = self.states.get(&candidate.path).expect("candidate state");
        let id = stable_session_id(candidate.provider, &state.provider_session_id);
        let existing = self
            .store
            .get_session(&id)
            .await
            .map_err(io::Error::other)?;
        let cwd = state.cwd.clone().or_else(|| existing.as_ref()?.cwd.clone());
        let can_resume = existing
            .as_ref()
            .is_none_or(|session| session.active_pid.is_none());
        let mut capabilities = existing
            .as_ref()
            .map(|session| session.capabilities.clone())
            .unwrap_or_else(empty_capabilities);
        set_capability(&mut capabilities, "discovered", true);
        set_capability(&mut capabilities, "replyable", can_resume && cwd.is_some());
        set_capability(&mut capabilities, "resumable", can_resume && cwd.is_some());
        let session = StoredSession {
            id,
            project_id: existing
                .as_ref()
                .and_then(|session| session.project_id.clone()),
            provider: candidate.provider.as_str().into(),
            surface: existing
                .as_ref()
                .map(|session| session.surface.clone())
                .unwrap_or_else(|| "unknown".into()),
            provider_session_id: state.provider_session_id.clone(),
            title: state.title.clone(),
            cwd,
            transcript_path: Some(candidate.path.to_string_lossy().into_owned()),
            status: existing
                .as_ref()
                .and_then(|session| session.active_pid.map(|_| "running".into()))
                .or_else(|| existing.as_ref().map(|session| session.status.clone()))
                .unwrap_or_else(|| "idle".into()),
            last_activity_at: last_activity_at.into(),
            created_at: state.created_at.clone(),
            active_pid: existing.as_ref().and_then(|session| session.active_pid),
            process_started_at: existing
                .as_ref()
                .and_then(|session| session.process_started_at.clone()),
            tty: existing.as_ref().and_then(|session| session.tty.clone()),
            correlation_uncertain: false,
            capabilities,
        };
        self.store
            .upsert_session(session)
            .await
            .map_err(io::Error::other)
    }

    async fn ingest_event(&self, mut event: UnifiedEvent) -> Result<(), io::Error> {
        event.payload = sanitize(event.payload);
        let result = self
            .store
            .insert_event(event)
            .await
            .map_err(io::Error::other)?;
        if !result.inserted {
            return Ok(());
        }
        let Some(mut session) = self
            .store
            .get_session(&result.event.session_id)
            .await
            .map_err(io::Error::other)?
        else {
            return Ok(());
        };
        session.status = match result.event.kind.as_str() {
            "needs_input" | "needs_approval" => "waiting".into(),
            "failed" => "failed".into(),
            "completed" => "completed".into(),
            "session_ended" => "ended".into(),
            _ => session.status,
        };
        session.last_activity_at = result.event.occurred_at;
        if result.event.kind == "files_changed" && contains_diff(&result.event.payload) {
            set_capability(&mut session.capabilities, "diffAvailable", true);
        }
        self.store
            .upsert_session(session)
            .await
            .map_err(io::Error::other)?;
        Ok(())
    }

    async fn scan_processes(&self) -> Result<(), io::Error> {
        let processes = scan_agent_processes().await?;
        let mut active_pids = processes
            .iter()
            .filter(|process| process.session_bearing)
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        for process in processes {
            let strong = match process.provider_session_id.as_deref() {
                Some(provider_session_id) => self
                    .store
                    .get_session_by_provider_id(process.provider.as_str(), provider_session_id)
                    .await
                    .map_err(io::Error::other)?,
                None => None,
            };
            if let Some(session) = strong {
                active_pids.insert(process.pid);
                self.mark_running(session, &process).await?;
                continue;
            }
            let transcript_path = process
                .transcript_paths
                .iter()
                .find(|path| self.files.contains_key(*path));
            if let Some(path) = transcript_path
                && let Some(candidate) = self.files.get(path)
                && let Some(state) = self.states.get(path)
            {
                active_pids.insert(process.pid);
                let session_id = stable_session_id(candidate.provider, &state.provider_session_id);
                if let Some(session) = self
                    .store
                    .get_session(&session_id)
                    .await
                    .map_err(io::Error::other)?
                {
                    self.mark_running(session, &process).await?;
                    continue;
                }
            }
            if !process.session_bearing {
                continue;
            }
            let provider_session_id = format!("process:{}:{}", process.pid, process.started_at);
            let session = StoredSession {
                id: stable_session_id(process.provider, &provider_session_id),
                project_id: None,
                provider: process.provider.as_str().into(),
                surface: if process.tty.is_some() {
                    "cli"
                } else {
                    "unknown"
                }
                .into(),
                provider_session_id,
                title: format!("{} · 活跃进程 {}", process.provider.label(), process.pid),
                cwd: process.cwd.clone(),
                transcript_path: None,
                status: "running".into(),
                last_activity_at: now(),
                created_at: process.started_at,
                active_pid: Some(process.pid),
                process_started_at: None,
                tty: process.tty,
                correlation_uncertain: true,
                capabilities: running_capabilities(false),
            };
            self.store
                .upsert_session(session)
                .await
                .map_err(io::Error::other)?;
        }
        self.store
            .clear_inactive_processes(active_pids)
            .await
            .map_err(io::Error::other)?;
        Ok(())
    }

    async fn mark_running(
        &self,
        mut session: StoredSession,
        process: &ProcessSnapshot,
    ) -> Result<(), io::Error> {
        if process.tty.is_some() {
            session.surface = "cli".into();
        }
        session.cwd = process.cwd.clone().or(session.cwd);
        session.status = "running".into();
        session.active_pid = Some(process.pid);
        session.process_started_at = Some(process.started_at.clone());
        session.tty.clone_from(&process.tty);
        session.correlation_uncertain = false;
        session.capabilities =
            running_capabilities(capability(&session.capabilities, "diffAvailable"));
        self.store
            .upsert_session(session)
            .await
            .map_err(io::Error::other)?;
        Ok(())
    }
}

enum ParsedEvent {
    Codex(CodexEventDraft),
    Claude(ClaudeEventDraft),
}

impl ParsedEvent {
    fn into_event(
        self,
        candidate: &TranscriptCandidate,
        session: &StoredSession,
        id: String,
    ) -> UnifiedEvent {
        let (kind, occurred_at, payload, provenance, turn_id, item_id) = match self {
            Self::Codex(event) => (
                event.kind,
                event.occurred_at,
                event.payload,
                event.provenance,
                event.turn_id,
                event.item_id,
            ),
            Self::Claude(event) => (
                event.kind,
                event.occurred_at,
                event.payload,
                event.provenance,
                event.turn_id,
                event.item_id,
            ),
        };
        UnifiedEvent {
            id,
            sequence: 0,
            provider: candidate.provider.as_str().into(),
            session_id: session.id.clone(),
            provider_session_id: session.provider_session_id.clone(),
            turn_id,
            item_id,
            kind,
            source: "transcript".into(),
            occurred_at,
            payload,
            provenance,
        }
    }
}

fn discover_candidates(codex_root: &Path, claude_root: &Path) -> Vec<TranscriptCandidate> {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs((RETENTION_DAYS * 86_400) as u64))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    [
        (Provider::Codex, codex_root),
        (Provider::Claude, claude_root),
    ]
    .into_iter()
    .flat_map(|(provider, root)| {
        let mut candidates = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                !entry
                    .path()
                    .components()
                    .any(|part| part.as_os_str() == "subagents")
            })
            .filter(|entry| {
                let file = entry.file_name().to_string_lossy();
                match provider {
                    Provider::Codex => file.starts_with("rollout-") && file.ends_with(".jsonl"),
                    Provider::Claude => file.ends_with(".jsonl"),
                }
            })
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                let modified = metadata.modified().ok()?;
                let path = entry.into_path();
                (modified >= cutoff).then(|| TranscriptCandidate {
                    provider,
                    provider_session_id: provider_session_id_from_path(provider, &path),
                    path,
                    modified_at: system_time_iso(modified),
                    modified,
                    size: metadata.len(),
                })
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.modified));
        candidates.truncate(LIMIT_PER_PROVIDER);
        candidates
    })
    .collect()
}

fn provider_session_id_from_path(provider: Provider, path: &Path) -> String {
    static UUID: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let path_text = path.to_string_lossy();
    if let Some(value) = UUID
        .get_or_init(|| {
            Regex::new(
                r"(?i)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})",
            )
            .expect("uuid regex")
        })
        .captures(&path_text)
        .and_then(|captures| captures.get(1))
    {
        return value.as_str().into();
    }
    let basename = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("session");
    format!("{}-{basename}", provider.as_str())
}

fn default_title(candidate: &TranscriptCandidate, cwd: Option<&str>) -> String {
    default_title_for(candidate.provider, cwd, &candidate.provider_session_id)
}

fn default_title_for(provider: Provider, cwd: Option<&str>, provider_session_id: &str) -> String {
    let location = cwd
        .and_then(|cwd| Path::new(cwd).file_name())
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| provider_session_id.chars().take(8).collect());
    format!("{} · {location}", provider.label())
}

fn stable_session_id(provider: Provider, provider_session_id: &str) -> String {
    let digest = Sha256::digest(format!("{}\0{provider_session_id}", provider.as_str()));
    format!("zim_{}", &format!("{digest:x}")[..24])
}

fn stable_event_id(path: &Path, offset: u64, index: usize, line: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(b"\0");
    hasher.update(offset.to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(index.to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(line.as_bytes());
    let digest = hasher.finalize();
    format!("evt_{}", &format!("{digest:x}")[..32])
}

async fn scan_agent_processes() -> Result<Vec<ProcessSnapshot>, io::Error> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,lstart=,tty=,command="])
        .output()
        .await?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let pattern = Regex::new(r"^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$")
        .expect("process line regex");
    let mut base = Vec::new();
    for line in stdout.lines() {
        let Some(captures) = pattern.captures(line) else {
            continue;
        };
        let command = captures
            .get(5)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let Some(provider) = detect_provider(command) else {
            continue;
        };
        let pid = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<i64>().ok())
            .unwrap_or_default();
        let started_at = captures
            .get(3)
            .and_then(|value| {
                chrono::NaiveDateTime::parse_from_str(value.as_str(), "%a %b %e %H:%M:%S %Y").ok()
            })
            .and_then(|value| Local.from_local_datetime(&value).single())
            .map(|value| {
                value
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or_else(now);
        let tty = captures
            .get(4)
            .map(|value| value.as_str())
            .filter(|value| *value != "??")
            .map(str::to_owned);
        let provider_session_id = resumed_session_id(provider, command);
        let session_bearing = provider == Provider::Claude
            || !(command.contains(" app-server") || command.contains(" sandbox"));
        base.push((
            pid,
            provider,
            started_at,
            tty,
            provider_session_id,
            session_bearing,
        ));
    }
    let mut result = Vec::with_capacity(base.len());
    for (pid, provider, started_at, tty, provider_session_id, session_bearing) in base {
        let (cwd, transcript_paths) = lsof_details(pid).await;
        result.push(ProcessSnapshot {
            pid,
            provider,
            started_at,
            tty,
            provider_session_id,
            session_bearing,
            cwd,
            transcript_paths,
        });
    }
    Ok(result)
}

fn detect_provider(command: &str) -> Option<Provider> {
    let executable = command
        .split_whitespace()
        .next()
        .and_then(|value| Path::new(value).file_name())
        .and_then(OsStr::to_str);
    match executable {
        Some("codex") => Some(Provider::Codex),
        Some("claude") => Some(Provider::Claude),
        _ => None,
    }
}

fn resumed_session_id(provider: Provider, command: &str) -> Option<String> {
    let pattern = match provider {
        Provider::Claude => r"(?i)(?:^|\s)(?:--resume|-r)\s+([0-9a-f-]{8,})\b",
        Provider::Codex => r"(?i)(?:^|\s)(?:exec\s+)?resume\s+([0-9a-f-]{8,})\b",
    };
    Regex::new(pattern)
        .expect("resume regex")
        .captures(command)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().into())
}

async fn lsof_details(pid: i64) -> (Option<String>, Vec<PathBuf>) {
    let Ok(output) = Command::new("/usr/sbin/lsof")
        .args(["-p", &pid.to_string(), "-Fn"])
        .output()
        .await
    else {
        return (None, Vec::new());
    };
    if !output.status.success() {
        return (None, Vec::new());
    }
    let mut cwd = None;
    let mut transcript_paths = Vec::new();
    let mut descriptor = "";
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix('f') {
            descriptor = value;
            continue;
        }
        let Some(path) = line.strip_prefix('n') else {
            continue;
        };
        if descriptor == "cwd" {
            cwd = Some(path.into());
        }
        if path.ends_with(".jsonl")
            && (path.contains("/.codex/sessions/") || path.contains("/.claude/projects/"))
        {
            transcript_paths.push(PathBuf::from(path));
        }
    }
    (cwd, transcript_paths)
}

fn empty_capabilities() -> Value {
    json!({
        "discovered": true,
        "liveObserved": false,
        "replyable": false,
        "approvableOnce": false,
        "approvableSession": false,
        "approvablePersistent": false,
        "resumable": true,
        "diffAvailable": false,
    })
}

fn running_capabilities(diff_available: bool) -> Value {
    let mut capabilities = empty_capabilities();
    set_capability(&mut capabilities, "liveObserved", true);
    set_capability(&mut capabilities, "replyable", false);
    set_capability(&mut capabilities, "resumable", false);
    set_capability(&mut capabilities, "diffAvailable", diff_available);
    capabilities
}

fn set_capability(capabilities: &mut Value, name: &str, enabled: bool) {
    if !capabilities.is_object() {
        *capabilities = empty_capabilities();
    }
    capabilities
        .as_object_mut()
        .expect("capabilities object")
        .insert(name.into(), enabled.into());
}

fn capability(capabilities: &Value, name: &str) -> bool {
    capabilities
        .get(name)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn contains_diff(value: &Value) -> bool {
    match value {
        Value::String(value) => value.contains("diff") || value.contains("*** Begin Patch"),
        Value::Array(values) => values.iter().any(contains_diff),
        Value::Object(values) => {
            values
                .keys()
                .any(|key| matches!(key.as_str(), "diff" | "patch"))
                || values.values().any(contains_diff)
        }
        _ => false,
    }
}

pub(super) fn sanitize(value: Value) -> Value {
    let value = redact_value(value, None);
    let encoded = value.to_string();
    if encoded.len() <= 4_096 {
        return value;
    }
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

fn redact_value(value: Value, path: Option<&str>) -> Value {
    match value {
        Value::String(value) => Value::String(redact_text(&value)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_value(value, path))
                .collect(),
        ),
        Value::Object(values) => {
            let object_path = values
                .iter()
                .find(|(key, value)| {
                    matches!(
                        key.as_str(),
                        "path" | "file_path" | "filePath" | "filename" | "name"
                    ) && value.is_string()
                })
                .and_then(|(_, value)| value.as_str().map(str::to_owned))
                .or_else(|| path.map(str::to_owned));
            let env_file = object_path.as_deref().is_some_and(|path| {
                Path::new(path)
                    .file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name == ".env" || name.starts_with(".env."))
            });
            Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| {
                        let value =
                            if matches!(key.as_str(), "env" | "environment" | "secret" | "secrets")
                            {
                                Value::String("[REDACTED]".into())
                            } else if env_file
                                && matches!(
                                    key.as_str(),
                                    "content"
                                        | "text"
                                        | "output"
                                        | "value"
                                        | "data"
                                        | "diff"
                                        | "patch"
                                )
                            {
                                Value::String("[REDACTED_ENV_FILE]".into())
                            } else {
                                redact_value(value, object_path.as_deref())
                            };
                        (key, value)
                    })
                    .collect::<Map<_, _>>(),
            )
        }
        value => value,
    }
}

fn redact_text(value: &str) -> String {
    let mut output = value.to_owned();
    for (pattern, replacement) in secret_patterns() {
        output = pattern.replace_all(&output, *replacement).into_owned();
    }
    if output.chars().count() <= 4_096 {
        output
    } else {
        let half = (4_096 - 32) / 2;
        let head = output.chars().take(half).collect::<String>();
        let tail = output
            .chars()
            .rev()
            .take(half)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        format!("{head}\n… [TRUNCATED] …\n{tail}")
    }
}

fn secret_patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: std::sync::OnceLock<Vec<(Regex, &'static str)>> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (Regex::new(r"(?is)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----").expect("private key regex"), "[REDACTED_PRIVATE_KEY]"),
            (Regex::new(r"(?i)\b(?:sk|pk)-(?:live|test|proj)?[_-]?[A-Za-z0-9_-]{16,}\b").expect("api key regex"), "[REDACTED_API_KEY]"),
            (Regex::new(r"(?i)\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{16,}\b").expect("token regex"), "[REDACTED_TOKEN]"),
            (Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*\b").expect("bearer regex"), "Bearer [REDACTED]"),
            (Regex::new(r#"(?i)\b((?:API|ACCESS|AUTH|SECRET|PRIVATE|SESSION|DATABASE|DB|OPENAI|ANTHROPIC)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|URL)?)\s*=\s*([^\s"']+|"[^"]*"|'[^']*')"#).expect("secret assignment regex"), "$1=[REDACTED]"),
            (Regex::new(r#"\b([A-Z][A-Z0-9_]{1,})\s*=\s*([^\s"']+|"[^"]*"|'[^']*')"#).expect("environment assignment regex"), "$1=[REDACTED]"),
            (Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").expect("aws key regex"), "[REDACTED_AWS_KEY]"),
        ]
    })
}

fn system_time_iso(value: SystemTime) -> String {
    chrono::DateTime::<Utc>::from(value).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{Provider, provider_session_id_from_path, stable_event_id, stable_session_id};

    #[test]
    fn stable_ids_match_node_contract() {
        assert_eq!(
            stable_session_id(Provider::Codex, "codex-fixture-session"),
            "zim_eaedd2d4167cda99bea979ca"
        );
        assert_eq!(
            stable_event_id(Path::new("/tmp/a.jsonl"), 12, 0, "{}"),
            "evt_6c77dc1e25956d43a552e61ff94982d6"
        );
    }

    #[test]
    fn extracts_uuid_or_uses_provider_basename() {
        assert_eq!(
            provider_session_id_from_path(
                Provider::Codex,
                Path::new("/tmp/rollout-019cfc25-38ec-7442-86cb-d9438d50279f.jsonl")
            ),
            "019cfc25-38ec-7442-86cb-d9438d50279f"
        );
        assert_eq!(
            provider_session_id_from_path(Provider::Claude, Path::new("/tmp/chat.jsonl")),
            "claude-chat"
        );
    }
}
