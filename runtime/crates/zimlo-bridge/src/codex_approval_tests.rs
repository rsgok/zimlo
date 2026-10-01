use serde_json::json;

use super::codex_approval::{approval_decisions, is_confirmation_elicitation};

#[test]
fn mcp_confirmation_preserves_protocol_and_does_not_grant_persistent_access() {
    let params = json!({"mode":"form", "requestedSchema":{"type":"object", "properties":{}}});
    assert!(is_confirmation_elicitation(&params));
    let decisions = approval_decisions("工具调用审批", &params);
    assert_eq!(decisions.len(), 2);
    assert_eq!(decisions[0].scope, "once");
    assert_eq!(
        decisions[0].value,
        json!({"action":"accept", "content":{}, "_meta":null})
    );
    assert_eq!(decisions[1].scope, "deny");
    assert_eq!(decisions[1].value["action"], "decline");
    assert!(!is_confirmation_elicitation(&json!({"mode":"url"})));
    assert!(!is_confirmation_elicitation(
        &json!({"mode":"form", "requestedSchema":{"type":"object", "properties":{"name":{"type":"string"}}}})
    ));
    assert!(!is_confirmation_elicitation(
        &json!({"mode":"form", "requestedSchema":{"type":"object", "properties":{}, "required":["name"]}})
    ));
}

#[test]
fn preserves_upstream_policy_amendments_as_high_risk_decisions() {
    let decisions = approval_decisions(
        "命令执行审批",
        &json!({
            "command": "git push origin main",
            "proposedExecpolicyAmendment": { "command": "git push origin main" },
            "proposedNetworkPolicyAmendments": [{ "host": "github.com" }]
        }),
    );
    assert_eq!(decisions.len(), 6);
    assert_eq!(decisions[0].risk, "high");
    assert_eq!(decisions[2].scope, "persistent");
    assert_eq!(decisions[3].scope, "persistent");
    assert_eq!(
        decisions[2].confirmation_phrase.as_deref(),
        Some("永久允许")
    );
}
