use std::sync::LazyLock;

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead as _, KeyInit as _},
};
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use zimlo_protocol::crypto::{fixed_bytes, from_base64_url};
use zimlo_store::MaterialRecord;

pub const MAX_PLAINTEXT_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_BODY_BYTES: usize = MAX_PLAINTEXT_BYTES + 64;

static MATERIAL_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^material_[a-zA-Z0-9_-]{12,140}$").expect("material id regex"));
static BYTE_RANGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^bytes=(\d+)-(\d*)$").expect("byte range regex"));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MaterialInput {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub preview_material_id: Option<String>,
    pub origin: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Registration {
    pub material: MaterialInput,
    pub transport: String,
    pub encryption_key: String,
    pub idempotency_key: String,
}

pub(super) fn validate_descriptor(input: &MaterialInput) -> Option<String> {
    if !valid_material_id(&input.id)
        || !(1..=180).contains(&input.name.chars().count())
        || !(1..=120).contains(&input.mime_type.chars().count())
        || !matches!(input.origin.as_str(), "user" | "agent")
        || input.created_at.is_empty()
        || !valid_sha256(&input.sha256)
        || input
            .width
            .is_some_and(|value| !(1..=20_000).contains(&value))
        || input
            .height
            .is_some_and(|value| !(1..=20_000).contains(&value))
        || input
            .duration_ms
            .is_some_and(|value| !(1..=180_000).contains(&value))
        || input
            .preview_material_id
            .as_ref()
            .is_some_and(|value| !(12..=160).contains(&value.chars().count()))
    {
        return Some("物料描述不受支持。".into());
    }
    let limit = match input.kind.as_str() {
        "image" => 8 * 1024 * 1024,
        "video" => MAX_PLAINTEXT_BYTES,
        "pdf" => 20 * 1024 * 1024,
        "document" => 15 * 1024 * 1024,
        _ => return Some("文件类型不受支持。".into()),
    } as i64;
    if input.size_bytes <= 0 || input.size_bytes > limit {
        return Some(format!(
            "{} 文件超过 {}MB 限制。",
            input.kind,
            limit / 1024 / 1024
        ));
    }
    (!valid_mime(&input.kind, &input.mime_type)).then(|| "文件格式不受支持。".into())
}

pub(super) fn validate_content(data: &[u8], input: &MaterialInput) -> Option<String> {
    let prefix = &data[..data.len().min(16)];
    match input.kind.as_str() {
        "image" => {
            let jpeg = prefix.starts_with(&[0xff, 0xd8, 0xff]);
            let png = prefix.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
            let webp = prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP");
            let heif = prefix.get(4..8) == Some(b"ftyp")
                && prefix.get(8..12).is_some_and(|brand| {
                    matches!(
                        brand,
                        b"heic"
                            | b"heix"
                            | b"hevc"
                            | b"hevx"
                            | b"heim"
                            | b"heis"
                            | b"hevm"
                            | b"hevs"
                            | b"mif1"
                    )
                });
            (!jpeg && !png && !webp && !heif).then(|| "图片内容与声明格式不一致。".into())
        }
        "video" => (prefix.get(4..8) != Some(b"ftyp")).then(|| "视频内容与声明格式不一致。".into()),
        "pdf" => {
            if !prefix.starts_with(b"%PDF-") {
                return Some("PDF 内容与声明格式不一致。".into());
            }
            (pdf_page_count(data) > 200).then(|| "PDF 不能超过 200 页。".into())
        }
        "document" => {
            let zip = prefix.starts_with(&[0x50, 0x4b]);
            let ole = prefix.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
            let text = !data[..data.len().min(4_096)].contains(&0);
            (!zip && !ole && !text).then(|| "文档内容与声明格式不一致。".into())
        }
        _ => Some("文件类型不受支持。".into()),
    }
}

pub(super) fn record_from_input(input: MaterialInput) -> MaterialRecord {
    MaterialRecord {
        id: input.id,
        kind: input.kind,
        name: input.name,
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        sha256: input.sha256,
        width: input.width,
        height: input.height,
        duration_ms: input.duration_ms,
        preview_material_id: input.preview_material_id,
        origin: input.origin,
        status: String::new(),
        local_path: None,
        created_at: input.created_at,
        error: None,
    }
}

pub(super) fn failed_record(input: MaterialInput, message: &str) -> MaterialRecord {
    MaterialRecord {
        status: "failed".into(),
        error: Some(truncate(message, 500)),
        ..record_from_input(input)
    }
}

pub(super) fn decrypt_combined(value: &[u8], encoded_key: &str) -> Result<Vec<u8>, String> {
    if value.len() < 28 {
        return Err("物料密文无效。".into());
    }
    let key = from_base64_url(encoded_key)
        .ok()
        .and_then(|value| fixed_bytes::<32>("material key", &value).ok())
        .ok_or_else(|| "物料密钥无效。".to_owned())?;
    Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "物料密钥无效。".to_owned())?
        .decrypt(Nonce::from_slice(&value[..12]), &value[12..])
        .map_err(|_| "物料密文无效。".into())
}

pub(super) fn safe_extension(name: &str) -> String {
    std::path::Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| {
            (1..=10).contains(&value.len())
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .map_or_else(String::new, |value| format!(".{value}"))
}

pub(super) fn valid_material_id(value: &str) -> bool {
    MATERIAL_ID.is_match(value)
}

pub(super) fn valid_path_component(value: &str) -> bool {
    (1..=180).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

pub(super) fn parse_range(value: &str, length: usize) -> Option<(usize, usize)> {
    let captures = BYTE_RANGE.captures(value)?;
    let start = captures.get(1)?.as_str().parse::<usize>().ok()?;
    let requested_end = captures
        .get(2)
        .filter(|value| !value.as_str().is_empty())
        .map(|value| value.as_str().parse::<usize>().ok())
        .unwrap_or_else(|| length.checked_sub(1))?;
    let end = requested_end.min(length.checked_sub(1)?);
    (start <= end && start < length).then_some((start, end))
}

pub(super) fn digest_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

pub(super) fn truncate(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn valid_mime(kind: &str, mime: &str) -> bool {
    let mime = mime.to_ascii_lowercase();
    match kind {
        "image" => matches!(
            mime.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif"
        ),
        "video" => matches!(
            mime.as_str(),
            "video/mp4" | "video/quicktime" | "video/x-m4v"
        ),
        "pdf" => mime == "application/pdf",
        "document" => {
            matches!(
                mime.as_str(),
                "text/plain"
                    | "text/markdown"
                    | "text/csv"
                    | "application/json"
                    | "application/msword"
            ) || mime.starts_with("application/vnd.openxmlformats-officedocument.")
                || mime.starts_with("application/vnd.ms-")
        }
        _ => false,
    }
}

fn pdf_page_count(data: &[u8]) -> usize {
    let needle = b"/Type /Page";
    data.windows(needle.len())
        .enumerate()
        .filter(|(index, window)| {
            *window == needle
                && data
                    .get(index + needle.len())
                    .is_none_or(|next| !next.is_ascii_alphanumeric())
        })
        .count()
}
