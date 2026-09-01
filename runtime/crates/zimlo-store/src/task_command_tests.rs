use serde_json::json;
use tempfile::tempdir;

use super::{
    CancelTaskCommandResult, RetryTaskCommandResult, Store, StoreMode, StoredSession,
    TaskCommandRecord,
};

fn command(id: &str, key: &str) -> TaskCommandRecord {
    TaskCommandRecord {
        id: id.into(),
        idempotency_key: key.into(),
        kind: "create".into(),
        provider: "codex".into(),
        session_id: None,
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

#[tokio::test]
async fn inserts_idempotently_and_claims_with_compare_and_swap() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    let first = store
        .insert_task_command(command("command-1", "device:key"))
        .await
        .expect("insert");
    let duplicate = store
        .insert_task_command(command("command-duplicate", "device:key"))
        .await
        .expect("deduplicate");
    assert!(first.inserted);
    assert!(!duplicate.inserted);
    assert_eq!(duplicate.command.id, "command-1");

    let left = store.clone();
    let right = store.clone();
    let (left, right) = tokio::join!(
        left.claim_task_command("command-1", "2026-09-02T00:00:01.000Z"),
        right.claim_task_command("command-1", "2026-09-02T00:00:02.000Z")
    );
    assert_eq!(
        [left.expect("left"), right.expect("right")]
            .into_iter()
            .filter(Option::is_some)
            .count(),
        1
    );
    assert_eq!(
        store
            .get_task_command("command-1")
            .await
            .expect("get")
            .expect("command")
            .state,
        "dispatching"
    );
}

#[tokio::test]
async fn cancellation_and_retry_enforce_the_persistent_state_machine() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .insert_task_command(command("cancel-me", "device:cancel"))
        .await
        .expect("insert cancel");
    let canceled = store
        .cancel_task_command(
            None,
            Some("device:cancel".into()),
            "2026-09-02T00:00:01.000Z",
        )
        .await
        .expect("cancel");
    assert!(matches!(
        canceled,
        CancelTaskCommandResult::Canceled(ref command) if command.state == "canceled"
    ));
    assert!(matches!(
        store
            .cancel_task_command(Some("cancel-me".into()), None, "2026-09-02T00:00:02.000Z")
            .await
            .expect("repeat cancel"),
        CancelTaskCommandResult::Canceled(ref command)
            if command.updated_at == "2026-09-02T00:00:01.000Z"
    ));
    assert_eq!(
        store
            .cancel_task_command(Some("missing".into()), None, "2026-09-02T00:00:02.000Z")
            .await
            .expect("missing cancel"),
        CancelTaskCommandResult::NotFound
    );

    store
        .insert_task_command(command("retry-me", "device:retry"))
        .await
        .expect("insert retry");
    store
        .claim_task_command("retry-me", "2026-09-02T00:00:01.000Z")
        .await
        .expect("claim");
    store
        .mark_task_command_running("retry-me", "2026-09-02T00:00:02.000Z")
        .await
        .expect("run");
    assert!(matches!(
        store
            .cancel_task_command(Some("retry-me".into()), None, "2026-09-02T00:00:03.000Z")
            .await
            .expect("running cancel"),
        CancelTaskCommandResult::NotCancelable(ref command) if command.state == "running"
    ));
    store
        .finish_task_command(
            "retry-me",
            "failed",
            None,
            "2026-09-02T00:00:04.000Z",
            Some("failed".into()),
        )
        .await
        .expect("fail");
    assert!(matches!(
        store
            .retry_task_command("retry-me", "2026-09-02T00:00:05.000Z")
            .await
            .expect("retry"),
        RetryTaskCommandResult::Queued(ref command)
            if command.state == "queued" && command.error.is_none()
    ));
}

#[tokio::test]
async fn recovers_interrupted_commands_without_automatically_repeating_running_work() {
    let directory = tempdir().expect("tempdir");
    let path = directory.path().join("zimlo.db");
    let store = Store::open(&path, StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .insert_task_command(command("interrupted", "device:interrupted"))
        .await
        .expect("insert");
    store
        .claim_task_command("interrupted", "2026-09-02T00:00:01.000Z")
        .await
        .expect("claim");
    store
        .mark_task_command_running("interrupted", "2026-09-02T00:00:02.000Z")
        .await
        .expect("running");
    store
        .insert_task_command(command("not-started", "device:not-started"))
        .await
        .expect("insert dispatching");
    store
        .claim_task_command("not-started", "2026-09-02T00:00:02.000Z")
        .await
        .expect("dispatching");
    store
        .upsert_session(StoredSession {
            id: "managed-interrupted".into(),
            project_id: None,
            provider: "claude".into(),
            surface: "managed".into(),
            provider_session_id: "provider-interrupted".into(),
            title: "Interrupted".into(),
            cwd: Some("/tmp".into()),
            transcript_path: None,
            status: "running".into(),
            last_activity_at: "2026-09-02T00:00:02.000Z".into(),
            created_at: "2026-09-02T00:00:00.000Z".into(),
            active_pid: Some(42),
            process_started_at: Some("2026-09-02T00:00:01.000Z".into()),
            tty: None,
            correlation_uncertain: false,
            capabilities: json!({}),
        })
        .await
        .expect("managed session");
    drop(store);

    let reopened = Store::open(&path, StoreMode::ReadWriteExisting)
        .await
        .expect("reopen");
    let command = reopened
        .get_task_command("interrupted")
        .await
        .expect("get")
        .expect("command");
    assert_eq!(command.state, "failed");
    assert!(
        command
            .error
            .as_deref()
            .is_some_and(|error| error.contains("状态不确定"))
    );
    let not_started = reopened
        .get_task_command("not-started")
        .await
        .expect("get dispatching")
        .expect("dispatching command");
    assert_eq!(not_started.state, "queued");
    assert!(not_started.error.is_none());
    let session = reopened
        .get_session("managed-interrupted")
        .await
        .expect("get session")
        .expect("session");
    assert_eq!(session.status, "failed");
    assert_eq!(session.active_pid, None);
    assert_eq!(session.process_started_at, None);
}
