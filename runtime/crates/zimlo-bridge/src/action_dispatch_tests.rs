use serde_json::json;
use zimlo_store::{DecisionRecord, Store, StoreMode, StoredSession};

use super::{ActionBroker, NewAction, action_dispatch, dispatcher::DispatchResult};

#[tokio::test]
async fn requires_device_approval_permission_before_resolving_upstream() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .upsert_session(StoredSession {
            id: "session-permission-test".into(),
            project_id: None,
            provider: "codex".into(),
            surface: "managed".into(),
            provider_session_id: "thread-permission-test".into(),
            title: "Permission test".into(),
            cwd: Some("/tmp".into()),
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
    let broker = ActionBroker::new(store);
    let ticket = broker
        .create(NewAction {
            session_id: "session-permission-test".into(),
            upstream_request_id: Some("101".into()),
            kind: "approval".into(),
            title: "命令执行审批".into(),
            detail: "cargo test".into(),
            available_decisions: vec![DecisionRecord {
                id: "allow".into(),
                label: "允许一次".into(),
                scope: "once".into(),
                value: json!("accept"),
                confirmation_phrase: None,
                risk: "low".into(),
            }],
            approval_context: None,
            timeout: None,
        })
        .await
        .expect("action");
    let command = json!({
        "type": "action.decide", "actionId": ticket.action.action_id,
        "sessionId": "session-permission-test", "decisionId": "allow",
        "idempotencyKey": "permission-decision"
    });
    let denied = action_dispatch::decide(&broker, "phone", false, false, true, &command)
        .await
        .expect("denied");
    let DispatchResult::Message(denied) = denied else {
        panic!("denial result")
    };
    assert_eq!(denied["ok"], false);

    let accepted = action_dispatch::decide(&broker, "phone", false, true, true, &command)
        .await
        .expect("accepted");
    let DispatchResult::Message(accepted) = accepted else {
        panic!("accepted result")
    };
    assert_eq!(accepted["ok"], true);
    assert_eq!(
        ticket.result().await.expect("resolution").decision.value,
        json!("accept")
    );
}
