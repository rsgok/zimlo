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
use zimlo_protocol::host_platform;
use zimlo_store::{DeviceRecord, Store, StoreError};

use crate::{BridgeState, CloudService, api_error};

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
    #[error("cloud pairing failed: {0}")]
    Cloud(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairingPayload {
    pub pairing_id: String,
    pub pair_url: String,
    pub qr_data_url: String,
    pub expires_at: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_pair_url: Option<String>,
}

pub(super) struct PairingComplete {
    pub device: DeviceRecord,
    pub server_proof: String,
}

#[derive(Clone)]
pub(super) struct PairingManager {
    lan_base_url: Option<String>,
    cloud: Option<CloudService>,
    store: Store,
    host_name: String,
    pairings: Arc<Mutex<HashMap<String, PairingRecord>>>,
}

struct PairingRecord {
    secret: [u8; 32],
    private_key: [u8; 32],
    expires_at_ms: i64,
}

impl PairingManager {
    pub fn new(
        store: Store,
        host_name: impl Into<String>,
        lan_base_url: Option<String>,
        cloud: Option<CloudService>,
    ) -> Self {
        Self {
            lan_base_url: lan_base_url.map(|value| value.trim_end_matches('/').to_owned()),
            cloud,
            store,
            host_name: host_name.into(),
            pairings: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create(&self) -> Result<PairingPayload, PairingError> {
        let cloud_ready = match self.cloud.as_ref() {
            Some(cloud) if cloud.enabled() => cloud.ensure_ready().await,
            _ => false,
        };
        let (base_url, transport) = if cloud_ready {
            (
                self.cloud
                    .as_ref()
                    .and_then(CloudService::relay_url)
                    .ok_or(PairingError::State)?,
                "cloud",
            )
        } else {
            (
                self.lan_base_url.as_deref().ok_or(PairingError::State)?,
                "lan",
            )
        };
        let pair = create_key_pair()?;
        let secret = random_bytes::<32>()?;
        let relay_token = random_bytes::<32>()?;
        let pairing_id = Uuid::now_v7().to_string();
        let expires_at_ms = Utc::now().timestamp_millis() + PAIRING_LIFETIME_MS;
        let pair_url = format!(
            "{}/#pairingId={}&secret={}&bridgeKey={}&pairingToken={}",
            base_url,
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
        {
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
        }
        let local_pair_url = (transport == "cloud")
            .then_some(self.lan_base_url.as_deref())
            .flatten()
            .map(|local| replace_pairing_base(&pair_url, local));
        let payload = PairingPayload {
            pairing_id,
            pair_url,
            qr_data_url: format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(svg.as_bytes())
            ),
            expires_at,
            transport: transport.into(),
            local_pair_url,
        };
        if transport == "cloud" {
            let registered = self
                .cloud
                .as_ref()
                .ok_or(PairingError::State)?
                .register_pairing(
                    &payload.pairing_id,
                    &to_base64_url(&relay_token),
                    &payload.expires_at,
                )
                .await
                .map_err(|error| PairingError::Cloud(error.to_string()))?;
            if !registered {
                let _ = self.cancel_local(&payload.pairing_id);
                return Err(PairingError::Cloud("registration rejected".into()));
            }
            let manager = self.clone();
            let pairing_id = payload.pairing_id.clone();
            tokio::spawn(async move { manager.watch_cloud(pairing_id, expires_at_ms).await });
        }
        Ok(payload)
    }

    fn cancel_local(&self, pairing_id: &str) -> Result<bool, PairingError> {
        let mut pairings = self.pairings.lock().map_err(|_| PairingError::State)?;
        prune(&mut pairings, Utc::now().timestamp_millis());
        Ok(pairings.remove(pairing_id).is_some())
    }

    pub async fn cancel(&self, pairing_id: &str) -> Result<bool, PairingError> {
        let local = self.cancel_local(pairing_id)?;
        let cloud = match self.cloud.as_ref() {
            Some(cloud) => cloud.cancel_pairing(pairing_id).await.unwrap_or(false),
            None => true,
        };
        Ok(local || cloud)
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

    async fn watch_cloud(&self, pairing_id: String, expires_at_ms: i64) {
        let Some(cloud) = self.cloud.as_ref() else {
            return;
        };
        while Utc::now().timestamp_millis() < expires_at_ms {
            match cloud.pending_pairing_request(&pairing_id).await {
                Ok(Some(request)) => {
                    let result = self
                        .complete(
                            &self.store,
                            &pairing_id,
                            &request.client_public_key,
                            &request.proof,
                            request.name.as_deref(),
                        )
                        .await;
                    let (status, response) = match result {
                        Ok(Some(result)) => {
                            let credentials = cloud
                                .provision_device(&result.device.id)
                                .await
                                .ok()
                                .flatten();
                            (
                                200,
                                json!({
                                    "host": host_value(
                                        &self.store.get_metadata("host_identity_v1").await.ok().flatten().unwrap_or_default(),
                                        &self.host_name,
                                        &now(),
                                    ),
                                    "deviceId": result.device.id,
                                    "serverProof": result.server_proof,
                                    "cloud": credentials,
                                }),
                            )
                        }
                        _ => (410, json!({ "error": "Pairing expired, used, or invalid" })),
                    };
                    let _ = cloud
                        .complete_pairing(&pairing_id, &request.request_id, &response, status)
                        .await;
                    return;
                }
                Ok(None) | Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await
                }
            }
        }
        let _ = self.cancel_local(&pairing_id);
    }
}

fn replace_pairing_base(pair_url: &str, base_url: &str) -> String {
    pair_url
        .find("/#")
        .map(|index| format!("{}{}", base_url.trim_end_matches('/'), &pair_url[index..]))
        .unwrap_or_else(|| pair_url.to_owned())
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
            name: "Local Zimlo browser".into(),
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
            "请以可写模式启动 Rust Runtime 后再创建配对。",
            true,
        );
    };
    match pairing.create().await {
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
        .map(|pairing| pairing.cancel(&pairing_id));
    let cancelled = match cancelled {
        Some(result) => result.await.unwrap_or(false),
        None => false,
    };
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
            let cloud = match state.cloud.as_ref() {
                Some(cloud) => cloud
                    .provision_device(&result.device.id)
                    .await
                    .ok()
                    .flatten(),
                None => None,
            };
            Json(json!({
                "host": host_value(&host_id, &state.host_name, &now()),
                "deviceId": result.device.id,
                "serverProof": result.server_proof,
                "cloud": cloud,
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
        "platform": host_platform(),
        "lastSeenAt": last_seen_at,
    })
}
