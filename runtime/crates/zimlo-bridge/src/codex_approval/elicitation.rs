use serde_json::{Value, json};
use zimlo_store::DecisionRecord;

use super::{ApprovalRequest, decision, resolve_approval};

pub(super) async fn resolve(request: ApprovalRequest) -> Result<Value, String> {
    if is_confirmation_elicitation(&request.params) {
        resolve_approval(request, "工具调用审批", "direct").await
    } else {
        // Never claim to have collected fields that this client cannot render.
        Ok(json!({ "action": "cancel", "content": null, "_meta": null }))
    }
}

pub(crate) fn is_confirmation_elicitation(params: &Value) -> bool {
    matches!(params["mode"].as_str(), Some("form" | "openai/form"))
        && params["requestedSchema"]["type"] == "object"
        && params["requestedSchema"]["properties"]
            .as_object()
            .is_some_and(|p| p.is_empty())
        && params["requestedSchema"]
            .get("required")
            .is_none_or(|r| r.as_array().is_some_and(|r| r.is_empty()))
}

pub(super) fn decisions() -> Vec<DecisionRecord> {
    vec![
        decision(
            "mcp-accept",
            "允许一次",
            "once",
            json!({ "action": "accept", "content": {}, "_meta": null }),
            "medium",
            None,
        ),
        decision(
            "mcp-decline",
            "拒绝",
            "deny",
            json!({ "action": "decline", "content": null, "_meta": null }),
            "low",
            None,
        ),
    ]
}
