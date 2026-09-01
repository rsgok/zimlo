use serde_json::{Value, json};
use zimlo_store::{DeviceRecord, Store, StoreMode};

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
             VALUES ('project-management', 'Management project', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
             INSERT INTO project_locations (path, project_id, first_seen_at, last_seen_at)
             VALUES ('/tmp', 'project-management', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');",
        )
        .expect("project");
    drop(connection);
    let store = Store::open(&database, StoreMode::ReadWriteExisting)
        .await
        .expect("store");
    store
        .set_metadata("host_identity_v1", "host-management")
        .await
        .expect("host");
    for device in [
        device("local-management", true),
        device("phone-management", false),
    ] {
        store.upsert_device(device).await.expect("device");
    }
    let broker = ActionBroker::new(store.clone());
    (directory, store, broker)
}

fn device(id: &str, is_local_admin: bool) -> DeviceRecord {
    DeviceRecord {
        id: id.into(),
        name: id.into(),
        key_base64: "fixture-key".into(),
        created_at: "2026-09-02T00:00:00.000Z".into(),
        last_seen_at: "2026-09-02T00:00:00.000Z".into(),
        revoked_at: None,
        is_local_admin,
        can_approve: is_local_admin,
        can_manage_trust: is_local_admin,
    }
}

async fn dispatch(
    store: &Store,
    broker: &ActionBroker,
    device_id: &str,
    is_local_admin: bool,
    writable: bool,
    command: Value,
) -> DispatchResult {
    dispatcher::dispatch(
        DispatchContext {
            store,
            device_id,
            is_local_admin,
            can_approve: is_local_admin,
            can_manage_trust: is_local_admin,
            writable,
            pairing: None,
            action_broker: broker,
            host_name: "Management Mac",
        },
        &command,
    )
    .await
    .expect("dispatch")
}

fn profile_command(project_id: &str, display_name: &str, key: &str) -> Value {
    json!({
        "type": "agent.profile.update",
        "projectId": project_id,
        "displayName": display_name,
        "avatar": "agent-01",
        "bio": "  Rust native agent  ",
        "defaultProvider": "codex",
        "idempotencyKey": key,
    })
}

#[tokio::test]
async fn updates_agent_profile_idempotently_and_returns_the_complete_project() {
    let (_directory, store, broker) = fixture().await;
    let first = dispatch(
        &store,
        &broker,
        "phone-management",
        false,
        true,
        profile_command("project-management", "  Rust Agent  ", "profile-once"),
    )
    .await;
    let DispatchResult::Message(first) = first else {
        panic!("project update response");
    };
    assert_eq!(first["type"], "project.updated");
    assert_eq!(first["project"]["hostId"], "host-management");
    assert_eq!(
        first["project"]["agentProfile"]["displayName"],
        "Rust Agent"
    );
    assert_eq!(first["project"]["agentProfile"]["bio"], "Rust native agent");
    let updated_at = first["project"]["agentProfile"]["updatedAt"].clone();

    let replay = dispatch(
        &store,
        &broker,
        "phone-management",
        false,
        true,
        profile_command("project-management", "Changed", "profile-once"),
    )
    .await;
    let DispatchResult::Message(replay) = replay else {
        panic!("replay response");
    };
    assert_eq!(
        replay["project"]["agentProfile"]["displayName"],
        "Rust Agent"
    );
    assert_eq!(replay["project"]["agentProfile"]["updatedAt"], updated_at);

    let missing = dispatch(
        &store,
        &broker,
        "phone-management",
        false,
        true,
        profile_command("missing", "Missing", "profile-missing"),
    )
    .await;
    let DispatchResult::Message(missing) = missing else {
        panic!("missing project response");
    };
    assert_eq!(missing["code"], "project_not_found");
    assert_eq!(missing["commandType"], "agent.profile.update");
    assert_eq!(missing["idempotencyKey"], "profile-missing");
}

#[tokio::test]
async fn validates_profile_payload_and_read_only_mode() {
    let (_directory, store, broker) = fixture().await;
    let invalid = dispatch(
        &store,
        &broker,
        "phone-management",
        false,
        true,
        json!({
            "type": "agent.profile.update", "projectId": "project-management",
            "displayName": "Agent", "avatar": "agent-01", "bio": "",
            "defaultProvider": "unknown"
        }),
    )
    .await;
    assert!(matches!(invalid, DispatchResult::Invalid));

    let read_only = dispatch(
        &store,
        &broker,
        "phone-management",
        false,
        false,
        profile_command("project-management", "Agent", "profile-read-only"),
    )
    .await;
    let DispatchResult::Message(read_only) = read_only else {
        panic!("read-only response");
    };
    assert_eq!(read_only["code"], "runtime_read_only");
}

#[tokio::test]
async fn local_admin_toggles_lan_approval_for_every_active_phone() {
    let (_directory, store, broker) = fixture().await;
    let forbidden = dispatch(
        &store,
        &broker,
        "phone-management",
        false,
        true,
        json!({ "type": "lan.approvals.set", "enabled": true }),
    )
    .await;
    let DispatchResult::Message(forbidden) = forbidden else {
        panic!("forbidden response");
    };
    assert_eq!(forbidden["code"], "forbidden");

    for enabled in [true, false] {
        let result = dispatch(
            &store,
            &broker,
            "local-management",
            true,
            true,
            json!({ "type": "lan.approvals.set", "enabled": enabled }),
        )
        .await;
        let DispatchResult::Messages(messages) = result else {
            panic!("LAN approval responses");
        };
        assert_eq!(messages[0]["type"], "lan.approvals.changed");
        assert_eq!(messages[0]["enabled"], enabled);
        let phone = messages[1]["devices"]
            .as_array()
            .expect("devices")
            .iter()
            .find(|device| device["id"] == "phone-management")
            .expect("phone");
        assert_eq!(phone["canApprove"], enabled);
        assert!(phone.get("keyBase64").is_none());
        assert_eq!(
            store
                .get_metadata("lan_approvals_enabled")
                .await
                .expect("metadata")
                .as_deref(),
            Some(if enabled { "1" } else { "0" })
        );
    }
}
