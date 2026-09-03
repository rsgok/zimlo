use std::{future::Future, io, net::SocketAddr, path::PathBuf};

use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, State, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse as _, Response},
    routing::{delete, get, post, put},
};
use serde::Serialize;
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};
use zimlo_protocol::{
    ZIMLO_PROTOCOL_VERSION, ZIMLO_VERSION,
    crypto::{random_bytes, to_base64_url},
};
use zimlo_store::{DeviceRecord, SnapshotOptions, Store, StoreError, UnifiedEvent};

mod action_broker;
mod action_dispatch;
mod agent_command;
mod claude_executor;
mod claude_stream;
mod cloud;
mod codex_app_server;
mod codex_approval;
mod codex_executor;
mod codex_stream;
mod discovery;
mod dispatcher;
mod integrations;
mod local_socket;
mod management;
mod material_validation;
mod materials;
mod native_executor;
mod pairing;
mod push_service;
mod task_commands;
mod task_enqueue;
mod task_runner;
mod trust_dispatch;
mod trust_policy;
mod websocket;

pub use action_broker::{
    ActionBroker, ActionTicket, DecisionResolution, DecisionSubmission, NewAction,
};
pub use claude_executor::ClaudeTaskExecutor;
pub use cloud::{CloudError, CloudRelay, CloudService, DEFAULT_CLOUD_URL, DeviceCloudCredentials};
pub use codex_executor::CodexTaskExecutor;
pub use discovery::DiscoveryService;
pub use local_socket::run_until_shutdown as run_local_control_until_shutdown;
pub use native_executor::NativeTaskExecutor;
pub use push_service::PushService;
pub use task_runner::{ResolvedMaterial, TaskCommandRunner, TaskExecutionResult, TaskExecutor};

use pairing::PairingManager;

#[derive(Clone, Default)]
pub(crate) struct BridgeState {
    store: Option<Store>,
    action_broker: Option<ActionBroker>,
    host_name: String,
    writable: bool,
    pairing: Option<PairingManager>,
    cloud: Option<CloudService>,
}

#[derive(Clone)]
pub struct BridgeConfig {
    pub host_name: String,
    pub writable: bool,
    pub pairing_base_url: Option<String>,
    pub web_root: Option<PathBuf>,
    pub cloud: Option<CloudService>,
}

impl BridgeConfig {
    pub fn read_only(host_name: impl Into<String>) -> Self {
        Self {
            host_name: host_name.into(),
            writable: false,
            pairing_base_url: None,
            web_root: None,
            cloud: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: bool,
    pub version: &'static str,
    pub protocol_version: u32,
    pub features: FeatureCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureCapabilities {
    pub project_trust_policy: bool,
    pub push_notifications: bool,
    pub remote_sync: bool,
    pub multi_host: bool,
}

pub fn router() -> Router {
    routes(BridgeState {
        store: None,
        action_broker: None,
        host_name: "Mac".into(),
        writable: false,
        pairing: None,
        cloud: None,
    })
}

pub fn router_with_store(store: Store) -> Router {
    router_with_store_named(store, "Mac")
}

pub fn router_with_store_named(store: Store, host_name: impl Into<String>) -> Router {
    router_with_config(store, BridgeConfig::read_only(host_name))
}

pub fn router_with_config(store: Store, config: BridgeConfig) -> Router {
    let broker = ActionBroker::new(store.clone());
    router_with_config_and_broker(store, config, broker)
}

pub fn router_with_config_and_broker(
    store: Store,
    config: BridgeConfig,
    action_broker: ActionBroker,
) -> Router {
    let pairing = config.writable.then(|| {
        PairingManager::new(
            store.clone(),
            config.host_name.clone(),
            config.pairing_base_url.clone(),
            config.cloud.clone(),
        )
    });
    let router = routes(BridgeState {
        store: Some(store),
        action_broker: Some(action_broker),
        host_name: config.host_name,
        writable: config.writable,
        pairing,
        cloud: config.cloud,
    });
    match config.web_root {
        Some(web_root) => {
            let index = web_root.join("index.html");
            router
                .fallback_service(ServeDir::new(web_root).not_found_service(ServeFile::new(index)))
        }
        None => router,
    }
}

fn routes(state: BridgeState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route(
            "/api/local/sessions/{session_id}/events",
            get(session_events),
        )
        .route("/api/local/snapshot", get(local_snapshot))
        .route("/api/local/commands", post(local_commands))
        .route("/api/local/status", get(local_status))
        .route("/api/local/integrations", post(local_integrations))
        .route(
            "/api/materials/{material_id}/blob",
            put(materials::receive_blob).layer(DefaultBodyLimit::max(materials::MAX_BODY_BYTES)),
        )
        .route(
            "/api/materials/{material_id}/content",
            get(materials::content),
        )
        .route(
            "/api/local/materials/{material_id}",
            put(materials::import_local)
                .layer(DefaultBodyLimit::max(materials::MAX_PLAINTEXT_BYTES)),
        )
        .route("/api/local-bootstrap", get(pairing::local_bootstrap))
        .route("/api/local/pairing", post(pairing::create_pairing))
        .route(
            "/api/local/pairing/{pairing_id}",
            delete(pairing::cancel_pairing),
        )
        .route("/api/pair", post(pairing::complete_pairing))
        .route("/ws", get(websocket_upgrade))
        .with_state(state)
}

async fn websocket_upgrade(
    State(state): State<BridgeState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(store) = state.store else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置数据库。",
            true,
        );
    };
    let Some(action_broker) = state.action_broker else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置审批代理。",
            true,
        );
    };
    upgrade
        .on_upgrade(move |socket| {
            websocket::serve(
                socket,
                store,
                state.host_name,
                state.writable,
                state.pairing,
                state.cloud,
                action_broker,
            )
        })
        .into_response()
}

pub async fn serve(
    listener: TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    serve_router(listener, router(), shutdown).await
}

pub async fn serve_with_store(
    listener: TcpListener,
    store: Store,
    host_name: impl Into<String>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    serve_router(
        listener,
        router_with_store_named(store, host_name),
        shutdown,
    )
    .await
}

pub async fn serve_runtime(
    listener: TcpListener,
    store: Store,
    config: BridgeConfig,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    serve_router(listener, router_with_config(store, config), shutdown).await
}

pub async fn serve_runtime_with_broker(
    listener: TcpListener,
    store: Store,
    config: BridgeConfig,
    action_broker: ActionBroker,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    serve_router(
        listener,
        router_with_config_and_broker(store, config, action_broker),
        shutdown,
    )
    .await
}

async fn serve_router(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}

pub async fn bind(port: u16, lan: bool) -> io::Result<TcpListener> {
    let address = if lan {
        SocketAddr::from(([0, 0, 0, 0], port))
    } else {
        SocketAddr::from(([127, 0, 0, 1], port))
    };
    TcpListener::bind(address).await
}

async fn health(State(state): State<BridgeState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        version: ZIMLO_VERSION,
        protocol_version: ZIMLO_PROTOCOL_VERSION,
        features: FeatureCapabilities {
            project_trust_policy: true,
            push_notifications: state
                .cloud
                .as_ref()
                .is_some_and(CloudService::push_notifications_available),
            remote_sync: state.cloud.as_ref().is_some_and(CloudService::enabled),
            multi_host: true,
        },
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEventsResponse {
    session_id: String,
    events: Vec<UnifiedEvent>,
}

#[derive(Debug, Serialize)]
struct ApiErrorResponse {
    code: &'static str,
    message: &'static str,
    recoverable: bool,
}

async fn session_events(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
    Path(session_id): Path<String>,
) -> Response {
    if !peer.ip().is_loopback() {
        return api_error(
            StatusCode::FORBIDDEN,
            "loopback_only",
            "仅允许本机访问。",
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
    match store.session_exists(session_id.clone()).await {
        Ok(false) => api_error(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "这个任务已不存在。",
            false,
        ),
        Ok(true) => match store.list_events(&session_id, 200).await {
            Ok(events) => Json(SessionEventsResponse { session_id, events }).into_response(),
            Err(error) => {
                eprintln!("[zimlo:rust-bridge] 读取 session events 失败: {error}");
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "store_unavailable",
                    "本地任务数据暂时不可用。",
                    true,
                )
            }
        },
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 查询 session 失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_unavailable",
                "本地任务数据暂时不可用。",
                true,
            )
        }
    }
}

async fn local_snapshot(
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
    let Some(store) = state.store else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置数据库。",
            true,
        );
    };
    if state.writable
        && let Err(error) = ensure_local_admin(&store).await
    {
        eprintln!("[zimlo:rust-bridge] 初始化本机管理设备失败: {error}");
        return api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "bootstrap_unavailable",
            "本机管理设备初始化失败。",
            true,
        );
    }
    match store
        .snapshot(SnapshotOptions::local(state.host_name, now()))
        .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(StoreError::MissingHostIdentity | StoreError::MissingLocalAdmin) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "snapshot_identity_unavailable",
            "本机身份尚未初始化，请先由现有 Runtime 启动一次。",
            true,
        ),
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 读取 Snapshot 失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_unavailable",
                "本地任务数据暂时不可用。",
                true,
            )
        }
    }
}

async fn local_commands(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
    Json(command): Json<serde_json::Value>,
) -> Response {
    if !peer.ip().is_loopback() {
        return api_error(
            StatusCode::FORBIDDEN,
            "loopback_only",
            "仅允许本机访问。",
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
    let Some(action_broker) = state.action_broker else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置审批代理。",
            true,
        );
    };
    let device = match ensure_local_admin(&store).await {
        Ok(device) => device,
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 初始化本机管理设备失败: {error}");
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "bootstrap_unavailable",
                "本机管理设备初始化失败。",
                true,
            );
        }
    };
    let result = dispatcher::dispatch(
        dispatcher::DispatchContext {
            store: &store,
            device_id: &device.id,
            is_local_admin: true,
            can_approve: true,
            can_manage_trust: true,
            writable: state.writable,
            pairing: state.pairing.as_ref(),
            cloud: state.cloud.as_ref(),
            action_broker: &action_broker,
            host_name: &state.host_name,
        },
        &command,
    )
    .await;
    let messages = match result {
        Ok(dispatcher::DispatchResult::Message(message)) => vec![message],
        Ok(dispatcher::DispatchResult::Messages(messages)) => messages,
        Ok(dispatcher::DispatchResult::Snapshot) => Vec::new(),
        Ok(dispatcher::DispatchResult::Invalid) | Err(StoreError::InvalidMutation) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_command",
                "操作参数不受支持。",
                false,
            );
        }
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 本机命令失败: {error}");
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_unavailable",
                "本机任务数据暂时不可用。",
                true,
            );
        }
    };
    match store
        .snapshot(SnapshotOptions::for_device(
            &state.host_name,
            now(),
            &device.id,
        ))
        .await
    {
        Ok(snapshot) => Json(serde_json::json!({
            "ok": true,
            "messages": messages,
            "snapshot": snapshot,
        }))
        .into_response(),
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 本机命令 Snapshot 失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_unavailable",
                "本机任务数据暂时不可用。",
                true,
            )
        }
    }
}

async fn local_status(
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
    let Some(store) = state.store else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置数据库。",
            true,
        );
    };
    match store.list_devices().await {
        Ok(devices) => {
            let integrations = integrations::statuses().await.unwrap_or_default();
            Json(serde_json::json!({
            "ready": true,
            "cloud": state.cloud.as_ref().is_some_and(CloudService::enabled),
            "pushNotifications": state.cloud.as_ref().is_some_and(CloudService::push_notifications_available),
            "pairedDeviceCount": devices.into_iter()
                .filter(|device| !device.is_local_admin && device.revoked_at.is_none())
                .count(),
            "integrations": integrations,
        }))
        .into_response()
        }
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 本机状态失败: {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "status_unavailable",
                "本地状态检查失败。",
                true,
            )
        }
    }
}

async fn local_integrations(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if !peer.ip().is_loopback() {
        return api_error(
            StatusCode::FORBIDDEN,
            "loopback_only",
            "仅允许本机访问。",
            false,
        );
    }
    let Some(target) = body.get("target").and_then(serde_json::Value::as_str) else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "unknown_integration_target",
            "未知的集成目标。",
            false,
        );
    };
    if !matches!(target, "all" | "codex_gui" | "cli") {
        return api_error(
            StatusCode::BAD_REQUEST,
            "unknown_integration_target",
            "未知的集成目标。",
            false,
        );
    }
    match integrations::install(target).await {
        Ok(integrations) => {
            Json(serde_json::json!({ "integrations": integrations })).into_response()
        }
        Err(error) => {
            eprintln!("[zimlo:rust-integrations] {error}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "integration_install_failed",
                "Agent 接入配置失败。",
                true,
            )
        }
    }
}

async fn ensure_local_admin(store: &Store) -> Result<DeviceRecord, StoreError> {
    let now = now();
    let key = random_bytes::<32>().map_err(|error| {
        StoreError::PreparePath(format!("local key generation failed: {error}"))
    })?;
    store
        .ensure_local_admin(DeviceRecord {
            id: format!("local_{}", uuid::Uuid::now_v7()),
            name: "Local Zimlo browser".into(),
            key_base64: to_base64_url(&key),
            created_at: now.clone(),
            last_seen_at: now,
            revoked_at: None,
            is_local_admin: true,
            can_approve: true,
            can_manage_trust: true,
        })
        .await
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn api_error(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    recoverable: bool,
) -> Response {
    (
        status,
        Json(ApiErrorResponse {
            code,
            message,
            recoverable,
        }),
    )
        .into_response()
}

#[cfg(test)]
mod action_broker_tests;
#[cfg(test)]
mod action_dispatch_tests;
#[cfg(all(test, unix))]
mod claude_executor_tests;
#[cfg(test)]
mod codex_approval_tests;
#[cfg(all(test, unix))]
mod codex_executor_tests;
#[cfg(test)]
mod management_tests;
#[cfg(test)]
mod material_tests;
#[cfg(test)]
mod task_enqueue_tests;
#[cfg(test)]
mod task_runner_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod trust_dispatch_tests;
#[cfg(all(test, unix))]
mod trust_policy_tests;
#[cfg(test)]
mod write_tests;
mod ws_frame;
