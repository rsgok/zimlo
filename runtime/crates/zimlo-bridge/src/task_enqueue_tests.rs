use serde_json::json;
use tempfile::tempdir;
use zimlo_store::{Store, StoreMode, StoredSession};

use crate::{
    dispatcher::DispatchResult,
    task_enqueue::{create, follow_up, retry},
};

async fn store() -> (tempfile::TempDir, Store) {
    let directory = tempdir().expect("tempdir");
    let path = directory.path().join("zimlo.db");
    drop(
        Store::open(&path, StoreMode::ReadWriteCreate)
            .await
            .expect("initialize"),
    );
    let connection = rusqlite::Connection::open(&path).expect("fixture connection");
    connection
        .execute_batch(
            "INSERT INTO projects (id, name, created_at, last_used_at)
             VALUES ('project-claude', 'Claude project', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
             INSERT INTO project_locations (path, project_id, first_seen_at, last_seen_at)
             VALUES ('/tmp', 'project-claude', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');",
        )
        .expect("fixture");
    drop(connection);
    let store = Store::open(&path, StoreMode::ReadWriteExisting)
        .await
        .expect("store");
    (directory, store)
}

fn session() -> StoredSession {
    StoredSession {
        id: "session-claude".into(),
        project_id: Some("project-claude".into()),
        provider: "claude".into(),
        surface: "managed".into(),
        provider_session_id: "provider-claude".into(),
        title: "Claude task".into(),
        cwd: Some("/tmp".into()),
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

#[tokio::test]
async fn enqueues_claude_and_codex_create_commands_idempotently() {
    let (_directory, store) = store().await;
    let input = json!({
        "type": "task.create",
        "provider": "claude",
        "workspaceId": "project-claude",
        "text": "继续迁移",
        "idempotencyKey": "create-once",
    });
    let first = create(&store, "device-1", true, &input)
        .await
        .expect("create");
    let replay = create(&store, "device-1", true, &input)
        .await
        .expect("replay");
    let (DispatchResult::Message(first), DispatchResult::Message(replay)) = (first, replay) else {
        panic!("expected updates");
    };
    assert_eq!(first["command"]["state"], "queued");
    assert_eq!(first["command"]["cwd"], "/tmp");
    assert_eq!(first["command"]["id"], replay["command"]["id"]);

    let codex = create(
        &store,
        "device-1",
        true,
        &json!({
            "type": "task.create",
            "provider": "codex",
            "workspaceId": "project-claude",
            "text": "run in Rust",
            "idempotencyKey": "codex-native",
        }),
    )
    .await
    .expect("codex");
    let DispatchResult::Message(codex) = codex else {
        panic!("expected update");
    };
    assert_eq!(codex["command"]["state"], "queued");
    assert_eq!(codex["command"]["provider"], "codex");
}

#[tokio::test]
async fn enqueues_claude_followups_and_returns_session_message_receipts() {
    let (_directory, store) = store().await;
    store.upsert_session(session()).await.expect("session");
    let result = follow_up(
        &store,
        "device-1",
        true,
        &json!({
            "type": "session.message",
            "sessionId": "session-claude",
            "text": "继续",
            "materialIds": [],
            "idempotencyKey": "follow-once",
        }),
    )
    .await
    .expect("follow-up");
    let DispatchResult::Messages(messages) = result else {
        panic!("expected update and receipt");
    };
    assert_eq!(messages[0]["command"]["state"], "queued");
    assert_eq!(messages[0]["command"]["provider"], "claude");
    assert_eq!(messages[1]["type"], "session.message.result");
    assert_eq!(messages[1]["ok"], true);

    let missing = follow_up(
        &store,
        "device-1",
        true,
        &json!({
            "type": "task.follow_up",
            "sessionId": "missing",
            "text": "继续",
            "idempotencyKey": "missing-follow",
        }),
    )
    .await
    .expect("missing");
    let DispatchResult::Message(missing) = missing else {
        panic!("expected failed command");
    };
    assert_eq!(missing["command"]["state"], "failed");
    assert_eq!(missing["command"]["error"], "找不到要继续的任务。");
}

#[tokio::test]
async fn retries_failed_native_commands_after_revalidation() {
    let (_directory, store) = store().await;
    store.upsert_session(session()).await.expect("session");
    let queued = follow_up(
        &store,
        "device-1",
        true,
        &json!({
            "type": "task.follow_up",
            "sessionId": "session-claude",
            "text": "继续",
            "idempotencyKey": "retry-target",
        }),
    )
    .await
    .expect("enqueue");
    let DispatchResult::Message(queued) = queued else {
        panic!("expected update");
    };
    let command_id = queued["command"]["id"].as_str().expect("command id");
    store
        .claim_task_command(command_id, "2026-09-02T00:00:01.000Z")
        .await
        .expect("claim");
    store
        .mark_task_command_running(command_id, "2026-09-02T00:00:02.000Z")
        .await
        .expect("running");
    store
        .finish_task_command(
            command_id,
            "failed",
            None,
            "2026-09-02T00:00:03.000Z",
            Some("failed".into()),
        )
        .await
        .expect("failed");

    let retried = retry(
        &store,
        true,
        &json!({
            "type": "task.command.retry",
            "commandId": command_id,
            "idempotencyKey": "retry-request",
        }),
    )
    .await
    .expect("retry");
    let DispatchResult::Message(retried) = retried else {
        panic!("expected update");
    };
    assert_eq!(retried["command"]["state"], "queued");
    assert!(retried["command"]["error"].is_null());
}
