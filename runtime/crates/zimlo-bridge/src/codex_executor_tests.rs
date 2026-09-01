use std::{collections::HashMap, os::unix::fs::PermissionsExt as _, path::Path, time::Duration};

use zimlo_store::{Store, StoreMode, TaskCommandRecord};

use super::{ActionBroker, CodexTaskExecutor, DecisionSubmission, TaskCommandRunner};

async fn fixture() -> (
    tempfile::TempDir,
    Store,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let directory = tempfile::tempdir().expect("tempdir");
    let database = directory.path().join("zimlo.db");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).expect("workspace");
    drop(
        Store::open(&database, StoreMode::ReadWriteCreate)
            .await
            .expect("initialize"),
    );
    let connection = rusqlite::Connection::open(&database).expect("fixture connection");
    connection.execute(
        "INSERT INTO projects (id, name, created_at, last_used_at) VALUES ('project-codex', 'Codex project', ?1, ?1)",
        ["2026-09-02T00:00:00.000Z"],
    ).expect("project");
    connection.execute(
        "INSERT INTO project_locations (path, project_id, first_seen_at, last_seen_at) VALUES (?1, 'project-codex', ?2, ?2)",
        rusqlite::params![workspace.to_string_lossy(), "2026-09-02T00:00:00.000Z"],
    ).expect("location");
    drop(connection);
    let store = Store::open(&database, StoreMode::ReadWriteExisting)
        .await
        .expect("store");
    let fake = directory.path().join("fake-codex");
    std::fs::write(&fake, fake_codex()).expect("fake codex");
    let mut permissions = std::fs::metadata(&fake).expect("metadata").permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&fake, permissions).expect("permissions");
    (directory, store, workspace, fake)
}

fn fake_codex() -> &'static str {
    r#"#!/bin/sh
IFS= read -r line
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r line
IFS= read -r line
printf '%s\n' '{"id":2,"result":{"thread":{"id":"codex-fake-thread","status":{"type":"idle"}}}}'
IFS= read -r line
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-fake","status":"inProgress"}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"codex-fake-thread","turn":{"id":"turn-fake","status":"inProgress"}}}'
printf '%s\n' '{"id":101,"method":"item/commandExecution/requestApproval","params":{"threadId":"codex-fake-thread","turnId":"turn-fake","itemId":"command-fake","command":"git push origin main"}}'
IFS= read -r approval
case "$approval" in *'"decision":"accept"'*) ;; *) printf '%s\n' 'approval response mismatch' >&2; exit 41;; esac
printf '%s\n' '{"id":102,"method":"item/tool/requestUserInput","params":{"threadId":"codex-fake-thread","turnId":"turn-fake","itemId":"input-fake","questions":[{"id":"q1","header":"Continue","question":"Proceed?"}]}}'
IFS= read -r input
case "$input" in *'from-phone'*) ;; *) printf '%s\n' 'input response mismatch' >&2; exit 42;; esac
printf '%s\n' '{"method":"item/started","params":{"threadId":"codex-fake-thread","turnId":"turn-fake","item":{"id":"command-fake","type":"commandExecution","command":"cargo test"}}}'
printf '%s\n' '{"method":"item/completed","params":{"threadId":"codex-fake-thread","turnId":"turn-fake","item":{"id":"command-fake","type":"commandExecution","command":"cargo test","exitCode":0}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"codex-fake-thread","turn":{"id":"turn-fake","status":"completed"}}}'
"#
}

fn command(workspace: &Path) -> TaskCommandRecord {
    let at = "2026-09-02T00:00:00.000Z".to_owned();
    TaskCommandRecord {
        id: uuid::Uuid::now_v7().to_string(),
        idempotency_key: "device:codex-create".into(),
        kind: "create".into(),
        provider: "codex".into(),
        session_id: None,
        workspace_id: Some("project-codex".into()),
        cwd: workspace.to_string_lossy().into_owned(),
        text: "run Codex approval fixture".into(),
        material_ids: Vec::new(),
        state: "queued".into(),
        created_at: at.clone(),
        updated_at: at,
        error: None,
    }
}

async fn wait_action(store: &Store, kind: &str) -> zimlo_store::PendingActionRecord {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let actions = store
            .list_pending_actions(now())
            .await
            .expect("pending actions");
        if let Some(action) = actions.into_iter().find(|action| action.kind == kind) {
            return action;
        }
        assert!(tokio::time::Instant::now() < deadline, "action timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn codex_app_server_create_closes_approval_and_input_loops() {
    let (_directory, store, workspace, fake) = fixture().await;
    let broker = ActionBroker::new(store.clone());
    let inserted = store
        .insert_task_command(command(&workspace))
        .await
        .expect("insert command")
        .command;
    let runner = TaskCommandRunner::new(
        store.clone(),
        CodexTaskExecutor::with_command(store.clone(), broker.clone(), fake),
    );
    let running = tokio::spawn(async move { runner.run_once().await });

    let approval = wait_action(&store, "approval").await;
    let approval_result = broker
        .decide(DecisionSubmission {
            device_id: "phone-codex-test".into(),
            action_id: approval.action_id.clone(),
            session_id: approval.session_id.clone(),
            decision_id: "upstream-0-accept".into(),
            idempotency_key: "approve-once".into(),
            confirmation_phrase: Some("确认执行".into()),
            input: None,
        })
        .await
        .expect("approve");
    assert!(approval_result.ok);

    let input = wait_action(&store, "input").await;
    let input_result = broker
        .decide(DecisionSubmission {
            device_id: "phone-codex-test".into(),
            action_id: input.action_id.clone(),
            session_id: input.session_id.clone(),
            decision_id: "submit-input".into(),
            idempotency_key: "input-once".into(),
            confirmation_phrase: None,
            input: Some(HashMap::from([("answer".into(), "from-phone".into())])),
        })
        .await
        .expect("input");
    assert!(input_result.ok);

    let completed = running
        .await
        .expect("runner join")
        .expect("runner")
        .expect("completed command");
    assert_eq!(completed.id, inserted.id);
    assert_eq!(completed.state, "completed");
    let session_id = completed.session_id.expect("attached session");
    let session = store
        .get_session(&session_id)
        .await
        .expect("session query")
        .expect("session");
    assert_eq!(session.provider_session_id, "codex-fake-thread");
    assert_eq!(session.status, "idle");
    assert_eq!(session.active_pid, None);
    let kinds = store
        .list_events(&session_id, 100)
        .await
        .expect("events")
        .into_iter()
        .map(|event| event.kind)
        .collect::<Vec<_>>();
    for expected in [
        "user_instruction",
        "session_started",
        "needs_approval",
        "needs_input",
        "command_started",
        "command_completed",
        "tests_passed",
        "completed",
    ] {
        assert!(
            kinds.iter().any(|kind| kind == expected),
            "missing {expected}: {kinds:?}"
        );
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
