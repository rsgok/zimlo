use std::{collections::HashSet, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentProvider {
    Codex,
    Claude,
}

impl AgentProvider {
    fn command(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    fn override_name(self) -> &'static str {
        match self {
            Self::Codex => "ZIMLO_CODEX_BIN",
            Self::Claude => "ZIMLO_CLAUDE_BIN",
        }
    }

    fn application_binaries(self) -> &'static [&'static str] {
        match self {
            Self::Codex => &[
                "/Applications/ChatGPT.app/Contents/Resources/codex",
                "/Applications/Codex.app/Contents/Resources/codex",
            ],
            Self::Claude => &["/Applications/Claude.app/Contents/Resources/claude"],
        }
    }
}

pub(crate) async fn resolve(provider: AgentProvider) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(provider.override_name())
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return executable(&path).await.then_some(path);
    }

    let mut candidates = provider
        .application_binaries()
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|path| path.join(provider.command())));
    }
    candidates.extend(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
            .map(PathBuf::from)
            .map(|path| path.join(provider.command())),
    );
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/bin").join(provider.command()));
        candidates.push(home.join(".nvm/current/bin").join(provider.command()));
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        if seen.insert(candidate.clone()) && executable(&candidate).await {
            return Some(candidate);
        }
    }
    None
}

async fn executable(path: &PathBuf) -> bool {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
