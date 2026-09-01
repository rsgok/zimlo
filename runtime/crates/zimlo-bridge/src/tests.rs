use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use futures_util::{SinkExt as _, StreamExt as _};
use http_body_util::BodyExt as _;
use rusqlite::params;
use serde_json::json;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message as ClientMessage, protocol::frame::coding::CloseCode},
};
use tower::ServiceExt as _;
use zimlo_protocol::crypto::{
    decrypt_frame, derive_connection_keys, encrypt_frame, fixed_bytes, from_base64_url, make_proof,
    verify_proof,
};
use zimlo_store::{Store, StoreMode, StoredSession, UnifiedEvent};

use super::{router, router_with_store, router_with_store_named, serve_with_store};

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn next_socket_json(socket: &mut TestSocket) -> serde_json::Value {
    let message = socket
        .next()
        .await
        .expect("socket message")
        .expect("valid socket message");
    serde_json::from_slice(&message.into_data()).expect("JSON socket message")
}

fn request(uri: &str, peer: IpAddr) -> Request<Body> {
    let mut request = Request::builder()
        .uri(uri)
        .body(Body::empty())
        .expect("request");
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(peer, 51_234)));
    request
}

fn session() -> StoredSession {
    StoredSession {
        id: "session-1".into(),
        project_id: None,
        provider: "codex".into(),
        surface: "cli".into(),
        provider_session_id: "provider-session-1".into(),
        title: "Rust Bridge events".into(),
        cwd: Some("/tmp/zimlo".into()),
        transcript_path: None,
        status: "running".into(),
        last_activity_at: "2026-09-01T10:01:00.000Z".into(),
        created_at: "2026-09-01T10:00:00.000Z".into(),
        active_pid: None,
        process_started_at: None,
        tty: None,
        correlation_uncertain: false,
        capabilities: serde_json::json!({
            "discovered": true,
            "liveObserved": true,
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
async fn healthz_matches_the_existing_bridge_contract() {
    let response = router()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).expect("health JSON");
    assert_eq!(
        value,
        json!({
            "ok": true,
            "version": "0.2.1",
            "protocolVersion": 5,
            "features": {
                "projectTrustPolicy": true,
                "pushNotifications": true,
                "remoteSync": true,
                "multiHost": true
            }
        })
    );
}

#[tokio::test]
async fn local_events_route_matches_the_existing_bridge_shape() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store.upsert_session(session()).await.expect("session");
    store
        .insert_event(UnifiedEvent {
            id: "event-1".into(),
            sequence: 0,
            provider: "codex".into(),
            session_id: "session-1".into(),
            provider_session_id: "provider-session-1".into(),
            turn_id: Some("turn-1".into()),
            item_id: None,
            kind: "user_instruction".into(),
            source: "app_server".into(),
            occurred_at: "2026-09-01T10:01:00.000Z".into(),
            payload: serde_json::json!({ "prompt": "继续迁移 Runtime" }),
            provenance: "verified".into(),
        })
        .await
        .expect("event");

    let response = router_with_store(store)
        .oneshot(request(
            "/api/local/sessions/session-1/events",
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).expect("events JSON");
    assert_eq!(value["sessionId"], "session-1");
    assert_eq!(value["events"][0]["sequence"], 1);
    assert_eq!(value["events"][0]["payload"]["prompt"], "继续迁移 Runtime");
    assert!(value["events"][0].get("itemId").is_none());
}

#[tokio::test]
async fn local_events_route_rejects_non_loopback_clients() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    let response = router_with_store(store)
        .oneshot(request(
            "/api/local/sessions/session-1/events",
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 2)),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).expect("error JSON");
    assert_eq!(value["code"], "loopback_only");
    assert_eq!(value["recoverable"], false);
}

#[tokio::test]
async fn local_snapshot_route_serves_the_complete_node_shape() {
    let directory = tempfile::tempdir().expect("tempdir");
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

    let response = router_with_store_named(store, "Snapshot Fixture Mac")
        .oneshot(request(
            "/api/local/snapshot",
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).expect("snapshot JSON");
    assert_eq!(value["host"]["id"], "host_snapshot_fixture");
    assert_eq!(value["host"]["name"], "Snapshot Fixture Mac");
    assert_eq!(value["sessions"][0]["title"], "继续迁移完整 Snapshot");
    assert_eq!(value["posts"][0]["headline"], "Snapshot 已兼容");
    assert_eq!(value["actions"][0]["approvalContext"]["category"], "test");
    assert_eq!(value["features"]["remoteSync"], false);
    assert_eq!(value["sequence"], 1);
}

#[tokio::test]
async fn local_snapshot_route_requires_an_initialized_identity() {
    let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    let response = router_with_store(store)
        .oneshot(request(
            "/api/local/snapshot",
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).expect("error JSON");
    assert_eq!(value["code"], "snapshot_identity_unavailable");
}

#[tokio::test]
async fn websocket_authenticates_encrypts_and_broadcasts_device_snapshot() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("zimlo.db");
    let store = Store::open(&path, StoreMode::ReadWriteCreate)
        .await
        .expect("initialize store");
    drop(store);

    let vectors: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/test-vectors/crypto.json"
    )))
    .expect("crypto vectors");
    let device_key_text = vectors["frame"]["deviceKey"].as_str().expect("device key");
    let client_nonce_text = vectors["frame"]["clientNonce"]
        .as_str()
        .expect("client nonce");
    let device_key = fixed_bytes::<32>(
        "device key",
        &from_base64_url(device_key_text).expect("device key base64"),
    )
    .expect("device key length");
    let client_nonce = fixed_bytes::<24>(
        "client nonce",
        &from_base64_url(client_nonce_text).expect("client nonce base64"),
    )
    .expect("client nonce length");

    let connection = rusqlite::Connection::open(&path).expect("fixture connection");
    connection
        .execute_batch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/test-vectors/snapshot-compat.sql"
        )))
        .expect("seed snapshot fixture");
    connection
        .execute(
            "INSERT INTO devices(
                id, name, key_base64, created_at, last_seen_at, revoked_at,
                is_local_admin, can_approve, can_manage_trust
             ) VALUES (?1, 'WebSocket Device', ?2, ?3, ?3, NULL, 0, 0, 0)",
            params!["device-ws", device_key_text, "2026-09-01T12:00:00.000Z"],
        )
        .expect("seed WebSocket device");
    drop(connection);

    let store = Store::open(&path, StoreMode::ReadOnly)
        .await
        .expect("read-only store");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("listener address");
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
    let server_store = store.clone();
    let server = tokio::spawn(async move {
        serve_with_store(listener, server_store, "WebSocket Mac", async {
            let _ = stopped.await;
        })
        .await
        .expect("serve bridge");
    });

    let (mut socket, _) = connect_async(format!("ws://{address}/ws"))
        .await
        .expect("connect WebSocket");
    let client_proof =
        make_proof(&device_key, &format!("ws:{client_nonce_text}")).expect("client proof");
    socket
        .send(ClientMessage::Text(
            json!({
                "type": "auth",
                "deviceId": "device-ws",
                "clientNonce": client_nonce_text,
                "proof": client_proof,
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send auth");

    let auth = next_socket_json(&mut socket).await;
    assert_eq!(auth["type"], "auth.ok");
    let server_nonce_text = auth["serverNonce"].as_str().expect("server nonce");
    verify_proof(
        &device_key,
        &format!("ws-server:{client_nonce_text}:{server_nonce_text}"),
        auth["proof"].as_str().expect("server proof"),
    )
    .expect("valid server proof");
    let server_nonce = fixed_bytes::<24>(
        "server nonce",
        &from_base64_url(server_nonce_text).expect("server nonce base64"),
    )
    .expect("server nonce length");
    let keys =
        derive_connection_keys(&device_key, &client_nonce, &server_nonce).expect("connection keys");
    let aad = "zimlo-ws-v1:device-ws";

    let initial_frame = next_socket_json(&mut socket).await;
    assert_eq!(initial_frame["counter"], 0);
    let initial: serde_json::Value = decrypt_frame(
        &keys.server_tx,
        0,
        initial_frame["ciphertext"].as_str().expect("ciphertext"),
        aad,
    )
    .expect("initial snapshot");
    assert_eq!(initial["type"], "session.snapshot");
    assert_eq!(initial["snapshot"]["host"]["name"], "WebSocket Mac");
    assert_eq!(initial["snapshot"]["seenPostIds"], json!([]));
    assert_eq!(initial["snapshot"]["lanApprovalsEnabled"], false);
    assert_eq!(initial["snapshot"]["trustManagementEnabled"], false);

    let request_ciphertext = encrypt_frame(
        &keys.client_tx,
        0,
        &json!({ "type": "snapshot.request", "afterSequence": 1 }),
        aad,
    )
    .expect("request ciphertext");
    let request_frame = json!({
        "type": "secure",
        "counter": 0,
        "ciphertext": request_ciphertext,
    })
    .to_string();
    socket
        .send(ClientMessage::Text(request_frame.clone().into()))
        .await
        .expect("request snapshot");
    let requested_frame = next_socket_json(&mut socket).await;
    assert_eq!(requested_frame["counter"], 1);
    let requested: serde_json::Value = decrypt_frame(
        &keys.server_tx,
        1,
        requested_frame["ciphertext"].as_str().expect("ciphertext"),
        aad,
    )
    .expect("requested snapshot");
    assert_eq!(requested["type"], "session.snapshot");

    let events_ciphertext = encrypt_frame(
        &keys.client_tx,
        1,
        &json!({ "type": "session.events.request", "sessionId": "session-snapshot" }),
        aad,
    )
    .expect("events ciphertext");
    socket
        .send(ClientMessage::Text(
            json!({
                "type": "secure",
                "counter": 1,
                "ciphertext": events_ciphertext,
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("request events");
    let events_frame = next_socket_json(&mut socket).await;
    assert_eq!(events_frame["counter"], 2);
    let events: serde_json::Value = decrypt_frame(
        &keys.server_tx,
        2,
        events_frame["ciphertext"].as_str().expect("ciphertext"),
        aad,
    )
    .expect("session events");
    assert_eq!(events["type"], "session.events");
    assert_eq!(events["sessionId"], "session-snapshot");
    assert_eq!(events["events"][0]["id"], "event-snapshot");

    let write_ciphertext = encrypt_frame(
        &keys.client_tx,
        2,
        &json!({ "type": "feed.seen", "postId": "post-snapshot" }),
        aad,
    )
    .expect("write ciphertext");
    socket
        .send(ClientMessage::Text(
            json!({
                "type": "secure",
                "counter": 2,
                "ciphertext": write_ciphertext,
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send read-only write");
    let read_only_frame = next_socket_json(&mut socket).await;
    assert_eq!(read_only_frame["counter"], 3);
    let read_only: serde_json::Value = decrypt_frame(
        &keys.server_tx,
        3,
        read_only_frame["ciphertext"].as_str().expect("ciphertext"),
        aad,
    )
    .expect("read-only error");
    assert_eq!(read_only["type"], "error");
    assert_eq!(read_only["code"], "runtime_read_only");

    let writer = rusqlite::Connection::open(&path).expect("external writer");
    writer
        .execute(
            "UPDATE user_profile SET avatar_id = 'user-04', updated_at = ?1 WHERE id = 1",
            ["2026-09-01T12:30:00.000Z"],
        )
        .expect("update profile");
    drop(writer);
    let broadcast_frame =
        tokio::time::timeout(Duration::from_secs(3), next_socket_json(&mut socket))
            .await
            .expect("snapshot broadcast");
    assert_eq!(broadcast_frame["counter"], 4);
    let broadcast: serde_json::Value = decrypt_frame(
        &keys.server_tx,
        4,
        broadcast_frame["ciphertext"].as_str().expect("ciphertext"),
        aad,
    )
    .expect("broadcast snapshot");
    assert_eq!(broadcast["snapshot"]["userProfile"]["avatarId"], "user-04");
    assert_eq!(broadcast["snapshot"]["seenPostIds"], json!([]));

    socket
        .send(ClientMessage::Text(request_frame.into()))
        .await
        .expect("replay frame");
    let close = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .expect("replay close timeout")
        .expect("replay close message")
        .expect("valid replay close");
    match close {
        ClientMessage::Close(Some(frame)) => {
            assert_eq!(frame.code, CloseCode::Policy);
            assert_eq!(frame.reason, "Replay or counter gap");
        }
        message => panic!("expected policy close, got {message:?}"),
    }

    let _ = shutdown.send(());
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .expect("server shutdown timeout")
        .expect("server task");
}
