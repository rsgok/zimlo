use std::{fs, net::SocketAddr, path::PathBuf};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse as _, Response},
};
use chrono::Utc;
use hmac::{Hmac, Mac as _};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::{Value, json};
use uuid::Uuid;
use zimlo_protocol::crypto::{fixed_bytes, from_base64_url, random_bytes, verify_proof};
use zimlo_store::{MaterialRecord, Store, StoreError};

use crate::{
    BridgeState, CloudService,
    material_validation::{
        MaterialInput, Registration, decrypt_combined, digest_hex, failed_record, parse_range,
        record_from_input, safe_extension, truncate, valid_material_id, valid_path_component,
        validate_content, validate_descriptor,
    },
};

pub use crate::material_validation::{MAX_BODY_BYTES, MAX_PLAINTEXT_BYTES};
const MAX_CLOCK_SKEW: i64 = 5 * 60 * 1_000;

pub(super) enum RegistrationResult {
    Material(Box<MaterialRecord>),
    Invalid,
}

pub(super) async fn receive_blob(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
    Path(material_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(store) = state.store else {
        return material_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置数据库。",
            true,
        );
    };
    if !state.writable {
        return material_error(
            StatusCode::CONFLICT,
            "runtime_read_only",
            "Rust Runtime 当前以只读模式运行。",
            true,
        );
    }
    if !valid_material_id(&material_id) {
        return material_error(
            StatusCode::BAD_REQUEST,
            "material_id_invalid",
            "物料上传失败。",
            false,
        );
    }
    if body.len() > MAX_BODY_BYTES {
        return material_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "material_too_large",
            "物料上传失败。",
            false,
        );
    }
    let owner = if peer.ip().is_loopback() {
        match loopback_owner(&store, &headers).await {
            Ok(owner) => owner,
            Err(response) => return *response,
        }
    } else {
        match authorize(&store, &headers, &material_id, body.len(), true).await {
            Ok(device_id) => device_id,
            Err(response) => return *response,
        }
    };
    let Some(root) = store.storage_root() else {
        return storage_unavailable();
    };
    let path = staged_path(&root, &owner, &material_id);
    match tokio::task::spawn_blocking(move || write_atomic_private(&path, &body)).await {
        Ok(Ok(())) => (
            StatusCode::CREATED,
            Json(json!({ "ok": true, "materialId": material_id })),
        )
            .into_response(),
        Ok(Err(error)) => {
            eprintln!("[zimlo:rust-materials] 暂存上传失败: {error}");
            storage_unavailable()
        }
        Err(error) => {
            eprintln!("[zimlo:rust-materials] 暂存任务失败: {error}");
            storage_unavailable()
        }
    }
}

pub(super) async fn import_local(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
    Path(material_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !peer.ip().is_loopback() {
        return material_error(
            StatusCode::FORBIDDEN,
            "loopback_only",
            "仅允许本机访问。",
            false,
        );
    }
    let Some(store) = state.store else {
        return material_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置数据库。",
            true,
        );
    };
    if !state.writable {
        return material_error(
            StatusCode::CONFLICT,
            "runtime_read_only",
            "Rust Runtime 当前以只读模式运行。",
            true,
        );
    }
    if body.is_empty() {
        return material_error(
            StatusCode::BAD_REQUEST,
            "material_body_required",
            "文件内容为空。",
            false,
        );
    }
    let kind = header_value(&headers, "x-zimlo-kind").unwrap_or_default();
    if !matches!(kind.as_str(), "image" | "video" | "pdf" | "document") {
        return material_error(
            StatusCode::BAD_REQUEST,
            "material_kind_invalid",
            "文件类型不受支持。",
            false,
        );
    }
    let encoded_name = header_value(&headers, "x-zimlo-name").unwrap_or_default();
    let name = percent_decode_str(&encoded_name)
        .decode_utf8()
        .map_or_else(|_| encoded_name.clone(), |value| value.into_owned());
    let input = MaterialInput {
        id: material_id,
        kind,
        name,
        mime_type: header_value(&headers, "x-zimlo-mime").unwrap_or_default(),
        size_bytes: body.len() as i64,
        sha256: header_value(&headers, "x-zimlo-sha256").unwrap_or_default(),
        width: None,
        height: None,
        duration_ms: None,
        preview_material_id: None,
        origin: "user".into(),
        created_at: now(),
    };
    if let Some(message) = validate_descriptor(&input).or_else(|| validate_content(&body, &input)) {
        let failed = failed_record(input, &message);
        let _ = store.upsert_material(failed).await;
        return material_error(StatusCode::BAD_REQUEST, "material_invalid", &message, false);
    }
    if digest_hex(&body) != input.sha256 {
        let message = "物料完整性校验失败。";
        let failed = failed_record(input, message);
        let _ = store.upsert_material(failed).await;
        return material_error(StatusCode::BAD_REQUEST, "material_invalid", message, false);
    }
    match persist_ready(&store, input, body.to_vec()).await {
        Ok(material) => (StatusCode::CREATED, Json(material)).into_response(),
        Err(error) => {
            eprintln!("[zimlo:rust-materials] 本地导入失败: {error}");
            storage_unavailable()
        }
    }
}

pub(super) async fn content(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
    Path(material_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(store) = state.store else {
        return material_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_configured",
            "Rust Runtime 尚未配置数据库。",
            true,
        );
    };
    if !peer.ip().is_loopback()
        && let Err(response) = authorize(&store, &headers, &material_id, 0, false).await
    {
        return *response;
    }
    let material = match store.get_material(&material_id).await {
        Ok(Some(material)) if material.status == "ready" => material,
        Ok(_) => return material_not_found(),
        Err(error) => {
            eprintln!("[zimlo:rust-materials] 查询物料失败: {error}");
            return storage_unavailable();
        }
    };
    let Some(path) = material.local_path.as_deref().map(PathBuf::from) else {
        return material_not_found();
    };
    let data = match tokio::task::spawn_blocking(move || fs::read(path)).await {
        Ok(Ok(data)) => data,
        Ok(Err(_)) => return material_not_found(),
        Err(error) => {
            eprintln!("[zimlo:rust-materials] 读取物料任务失败: {error}");
            return storage_unavailable();
        }
    };
    content_response(&headers, &material, data)
}

pub(super) async fn register(
    store: &Store,
    cloud: Option<&CloudService>,
    device_id: &str,
    command: &Value,
) -> Result<RegistrationResult, StoreError> {
    let Ok(registration) = serde_json::from_value::<Registration>(command.clone()) else {
        return Ok(RegistrationResult::Invalid);
    };
    if !matches!(registration.transport.as_str(), "local" | "cloud")
        || registration.idempotency_key.is_empty()
        || registration.idempotency_key.chars().count() > 240
        || !(40..=80).contains(&registration.encryption_key.len())
        || validate_descriptor(&registration.material).is_some()
        || !valid_path_component(device_id)
    {
        return Ok(RegistrationResult::Invalid);
    }
    if let Some(existing) = store.get_material(&registration.material.id).await?
        && existing.status == "ready"
    {
        return Ok(RegistrationResult::Material(Box::new(existing)));
    }
    let Some(root) = store.storage_root() else {
        return Ok(RegistrationResult::Invalid);
    };
    let encrypted = if registration.transport == "cloud" {
        match cloud {
            Some(cloud) => cloud
                .download_material(device_id, &registration.material.id)
                .await
                .ok()
                .flatten(),
            None => None,
        }
    } else {
        let staged = staged_path(&root, device_id, &registration.material.id);
        tokio::task::spawn_blocking(move || fs::read(staged))
            .await
            .ok()
            .and_then(Result::ok)
    };
    let plaintext = encrypted
        .ok_or_else(|| "找不到已上传的物料，请重新选择。".to_owned())
        .and_then(|encrypted| decrypt_combined(&encrypted, &registration.encryption_key));
    let plaintext = match plaintext {
        Ok(plaintext) if plaintext.len() as i64 == registration.material.size_bytes => plaintext,
        Ok(_) => {
            return persist_failure(store, registration.material, "物料大小校验失败。").await;
        }
        Err(message) => return persist_failure(store, registration.material, &message).await,
    };
    if let Some(message) = validate_content(&plaintext, &registration.material) {
        return persist_failure(store, registration.material, &message).await;
    }
    if digest_hex(&plaintext) != registration.material.sha256 {
        return persist_failure(store, registration.material, "物料完整性校验失败。").await;
    }
    match persist_ready(store, registration.material.clone(), plaintext).await {
        Ok(material) => {
            let staged = staged_path(&root, device_id, &material.id);
            let _ = tokio::task::spawn_blocking(move || fs::remove_file(staged)).await;
            if registration.transport == "cloud"
                && let Some(cloud) = cloud
            {
                let _ = cloud.delete_material(device_id, &material.id).await;
            }
            Ok(RegistrationResult::Material(Box::new(material)))
        }
        Err(message) => {
            eprintln!("[zimlo:rust-materials] 保存物料失败: {message}");
            Ok(RegistrationResult::Material(Box::new(
                store
                    .upsert_material(MaterialRecord {
                        status: "failed".into(),
                        local_path: None,
                        error: Some(truncate(&message, 500)),
                        ..record_from_input(registration.material)
                    })
                    .await?,
            )))
        }
    }
}

pub(super) async fn publish_remote_copy(
    store: &Store,
    cloud: Option<&CloudService>,
    device_id: &str,
    material_id: &str,
) -> bool {
    let Some(cloud) = cloud else { return false };
    let Some(device) = store.active_device(device_id).await.ok().flatten() else {
        return false;
    };
    let Some(material) = store.get_material(material_id).await.ok().flatten() else {
        return false;
    };
    if material.status != "ready" {
        return false;
    }
    let Some(path) = material.local_path.map(PathBuf::from) else {
        return false;
    };
    let Ok(plaintext) = tokio::task::spawn_blocking(move || fs::read(path)).await else {
        return false;
    };
    let Ok(plaintext) = plaintext else {
        return false;
    };
    let Ok(device_key) = from_base64_url(&device.key_base64) else {
        return false;
    };
    let Ok(mut derivation) = <Hmac<sha2::Sha256> as hmac::Mac>::new_from_slice(&device_key) else {
        return false;
    };
    derivation.update(format!("material-download:{material_id}").as_bytes());
    let key = derivation.finalize().into_bytes();
    let Ok(nonce) = random_bytes::<12>() else {
        return false;
    };
    use aes_gcm::{Aes256Gcm, KeyInit as _, aead::Aead as _};
    let Ok(cipher) = Aes256Gcm::new_from_slice(&key) else {
        return false;
    };
    let Ok(ciphertext) = cipher.encrypt((&nonce).into(), plaintext.as_slice()) else {
        return false;
    };
    let mut encrypted = Vec::with_capacity(nonce.len() + ciphertext.len());
    encrypted.extend_from_slice(&nonce);
    encrypted.extend_from_slice(&ciphertext);
    cloud
        .upload_material(device_id, material_id, encrypted)
        .await
        .is_ok()
}

async fn persist_failure(
    store: &Store,
    input: MaterialInput,
    message: &str,
) -> Result<RegistrationResult, StoreError> {
    let material = store.upsert_material(failed_record(input, message)).await?;
    Ok(RegistrationResult::Material(Box::new(material)))
}

async fn persist_ready(
    store: &Store,
    input: MaterialInput,
    plaintext: Vec<u8>,
) -> Result<MaterialRecord, String> {
    let root = store
        .storage_root()
        .ok_or_else(|| "物料存储目录不可用。".to_owned())?;
    let extension = safe_extension(&input.name);
    let final_path = root
        .join("materials")
        .join(format!("{}{extension}", input.id));
    let write_path = final_path.clone();
    tokio::task::spawn_blocking(move || write_atomic_private(&write_path, &plaintext))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    store
        .upsert_material(MaterialRecord {
            status: "ready".into(),
            local_path: Some(final_path.to_string_lossy().into_owned()),
            error: None,
            ..record_from_input(input)
        })
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn publish_agent_material(
    store: &Store,
    cwd: &str,
    requested_path: &str,
    requested_name: Option<&str>,
) -> Result<MaterialRecord, String> {
    let workspace = fs::canonicalize(cwd).map_err(|_| "无法读取当前 workspace。".to_owned())?;
    let candidate = PathBuf::from(requested_path);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        workspace.join(candidate)
    };
    let source = fs::canonicalize(candidate).map_err(|_| "找不到要发布的物料。".to_owned())?;
    if source == workspace || !source.starts_with(&workspace) {
        return Err("物料必须位于当前可信 workspace 内。".into());
    }
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("物料文件为空或不是普通文件。".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (kind, mime_type, limit) = match extension.as_str() {
        "jpg" | "jpeg" => ("image", "image/jpeg", 8 * 1024 * 1024),
        "png" => ("image", "image/png", 8 * 1024 * 1024),
        "webp" => ("image", "image/webp", 8 * 1024 * 1024),
        "heic" => ("image", "image/heic", 8 * 1024 * 1024),
        "heif" => ("image", "image/heif", 8 * 1024 * 1024),
        "mp4" => ("video", "video/mp4", 50 * 1024 * 1024),
        "mov" => ("video", "video/quicktime", 50 * 1024 * 1024),
        "m4v" => ("video", "video/x-m4v", 50 * 1024 * 1024),
        "pdf" => ("pdf", "application/pdf", 20 * 1024 * 1024),
        "txt" => ("document", "text/plain", 15 * 1024 * 1024),
        "md" => ("document", "text/markdown", 15 * 1024 * 1024),
        "csv" => ("document", "text/csv", 15 * 1024 * 1024),
        "json" => ("document", "application/json", 15 * 1024 * 1024),
        "doc" => ("document", "application/msword", 15 * 1024 * 1024),
        "docx" => (
            "document",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            15 * 1024 * 1024,
        ),
        "xls" => ("document", "application/vnd.ms-excel", 15 * 1024 * 1024),
        "xlsx" => (
            "document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            15 * 1024 * 1024,
        ),
        "ppt" => (
            "document",
            "application/vnd.ms-powerpoint",
            15 * 1024 * 1024,
        ),
        "pptx" => (
            "document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            15 * 1024 * 1024,
        ),
        _ => return Err("暂不支持这种物料格式。".into()),
    };
    if metadata.len() > limit {
        return Err("物料超过大小限制。".into());
    }
    let data = tokio::fs::read(&source)
        .await
        .map_err(|error| error.to_string())?;
    let name = requested_name
        .filter(|value| !value.is_empty() && value.chars().count() <= 180)
        .map(str::to_owned)
        .or_else(|| {
            source
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| "物料文件名无效。".to_owned())?;
    let input = MaterialInput {
        id: format!("material_{}", Uuid::now_v7().simple()),
        kind: kind.into(),
        name,
        mime_type: mime_type.into(),
        size_bytes: data.len() as i64,
        sha256: digest_hex(&data),
        width: None,
        height: None,
        duration_ms: None,
        preview_material_id: None,
        origin: "agent".into(),
        created_at: now(),
    };
    if let Some(message) = validate_descriptor(&input).or_else(|| validate_content(&data, &input)) {
        return Err(message);
    }
    persist_ready(store, input, data).await
}

fn content_response(headers: &HeaderMap, material: &MaterialRecord, data: Vec<u8>) -> Response {
    let range = header_value(headers, "range").and_then(|value| parse_range(&value, data.len()));
    if header_value(headers, "range").is_some() && range.is_none() {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{}", data.len()))
            .body(Body::empty())
            .unwrap_or_else(|_| storage_unavailable());
    }
    let (status, start, end) = range.map_or(
        (StatusCode::OK, 0, data.len().saturating_sub(1)),
        |(start, end)| (StatusCode::PARTIAL_CONTENT, start, end),
    );
    let bytes = if data.is_empty() {
        Vec::new()
    } else {
        data[start..=end].to_vec()
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, &material.mime_type)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, max-age=300")
        .header("x-content-type-options", "nosniff");
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", data.len()),
        );
    } else {
        response = response.header(
            header::CONTENT_DISPOSITION,
            format!(
                "inline; filename*=UTF-8''{}",
                utf8_percent_encode(&material.name, NON_ALPHANUMERIC)
            ),
        );
    }
    response
        .body(Body::from(bytes))
        .unwrap_or_else(|_| storage_unavailable())
}

async fn authorize(
    store: &Store,
    headers: &HeaderMap,
    material_id: &str,
    size: usize,
    upload: bool,
) -> Result<String, Box<Response>> {
    let device_id = header_value(headers, "x-zimlo-device-id").unwrap_or_default();
    let timestamp = header_value(headers, "x-zimlo-timestamp").unwrap_or_default();
    let proof = header_value(headers, "x-zimlo-proof").unwrap_or_default();
    let valid_time = chrono::DateTime::parse_from_rfc3339(&timestamp)
        .ok()
        .is_some_and(|value| {
            (Utc::now().timestamp_millis() - value.timestamp_millis()).abs() <= MAX_CLOCK_SKEW
        });
    let device = store.active_device(&device_id).await.ok().flatten();
    let valid = device.and_then(|device| {
        let key = from_base64_url(&device.key_base64).ok()?;
        let key = fixed_bytes::<32>("device key", &key).ok()?;
        let message = if upload {
            format!("material-upload:{material_id}:{timestamp}:{size}")
        } else {
            format!("material-download:{material_id}:{timestamp}")
        };
        verify_proof(&key, &message, &proof).ok().map(|_| device.id)
    });
    if valid_time && let Some(device_id) = valid {
        Ok(device_id)
    } else {
        Err(Box::new(material_error(
            StatusCode::UNAUTHORIZED,
            if upload {
                "material_upload_unauthorized"
            } else {
                "material_download_unauthorized"
            },
            if upload {
                "物料上传认证失败。"
            } else {
                "物料读取认证失败。"
            },
            false,
        )))
    }
}

async fn loopback_owner(store: &Store, headers: &HeaderMap) -> Result<String, Box<Response>> {
    if let Some(device_id) = header_value(headers, "x-zimlo-device-id")
        && valid_path_component(&device_id)
        && store
            .active_device(&device_id)
            .await
            .ok()
            .flatten()
            .is_some()
    {
        return Ok(device_id);
    }
    store
        .list_devices()
        .await
        .ok()
        .and_then(|devices| {
            devices
                .into_iter()
                .find(|device| device.is_local_admin && device.revoked_at.is_none())
        })
        .map(|device| device.id)
        .ok_or_else(|| Box::new(storage_unavailable()))
}

fn write_private(path: &PathBuf, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        private_permissions(parent, 0o700)?;
        if parent
            .parent()
            .and_then(|directory| directory.file_name())
            .is_some_and(|name| name == ".staging")
        {
            let staging = parent.parent().expect("checked staging parent");
            private_permissions(staging, 0o700)?;
            if let Some(materials) = staging.parent() {
                private_permissions(materials, 0o700)?;
            }
        }
    }
    fs::write(path, data)?;
    private_permissions(path, 0o600)
}

fn write_atomic_private(path: &PathBuf, data: &[u8]) -> std::io::Result<()> {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("material");
    let temporary = path.with_file_name(format!(".{filename}.{}.tmp", Uuid::now_v7()));
    write_private(&temporary, data)?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(temporary);
        return Err(error);
    }
    private_permissions(path, 0o600)
}

fn private_permissions(path: &std::path::Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

fn staged_path(root: &std::path::Path, device_id: &str, material_id: &str) -> PathBuf {
    root.join("materials")
        .join(".staging")
        .join(device_id)
        .join(format!("{material_id}.enc"))
}

fn header_value(headers: &HeaderMap, name: &'static str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn material_not_found() -> Response {
    material_error(
        StatusCode::NOT_FOUND,
        "material_not_found",
        "物料尚不可用。",
        false,
    )
}

fn storage_unavailable() -> Response {
    material_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "material_storage_unavailable",
        "物料存储暂时不可用。",
        true,
    )
}

fn material_error(status: StatusCode, code: &str, message: &str, recoverable: bool) -> Response {
    (
        status,
        Json(json!({
            "code": code,
            "message": message,
            "recoverable": recoverable,
        })),
    )
        .into_response()
}
