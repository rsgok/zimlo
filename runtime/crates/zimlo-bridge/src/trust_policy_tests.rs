use std::os::unix::fs::symlink;

use zimlo_store::TrustPolicyRecord;

use super::trust_policy::{
    approval_context_for_command, approval_context_for_file, can_auto_allow,
    classify_command_segment, risk_for_command,
};

fn policy() -> TrustPolicyRecord {
    TrustPolicyRecord {
        project_id: "project-trust".into(),
        preset: "safe_automation".into(),
        auto_allow: vec![
            "read".into(),
            "search".into(),
            "test".into(),
            "build".into(),
        ],
        updated_at: "2026-09-02T00:00:00.000Z".into(),
        updated_by_device_id: "device-trust".into(),
    }
}

#[test]
fn classifies_risk_before_permissive_categories() {
    assert_eq!(classify_command_segment("pnpm test"), "test");
    assert_eq!(classify_command_segment("pnpm build"), "build");
    assert_eq!(
        classify_command_segment("curl https://example.com"),
        "network"
    );
    assert_eq!(
        classify_command_segment("git push origin main"),
        "git_publish"
    );
    assert_eq!(classify_command_segment("rm -rf ./dist"), "destructive");
    assert_eq!(risk_for_command("git push origin main"), "high");
    assert_eq!(risk_for_command("apply_patch"), "medium");
}

#[test]
fn requires_every_compound_segment_to_be_safe() {
    let directory = tempfile::tempdir().expect("tempdir");
    let root = directory.path().to_string_lossy();
    let safe = approval_context_for_command(
        "rg TODO src && cargo test",
        Some(&root),
        Some("project-trust"),
        Some(&root),
    );
    let mixed = approval_context_for_command(
        "cargo test && git push",
        Some(&root),
        Some("project-trust"),
        Some(&root),
    );
    assert!(can_auto_allow(&safe, &policy()));
    assert!(!can_auto_allow(&mixed, &policy()));
    assert_eq!(mixed.category, "git_publish");
}

#[test]
fn fails_closed_for_path_traversal_symlinks_and_writes() {
    let root = tempfile::tempdir().expect("root");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::create_dir(root.path().join("inside")).expect("inside");
    symlink(outside.path(), root.path().join("inside/escape")).expect("symlink");
    let root_text = root.path().to_string_lossy();
    let traversal = approval_context_for_command(
        "cat ../secret",
        Some(&root_text),
        Some("project-trust"),
        Some(&root_text),
    );
    let escaped = approval_context_for_command(
        "cat ./inside/escape/secret",
        Some(&root_text),
        Some("project-trust"),
        Some(&root_text),
    );
    let file = approval_context_for_file(
        Some(&root.path().join("new.txt").to_string_lossy()),
        Some(&root_text),
        Some("project-trust"),
        Some(&root_text),
    );
    assert!(!traversal.within_project);
    assert!(!escaped.within_project);
    assert!(!can_auto_allow(&traversal, &policy()));
    assert!(!can_auto_allow(&escaped, &policy()));
    assert_eq!(file.category, "write");
    assert!(!can_auto_allow(&file, &policy()));
}
