use std::{net::SocketAddr, path::Path};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead as _, KeyInit as _},
};
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
};
use chrono::Utc;
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tower::ServiceExt as _;
use zimlo_protocol::crypto::{make_proof, to_base64_url};
use zimlo_store::{DeviceRecord, SnapshotOptions, Store, StoreMode};

use super::{
    ActionBroker, BridgeConfig,
    dispatcher::{self, DispatchContext, DispatchResult},
    router_with_config,
};

const LOCAL_DEVICE_ID: &str = "local_material_test";
const PAIRED_DEVICE_ID: &str = "device_material_test";
const MATERIAL_ID: &str = "material_1234567890123456";

async fn store(path: &Path) -> Store {
    let store = Store::open(path, StoreMode::ReadWriteCreate)
        .await
        .expect("store");
    store
        .set_metadata("host_identity_v1", "host-material-test")
        .await
        .expect("host identity");
    store
        .upsert_device(device(LOCAL_DEVICE_ID, true, &[7; 32]))
        .await
        .expect("local device");
    store
        .upsert_device(device(PAIRED_DEVICE_ID, false, &[9; 32]))
        .await
        .expect("paired device");
    store
}

fn device(id: &str, local: bool, key: &[u8; 32]) -> DeviceRecord {
    DeviceRecord {
        id: id.into(),
        name: format!("{id} name"),
        key_base64: to_base64_url(key),
        created_at: "2026-09-01T10:00:00.000Z".into(),
        last_seen_at: "2026-09-01T10:00:00.000Z".into(),
        revoked_at: None,
        is_local_admin: local,
        can_approve: true,
        can_manage_trust: true,
    }
}

fn router(store: Store) -> axum::Router {
    router_with_config(
        store,
        BridgeConfig {
            host_name: "Material Mac".into(),
            writable: true,
            pairing_base_url: None,
            web_root: None,
            cloud: None,
        },
    )
}

fn request(
    method: Method,
    uri: &str,
    peer: SocketAddr,
    headers: &[(&str, String)],
    body: Vec<u8>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, value);
    }
    let mut request = builder.body(Body::from(body)).expect("request");
    request.extensions_mut().insert(ConnectInfo(peer));
    request
}

async fn body(response: axum::response::Response) -> Vec<u8> {
    response
        .into_body()
        .collect()
        .await
        .expect("response body")
        .to_bytes()
        .to_vec()
}

fn png() -> Vec<u8> {
    let mut value = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    value.extend_from_slice(b"rust-material-smoke");
    value
}

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn encrypted(value: &[u8], key: &[u8; 32], nonce: &[u8; 12]) -> Vec<u8> {
    let mut combined = nonce.to_vec();
    combined.extend(
        Aes256Gcm::new_from_slice(key)
            .expect("cipher")
            .encrypt(Nonce::from_slice(nonce), value)
            .expect("encrypt"),
    );
    combined
}

#[tokio::test]
async fn local_import_persists_private_material_and_supports_ranges() {
    let directory = tempfile::tempdir().expect("tempdir");
    let store = store(&directory.path().join("zimlo.db")).await;
    let router = router(store.clone());
    let plaintext = png();
    let response = router
        .clone()
        .oneshot(request(
            Method::PUT,
            &format!("/api/local/materials/{MATERIAL_ID}"),
            "127.0.0.1:51001".parse().expect("loopback"),
            &[
                ("content-type", "application/octet-stream".into()),
                ("x-zimlo-kind", "image".into()),
                ("x-zimlo-name", "smoke%20image.png".into()),
                ("x-zimlo-mime", "image/png".into()),
                ("x-zimlo-sha256", digest(&plaintext)),
            ],
            plaintext.clone(),
        ))
        .await
        .expect("local import");
    assert_eq!(response.status(), StatusCode::CREATED);
    let imported: Value = serde_json::from_slice(&body(response).await).expect("material JSON");
    assert_eq!(imported["name"], "smoke image.png");
    assert_eq!(imported["status"], "ready");
    assert!(imported.get("localPath").is_none());

    let stored = store
        .get_material(MATERIAL_ID)
        .await
        .expect("material")
        .expect("stored material");
    let path = stored.local_path.expect("local path");
    assert_eq!(std::fs::read(&path).expect("private material"), plaintext);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    let range = router
        .clone()
        .oneshot(request(
            Method::GET,
            &format!("/api/materials/{MATERIAL_ID}/content"),
            "127.0.0.1:51002".parse().expect("loopback"),
            &[("range", "bytes=0-7".into())],
            Vec::new(),
        ))
        .await
        .expect("range response");
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        range.headers()["content-range"],
        format!("bytes 0-7/{}", plaintext.len())
    );
    assert_eq!(body(range).await, plaintext[..8]);

    let snapshot = store
        .snapshot(SnapshotOptions::for_device(
            "Material Mac",
            "2026-09-01T11:00:00.000Z",
            LOCAL_DEVICE_ID,
        ))
        .await
        .expect("snapshot");
    assert_eq!(snapshot["materials"][0]["id"], MATERIAL_ID);
    assert_eq!(snapshot["materials"][0]["hostId"], "host-material-test");
}

#[tokio::test]
async fn paired_upload_authenticates_decrypts_and_registers_idempotently() {
    let directory = tempfile::tempdir().expect("tempdir");
    let store = store(&directory.path().join("zimlo.db")).await;
    let broker = ActionBroker::new(store.clone());
    let router = router(store.clone());
    let plaintext = png();
    let material_key = [11_u8; 32];
    let blob = encrypted(&plaintext, &material_key, &[13; 12]);
    let timestamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let proof = make_proof(
        &[9; 32],
        &format!("material-upload:{MATERIAL_ID}:{timestamp}:{}", blob.len()),
    )
    .expect("upload proof");
    let response = router
        .clone()
        .oneshot(request(
            Method::PUT,
            &format!("/api/materials/{MATERIAL_ID}/blob"),
            "192.168.1.25:51003".parse().expect("LAN peer"),
            &[
                ("x-zimlo-device-id", PAIRED_DEVICE_ID.into()),
                ("x-zimlo-timestamp", timestamp),
                ("x-zimlo-proof", proof),
            ],
            blob,
        ))
        .await
        .expect("upload response");
    assert_eq!(response.status(), StatusCode::CREATED);

    let command = json!({
        "type": "material.register",
        "material": {
            "id": MATERIAL_ID,
            "kind": "image",
            "name": "paired.png",
            "mimeType": "image/png",
            "sizeBytes": plaintext.len(),
            "sha256": digest(&plaintext),
            "origin": "user",
            "createdAt": "2026-09-01T11:00:00.000Z"
        },
        "transport": "local",
        "encryptionKey": to_base64_url(&material_key),
        "idempotencyKey": "material-register-test"
    });
    let result = dispatcher::dispatch(
        DispatchContext {
            store: &store,
            device_id: PAIRED_DEVICE_ID,
            is_local_admin: false,
            can_approve: true,
            can_manage_trust: true,
            writable: true,
            pairing: None,
            cloud: None,
            action_broker: &broker,
            host_name: "Material Mac",
        },
        &command,
    )
    .await
    .expect("register");
    let DispatchResult::Message(message) = result else {
        panic!("registration should return material.updated");
    };
    assert_eq!(message["type"], "material.updated");
    assert_eq!(message["material"]["status"], "ready");
    assert!(message["material"].get("localPath").is_none());

    let replay = dispatcher::dispatch(
        DispatchContext {
            store: &store,
            device_id: PAIRED_DEVICE_ID,
            is_local_admin: false,
            can_approve: true,
            can_manage_trust: true,
            writable: true,
            pairing: None,
            cloud: None,
            action_broker: &broker,
            host_name: "Material Mac",
        },
        &command,
    )
    .await
    .expect("register replay");
    assert!(matches!(replay, DispatchResult::Message(_)));

    let timestamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let proof = make_proof(
        &[9; 32],
        &format!("material-download:{MATERIAL_ID}:{timestamp}"),
    )
    .expect("download proof");
    let download = router
        .oneshot(request(
            Method::GET,
            &format!("/api/materials/{MATERIAL_ID}/content"),
            "192.168.1.25:51004".parse().expect("LAN peer"),
            &[
                ("x-zimlo-device-id", PAIRED_DEVICE_ID.into()),
                ("x-zimlo-timestamp", timestamp),
                ("x-zimlo-proof", proof),
            ],
            Vec::new(),
        ))
        .await
        .expect("download");
    assert_eq!(download.status(), StatusCode::OK);
    assert_eq!(body(download).await, plaintext);
}

#[tokio::test]
async fn material_routes_reject_bad_auth_invalid_content_and_cloud_transport() {
    let directory = tempfile::tempdir().expect("tempdir");
    let store = store(&directory.path().join("zimlo.db")).await;
    let broker = ActionBroker::new(store.clone());
    let router = router(store.clone());
    let unauthorized = router
        .clone()
        .oneshot(request(
            Method::PUT,
            &format!("/api/materials/{MATERIAL_ID}/blob"),
            "192.168.1.25:51005".parse().expect("LAN peer"),
            &[],
            vec![1, 2, 3],
        ))
        .await
        .expect("unauthorized upload");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let invalid = router
        .oneshot(request(
            Method::PUT,
            &format!("/api/local/materials/{MATERIAL_ID}"),
            "127.0.0.1:51006".parse().expect("loopback"),
            &[
                ("x-zimlo-kind", "image".into()),
                ("x-zimlo-name", "not-an-image.png".into()),
                ("x-zimlo-mime", "image/png".into()),
                ("x-zimlo-sha256", digest(b"not an image")),
            ],
            b"not an image".to_vec(),
        ))
        .await
        .expect("invalid import");
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        store
            .get_material(MATERIAL_ID)
            .await
            .expect("failed material")
            .expect("failed record")
            .status,
        "failed"
    );

    let cloud = dispatcher::dispatch(
        DispatchContext {
            store: &store,
            device_id: PAIRED_DEVICE_ID,
            is_local_admin: false,
            can_approve: true,
            can_manage_trust: true,
            writable: true,
            pairing: None,
            cloud: None,
            action_broker: &broker,
            host_name: "Material Mac",
        },
        &json!({
            "type": "material.register",
            "material": {
                "id": MATERIAL_ID,
                "kind": "image",
                "name": "cloud.png",
                "mimeType": "image/png",
                "sizeBytes": 10,
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "origin": "user",
                "createdAt": "2026-09-01T11:00:00.000Z"
            },
            "transport": "cloud",
            "encryptionKey": to_base64_url(&[1; 32]),
            "idempotencyKey": "cloud-unavailable"
        }),
    )
    .await
    .expect("cloud handling");
    let DispatchResult::Message(message) = cloud else {
        panic!("cloud transport should return material state");
    };
    assert_eq!(message["type"], "material.updated");
    assert_eq!(message["material"]["status"], "failed");
    assert_eq!(
        message["material"]["error"],
        "找不到已上传的物料，请重新选择。"
    );
}
