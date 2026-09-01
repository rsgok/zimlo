use std::{
    path::{Component, Path, PathBuf},
    sync::LazyLock,
};

use regex::Regex;
use zimlo_store::{ApprovalContextRecord, TrustPolicyRecord};

const SAFE_CATEGORIES: [&str; 4] = ["read", "search", "test", "build"];

static SHELL_SEPARATOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:&&|\|\||;|\n)").expect("shell separator regex"));
static DESTRUCTIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:rm|rmdir|shred)\b|\bgit\s+(?:reset|clean)\b|\b(?:drop|truncate)\s+(?:table|database)\b|\bsudo\b")
        .expect("destructive regex")
});
static GIT_PUBLISH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bgit\s+(?:push|commit|tag|merge|rebase)\b|\bgh\s+pr\s+(?:create|merge)\b")
        .expect("git publish regex")
});
static NETWORK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:curl|wget|ssh|scp|rsync)\b|\b(?:fetch|axios)\b").expect("network regex")
});
static GH_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bgh\s+([^\s]+)(?:\s+([^\s]+))?").expect("gh regex"));
static INSTALL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:npm|pnpm|yarn|bun|pip|uv|cargo|gem|brew)\s+(?:add|install|update|upgrade)\b",
    )
    .expect("install regex")
});
static WRITE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|\s)(?:apply_patch|tee)\b|(?:^|\s)(?:cp|mv|mkdir|touch)\b|(?:^|\s)sed\s+-i\b|(?:>|>>)\s*\S+")
        .expect("write regex")
});
static TEST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint)\b|\b(?:vitest|jest|pytest|xcodebuild\s+test|swift\s+test|cargo\s+test)\b")
        .expect("test regex")
});
static BUILD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:tsc|vite\s+build|xcodebuild\s+build|swift\s+build|cargo\s+build)\b")
        .expect("build regex")
});
static SEARCH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:rg|grep|find|fd)\b").expect("search regex"));
static READ: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:pwd|ls|cat|head|tail|sed\s+-n|git\s+(?:status|diff|log|show)|stat|wc)\b")
        .expect("read regex")
});
static HIGH_RISK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:rm\s+-rf|deploy|production|git\s+push|git\s+reset|drop\s+(?:table|database)|sudo)\b",
    )
    .expect("high risk regex")
});
static MEDIUM_RISK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:write|edit|apply_patch|install|delete|remove)\b")
        .expect("medium risk regex")
});
static PATH_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:^|\s)(/[^\s"'`;|&]+|\.{1,2}/[^\s"'`;|&]*)"#).expect("path token regex")
});

pub(super) fn shell_segments(command: &str) -> Vec<String> {
    SHELL_SEPARATOR
        .split(command)
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(str::to_owned)
        .collect()
}

pub(super) fn classify_command_segment(segment: &str) -> &'static str {
    let value = segment.trim();
    if value.is_empty() {
        "unknown"
    } else if DESTRUCTIVE.is_match(value) {
        "destructive"
    } else if GIT_PUBLISH.is_match(value) {
        "git_publish"
    } else if NETWORK.is_match(value) || unsafe_gh_command(value) {
        "network"
    } else if INSTALL.is_match(value) {
        "install"
    } else if WRITE.is_match(value) {
        "write"
    } else if TEST.is_match(value) {
        "test"
    } else if BUILD.is_match(value) {
        "build"
    } else if SEARCH.is_match(value) {
        "search"
    } else if READ.is_match(value) {
        "read"
    } else {
        "unknown"
    }
}

pub(super) fn approval_context_for_command(
    command: &str,
    cwd: Option<&str>,
    project_id: Option<&str>,
    project_root: Option<&str>,
) -> ApprovalContextRecord {
    let segments = shell_segments(command);
    let categories = segments
        .iter()
        .map(|segment| classify_command_segment(segment))
        .collect::<Vec<_>>();
    let category = combined_category(&categories);
    let within_project = match (cwd, project_root) {
        (Some(cwd), Some(root)) => command_stays_within_project(command, cwd, root),
        _ => false,
    };
    let reason = if project_id.is_none() {
        "无法关联项目".into()
    } else if !within_project {
        "命令路径无法确认位于项目内".into()
    } else {
        format!("识别为 {category}")
    };
    ApprovalContextRecord {
        category: category.into(),
        project_id: project_id.map(str::to_owned),
        cwd: cwd.map(str::to_owned),
        command: Some(command.into()),
        segments,
        within_project,
        reason,
    }
}

pub(super) fn approval_context_for_file(
    path: Option<&str>,
    cwd: Option<&str>,
    project_id: Option<&str>,
    project_root: Option<&str>,
) -> ApprovalContextRecord {
    let root = project_root.and_then(|root| normalized_path(Path::new(root)));
    let candidate = path.and_then(|path| {
        let path = Path::new(path);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            Path::new(cwd.unwrap_or("")).join(path)
        };
        normalized_path(&path)
    });
    let within_project = root
        .as_deref()
        .zip(candidate.as_deref())
        .is_some_and(|(root, candidate)| is_within(root, candidate));
    ApprovalContextRecord {
        category: "write".into(),
        project_id: project_id.map(str::to_owned),
        cwd: cwd.map(str::to_owned),
        command: None,
        segments: Vec::new(),
        within_project,
        reason: if within_project {
            "文件写入始终需要确认".into()
        } else {
            "写入路径不在可信项目内".into()
        },
    }
}

pub(super) fn can_auto_allow(context: &ApprovalContextRecord, policy: &TrustPolicyRecord) -> bool {
    if policy.preset != "safe_automation" || !context.within_project || !is_safe(&context.category)
    {
        return false;
    }
    if context.segments.is_empty() {
        return policy.auto_allow.contains(&context.category);
    }
    context.segments.iter().all(|segment| {
        policy
            .auto_allow
            .iter()
            .any(|category| category == classify_command_segment(segment))
    })
}

pub(super) fn risk_for_command(command: &str) -> &'static str {
    if HIGH_RISK.is_match(command) {
        "high"
    } else if MEDIUM_RISK.is_match(command) {
        "medium"
    } else {
        "low"
    }
}

fn combined_category(categories: &[&'static str]) -> &'static str {
    if let Some(first) = categories.first()
        && categories.iter().all(|category| category == first)
    {
        return first;
    }
    if let Some(unsafe_category) = categories.iter().find(|category| !is_safe(category)) {
        return unsafe_category;
    }
    for category in ["build", "test", "search"] {
        if categories.contains(&category) {
            return category;
        }
    }
    "read"
}

fn unsafe_gh_command(value: &str) -> bool {
    GH_COMMAND.captures_iter(value).any(|captures| {
        let first = captures.get(1).map(|value| value.as_str()).unwrap_or("");
        let second = captures.get(2).map(|value| value.as_str()).unwrap_or("");
        !first.eq_ignore_ascii_case("status")
            && !(first.eq_ignore_ascii_case("repo") && second.eq_ignore_ascii_case("view"))
    })
}

fn command_stays_within_project(command: &str, cwd: &str, project_root: &str) -> bool {
    let Some(root) = normalized_path(Path::new(project_root)) else {
        return false;
    };
    let Some(cwd) = normalized_path(Path::new(cwd)) else {
        return false;
    };
    if !is_within(&root, &cwd) {
        return false;
    }
    PATH_TOKEN.captures_iter(command).all(|captures| {
        let Some(path) = captures.get(1).map(|value| Path::new(value.as_str())) else {
            return false;
        };
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        normalized_path(&candidate).is_some_and(|candidate| is_within(&root, &candidate))
    })
}

fn normalized_path(path: &Path) -> Option<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let absolute = lexical_normalize(&absolute);
    if absolute.exists() {
        return std::fs::canonicalize(absolute).ok();
    }
    let mut cursor = absolute.as_path();
    let mut missing = Vec::new();
    while !cursor.exists() {
        missing.push(cursor.file_name()?.to_owned());
        cursor = cursor.parent()?;
    }
    let mut normalized = std::fs::canonicalize(cursor).ok()?;
    for component in missing.iter().rev() {
        normalized.push(component);
    }
    Some(normalized)
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn is_safe(category: &str) -> bool {
    SAFE_CATEGORIES.contains(&category)
}
