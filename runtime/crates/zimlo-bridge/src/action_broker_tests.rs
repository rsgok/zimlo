use std::{collections::HashMap, time::Duration};

use serde_json::json;
use zimlo_store::{DecisionRecord, Store, StoreMode, StoredSession};

use super::{ActionBroker, DecisionSubmission, NewAction};

async fn setup() -> (tempfile::TempDir, Store, ActionBroker) {
    let directory = tempfile::tempdir().expect("tempdir");
    let database = directory.path().join("zimlo.db");
    drop(
        Store::open(&database, StoreMode::ReadWriteCreate)
            .await
            .expect("initialize"),
    );
    let connection = rusqlite::Connection::open(&database).expect("fixture connection");
    connection
        .execute(
            "INSERT INTO projects (id, name, created_at, last_used_at) VALUES ('project-action-test', 'Action project', ?1, ?1)",
            ["2026-09-02T00:00:00.000Z"],
        )
        .expect("project");
    connection
        .execute(
            "INSERT INTO project_locations (path, project_id, first_seen_at, last_seen_at) VALUES (?1, 'project-action-test', ?2, ?2)",
            rusqlite::params![directory.path().to_string_lossy(), "2026-09-02T00:00:00.000Z"],
        )
        .expect("location");
    drop(connection);
    let store = Store::open(&database, StoreMode::ReadWriteExisting)
        .await
        .expect("store");
    store
        .upsert_session(StoredSession {
            id: "session-action-test".into(),
            project_id: Some("project-action-test".into()),
            provider: "codex".into(),
            surface: "managed".into(),
            provider_session_id: "thread-action-test".into(),
            title: "Approval test".into(),
            cwd: Some(directory.path().to_string_lossy().into_owned()),
            transcript_path: None,
            status: "waiting".into(),
            last_activity_at: "2026-09-02T00:00:00.000Z".into(),
            created_at: "2026-09-02T00:00:00.000Z".into(),
            active_pid: None,
            process_started_at: None,
            tty: None,
            correlation_uncertain: false,
            capabilities: json!({}),
        })
        .await
        .expect("session");
    let broker = ActionBroker::new(store.clone());
    (directory, store, broker)
}

fn new_action(timeout: Option<Duration>) -> NewAction {
    NewAction {
        session_id: "session-action-test".into(),
        upstream_request_id: Some("rpc-42".into()),
        kind: "approval".into(),
        title: "命令执行审批".into(),
        detail: "git push".into(),
        available_decisions: vec![
            DecisionRecord {
                id: "allow".into(),
                label: "允许一次".into(),
                scope: "once".into(),
                value: json!("accept"),
                confirmation_phrase: Some("确认执行".into()),
                risk: "high".into(),
            },
            DecisionRecord {
                id: "deny".into(),
                label: "拒绝".into(),
                scope: "deny".into(),
                value: json!("decline"),
                confirmation_phrase: None,
                risk: "low".into(),
            },
        ],
        approval_context: Some(json!({
            "category": "git_publish",
            "projectId": null,
            "cwd": "/tmp/zimlo",
            "segments": ["git push"],
            "withinProject": true,
            "reason": "发布需要确认"
        })),
        timeout,
    }
}

fn submission(action_id: &str, key: &str) -> DecisionSubmission {
    DecisionSubmission {
        device_id: "device-action-test".into(),
        action_id: action_id.into(),
        session_id: "session-action-test".into(),
        decision_id: "allow".into(),
        idempotency_key: key.into(),
        confirmation_phrase: Some("确认执行".into()),
        input: Some(HashMap::from([("answer".into(), "继续".into())])),
    }
}

#[tokio::test]
async fn persists_resolves_and_replays_a_decision_without_double_delivery() {
    let (_directory, store, broker) = setup().await;
    let ticket = broker
        .create(new_action(None))
        .await
        .expect("create action");
    let action_id = ticket.action.action_id.clone();
    assert_eq!(
        store
            .get_action(&action_id)
            .await
            .expect("stored action")
            .expect("action")
            .state,
        "pending"
    );

    let mut wrong = submission(&action_id, "wrong-phrase");
    wrong.confirmation_phrase = Some("wrong".into());
    let rejected = broker.decide(wrong).await.expect("phrase rejection");
    assert!(!rejected.ok);
    assert!(rejected.message.contains("确认执行"));

    let accepted = broker
        .decide(submission(&action_id, "accepted"))
        .await
        .expect("decision");
    assert!(accepted.ok);
    let resolution = ticket.result().await.expect("upstream resolution");
    assert_eq!(resolution.decision.value, json!("accept"));
    assert_eq!(resolution.input.expect("input")["answer"], "继续");
    assert_eq!(
        store
            .get_action(&action_id)
            .await
            .expect("stored action")
            .expect("action")
            .state,
        "resolved"
    );

    let replay = broker
        .decide(submission(&action_id, "accepted"))
        .await
        .expect("idempotent replay");
    assert_eq!(replay, accepted);
}

#[tokio::test]
async fn expires_waiters_and_fails_closed_after_a_broker_restart() {
    let (_directory, store, broker) = setup().await;
    let ticket = broker
        .create(new_action(Some(Duration::from_millis(10))))
        .await
        .expect("create expiring action");
    let action_id = ticket.action.action_id.clone();
    assert!(ticket.result().await.is_none());
    assert_eq!(
        store
            .get_action(&action_id)
            .await
            .expect("expired action")
            .expect("action")
            .state,
        "expired"
    );

    let stranded = broker
        .create(new_action(None))
        .await
        .expect("stranded action");
    let stranded_id = stranded.action.action_id.clone();
    let restarted = ActionBroker::new(store.clone());
    let rejected = restarted
        .decide(submission(&stranded_id, "after-restart"))
        .await
        .expect("restart rejection");
    assert!(!rejected.ok);
    assert!(rejected.message.contains("重启"));
    broker.expire(&stranded_id).await.expect("cleanup");
    assert!(stranded.result().await.is_none());
}

#[tokio::test]
async fn auto_allows_only_safe_project_scoped_commands_and_records_audit() {
    let (directory, store, broker) = setup().await;
    store
        .update_trust_policy(
            "project-action-test",
            "safe_automation",
            "device-policy",
            "device-policy:enable-safe",
            "2026-09-02T00:01:00.000Z",
        )
        .await
        .expect("trust policy");
    let root = directory.path().to_string_lossy().into_owned();
    let mut safe = new_action(None);
    safe.detail = "cargo test".into();
    safe.available_decisions[0].confirmation_phrase = None;
    safe.available_decisions[0].risk = "low".into();
    safe.approval_context = Some(json!({
        "category": "test",
        "projectId": "project-action-test",
        "cwd": root,
        "command": "cargo test",
        "segments": ["cargo test"],
        "withinProject": true,
        "reason": "识别为 test"
    }));
    let automatic = broker.create(safe).await.expect("automatic action");
    assert_eq!(automatic.action.state, "resolved");
    assert_eq!(
        automatic
            .result()
            .await
            .expect("automatic resolution")
            .decision
            .id,
        "allow"
    );
    assert!(
        store
            .list_pending_actions("2026-09-02T00:00:00.000Z")
            .await
            .expect("pending actions")
            .is_empty()
    );

    let mut unsafe_action = new_action(None);
    unsafe_action.approval_context = Some(json!({
        "category": "git_publish",
        "projectId": "project-action-test",
        "cwd": directory.path().to_string_lossy(),
        "command": "git push",
        "segments": ["git push"],
        "withinProject": true,
        "reason": "识别为 git_publish"
    }));
    let pending = broker.create(unsafe_action).await.expect("pending action");
    assert_eq!(pending.action.state, "pending");
    broker
        .expire(&pending.action.action_id)
        .await
        .expect("cleanup pending");
    assert!(pending.result().await.is_none());

    let audit = store
        .list_trust_audit(Some("project-action-test".into()), 10)
        .await
        .expect("trust audit");
    assert!(audit.iter().any(|entry| entry.decision == "auto_allowed"));
    assert!(audit.iter().any(|entry| entry.decision == "asked"));
}
