use serde_json::{Value, json};
use zimlo_store::{Store, StoreMode};

use super::{
    ActionBroker,
    dispatcher::{self, DispatchContext, DispatchResult},
};

async fn fixture() -> (tempfile::TempDir, Store, ActionBroker) {
    let directory = tempfile::tempdir().expect("tempdir");
    let database = directory.path().join("zimlo.db");
    drop(
        Store::open(&database, StoreMode::ReadWriteCreate)
            .await
            .expect("initialize"),
    );
    let connection = rusqlite::Connection::open(&database).expect("fixture connection");
    connection
        .execute_batch(
            "INSERT INTO projects (id, name, created_at, last_used_at)
             VALUES ('project-dispatch', 'Dispatch project', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
             INSERT INTO project_locations (path, project_id, first_seen_at, last_seen_at)
             VALUES ('/tmp', 'project-dispatch', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');",
        )
        .expect("fixture");
    drop(connection);
    let store = Store::open(&database, StoreMode::ReadWriteExisting)
        .await
        .expect("store");
    let broker = ActionBroker::new(store.clone());
    (directory, store, broker)
}

async fn update(
    store: &Store,
    broker: &ActionBroker,
    can_manage_trust: bool,
    writable: bool,
    command: Value,
) -> Value {
    let result = dispatcher::dispatch(
        DispatchContext {
            store,
            device_id: "device-dispatch",
            is_local_admin: false,
            can_approve: false,
            can_manage_trust,
            writable,
            pairing: None,
            action_broker: broker,
            host_name: "Dispatch Mac",
        },
        &command,
    )
    .await
    .expect("dispatch");
    let DispatchResult::Message(message) = result else {
        panic!("expected response message");
    };
    message
}

#[tokio::test]
async fn enforces_permission_project_and_read_only_boundaries() {
    let (_directory, store, broker) = fixture().await;
    let command = json!({
        "type": "trust.policy.update",
        "projectId": "project-dispatch",
        "preset": "safe_automation",
        "idempotencyKey": "policy-once",
    });
    let forbidden = update(&store, &broker, false, true, command.clone()).await;
    assert_eq!(forbidden["code"], "forbidden");
    assert_eq!(forbidden["commandType"], "trust.policy.update");
    assert_eq!(forbidden["idempotencyKey"], "policy-once");

    let read_only = update(&store, &broker, true, false, command.clone()).await;
    assert_eq!(read_only["code"], "runtime_read_only");

    let updated = update(&store, &broker, true, true, command.clone()).await;
    assert_eq!(updated["type"], "trust.policy.updated");
    assert_eq!(updated["policy"]["preset"], "safe_automation");
    let updated_at = updated["policy"]["updatedAt"].clone();

    let replay = update(
        &store,
        &broker,
        true,
        true,
        json!({
            "type": "trust.policy.update",
            "projectId": "project-dispatch",
            "preset": "ask",
            "idempotencyKey": "policy-once",
        }),
    )
    .await;
    assert_eq!(replay["policy"]["preset"], "safe_automation");
    assert_eq!(replay["policy"]["updatedAt"], updated_at);

    let missing = update(
        &store,
        &broker,
        true,
        true,
        json!({
            "type": "trust.policy.update",
            "projectId": "missing",
            "preset": "ask",
            "idempotencyKey": "missing-project",
        }),
    )
    .await;
    assert_eq!(missing["code"], "project_not_found");
}
