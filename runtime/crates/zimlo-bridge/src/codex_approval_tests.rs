use serde_json::json;

use super::codex_approval::approval_decisions;

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
