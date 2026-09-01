use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use serde_json::json;
use tempfile::tempdir;
use zimlo_store::{MaterialRecord, Store, StoreMode, StoredSession, TaskCommandRecord};

use crate::{ResolvedMaterial, TaskCommandRunner, TaskExecutionResult, TaskExecutor};

struct FakeExecutor {
    store: Store,
    calls: Arc<AtomicUsize>,
    saw_running: Arc<AtomicBool>,
    result: TaskExecutionResult,
}

impl TaskExecutor for FakeExecutor {
    async fn execute(
        &self,
        command: TaskCommandRecord,
        materials: Vec<ResolvedMaterial>,
    ) -> TaskExecutionResult {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let current = self
            .store
            .get_task_command(&command.id)
            .await
            .expect("task command")
            .expect("stored task command");
        self.saw_running
            .store(current.state == "running", Ordering::SeqCst);
        if !command.material_ids.is_empty() {
            assert_eq!(materials.len(), 1);
            assert_eq!(materials[0].material.id, command.material_ids[0]);
            assert!(materials[0].path.is_file());
        }
        self.result.clone()
    }
}

fn command(id: &str, kind: &str) -> TaskCommandRecord {
    TaskCommandRecord {
        id: id.into(),
        idempotency_key: format!("device:{id}"),
        kind: kind.into(),
        provider: "codex".into(),
        session_id: (kind == "follow_up").then(|| "session-runner".into()),
        workspace_id: None,
        cwd: "/tmp/zimlo".into(),
        text: "continue".into(),
        material_ids: Vec::new(),
        state: "queued".into(),
        created_at: "2026-09-02T00:00:00.000Z".into(),
        updated_at: "2026-09-02T00:00:00.000Z".into(),
        error: None,
    }
}

fn session(status: &str, active_pid: Option<i64>) -> StoredSession {
    StoredSession {
        id: "session-runner".into(),
        project_id: None,
        provider: "codex".into(),
        surface: "cli".into(),
        provider_session_id: "provider-runner".into(),
        title: "Runner".into(),
        cwd: Some("/tmp/zimlo".into()),
        transcript_path: None,
        status: status.into(),
        last_activity_at: "2026-09-02T00:00:00.000Z".into(),
        created_at: "2026-09-02T00:00:00.000Z".into(),
        active_pid,
        process_started_at: None,
        tty: None,
        correlation_uncertain: false,
        capabilities: json!({ "replyable": true, "resumable": true }),
    }
}

fn executor(
    store: &Store,
    result: TaskExecutionResult,
) -> (FakeExecutor, Arc<AtomicUsize>, Arc<AtomicBool>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let saw_running = Arc::new(AtomicBool::new(false));
    (
        FakeExecutor {
            store: store.clone(),
            calls: Arc::clone(&calls),
            saw_running: Arc::clone(&saw_running),
            result,
        },
        calls,
        saw_running,
    )
}

#[tokio::test]
async fn resolves_ready_materials_and_completes_through_the_injected_executor() {
    let directory = tempdir().expect("tempdir");
    let path = directory.path().join("material.txt");
    std::fs::write(&path, b"material").expect("material file");
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    let mut created_session = session("idle", None);
    created_session.id = "session-created".into();
    created_session.provider_session_id = "provider-created".into();
    store
        .upsert_session(created_session)
        .await
        .expect("created session");
    store
        .upsert_material(MaterialRecord {
            id: "material-runner".into(),
            kind: "file".into(),
            name: "material.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 8,
            sha256: "fixture".into(),
            width: None,
            height: None,
            duration_ms: None,
            preview_material_id: None,
            origin: "local".into(),
            status: "ready".into(),
            local_path: Some(path.to_string_lossy().into_owned()),
            created_at: "2026-09-02T00:00:00.000Z".into(),
            error: None,
        })
        .await
        .expect("material");
    let mut queued = command("complete", "create");
    queued.material_ids.push("material-runner".into());
    store.insert_task_command(queued).await.expect("insert");
    let (executor, calls, saw_running) = executor(
        &store,
        TaskExecutionResult {
            ok: true,
            message: "done".into(),
            session_id: Some("session-created".into()),
        },
    );

    let completed = TaskCommandRunner::new(store.clone(), executor)
        .run_once()
        .await
        .expect("run")
        .expect("completed");
    assert_eq!(completed.state, "completed");
    assert_eq!(completed.session_id.as_deref(), Some("session-created"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(saw_running.load(Ordering::SeqCst));
}

#[tokio::test]
async fn persists_redacted_executor_failures() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .insert_task_command(command("fail", "create"))
        .await
        .expect("insert");
    let (executor, calls, _) = executor(
        &store,
        TaskExecutionResult {
            ok: false,
            message: "x".repeat(900),
            session_id: None,
        },
    );

    let failed = TaskCommandRunner::new(store, executor)
        .run_once()
        .await
        .expect("run")
        .expect("failed");
    assert_eq!(failed.state, "failed");
    assert_eq!(failed.error.expect("error").chars().count(), 800);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn leaves_active_followups_queued_and_fails_missing_materials_without_execution() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .upsert_session(session("running", Some(42)))
        .await
        .expect("session");
    store
        .insert_task_command(command("follow-up", "follow_up"))
        .await
        .expect("follow-up");
    let (executor, calls, _) = executor(
        &store,
        TaskExecutionResult {
            ok: true,
            message: "unused".into(),
            session_id: None,
        },
    );
    let runner = TaskCommandRunner::new(store.clone(), executor)
        .with_timing(Duration::ZERO, Duration::from_millis(1));
    assert!(runner.run_once().await.expect("skip active").is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        store
            .get_task_command("follow-up")
            .await
            .expect("get")
            .expect("command")
            .state,
        "queued"
    );

    let mut missing = command("missing-material", "create");
    missing.material_ids.push("missing".into());
    store
        .insert_task_command(missing)
        .await
        .expect("insert missing");
    let failed = runner
        .run_once()
        .await
        .expect("run missing")
        .expect("failed command");
    assert_eq!(failed.state, "failed");
    assert!(failed.error.expect("error").contains("尚未上传完成"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
