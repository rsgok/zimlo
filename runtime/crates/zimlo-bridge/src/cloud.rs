use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use base64::Engine as _;
use futures_util::{SinkExt as _, StreamExt as _};
use p256::{
    ecdsa::{Signature, SigningKey, signature::Signer as _},
    elliptic_curve::rand_core::OsRng,
    pkcs8::{DecodePrivateKey as _, EncodePrivateKey as _, EncodePublicKey as _, LineEnding},
};
use reqwest::{Method, Response, header::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpStream,
    sync::{Mutex, mpsc, watch},
    task::JoinHandle,
    time::sleep,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, client_async_tls, connect_async,
    tungstenite::{Message, client::IntoClientRequest as _, http::HeaderValue},
};
use uuid::Uuid;
use zimlo_protocol::crypto::{random_bytes, to_base64_url};
use zimlo_store::{Store, StoreError};

const IDENTITY_METADATA_KEY: &str = "cloud_installation_identity_v1";
pub const DEFAULT_CLOUD_URL: &str = "https://cloud.zimlo.app";

#[derive(Debug, Error)]
pub enum CloudError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("cloud request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("cloud crypto failed: {0}")]
    Crypto(String),
    #[error("cloud response was invalid: {0}")]
    InvalidResponse(String),
    #[error("cloud service is disabled")]
    Disabled,
    #[error("cloud WebSocket failed: {0}")]
    WebSocket(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudIdentity {
    installation_id: String,
    public_key: String,
    #[serde(rename = "privateKeyPEM")]
    private_key_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCloudCredentials {
    #[serde(rename = "relayURL")]
    pub relay_url: String,
    pub access_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudPairingRequest {
    pub request_id: String,
    pub client_public_key: String,
    pub proof: String,
    pub name: Option<String>,
}

#[derive(Clone)]
pub struct CloudService {
    store: Store,
    base_url: Option<String>,
    client: reqwest::Client,
    identity: Arc<Mutex<Option<CloudIdentity>>>,
    ready: Arc<AtomicBool>,
    push_configured: Arc<AtomicBool>,
}

impl CloudService {
    pub fn new(store: Store) -> Result<Self, CloudError> {
        let base_url = if std::env::var("ZIMLO_CLOUD_DISABLED").ok().as_deref() == Some("1") {
            None
        } else {
            Some(
                std::env::var("ZIMLO_CLOUD_URL")
                    .ok()
                    .map(|value| value.trim().trim_end_matches('/').to_owned())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| DEFAULT_CLOUD_URL.into()),
            )
        };
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self {
            store,
            base_url,
            client,
            identity: Arc::new(Mutex::new(None)),
            ready: Arc::new(AtomicBool::new(false)),
            push_configured: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn enabled(&self) -> bool {
        self.base_url.is_some()
    }

    pub fn relay_url(&self) -> Option<&str> {
        self.base_url.as_deref()
    }

    pub fn push_notifications_available(&self) -> bool {
        self.push_configured.load(Ordering::Relaxed)
    }

    pub async fn refresh_health(&self) -> bool {
        let Some(base_url) = self.base_url.as_deref() else {
            self.push_configured.store(false, Ordering::Relaxed);
            return false;
        };
        let result = self
            .client
            .get(format!("{base_url}/healthz"))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        let Ok(response) = result else {
            self.push_configured.store(false, Ordering::Relaxed);
            return false;
        };
        if !response.status().is_success() {
            self.push_configured.store(false, Ordering::Relaxed);
            return false;
        }
        let value = response.json::<Value>().await.unwrap_or(Value::Null);
        self.push_configured.store(
            value["pushConfigured"].as_bool() == Some(true),
            Ordering::Relaxed,
        );
        true
    }

    pub async fn ensure_ready(&self) -> bool {
        if self.ready.load(Ordering::Acquire) {
            return true;
        }
        match self.register_installation().await {
            Ok(true) => {
                self.ready.store(true, Ordering::Release);
                true
            }
            Ok(false) | Err(_) => {
                self.ready.store(false, Ordering::Release);
                false
            }
        }
    }

    pub async fn provision_device(
        &self,
        device_id: &str,
    ) -> Result<Option<DeviceCloudCredentials>, CloudError> {
        if !self.ensure_ready().await {
            return Ok(None);
        }
        let access_token = to_base64_url(
            &random_bytes::<32>().map_err(|error| CloudError::Crypto(error.to_string()))?,
        );
        let metadata_key = format!("cloud_device_token:{device_id}");
        self.store
            .set_metadata(&metadata_key, &access_token)
            .await?;
        let response = self
            .signed_json(
                Method::POST,
                "/v1/devices",
                Some(&json!({
                    "deviceId": device_id,
                    "accessTokenHash": sha256_url(access_token.as_bytes()),
                })),
            )
            .await?;
        if !response.status().is_success() {
            self.store.delete_metadata(metadata_key).await?;
            return Ok(None);
        }
        Ok(Some(DeviceCloudCredentials {
            relay_url: self.base_url.clone().ok_or(CloudError::Disabled)?,
            access_token,
        }))
    }

    pub async fn register_pairing(
        &self,
        pairing_id: &str,
        relay_token: &str,
        expires_at: &str,
    ) -> Result<bool, CloudError> {
        if !self.ensure_ready().await {
            return Ok(false);
        }
        let response = self
            .signed_json(
                Method::POST,
                "/v1/pairings",
                Some(&json!({
                    "pairingId": pairing_id,
                    "tokenHash": sha256_url(relay_token.as_bytes()),
                    "expiresAt": expires_at,
                })),
            )
            .await?;
        Ok(response.status().is_success())
    }

    pub async fn pending_pairing_request(
        &self,
        pairing_id: &str,
    ) -> Result<Option<CloudPairingRequest>, CloudError> {
        if !self.ensure_ready().await {
            return Ok(None);
        }
        let path = format!("/v1/pairings/{pairing_id}/request");
        let response = self.signed_json(Method::GET, &path, None).await?;
        if response.status().as_u16() == 204 || response.status().as_u16() == 410 {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(CloudError::InvalidResponse(format!(
                "pairing request returned {}",
                response.status()
            )));
        }
        Ok(Some(response.json().await?))
    }

    pub async fn cancel_pairing(&self, pairing_id: &str) -> Result<bool, CloudError> {
        if !self.ensure_ready().await {
            return Ok(false);
        }
        let path = format!("/v1/pairings/{pairing_id}");
        let response = self.signed_json(Method::DELETE, &path, None).await?;
        Ok(response.status().is_success() || response.status().as_u16() == 410)
    }

    pub async fn complete_pairing(
        &self,
        pairing_id: &str,
        request_id: &str,
        response_body: &Value,
        status: u16,
    ) -> Result<bool, CloudError> {
        if !self.ensure_ready().await {
            return Ok(false);
        }
        let path = format!("/v1/pairings/{pairing_id}/complete");
        let response = self
            .signed_json(
                Method::POST,
                &path,
                Some(&json!({
                    "requestId": request_id,
                    "status": status,
                    "response": response_body,
                })),
            )
            .await?;
        Ok(response.status().is_success())
    }

    pub async fn register_push_device(
        &self,
        device_id: &str,
        apns_token: &str,
        route_public_key: &str,
        environment: &str,
    ) -> Result<Option<String>, CloudError> {
        if !self.ensure_ready().await {
            return Ok(None);
        }
        let Some(access_token) = self
            .store
            .get_metadata(format!("cloud_device_token:{device_id}"))
            .await?
        else {
            return Ok(None);
        };
        let response = self
            .signed_json(
                Method::POST,
                "/v1/devices",
                Some(&json!({
                    "deviceId": device_id,
                    "accessTokenHash": sha256_url(access_token.as_bytes()),
                    "apnsToken": apns_token,
                    "routePublicKey": route_public_key,
                    "apnsEnvironment": environment,
                })),
            )
            .await?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let value: Value = response.json().await?;
        Ok(value["endpoint"].as_str().map(str::to_owned))
    }

    pub async fn unregister_push_device(&self, device_id: &str) -> Result<(), CloudError> {
        if !self.ensure_ready().await {
            return Ok(());
        }
        let path = format!("/v1/devices/{device_id}/push");
        let _ = self
            .signed_json(Method::DELETE, &path, Some(&json!({})))
            .await?;
        Ok(())
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<(), CloudError> {
        if !self.ensure_ready().await {
            return Ok(());
        }
        let path = format!("/v1/devices/{device_id}");
        let response = self
            .signed_json(Method::DELETE, &path, Some(&json!({})))
            .await?;
        if response.status().is_success() {
            self.store
                .delete_metadata(format!("cloud_device_token:{device_id}"))
                .await?;
        }
        Ok(())
    }

    pub async fn send_push(&self, input: &Value) -> Result<u16, CloudError> {
        if !self.ensure_ready().await {
            return Ok(503);
        }
        let response = self
            .signed_json(Method::POST, "/v1/push", Some(input))
            .await?;
        let status = response.status().as_u16();
        let value = response.json::<Value>().await.unwrap_or(Value::Null);
        Ok(value["apnsStatus"]
            .as_u64()
            .and_then(|status| u16::try_from(status).ok())
            .unwrap_or(status))
    }

    pub async fn download_material(
        &self,
        device_id: &str,
        material_id: &str,
    ) -> Result<Option<Vec<u8>>, CloudError> {
        if !self.ensure_ready().await {
            return Ok(None);
        }
        let path = format!("/v1/materials/{device_id}/{material_id}");
        let response = self.signed_binary(Method::GET, &path, "", None).await?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(CloudError::InvalidResponse(format!(
                "material download returned {}",
                response.status()
            )));
        }
        Ok(Some(response.bytes().await?.to_vec()))
    }

    pub async fn upload_material(
        &self,
        device_id: &str,
        material_id: &str,
        encrypted: Vec<u8>,
    ) -> Result<(), CloudError> {
        if !self.ensure_ready().await {
            return Err(CloudError::Disabled);
        }
        let path = format!("/v1/materials/{device_id}/{material_id}");
        let hash = sha256_url(&encrypted);
        let response = self
            .signed_binary(Method::PUT, &path, &hash, Some(encrypted))
            .await?;
        if !response.status().is_success() {
            return Err(CloudError::InvalidResponse(format!(
                "material upload returned {}",
                response.status()
            )));
        }
        Ok(())
    }

    pub async fn delete_material(
        &self,
        device_id: &str,
        material_id: &str,
    ) -> Result<(), CloudError> {
        if !self.ensure_ready().await {
            return Ok(());
        }
        let path = format!("/v1/materials/{device_id}/{material_id}");
        let _ = self.signed_binary(Method::DELETE, &path, "", None).await?;
        Ok(())
    }

    pub async fn mac_socket_headers(&self) -> Result<Option<HeaderMap>, CloudError> {
        if !self.ensure_ready().await {
            return Ok(None);
        }
        Ok(Some(
            self.signed_headers(Method::GET, "/v1/sync/mac", "").await?,
        ))
    }

    async fn register_installation(&self) -> Result<bool, CloudError> {
        let Some(base_url) = self.base_url.as_deref() else {
            return Ok(false);
        };
        if !self.refresh_health().await {
            return Ok(false);
        }
        let identity = self.load_or_create_identity().await?;
        let timestamp = now();
        let message = format!(
            "{timestamp}.POST./v1/installations.{}.{}",
            identity.installation_id, identity.public_key
        );
        let response = self
            .client
            .post(format!("{base_url}/v1/installations"))
            .timeout(Duration::from_secs(5))
            .json(&json!({
                "installationId": identity.installation_id,
                "publicKey": identity.public_key,
                "timestamp": timestamp,
                "signature": sign_message(&identity, &message)?,
            }))
            .send()
            .await?;
        Ok(response.status().is_success())
    }

    async fn load_or_create_identity(&self) -> Result<CloudIdentity, CloudError> {
        let mut cached = self.identity.lock().await;
        if let Some(identity) = cached.clone() {
            return Ok(identity);
        }
        if let Some(existing) = self.store.get_metadata(IDENTITY_METADATA_KEY).await?
            && let Ok(identity) = serde_json::from_str::<CloudIdentity>(&existing)
            && signing_key(&identity).is_ok()
        {
            *cached = Some(identity.clone());
            return Ok(identity);
        }
        let key = SigningKey::random(&mut OsRng);
        let private_key_pem = key
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|error| CloudError::Crypto(error.to_string()))?
            .to_string();
        let public_key = key
            .verifying_key()
            .to_public_key_der()
            .map_err(|error| CloudError::Crypto(error.to_string()))?;
        let identity = CloudIdentity {
            installation_id: format!("installation_{}", Uuid::now_v7().simple()),
            public_key: to_base64_url(public_key.as_bytes()),
            private_key_pem,
        };
        self.store
            .set_metadata(
                IDENTITY_METADATA_KEY,
                serde_json::to_string(&identity)
                    .map_err(|error| CloudError::InvalidResponse(error.to_string()))?,
            )
            .await?;
        *cached = Some(identity.clone());
        Ok(identity)
    }

    async fn signed_json(
        &self,
        method: Method,
        path: &str,
        value: Option<&Value>,
    ) -> Result<Response, CloudError> {
        let base_url = self.base_url.as_deref().ok_or(CloudError::Disabled)?;
        let body = value
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| CloudError::InvalidResponse(error.to_string()))?
            .unwrap_or_default();
        let headers = self.signed_headers(method.clone(), path, &body).await?;
        let mut request = self
            .client
            .request(method, format!("{base_url}{path}"))
            .headers(headers)
            .timeout(Duration::from_secs(5));
        if !body.is_empty() {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        Ok(request.send().await?)
    }

    async fn signed_binary(
        &self,
        method: Method,
        path: &str,
        body_hash: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Response, CloudError> {
        let base_url = self.base_url.as_deref().ok_or(CloudError::Disabled)?;
        let headers = self.signed_headers(method.clone(), path, body_hash).await?;
        let mut request = self
            .client
            .request(method, format!("{base_url}{path}"))
            .headers(headers);
        if let Some(body) = body {
            request = request
                .header("content-type", "application/octet-stream")
                .header("x-zimlo-content-sha256", body_hash)
                .body(body);
        }
        Ok(request.send().await?)
    }

    async fn signed_headers(
        &self,
        method: Method,
        path: &str,
        body: &str,
    ) -> Result<HeaderMap, CloudError> {
        let identity = self.load_or_create_identity().await?;
        let timestamp = now();
        let message = format!(
            "{timestamp}.{}.{path}.{}",
            method.as_str().to_uppercase(),
            if body.len() == 43 && body.bytes().all(is_base64url) {
                body.to_owned()
            } else {
                sha256_url(body.as_bytes())
            }
        );
        let signature = sign_message(&identity, &message)?;
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("x-zimlo-installation", identity.installation_id.as_str()),
            ("x-zimlo-timestamp", timestamp.as_str()),
            ("x-zimlo-signature", signature.as_str()),
        ] {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|error| CloudError::InvalidResponse(error.to_string()))?,
                reqwest::header::HeaderValue::from_str(value)
                    .map_err(|error| CloudError::InvalidResponse(error.to_string()))?,
            );
        }
        Ok(headers)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayFrame {
    #[serde(rename = "type")]
    kind: String,
    connection_id: String,
    data: Option<String>,
}

pub struct CloudRelay {
    cloud: CloudService,
    local_port: u16,
}

impl CloudRelay {
    pub fn new(cloud: CloudService, local_port: u16) -> Self {
        Self { cloud, local_port }
    }

    pub async fn run_until_shutdown(self, mut stop: watch::Receiver<bool>) {
        let mut retry = Duration::from_secs(1);
        while !*stop.borrow() {
            match self.connect_once(&mut stop).await {
                Ok(()) if *stop.borrow() => break,
                Ok(()) => retry = Duration::from_secs(1),
                Err(error) => eprintln!("[zimlo:rust-cloud] relay disconnected: {error}"),
            }
            tokio::select! {
                _ = sleep(retry) => {}
                _ = stop.changed() => {}
            }
            retry = (retry * 2).min(Duration::from_secs(30));
        }
    }

    async fn connect_once(&self, stop: &mut watch::Receiver<bool>) -> Result<(), CloudError> {
        let Some(base_url) = self.cloud.relay_url() else {
            return Err(CloudError::Disabled);
        };
        let Some(headers) = self.cloud.mac_socket_headers().await? else {
            return Err(CloudError::Disabled);
        };
        let url = if let Some(rest) = base_url.strip_prefix("https://") {
            format!("wss://{rest}/v1/sync/mac")
        } else if let Some(rest) = base_url.strip_prefix("http://") {
            format!("ws://{rest}/v1/sync/mac")
        } else {
            return Err(CloudError::InvalidResponse("unsupported cloud URL".into()));
        };
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|error| CloudError::WebSocket(error.to_string()))?;
        for (name, value) in headers.iter() {
            request.headers_mut().insert(
                name,
                HeaderValue::from_bytes(value.as_bytes())
                    .map_err(|error| CloudError::WebSocket(error.to_string()))?,
            );
        }
        let relay = connect_relay(request, &url).await?;
        let (mut relay_write, mut relay_read) = relay.split();
        let (outgoing, mut outgoing_rx) = mpsc::channel::<RelayFrame>(256);
        let mut locals = HashMap::<String, mpsc::Sender<String>>::new();
        let mut tasks = Vec::<JoinHandle<()>>::new();
        loop {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() { break; }
                }
                outgoing = outgoing_rx.recv() => {
                    let Some(outgoing) = outgoing else { break; };
                    let text = serde_json::to_string(&outgoing)
                        .map_err(|error| CloudError::InvalidResponse(error.to_string()))?;
                    relay_write.send(Message::Text(text.into())).await
                        .map_err(|error| CloudError::WebSocket(error.to_string()))?;
                }
                incoming = relay_read.next() => {
                    let Some(incoming) = incoming else { break; };
                    let incoming = incoming.map_err(|error| CloudError::WebSocket(error.to_string()))?;
                    let Message::Text(text) = incoming else { continue; };
                    let frame = serde_json::from_str::<RelayFrame>(&text)
                        .map_err(|error| CloudError::InvalidResponse(error.to_string()))?;
                    match frame.kind.as_str() {
                        "open" => {
                            let (sender, task) = open_local(self.local_port, frame.connection_id.clone(), outgoing.clone()).await?;
                            locals.insert(frame.connection_id, sender);
                            tasks.push(task);
                        }
                        "data" => {
                            if !locals.contains_key(&frame.connection_id) {
                                let (sender, task) = open_local(self.local_port, frame.connection_id.clone(), outgoing.clone()).await?;
                                locals.insert(frame.connection_id.clone(), sender);
                                tasks.push(task);
                            }
                            if let (Some(sender), Some(data)) = (locals.get(&frame.connection_id), frame.data) {
                                let _ = sender.send(data).await;
                            }
                        }
                        "close" => { locals.remove(&frame.connection_id); }
                        _ => {}
                    }
                }
            }
        }
        for task in tasks {
            task.abort();
        }
        Ok(())
    }
}

async fn connect_relay(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    url: &str,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, CloudError> {
    let Some(proxy) = proxy_url_for(url)? else {
        return connect_async(request)
            .await
            .map(|(socket, _)| socket)
            .map_err(|error| CloudError::WebSocket(error.to_string()));
    };
    if proxy.scheme() != "http" {
        return Err(CloudError::WebSocket(
            "HTTPS proxy URL 暂不支持；macOS 系统代理应以 http:// 形式传入。".into(),
        ));
    }
    let target =
        reqwest::Url::parse(url).map_err(|error| CloudError::WebSocket(error.to_string()))?;
    let target_host = target
        .host_str()
        .ok_or_else(|| CloudError::WebSocket("relay URL 缺少 host".into()))?;
    let target_port = target.port_or_known_default().unwrap_or(443);
    let proxy_host = proxy
        .host_str()
        .ok_or_else(|| CloudError::WebSocket("proxy URL 缺少 host".into()))?;
    let proxy_port = proxy.port_or_known_default().unwrap_or(80);
    let mut stream = tokio::time::timeout(
        Duration::from_secs(5),
        TcpStream::connect((proxy_host, proxy_port)),
    )
    .await
    .map_err(|_| CloudError::WebSocket("连接代理超时".into()))?
    .map_err(|error| CloudError::WebSocket(error.to_string()))?;
    let authority = format!("{target_host}:{target_port}");
    let authorization = if proxy.username().is_empty() {
        String::new()
    } else {
        let credentials = format!(
            "{}:{}",
            proxy.username(),
            proxy.password().unwrap_or_default()
        );
        format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64::engine::general_purpose::STANDARD.encode(credentials)
        )
    };
    stream
        .write_all(
            format!(
                "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{authorization}Connection: keep-alive\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .map_err(|error| CloudError::WebSocket(error.to_string()))?;
    let mut response = Vec::with_capacity(1_024);
    while response.len() < 16 * 1_024 && !response.ends_with(b"\r\n\r\n") {
        let mut byte = [0_u8; 1];
        tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut byte))
            .await
            .map_err(|_| CloudError::WebSocket("代理 CONNECT 超时".into()))?
            .map_err(|error| CloudError::WebSocket(error.to_string()))?;
        response.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned();
    if !status.contains(" 200 ") {
        return Err(CloudError::WebSocket(format!(
            "代理 CONNECT 失败：{status}"
        )));
    }
    client_async_tls(request, stream)
        .await
        .map(|(socket, _)| socket)
        .map_err(|error| CloudError::WebSocket(error.to_string()))
}

fn proxy_url_for(input: &str) -> Result<Option<reqwest::Url>, CloudError> {
    let input =
        reqwest::Url::parse(input).map_err(|error| CloudError::WebSocket(error.to_string()))?;
    let proxy = if matches!(input.scheme(), "https" | "wss") {
        std::env::var("HTTPS_PROXY")
            .or_else(|_| std::env::var("https_proxy"))
            .or_else(|_| std::env::var("HTTP_PROXY"))
            .or_else(|_| std::env::var("http_proxy"))
            .ok()
    } else {
        std::env::var("HTTP_PROXY")
            .or_else(|_| std::env::var("http_proxy"))
            .ok()
    };
    let Some(proxy) = proxy.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let no_proxy = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    if bypasses_proxy(&input, &no_proxy) {
        return Ok(None);
    }
    let proxy =
        reqwest::Url::parse(&proxy).map_err(|error| CloudError::WebSocket(error.to_string()))?;
    matches!(proxy.scheme(), "http" | "https")
        .then_some(proxy)
        .ok_or_else(|| CloudError::WebSocket("proxy URL 必须使用 http 或 https".into()))
        .map(Some)
}

fn bypasses_proxy(input: &reqwest::Url, no_proxy: &str) -> bool {
    let hostname = input.host_str().unwrap_or_default().to_ascii_lowercase();
    let port = input
        .port_or_known_default()
        .unwrap_or_default()
        .to_string();
    no_proxy.split(',').any(|rule| {
        let rule = rule.trim().to_ascii_lowercase();
        if rule.is_empty() {
            return false;
        }
        if rule == "*" {
            return true;
        }
        let (rule_host, rule_port) = rule
            .rsplit_once(':')
            .filter(|(host, port)| {
                !host.contains(':') && port.chars().all(|value| value.is_ascii_digit())
            })
            .map_or((rule.as_str(), None), |(host, port)| (host, Some(port)));
        if rule_port.is_some_and(|rule_port| rule_port != port) {
            return false;
        }
        let normalized = rule_host
            .strip_prefix("*.")
            .or_else(|| rule_host.strip_prefix('.'))
            .unwrap_or(rule_host);
        hostname == normalized || hostname.ends_with(&format!(".{normalized}"))
    })
}

type LocalSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn open_local(
    port: u16,
    connection_id: String,
    relay: mpsc::Sender<RelayFrame>,
) -> Result<(mpsc::Sender<String>, JoinHandle<()>), CloudError> {
    let (socket, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .map_err(|error| CloudError::WebSocket(error.to_string()))?;
    Ok(local_task(socket, connection_id, relay))
}

fn local_task(
    socket: LocalSocket,
    connection_id: String,
    relay: mpsc::Sender<RelayFrame>,
) -> (mpsc::Sender<String>, JoinHandle<()>) {
    let (incoming, mut incoming_rx) = mpsc::channel::<String>(64);
    let task = tokio::spawn(async move {
        let (mut writer, mut reader) = socket.split();
        loop {
            tokio::select! {
                remote = incoming_rx.recv() => {
                    let Some(remote) = remote else { break; };
                    if writer.send(Message::Text(remote.into())).await.is_err() { break; }
                }
                local = reader.next() => {
                    let Some(Ok(Message::Text(data))) = local else { break; };
                    if relay.send(RelayFrame {
                        kind: "data".into(),
                        connection_id: connection_id.clone(),
                        data: Some(data.to_string()),
                    }).await.is_err() { break; }
                }
            }
        }
        let _ = relay
            .send(RelayFrame {
                kind: "close".into(),
                connection_id,
                data: None,
            })
            .await;
    });
    (incoming, task)
}

fn signing_key(identity: &CloudIdentity) -> Result<SigningKey, CloudError> {
    SigningKey::from_pkcs8_pem(&identity.private_key_pem)
        .map_err(|error| CloudError::Crypto(error.to_string()))
}

fn sign_message(identity: &CloudIdentity, message: &str) -> Result<String, CloudError> {
    let signature: Signature = signing_key(identity)?.sign(message.as_bytes());
    Ok(to_base64_url(signature.to_bytes().as_slice()))
}

fn sha256_url(value: &[u8]) -> String {
    to_base64_url(&Sha256::digest(value))
}

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use p256::{
        ecdsa::{Signature, VerifyingKey, signature::Verifier as _},
        pkcs8::DecodePublicKey as _,
    };
    use zimlo_protocol::crypto::from_base64_url;
    use zimlo_store::{Store, StoreMode};

    use super::{CloudService, DeviceCloudCredentials, sign_message};

    #[test]
    fn serializes_device_cloud_credentials_with_the_shared_url_acronym() {
        let credentials = DeviceCloudCredentials {
            relay_url: "https://cloud.example".into(),
            access_token: "access-token".into(),
        };

        assert_eq!(
            serde_json::to_value(credentials).expect("credentials JSON"),
            serde_json::json!({
                "relayURL": "https://cloud.example",
                "accessToken": "access-token",
            })
        );
    }

    #[tokio::test]
    async fn persists_node_compatible_p256_identity_and_p1363_signature() {
        let store = Store::open(":memory:", StoreMode::ReadWriteCreate)
            .await
            .expect("store");
        let cloud = CloudService::new(store.clone()).expect("cloud");
        let identity = cloud.load_or_create_identity().await.expect("identity");
        let signature = sign_message(&identity, "timestamp.POST./v1/test.hash").expect("signature");
        let public = from_base64_url(&identity.public_key).expect("public key");
        let verifying = VerifyingKey::from_public_key_der(&public).expect("SPKI key");
        let signature =
            Signature::from_slice(&from_base64_url(&signature).expect("signature bytes"))
                .expect("P1363 signature");
        verifying
            .verify(b"timestamp.POST./v1/test.hash", &signature)
            .expect("valid signature");
        assert!(
            store
                .get_metadata("cloud_installation_identity_v1")
                .await
                .expect("metadata")
                .is_some()
        );
    }
}
