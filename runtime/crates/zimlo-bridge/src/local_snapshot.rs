use super::*;

pub(super) async fn get(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
    headers: axum::http::HeaderMap,
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
    let version = match store.data_version().await {
        Ok(version) => version,
        Err(_) => {
            return api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "store_unavailable",
                "本机数据暂不可用。",
                true,
            );
        }
    };
    let etag = format!(
        "\"{}:{}:{}\"",
        std::process::id(),
        version.sqlite,
        version.local
    );
    if headers
        .get("if-none-match")
        .and_then(|value| value.to_str().ok())
        == Some(etag.as_str())
    {
        return (
            StatusCode::NOT_MODIFIED,
            [
                ("etag", etag),
                ("cache-control", "private, no-cache".into()),
            ],
        )
            .into_response();
    }
    match store
        .snapshot(SnapshotOptions::local(state.host_name, now()))
        .await
    {
        Ok(snapshot) => (
            [
                ("etag", etag),
                ("cache-control", "private, no-cache".into()),
            ],
            Json(snapshot),
        )
            .into_response(),
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
