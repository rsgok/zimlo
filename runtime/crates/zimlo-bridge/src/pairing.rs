use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{
    Json,
    extract::{ConnectInfo, Path, State},
    http::StatusCode,
    response::{IntoResponse as _, Response},
};
use serde::Deserialize;
use serde_json::json;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, SecondsFormat, Utc};
use qrcode::{QrCode, render::svg};
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;
use zimlo_protocol::crypto::{
    CryptoError, create_key_pair, derive_device_key, derive_pair_key, fixed_bytes, from_base64_url,
    make_proof, random_bytes, to_base64_url, verify_proof,
};
use zimlo_store::{DeviceRecord, Store, StoreError};

use crate::{BridgeState, api_error};

const PAIRING_LIFETIME_MS: i64 = 120_000;

#[derive(Debug, Error)]
pub(super) enum PairingError {
    #[error("pairing state is unavailable")]
    State,
    #[error("pairing QR generation failed: {0}")]
    Qr(String),
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairingPayload {
    pub pairing_id: String,
    pub pair_url: String,
    pub qr_data_url: String,
    pub expires_at: String,
    pub transport: &'static str,
}

pub(super) struct PairingComplete {
    pub device: DeviceRecord,
    pub server_proof: String,
}

#[derive(Clone)]
pub(super) struct PairingManager {
    base_url: String,
    pairings: Arc<Mutex<HashMap<String, PairingRecord>>>,
}

struct PairingRecord {
    secret: [u8; 32],
    private_key: [u8; 32],
    expires_at_ms: i64,
}

impl PairingManager {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            pairings: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create(&self) -> Result<PairingPayload, PairingError> {
        let pair = create_key_pair()?;
        let secret = random_bytes::<32>()?;
        let relay_token = random_bytes::<32>()?;
        let pairing_id = Uuid::now_v7().to_string();
        let expires_at_ms = Utc::now().timestamp_millis() + PAIRING_LIFETIME_MS;
        let pair_url = format!(
            "{}/#pairingId={}&secret={}&bridgeKey={}&pairingToken={}",
            self.base_url,
            pairing_id,
            to_base64_url(&secret),
            to_base64_url(&pair.public_key),
            to_base64_url(&relay_token),
        );
        let qr = QrCode::new(pair_url.as_bytes())
            .map_err(|error| PairingError::Qr(error.to_string()))?;
        let svg = qr
            .render::<svg::Color>()
            .min_dimensions(320, 320)
            .quiet_zone(true)
            .build();
        let expires_at = DateTime::from_timestamp_millis(expires_at_ms)
            .ok_or(PairingError::State)?
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut pairings = self.pairings.lock().map_err(|_| PairingError::State)?;
        prune(&mut pairings, Utc::now().timestamp_millis());
        pairings.insert(
            pairing_id.clone(),
            PairingRecord {
                secret,
                private_key: pair.private_key,
                expires_at_ms,
            },
        );
        Ok(PairingPayload {
            pairing_id,
            pair_url,
            qr_data_url: format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(svg.as_bytes())
            ),
            expires_at,
            transport: "lan",
        })
    }

    pub fn cancel(&self, pairing_id: &str) -> Result<bool, PairingError> {
        let mut pairings = self.pairings.lock().map_err(|_| PairingError::State)?;
        prune(&mut pairings, Utc::now().timestamp_millis());
        Ok(pairings.remove(pairing_id).is_some())
    }

    pub async fn complete(
        &self,
        store: &Store,
        pairing_id: &str,
        client_public_key: &str,
        proof: &str,
        name: Option<&str>,
    ) -> Result<Option<PairingComplete>, PairingError> {
        let pair_key = {
            let mut pairings = self.pairings.lock().map_err(|_| PairingError::State)?;
            let now = Utc::now().timestamp_millis();
            prune(&mut pairings, now);
            let Some(record) = pairings.get(pairing_id) else {
                return Ok(None);
            };
            let private_key = record.private_key;
            let secret = record.secret;
            let Ok(client_public_key) = from_base64_url(client_public_key)
                .and_then(|bytes| fixed_bytes::<32>("client public key", &bytes))
            else {
                return Ok(None);
            };
            let pair_key = derive_pair_key(&private_key, &client_public_key, &secret)?;
            if verify_proof(&pair_key, &format!("client:{pairing_id}"), proof).is_err() {
                return Ok(None);
            }
            pairings.remove(pairing_id);
            (pair_key, secret)
        };
        let device_key = derive_device_key(&pair_key.0, &pair_key.1)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let device = DeviceRecord {
            id: format!("device_{}", Uuid::now_v7()),
            name: name.unwrap_or("Paired browser").chars().take(80).collect(),
            key_base64: to_base64_url(&device_key),
            created_at: now.clone(),
            last_seen_at: now,
            revoked_at: None,
            is_local_admin: false,
            can_approve: true,
            can_manage_trust: true,
        };
        store.upsert_device(device.clone()).await?;
        Ok(Some(PairingComplete {
            server_proof: make_proof(&pair_key.0, &format!("server:{}", device.id))?,
            device,
        }))
    }
}

fn prune(pairings: &mut HashMap<String, PairingRecord>, now_ms: i64) {
    pairings.retain(|_, pairing| pairing.expires_at_ms > now_ms);
}

pub(super) async fn local_bootstrap(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
) -> Response {
    if !peer.ip().is_loopback() {
        return api_error(
            StatusCode::FORBIDDEN,
            "loopback_only",
            "仅允许本机访问。",
            false,
        );
    }
    if !state.writable {
        return api_error(
            StatusCode::CONFLICT,
            "runtime_read_only",
            "Rust Runtime 当前以只读模式运行。",
            false,
        );
    }
    let Some(store) = state.store else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置数据库。",
            true,
        );
    };
    let now = now();
    let candidate = match random_bytes::<32>() {
        Ok(key) => DeviceRecord {
            id: format!("local_{}", Uuid::now_v7()),
            name: "Local Mac browser".into(),
            key_base64: to_base64_url(&key),
            created_at: now.clone(),
            last_seen_at: now.clone(),
            revoked_at: None,
            is_local_admin: true,
            can_approve: true,
            can_manage_trust: true,
        },
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 创建本机设备密钥失败: {error}");
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "bootstrap_unavailable",
                "本机管理设备初始化失败。",
                true,
            );
        }
    };
    let host_id = match store.get_metadata("host_identity_v1").await {
        Ok(Some(host_id)) => host_id,
        _ => {
            return api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "snapshot_identity_unavailable",
                "本机身份尚未初始化。",
                true,
            );
        }
    };
    match store.ensure_local_admin(candidate).await {
        Ok(device) => Json(json!({
            "host": host_value(&host_id, &state.host_name, &now),
            "deviceId": device.id,
            "deviceKey": device.key_base64,
        }))
        .into_response(),
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 初始化本机管理设备失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "bootstrap_unavailable",
                "本机管理设备初始化失败。",
                true,
            )
        }
    }
}

pub(super) async fn create_pairing(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
) -> Response {
    if !peer.ip().is_loopback() {
        return api_error(
            StatusCode::FORBIDDEN,
            "loopback_only",
            "仅允许本机访问。",
            false,
        );
    }
    let Some(pairing) = state.pairing else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "pairing_unavailable",
            "请以 --lan --write 启动 Rust Runtime 后再创建配对。",
            true,
        );
    };
    match pairing.create() {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 创建配对失败: {error}");
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "pairing_create_failed",
                "配对暂时不可用。",
                true,
            )
        }
    }
}

pub(super) async fn cancel_pairing(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
    Path(pairing_id): Path<String>,
) -> Response {
    if !peer.ip().is_loopback() {
        return api_error(
            StatusCode::FORBIDDEN,
            "loopback_only",
            "仅允许本机访问。",
            false,
        );
    }
    let cancelled = state
        .pairing
        .as_ref()
        .and_then(|pairing| pairing.cancel(&pairing_id).ok())
        .unwrap_or(false);
    if cancelled {
        Json(json!({ "ok": true })).into_response()
    } else {
        api_error(
            StatusCode::GONE,
            "pairing_expired",
            "这个连接码已经失效。",
            true,
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairBody {
    pairing_id: Option<String>,
    client_public_key: Option<String>,
    proof: Option<String>,
    name: Option<String>,
}

pub(super) async fn complete_pairing(
    State(state): State<BridgeState>,
    Json(body): Json<PairBody>,
) -> Response {
    let (Some(pairing), Some(store), Some(pairing_id), Some(client_public_key), Some(proof)) = (
        state.pairing,
        state.store,
        body.pairing_id,
        body.client_public_key,
        body.proof,
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid pairing request" })),
        )
            .into_response();
    };
    match pairing
        .complete(
            &store,
            &pairing_id,
            &client_public_key,
            &proof,
            body.name.as_deref(),
        )
        .await
    {
        Ok(Some(result)) => {
            let host_id = match store.get_metadata("host_identity_v1").await {
                Ok(Some(host_id)) => host_id,
                _ => {
                    return api_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "snapshot_identity_unavailable",
                        "本机身份尚未初始化。",
                        true,
                    );
                }
            };
            Json(json!({
                "host": host_value(&host_id, &state.host_name, &now()),
                "deviceId": result.device.id,
                "serverProof": result.server_proof,
            }))
            .into_response()
        }
        Ok(None) => (
            StatusCode::GONE,
            Json(json!({ "error": "Pairing expired, used, or invalid" })),
        )
            .into_response(),
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 完成配对失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "pairing_complete_failed",
                "配对确认失败，请重新扫码。",
                true,
            )
        }
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn host_value(host_id: &str, host_name: &str, last_seen_at: &str) -> serde_json::Value {
    json!({
        "id": host_id,
        "name": host_name,
        "platform": "macos",
        "lastSeenAt": last_seen_at,
    })
}
