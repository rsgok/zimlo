use super::{redact, string};
use serde_json::Value;

pub(super) fn approval_detail(params: &Value) -> String {
    if let Some(message) = string(&params["message"]) {
        let server = string(&params["serverName"]).unwrap_or_else(|| "MCP".into());
        return redact(&format!("{server}：{message}"), 800);
    }
    let network = &params["networkApprovalContext"];
    if let Some(host) = string(&network["host"]) {
        return format!(
            "网络访问：{}://{}{}",
            string(&network["protocol"]).unwrap_or_else(|| "network".into()),
            host,
            network["port"]
                .as_u64()
                .map(|port| format!(":{port}"))
                .unwrap_or_default()
        );
    }
    redact(
        &string(&params["command"])
            .or_else(|| string(&params["reason"]))
            .unwrap_or_else(|| params.to_string()),
        800,
    )
}
