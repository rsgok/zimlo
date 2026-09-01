use std::os::unix::fs::PermissionsExt as _;

use serde_json::json;
use tempfile::tempdir;
use zimlo_store::{Store, StoreMode, StoredSession, TaskCommandRecord};

use crate::{ClaudeTaskExecutor, TaskCommandRunner};

fn command(id: &str, kind: &str, cwd: &str) -> TaskCommandRecord {
    TaskCommandRecord {
        id: id.into(),
        idempotency_key: format!("device:{id}"),
        kind: kind.into(),
        provider: "claude".into(),
        session_id: (kind == "follow_up").then(|| "session-existing".into()),
        workspace_id: None,
        cwd: cwd.into(),
        text: "检查 Rust Runtime".into(),
        material_ids: Vec::new(),
        state: "queued".into(),
        created_at: "2026-09-02T00:00:00.000Z".into(),
        updated_at: "2026-09-02T00:00:00.000Z".into(),
        error: None,
    }
}

fn existing_session(cwd: &str) -> StoredSession {
    StoredSession {
        id: "session-existing".into(),
        project_id: None,
        provider: "claude".into(),
        surface: "managed".into(),
        provider_session_id: "claude-existing".into(),
        title: "Existing Claude task".into(),
        cwd: Some(cwd.into()),
        transcript_path: None,
        status: "idle".into(),
        last_activity_at: "2026-09-02T00:00:00.000Z".into(),
        created_at: "2026-09-02T00:00:00.000Z".into(),
        active_pid: None,
        process_started_at: None,
        tty: None,
        correlation_uncertain: false,
        capabilities: json!({
            "discovered": true,
            "liveObserved": false,
            "replyable": true,
            "approvableOnce": false,
            "approvableSession": false,
            "approvablePersistent": false,
            "resumable": true,
            "diffAvailable": false,
        }),
    }
}

fn fake_claude(
    directory: &std::path::Path,
    exit_code: i32,
    session_id: &str,
) -> std::path::PathBuf {
    let script = directory.join("fake-claude");
    let arguments = directory.join("arguments.txt");
    let source = r#"#!/bin/sh
printf '%s\n' "$@" > '__ARGS__'
printf '%s\n' '{"type":"system","subtype":"init","sessionId":"__SESSION__","cwd":"/tmp","model":"claude","timestamp":"2026-09-02T00:00:00.000Z","uuid":"turn-rust"}'
printf '%s\n' '{"type":"assistant","sessionId":"__SESSION__","timestamp":"2026-09-02T00:00:01.000Z","uuid":"turn-rust","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"cargo test"}}]}}'
printf '%s\n' '{"type":"user","sessionId":"__SESSION__","timestamp":"2026-09-02T00:00:02.000Z","uuid":"turn-rust","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":{"exitCode":0},"is_error":false}]}}'
printf '%s\n' '{"type":"assistant","sessionId":"__SESSION__","timestamp":"2026-09-02T00:00:03.000Z","uuid":"turn-rust","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Runtime complete"}]}}'
printf '%s\n' 'OPENAI_API_KEY=sk-proj_abcdefghijklmnop' >&2
exit __EXIT__
"#
    .replace("__ARGS__", &arguments.to_string_lossy())
    .replace("__SESSION__", session_id)
    .replace("__EXIT__", &exit_code.to_string());
    std::fs::write(&script, source).expect("write fake claude");
    let mut permissions = std::fs::metadata(&script).expect("metadata").permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&script, permissions).expect("executable");
    script
}

#[tokio::test]
async fn creates_a_persisted_claude_session_and_ingests_stream_events() {
    let directory = tempdir().expect("tempdir");
    let executable = fake_claude(directory.path(), 0, "claude-rust-create");
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    let mut codex = command(
        "existing-codex",
        "create",
        &directory.path().to_string_lossy(),
    );
    codex.provider = "codex".into();
    store
        .insert_task_command(codex)
        .await
        .expect("existing codex command");
    store
        .insert_task_command(command(
            "create-claude",
            "create",
            &directory.path().to_string_lossy(),
        ))
        .await
        .expect("command");
    let executor = ClaudeTaskExecutor::with_command(store.clone(), executable);

    let completed = TaskCommandRunner::new(store.clone(), executor)
        .run_once()
        .await
        .expect("run")
        .expect("completed");
    assert_eq!(completed.state, "completed");
    let session_id = completed.session_id.expect("session id");
    assert_eq!(session_id, "zim_714ca476872e40b171f5a819");
    let session = store
        .get_session(&session_id)
        .await
        .expect("session")
        .expect("stored session");
    assert_eq!(session.status, "idle");
    assert_eq!(session.active_pid, None);
    assert_eq!(session.surface, "managed");
    assert_eq!(
        store
            .get_task_command("existing-codex")
            .await
            .expect("codex command")
            .expect("stored codex command")
            .state,
        "queued"
    );
    assert_eq!(
        store
            .list_events(&session_id, 200)
            .await
            .expect("events")
            .into_iter()
            .map(|event| event.kind)
            .collect::<Vec<_>>(),
        [
            "user_instruction",
            "session_started",
            "command_started",
            "tests_passed",
            "completed",
        ]
    );
    let arguments =
        std::fs::read_to_string(directory.path().join("arguments.txt")).expect("arguments");
    assert!(arguments.contains("--output-format\nstream-json"));
    assert!(!arguments.contains("--resume"));
}

#[tokio::test]
async fn resumes_existing_claude_sessions_and_redacts_process_failures() {
    let directory = tempdir().expect("tempdir");
    let executable = fake_claude(directory.path(), 7, "claude-existing");
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .upsert_session(existing_session(&directory.path().to_string_lossy()))
        .await
        .expect("session");
    store
        .insert_task_command(command(
            "follow-claude",
            "follow_up",
            &directory.path().to_string_lossy(),
        ))
        .await
        .expect("command");
    let executor = ClaudeTaskExecutor::with_command(store.clone(), executable);

    let failed = TaskCommandRunner::new(store.clone(), executor)
        .run_once()
        .await
        .expect("run")
        .expect("failed");
    assert_eq!(failed.state, "failed");
    let error = failed.error.expect("error");
    assert!(error.contains("[REDACTED"));
    assert!(!error.contains("abcdefghijklmnop"));
    let session = store
        .get_session("session-existing")
        .await
        .expect("session")
        .expect("stored session");
    assert_eq!(session.status, "failed");
    assert_eq!(session.active_pid, None);
    let arguments =
        std::fs::read_to_string(directory.path().join("arguments.txt")).expect("arguments");
    assert!(arguments.contains("--resume\nclaude-existing"));
}
