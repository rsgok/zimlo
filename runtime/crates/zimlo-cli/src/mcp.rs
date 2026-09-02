use std::{
    fs::OpenOptions,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
    net::UnixStream,
    time::timeout,
};
use uuid::Uuid;
use zimlo_protocol::{ZIMLO_PROTOCOL_VERSION, ZIMLO_VERSION};

use crate::{paths::ZimloPaths, service_state};

pub async fn ensure_bridge_running(paths: &ZimloPaths) -> Result<(), String> {
    match bridge_protocol_version(&paths.socket).await {
        Ok(Some(version)) if version == ZIMLO_PROTOCOL_VERSION => return Ok(()),
        Ok(Some(_)) | Ok(None) => {
            return Err("Zimlo Bridge 版本过旧，请运行 zimlo stop 停止旧进程后重试。".into());
        }
        Err(_) => {}
    }

    service_state::secure_directory(&paths.logs).map_err(display)?;
    let log = open_private_append(&paths.autostart_log).map_err(display)?;
    let stderr = log.try_clone().map_err(display)?;
    let mut command = Command::new(std::env::current_exe().map_err(display)?);
    command
        .arg("start")
        .env("ZIMLO_AUTOSTARTED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    command.spawn().map_err(display)?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if bridge_protocol_version(&paths.socket).await.ok().flatten()
            == Some(ZIMLO_PROTOCOL_VERSION)
        {
            return Ok(());
        }
    }
    Err(format!(
        "Zimlo Bridge 未能在预期时间内启动；请查看日志：{}",
        paths.autostart_log.display()
    ))
}

pub async fn run(provider: &str, socket_path: &Path) -> Result<(), String> {
    let mut input = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line).await.map_err(display)? == 0 {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0", "id": id,
                "result": { "protocolVersion": "2025-03-26", "capabilities": { "tools": {} }, "serverInfo": { "name": "zimlo", "version": ZIMLO_VERSION } },
            }),
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            "tools/list" => {
                json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tool_definitions() } })
            }
            "tools/call" => {
                let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                if !matches!(
                    name,
                    "feed.post" | "feed.skip" | "signal.transition" | "material.publish"
                ) {
                    json!({ "jsonrpc": "2.0", "id": id, "result": { "isError": true, "content": [{ "type": "text", "text": "未知的 Zimlo 工具。" }] } })
                } else {
                    let request = json!({
                        "type": "agent_tool",
                        "id": Uuid::now_v7().to_string(),
                        "provider": provider,
                        "parentPid": std::os::unix::process::parent_id(),
                        "cwd": std::env::current_dir().map_err(display)?,
                        "name": name,
                        "arguments": params.get("arguments").cloned().unwrap_or_else(|| json!({})),
                    });
                    let result = call(socket_path, &request, Duration::from_secs(5))
                        .await
                        .unwrap_or_else(|message| json!({ "ok": false, "message": message }));
                    json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {
                            "isError": result.get("ok") != Some(&Value::Bool(true)),
                            "content": [{ "type": "text", "text": json!({ "ok": result["ok"], "message": result["message"], "data": result.get("data").cloned().unwrap_or(Value::Null) }).to_string() }],
                        },
                    })
                }
            }
            _ => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } })
            }
        };
        let mut output = tokio::io::stdout();
        output
            .write_all(response.to_string().as_bytes())
            .await
            .map_err(display)?;
        output.write_all(b"\n").await.map_err(display)?;
        output.flush().await.map_err(display)?;
    }
    Ok(())
}

pub async fn run_hook(provider: &str, surface: &str, socket_path: &Path) -> Result<(), String> {
    let mut input = Vec::new();
    tokio::io::stdin()
        .read_to_end(&mut input)
        .await
        .map_err(display)?;
    let Ok(payload) = serde_json::from_slice::<Value>(&input) else {
        return Ok(());
    };
    let waits = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|event| {
            event == "PermissionRequest"
                || (event == "PreToolUse"
                    && payload
                        .get("tool_name")
                        .and_then(Value::as_str)
                        .is_some_and(|tool| {
                            matches!(tool, "AskUserQuestion" | "request_user_input")
                        }))
        });
    let request = json!({
        "type": "hook", "id": Uuid::now_v7().to_string(), "provider": provider,
        "surface": surface, "payload": payload,
    });
    if let Ok(response) = call(
        socket_path,
        &request,
        if waits {
            Duration::from_secs(481)
        } else {
            Duration::from_millis(2_500)
        },
    )
    .await
        && let Some(output) = response.get("output").filter(|value| !value.is_null())
    {
        let mut stdout = tokio::io::stdout();
        stdout
            .write_all(output.to_string().as_bytes())
            .await
            .map_err(display)?;
        stdout.write_all(b"\n").await.map_err(display)?;
    }
    Ok(())
}

async fn call(socket_path: &Path, request: &Value, wait: Duration) -> Result<Value, String> {
    timeout(wait, async {
        let mut stream = UnixStream::connect(socket_path)
            .await
            .map_err(|_| "无法连接 Zimlo Bridge；请先运行 zimlo start。".to_owned())?;
        stream
            .write_all(request.to_string().as_bytes())
            .await
            .map_err(display)?;
        stream.write_all(b"\n").await.map_err(display)?;
        let mut response = String::new();
        BufReader::new(stream)
            .read_line(&mut response)
            .await
            .map_err(display)?;
        serde_json::from_str(response.trim()).map_err(display)
    })
    .await
    .map_err(|_| "Zimlo Bridge 未响应；请先运行 zimlo start。".to_owned())?
}

pub async fn bridge_protocol_version(socket_path: &Path) -> Result<Option<u32>, String> {
    let response = call(
        socket_path,
        &json!({ "type": "bridge_info" }),
        Duration::from_millis(400),
    )
    .await?;
    Ok(response
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok()))
}

fn open_private_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        options.mode(0o600);
        let file = options.open(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        options.open(path)
    }
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "feed.post",
            "description": "向 Zimlo 发布一条由你主动编辑、给人看的 Feed 帖子，并可同时更新任务状态。只在用户必须行动、已有可审阅产物、终止性失败或最终结果时发布。",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "required": ["task_id", "kind", "presentation", "headline", "takeaway", "highlights", "dedupe_key"],
                "properties": {
                    "task_id": { "type": "string", "minLength": 1, "maxLength": 160 },
                    "kind": { "type": "string", "enum": ["progress", "decision", "attention", "result", "failure"] },
                    "presentation": presentation_schema(),
                    "headline": { "type": "string", "minLength": 1, "maxLength": 72 },
                    "takeaway": { "type": "string", "minLength": 1, "maxLength": 320 },
                    "highlights": { "type": "array", "maxItems": 3, "items": { "type": "string", "minLength": 1, "maxLength": 100 } },
                    "blocks": blocks_schema(),
                    "proof": { "type": "string", "minLength": 1, "maxLength": 160 },
                    "content": {
                        "oneOf": [
                            { "type": "object", "required": ["type"], "properties": { "type": { "const": "text" } }, "additionalProperties": false },
                            { "type": "object", "required": ["type", "materialIds"], "properties": { "type": { "const": "image_album" }, "materialIds": { "type": "array", "minItems": 1, "maxItems": 10, "items": { "type": "string" } }, "caption": { "type": "string", "maxLength": 240 } }, "additionalProperties": false },
                            { "type": "object", "required": ["type", "materialId"], "properties": { "type": { "const": "video" }, "materialId": { "type": "string" }, "posterMaterialId": { "type": "string" }, "caption": { "type": "string", "maxLength": 240 } }, "additionalProperties": false },
                            { "type": "object", "required": ["type", "materialId"], "properties": { "type": { "const": "document" }, "materialId": { "type": "string" }, "coverMaterialId": { "type": "string" }, "summary": { "type": "string", "maxLength": 320 } }, "additionalProperties": false }
                        ]
                    },
                    "dedupe_key": { "type": "string", "minLength": 1, "maxLength": 240 },
                    "state": { "type": "string", "enum": ["running", "waiting_input", "reviewing", "user_review", "failed", "completed"] },
                    "state_reason": { "type": "string", "minLength": 1, "maxLength": 500 }
                }
            }
        },
        {
            "name": "material.publish",
            "description": "把当前可信 workspace 中已生成的图片、视频、PDF 或文档注册为 Zimlo 物料。",
            "inputSchema": { "type": "object", "additionalProperties": false, "required": ["path"], "properties": { "path": { "type": "string", "minLength": 1, "maxLength": 2000 }, "name": { "type": "string", "minLength": 1, "maxLength": 180 } } }
        }
    ])
}

fn presentation_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["system", "theme", "layout", "typography", "density", "mediaPlacement"],
        "properties": {
            "system": { "enum": ["auto", "editorial", "swiss"] },
            "theme": { "enum": ["auto", "ink_classic", "indigo_porcelain", "forest_ink", "kraft_paper", "dune", "midnight_ink", "ikb", "lemon", "lemon_green", "safety_orange"] },
            "layout": { "enum": ["auto", "feature", "field_note", "quote", "story_split", "media_quiet_zone", "document_excerpt", "metric_grid", "status_board", "evidence_top", "comparison", "steps", "alert"] },
            "typography": { "enum": ["auto", "serif", "sans", "mono", "rounded"] },
            "density": { "enum": ["auto", "airy", "balanced", "compact"] },
            "mediaPlacement": { "enum": ["auto", "hero", "full_bleed", "split", "evidence", "inline"] }
        }
    })
}

fn blocks_schema() -> Value {
    let comparison_item = json!({
        "type": "object", "additionalProperties": false, "required": ["label", "value"],
        "properties": {
            "label": { "type": "string", "minLength": 1, "maxLength": 32 },
            "value": { "type": "string", "minLength": 1, "maxLength": 48 },
            "detail": { "type": "string", "minLength": 1, "maxLength": 100 }
        }
    });
    json!({
        "type": "array", "maxItems": 8,
        "items": { "oneOf": [
            { "type": "object", "additionalProperties": false, "required": ["type", "label", "detail"], "properties": { "type": { "const": "fact" }, "label": { "type": "string", "minLength": 1, "maxLength": 32 }, "detail": { "type": "string", "minLength": 1, "maxLength": 120 }, "value": { "type": "string", "minLength": 1, "maxLength": 32 } } },
            { "type": "object", "additionalProperties": false, "required": ["type", "label", "value"], "properties": { "type": { "const": "metric" }, "label": { "type": "string", "minLength": 1, "maxLength": 24 }, "value": { "type": "string", "minLength": 1, "maxLength": 24 }, "unit": { "type": "string", "minLength": 1, "maxLength": 12 }, "caption": { "type": "string", "minLength": 1, "maxLength": 80 } } },
            { "type": "object", "additionalProperties": false, "required": ["type", "label", "phase"], "properties": { "type": { "const": "step" }, "label": { "type": "string", "minLength": 1, "maxLength": 48 }, "detail": { "type": "string", "minLength": 1, "maxLength": 120 }, "phase": { "type": "string", "enum": ["done", "current", "next"] } } },
            { "type": "object", "additionalProperties": false, "required": ["type", "text"], "properties": { "type": { "const": "quote" }, "text": { "type": "string", "minLength": 1, "maxLength": 240 }, "attribution": { "type": "string", "minLength": 1, "maxLength": 80 } } },
            { "type": "object", "additionalProperties": false, "required": ["type", "left", "right"], "properties": { "type": { "const": "comparison" }, "label": { "type": "string", "minLength": 1, "maxLength": 48 }, "left": comparison_item, "right": comparison_item } }
        ] }
    })
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn advertises_the_same_public_tools_as_the_node_runtime() {
        let tools = super::tool_definitions();
        assert_eq!(tools.as_array().expect("tools").len(), 2);
        assert_eq!(tools[0]["name"], "feed.post");
        assert_eq!(tools[1]["name"], "material.publish");
    }
}
