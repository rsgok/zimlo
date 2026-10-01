use std::os::unix::fs::PermissionsExt as _;

use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use tempfile::tempdir;

use super::{
    DeviceRecord, SnapshotOptions, Store, StoreError, StoreMode, StoredSession, UnifiedEvent,
};

#[derive(Deserialize)]
struct StoreCompatibilityVector {
    version: u32,
    session: StoredSession,
    event: UnifiedEvent,
}

fn compatibility_vector() -> StoreCompatibilityVector {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/store-compat.json"
    )))
    .expect("store compatibility vector")
}

#[tokio::test]
async fn serializes_writes_and_reopens_the_node_compatible_database_read_only() {
    let directory = tempdir().expect("tempdir");
    let path = directory.path().join("zimlo.db");
    let store = Store::open(&path, StoreMode::ReadWriteCreate)
        .await
        .expect("open store");
    let vector = compatibility_vector();
    assert_eq!(vector.version, 1);

    let writes = (0..8).map(|index| {
        let store = store.clone();
        tokio::spawn(async move {
            store
                .set_metadata(format!("key-{index}"), format!("value-{index}"))
                .await
        })
    });
    for write in writes {
        write.await.expect("join write").expect("metadata write");
    }
    store
        .upsert_session(vector.session.clone())
        .await
        .expect("upsert session");
    let mut input_event = vector.event.clone();
    input_event.sequence = 0;
    let first = store
        .insert_event(input_event.clone())
        .await
        .expect("insert");
    let duplicate = store.insert_event(input_event).await.expect("dedupe");
    assert!(first.inserted);
    assert!(!duplicate.inserted);
    assert_eq!(first.event, vector.event);
    assert_eq!(duplicate.event, vector.event);
    drop(store);

    assert_eq!(
        std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let read_only = Store::open(&path, StoreMode::ReadOnly)
        .await
        .expect("read-only store");
    assert_eq!(
        read_only.get_metadata("key-7").await.expect("metadata"),
        Some("value-7".into())
    );
    assert_eq!(
        read_only.list_sessions().await.expect("sessions"),
        vec![vector.session]
    );
    let events = read_only
        .list_events("session-store-compat", 200)
        .await
        .expect("events");
    assert_eq!(events, vec![vector.event]);
    assert!(matches!(
        read_only.set_metadata("blocked", "write").await,
        Err(StoreError::Sqlite(_))
    ));
}

#[tokio::test]
async fn enforces_event_query_bounds() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("memory store");
    assert_eq!(
        store.list_events("session-1", 0).await,
        Err(StoreError::InvalidEventLimit)
    );
    assert_eq!(
        store.list_events("session-1", 1_001).await,
        Err(StoreError::InvalidEventLimit)
    );
}

#[tokio::test]
async fn reusing_local_admin_preserves_version_and_does_not_notify_subscribers() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("memory store");
    let mut changes = store.subscribe_changes();
    let before = store.data_version().await.expect("initial version");
    let candidate = DeviceRecord {
        id: "first-local-admin".into(),
        name: "Local Admin".into(),
        key_base64: "fixture-key".into(),
        created_at: "2026-09-01T10:00:00.000Z".into(),
        last_seen_at: "2026-09-01T10:00:00.000Z".into(),
        revoked_at: None,
        is_local_admin: true,
        can_approve: true,
        can_manage_trust: true,
    };
    let created = store
        .ensure_local_admin(candidate.clone())
        .await
        .expect("create local admin");
    let version = store.data_version().await.expect("created version");
    assert_ne!(version, before);
    assert!(changes.has_changed().expect("change subscription"));
    changes.borrow_and_update();

    for index in 0..3 {
        let existing = store
            .ensure_local_admin(DeviceRecord {
                id: format!("unused-candidate-{index}"),
                ..candidate.clone()
            })
            .await
            .expect("reuse local admin");
        assert_eq!(existing, created);
        assert_eq!(
            store.data_version().await.expect("unchanged version"),
            version
        );
        assert!(!changes.has_changed().expect("change subscription"));
    }
}

#[tokio::test]
async fn builds_the_complete_node_compatible_snapshot() {
    let directory = tempdir().expect("tempdir");
    let path = directory.path().join("zimlo.db");
    let store = Store::open(&path, StoreMode::ReadWriteCreate)
        .await
        .expect("initialize store");
    drop(store);

    let connection = rusqlite::Connection::open(&path).expect("fixture connection");
    connection
        .execute_batch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/test-vectors/snapshot-compat.sql"
        )))
        .expect("seed snapshot fixture");
    drop(connection);

    let store = Store::open(&path, StoreMode::ReadOnly)
        .await
        .expect("read-only store");
    let mut snapshot = store
        .snapshot(SnapshotOptions::local(
            "Snapshot Fixture Mac",
            "2026-09-01T12:12:00.000Z",
        ))
        .await
        .expect("snapshot");

    assert_eq!(snapshot["host"]["id"], "host_snapshot_fixture");
    assert_eq!(snapshot["host"]["name"], "Snapshot Fixture Mac");
    assert_eq!(snapshot["host"]["platform"], std::env::consts::OS);
    assert_eq!(snapshot["userProfile"]["avatarId"], "user-07");
    assert_eq!(snapshot["projects"][0]["hostId"], "host_snapshot_fixture");
    assert_eq!(snapshot["projects"][0]["sessionCount"], 1);
    assert_eq!(snapshot["projects"][0]["postCount"], 1);
    assert_eq!(snapshot["sessions"][0]["title"], "继续迁移完整 Snapshot");
    assert_eq!(snapshot["sessions"][0]["projectName"], "Snapshot Project");
    assert_eq!(snapshot["posts"][0]["headline"], "Snapshot 已兼容");
    assert_eq!(snapshot["materials"][0]["width"], 320);
    assert_eq!(snapshot["tasks"][0]["state"], "user_review");
    assert_eq!(
        snapshot["commands"][0]["materialIds"][0],
        "material_snapshot_001"
    );
    assert_eq!(snapshot["workspaces"][0]["path"], "/fixture/snapshot");
    assert_eq!(snapshot["seenPostIds"][0], "post-snapshot");
    assert_eq!(snapshot["dismissedFeedItemIds"][0], "post:old");
    assert_eq!(
        snapshot["taskTimelineCursors"]["session-snapshot"],
        "event:event-snapshot"
    );
    assert_eq!(
        snapshot["taskPreferences"][0]["pinnedAt"],
        "2026-09-01T12:07:00.000Z"
    );
    assert_eq!(
        snapshot["actions"][0]["approvalContext"]["category"],
        "test"
    );
    assert_eq!(snapshot["trustPolicies"][0]["preset"], "safe_automation");
    assert_eq!(snapshot["trustAudit"][0]["decision"], "auto_allowed");
    assert_eq!(
        snapshot["notificationSettings"]["timeZoneOffsetMinutes"],
        480
    );
    assert_eq!(snapshot["pushDevices"][0]["lastDeliveryStatus"], 200);
    assert_eq!(snapshot["features"]["remoteSync"], false);
    assert_eq!(snapshot["sequence"], 1);
    assert_eq!(snapshot["lanApprovalsEnabled"], true);
    assert_eq!(snapshot["trustManagementEnabled"], true);
    assert_eq!(snapshot["cards"], serde_json::json!([]));

    snapshot["host"]["lastSeenAt"] = serde_json::json!("NORMALIZED");
    snapshot["host"]["platform"] = serde_json::json!("macos");
    let contract: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/snapshot-compat.json"
    )))
    .expect("snapshot contract");
    let digest = Sha256::digest(serde_json::to_vec(&snapshot).expect("snapshot JSON"));
    let digest = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(digest, contract["normalizedSha256"]);
}
