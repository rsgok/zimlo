use serde_json::json;
use tempfile::tempdir;

use super::{Store, StoreMode, StoredSession, TrustAuditRecord, UpdateTrustPolicyResult};

async fn fixture() -> (tempfile::TempDir, Store) {
    let directory = tempdir().expect("tempdir");
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
             VALUES ('project-trust', 'Trust project', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
             INSERT INTO project_locations (path, project_id, first_seen_at, last_seen_at)
             VALUES ('/tmp/zimlo-trust', 'project-trust', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');",
        )
        .expect("fixture");
    drop(connection);
    let store = Store::open(&database, StoreMode::ReadWriteExisting)
        .await
        .expect("store");
    store
        .upsert_session(StoredSession {
            id: "session-trust".into(),
            project_id: Some("project-trust".into()),
            provider: "codex".into(),
            surface: "managed".into(),
            provider_session_id: "provider-trust".into(),
            title: "Trust test".into(),
            cwd: Some("/tmp/zimlo-trust".into()),
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
    (directory, store)
}

#[tokio::test]
async fn persists_default_updates_and_idempotent_replays() {
    let (_directory, store) = fixture().await;
    let default = store
        .get_trust_policy("project-trust")
        .await
        .expect("default policy");
    assert_eq!(default.preset, "ask");
    assert!(default.auto_allow.is_empty());
    assert_eq!(
        store
            .project_primary_path("project-trust")
            .await
            .expect("project root")
            .as_deref(),
        Some("/tmp/zimlo-trust")
    );

    let UpdateTrustPolicyResult::Updated(updated) = store
        .update_trust_policy(
            "project-trust",
            "safe_automation",
            "device-trust",
            "device-trust:policy-once",
            "2026-09-02T01:00:00.000Z",
        )
        .await
        .expect("update")
    else {
        panic!("project should exist");
    };
    assert_eq!(updated.auto_allow, ["read", "search", "test", "build"]);

    let UpdateTrustPolicyResult::Updated(replay) = store
        .update_trust_policy(
            "project-trust",
            "ask",
            "other-device",
            "device-trust:policy-once",
            "2026-09-02T02:00:00.000Z",
        )
        .await
        .expect("replay")
    else {
        panic!("project should exist");
    };
    assert_eq!(replay, updated);
    assert_eq!(
        store
            .update_trust_policy(
                "missing",
                "ask",
                "device-trust",
                "device-trust:missing",
                "2026-09-02T03:00:00.000Z",
            )
            .await
            .expect("missing project"),
        UpdateTrustPolicyResult::ProjectNotFound
    );
}

#[tokio::test]
async fn records_and_filters_trust_audit() {
    let (_directory, store) = fixture().await;
    for (id, decision) in [("audit-asked", "asked"), ("audit-auto", "auto_allowed")] {
        store
            .insert_trust_audit(TrustAuditRecord {
                id: id.into(),
                project_id: "project-trust".into(),
                session_id: "session-trust".into(),
                device_id: "device-trust".into(),
                category: "test".into(),
                decision: decision.into(),
                reason: "fixture".into(),
                action_summary: "cargo test".into(),
                created_at: format!("2026-09-02T00:00:0{}.000Z", usize::from(id == "audit-auto")),
            })
            .await
            .expect("audit");
    }
    let filtered = store
        .list_trust_audit(Some("project-trust".into()), 10)
        .await
        .expect("filtered audit");
    assert_eq!(filtered.len(), 2);
    assert_eq!(filtered[0].decision, "auto_allowed");
    assert_eq!(
        store.list_trust_audit(None, 1).await.expect("all audit")[0].decision,
        "auto_allowed"
    );
}
