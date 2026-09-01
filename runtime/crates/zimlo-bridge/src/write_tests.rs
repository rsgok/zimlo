use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
};

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use tower::ServiceExt as _;
use zimlo_protocol::crypto::{
    create_key_pair, derive_device_key, derive_pair_key, fixed_bytes, from_base64_url, make_proof,
    verify_proof,
};
use zimlo_store::{DeviceRecord, SnapshotOptions, Store, StoreMode, StoredSession};

use super::{
    ActionBroker, BridgeConfig,
    dispatcher::{self, DispatchContext, DispatchResult},
    router_with_config,
};

fn request(method: Method, uri: &str, body: Value, loopback: bool) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("request");
    if loopback {
        request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            51_235,
        )));
    }
    request
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("response JSON")
}

fn device() -> DeviceRecord {
    DeviceRecord {
        id: "local-write-test".into(),
        name: "Local Write Test".into(),
        key_base64: "fixture-key".into(),
        created_at: "2026-09-01T10:00:00.000Z".into(),
        last_seen_at: "2026-09-01T10:00:00.000Z".into(),
        revoked_at: None,
        is_local_admin: true,
        can_approve: true,
        can_manage_trust: true,
    }
}

fn session() -> StoredSession {
    StoredSession {
        id: "session-write-test".into(),
        project_id: None,
        provider: "codex".into(),
        surface: "cli".into(),
        provider_session_id: "provider-write-test".into(),
        title: "Write test".into(),
        cwd: Some("/tmp/zimlo".into()),
        transcript_path: None,
        status: "idle".into(),
        last_activity_at: "2026-09-01T10:00:00.000Z".into(),
        created_at: "2026-09-01T10:00:00.000Z".into(),
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
            "diffAvailable": false
        }),
    }
}

#[tokio::test]
async fn local_pairing_matches_the_node_crypto_contract_and_is_single_use() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .set_metadata("host_identity_v1", "host-pair-test")
        .await
        .expect("host identity");
    let router = router_with_config(
        store.clone(),
        BridgeConfig {
            host_name: "Pairing Mac".into(),
            writable: true,
            pairing_base_url: Some("http://192.168.1.50:4747".into()),
        },
    );

    let bootstrap = router
        .clone()
        .oneshot(request(
            Method::GET,
            "/api/local-bootstrap",
            json!({}),
            true,
        ))
        .await
        .expect("local bootstrap");
    assert_eq!(bootstrap.status(), StatusCode::OK);
    let bootstrap = json_body(bootstrap).await;
    assert_eq!(bootstrap["host"]["id"], "host-pair-test");
    assert!(
        bootstrap["deviceId"]
            .as_str()
            .expect("local device id")
            .starts_with("local_")
    );
    assert_eq!(
        from_base64_url(bootstrap["deviceKey"].as_str().expect("local key"))
            .expect("local key base64")
            .len(),
        32
    );

    let response = router
        .clone()
        .oneshot(request(Method::POST, "/api/local/pairing", json!({}), true))
        .await
        .expect("pairing response");
    assert_eq!(response.status(), StatusCode::OK);
    let pairing = json_body(response).await;
    assert_eq!(pairing["transport"], "lan");
    assert!(
        pairing["qrDataUrl"]
            .as_str()
            .expect("QR data URL")
            .starts_with("data:image/svg+xml;base64,")
    );
    let pair_url = pairing["pairUrl"].as_str().expect("pair URL");
    assert!(pair_url.starts_with("http://192.168.1.50:4747/#"));
    let fields = pair_url
        .split_once('#')
        .expect("fragment")
        .1
        .split('&')
        .filter_map(|part| part.split_once('='))
        .collect::<HashMap<_, _>>();
    let pairing_id = fields["pairingId"];
    let secret = from_base64_url(fields["secret"]).expect("pairing secret");
    let bridge_public = fixed_bytes::<32>(
        "bridge public key",
        &from_base64_url(fields["bridgeKey"]).expect("bridge public key"),
    )
    .expect("bridge public key length");
    let client = create_key_pair().expect("client key pair");
    let pair_key = derive_pair_key(&client.private_key, &bridge_public, &secret).expect("pair key");
    let proof = make_proof(&pair_key, &format!("client:{pairing_id}")).expect("client proof");
    let body = json!({
        "pairingId": pairing_id,
        "clientPublicKey": zimlo_protocol::crypto::to_base64_url(&client.public_key),
        "proof": proof,
        "name": "Rust Pairing Client",
    });
    let response = router
        .clone()
        .oneshot(request(Method::POST, "/api/pair", body.clone(), false))
        .await
        .expect("complete pairing");
    assert_eq!(response.status(), StatusCode::OK);
    let completed = json_body(response).await;
    assert_eq!(completed["host"]["id"], "host-pair-test");
    assert_eq!(completed["host"]["name"], "Pairing Mac");
    let device_id = completed["deviceId"].as_str().expect("device id");
    verify_proof(
        &pair_key,
        &format!("server:{device_id}"),
        completed["serverProof"].as_str().expect("server proof"),
    )
    .expect("valid server proof");
    let expected_device_key = derive_device_key(&pair_key, &secret).expect("device key");
    let paired = store
        .active_device(device_id)
        .await
        .expect("paired device")
        .expect("active paired device");
    assert_eq!(
        from_base64_url(&paired.key_base64).expect("stored key"),
        expected_device_key
    );

    let replay = router
        .oneshot(request(Method::POST, "/api/pair", body, false))
        .await
        .expect("pairing replay");
    assert_eq!(replay.status(), StatusCode::GONE);
}

#[tokio::test]
async fn dispatcher_persists_safe_commands_and_queues_native_execution() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .set_metadata("host_identity_v1", "host-write-test")
        .await
        .expect("host identity");
    store.upsert_device(device()).await.expect("device");
    store.upsert_session(session()).await.expect("session");
    let broker = ActionBroker::new(store.clone());
    let before = store.data_version().await.expect("version before");

    let first = dispatcher::dispatch(
        DispatchContext {
            store: &store,
            device_id: "local-write-test",
            is_local_admin: true,
            can_approve: true,
            can_manage_trust: true,
            writable: true,
            pairing: None,
            action_broker: &broker,
            host_name: "Write Mac",
        },
        &json!({
            "type": "task.pin",
            "sessionId": "session-write-test",
            "pinned": true,
            "idempotencyKey": "pin-dispatch",
        }),
    )
    .await
    .expect("pin command");
    let DispatchResult::Message(first) = first else {
        panic!("pin should return a message");
    };
    assert_eq!(first["type"], "task.preference.updated");
    let pinned_at = first["preference"]["pinnedAt"].clone();

    let replay = dispatcher::dispatch(
        DispatchContext {
            store: &store,
            device_id: "local-write-test",
            is_local_admin: true,
            can_approve: true,
            can_manage_trust: true,
            writable: true,
            pairing: None,
            action_broker: &broker,
            host_name: "Write Mac",
        },
        &json!({
            "type": "task.pin",
            "sessionId": "session-write-test",
            "pinned": false,
            "idempotencyKey": "pin-dispatch",
        }),
    )
    .await
    .expect("pin replay");
    let DispatchResult::Message(replay) = replay else {
        panic!("replay should return a message");
    };
    assert_eq!(replay["preference"]["pinnedAt"], pinned_at);
    assert_ne!(store.data_version().await.expect("version after"), before);

    let read_only = dispatcher::dispatch(
        DispatchContext {
            store: &store,
            device_id: "local-write-test",
            is_local_admin: true,
            can_approve: true,
            can_manage_trust: true,
            writable: false,
            pairing: None,
            action_broker: &broker,
            host_name: "Write Mac",
        },
        &json!({ "type": "feed.seen", "postId": "post-missing" }),
    )
    .await
    .expect("read-only guard");
    let DispatchResult::Message(read_only) = read_only else {
        panic!("read-only command should return an error");
    };
    assert_eq!(read_only["code"], "runtime_read_only");

    let execution = dispatcher::dispatch(
        DispatchContext {
            store: &store,
            device_id: "local-write-test",
            is_local_admin: true,
            can_approve: true,
            can_manage_trust: true,
            writable: true,
            pairing: None,
            action_broker: &broker,
            host_name: "Write Mac",
        },
        &json!({
            "type": "session.message",
            "sessionId": "session-write-test",
            "text": "execute through Rust",
            "idempotencyKey": "execution-native",
        }),
    )
    .await
    .expect("execution guard");
    let DispatchResult::Messages(execution) = execution else {
        panic!("execution command should return an update");
    };
    assert_eq!(execution[0]["command"]["state"], "queued");
    assert_eq!(execution[0]["command"]["provider"], "codex");
    assert_eq!(execution[1]["ok"], true);

    let snapshot = store
        .snapshot(SnapshotOptions::for_device(
            "Write Mac",
            "2026-09-01T12:00:00.000Z",
            "local-write-test",
        ))
        .await
        .expect("snapshot");
    assert_eq!(snapshot["taskPreferences"][0]["pinnedAt"], pinned_at);
}
