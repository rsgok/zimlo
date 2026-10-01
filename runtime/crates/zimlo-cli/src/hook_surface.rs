use std::{path::Path, time::Duration};

use tokio::{process::Command, time::timeout};

struct ProcessParent {
    tty: String,
    command: String,
}

fn is_codex_cli(command: &str) -> bool {
    let mut arguments = command.split_whitespace();
    if !arguments.next().is_some_and(|executable| {
        Path::new(executable)
            .file_name()
            .is_some_and(|name| name == "codex")
    }) {
        return false;
    }
    while let Some(argument) = arguments.next() {
        if argument == "--" {
            return true;
        }
        if matches!(
            argument,
            "-c" | "--config"
                | "--enable"
                | "--disable"
                | "--remote"
                | "--remote-auth-token-env"
                | "-i"
                | "--image"
                | "-m"
                | "--model"
                | "--local-provider"
                | "-p"
                | "--profile"
                | "-s"
                | "--sandbox"
                | "-C"
                | "--cd"
                | "--add-dir"
                | "-a"
                | "--ask-for-approval"
        ) {
            arguments.next();
            continue;
        }
        if argument.starts_with('-') {
            continue;
        }
        // Later positional arguments belong to the subcommand or user prompt.
        return argument != "app-server";
    }
    true
}

fn surface_from_process_chain(chain: &[ProcessParent]) -> &'static str {
    if chain
        .iter()
        .any(|process| !matches!(process.tty.as_str(), "??" | "?" | ""))
    {
        return "cli";
    }
    // Non-interactive Codex CLI runs may have no TTY. An app-server without
    // desktop ancestry is ambiguous, so do not assign it a CLI identity.
    // Check before desktop paths: the app bundle also supplies the CLI binary.
    if chain.iter().any(|process| is_codex_cli(&process.command)) {
        return "cli";
    }
    if chain.iter().any(|process| {
        [
            "Codex.app/",
            "ChatGPT.app/",
            "Claude.app/",
            "Claude Code.app/",
            "Codex Helper",
            "ChatGPT Helper",
            "Claude Helper",
            "Claude Code Helper",
        ]
        .iter()
        .any(|name| process.command.contains(name))
    }) {
        return "gui";
    }
    "unknown"
}

pub async fn detect_hook_surface() -> &'static str {
    timeout(Duration::from_millis(500), detect_from_ancestry())
        .await
        .unwrap_or("unknown")
}

async fn detect_from_ancestry() -> &'static str {
    let mut chain = Vec::new();
    let mut pid = std::os::unix::process::parent_id();
    for _ in 0..8 {
        if pid <= 1 {
            break;
        }
        let output = timeout(
            Duration::from_millis(500),
            Command::new("/bin/ps")
                .kill_on_drop(true)
                .args(["-o", "ppid=,tty=,command=", "-p", &pid.to_string()])
                .output(),
        )
        .await;
        let Ok(Ok(output)) = output else {
            break;
        };
        if !output.status.success() {
            break;
        }
        let output = String::from_utf8_lossy(&output.stdout);
        let mut fields = output.split_whitespace();
        let Some(parent) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            break;
        };
        let Some(tty) = fields.next() else {
            break;
        };
        chain.push(ProcessParent {
            tty: tty.into(),
            command: fields.collect::<Vec<_>>().join(" "),
        });
        pid = parent;
    }
    surface_from_process_chain(&chain)
}

#[cfg(test)]
mod tests {
    use super::{ProcessParent, surface_from_process_chain};

    fn process(tty: &str, command: &str) -> ProcessParent {
        ProcessParent {
            tty: tty.into(),
            command: command.into(),
        }
    }

    #[test]
    fn shared_hooks_identify_desktop_and_cli_from_actual_ancestry() {
        assert_eq!(
            surface_from_process_chain(&[process("ttys003", "codex")]),
            "cli"
        );
        assert_eq!(
            surface_from_process_chain(&[
                process(
                    "??",
                    "/Applications/Codex.app/Contents/Resources/codex app-server"
                ),
                process("??", "/Applications/Codex.app/Contents/MacOS/Codex"),
            ]),
            "gui"
        );
        assert_eq!(
            surface_from_process_chain(&[process("?", "/usr/bin/codex exec task")]),
            "cli"
        );
        assert_eq!(
            surface_from_process_chain(&[process("??", "codex app-server")]),
            "unknown"
        );
        assert_eq!(
            surface_from_process_chain(&[process("??", "unrecognized-runner")]),
            "unknown"
        );
    }

    #[test]
    fn terminal_inside_desktop_is_still_cli() {
        assert_eq!(
            surface_from_process_chain(&[
                process("ttys003", "codex"),
                process("??", "/Applications/Codex.app/Contents/MacOS/Codex"),
            ]),
            "cli"
        );
    }

    #[test]
    fn bundled_codex_cli_without_tty_is_not_a_desktop_session() {
        for executable in [
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
        ] {
            assert_eq!(
                surface_from_process_chain(&[
                    process("??", &format!("{executable} exec task")),
                    process("??", "/bin/sh automation.sh"),
                ]),
                "cli"
            );
            assert_eq!(
                surface_from_process_chain(&[
                    process("??", &format!("{executable} app-server")),
                    process("??", "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
                ]),
                "gui"
            );
        }
    }

    #[test]
    fn app_server_in_a_prompt_or_option_value_is_not_the_subcommand() {
        for (arguments, expected) in [
            ("exec app-server", "cli"),
            ("exec fix app-server now", "cli"),
            ("e fix app-server", "cli"),
            ("review fix app-server", "cli"),
            ("resume session-id fix app-server", "cli"),
            ("fork session-id fix app-server", "cli"),
            ("fix app-server now", "cli"),
            ("-- app-server", "cli"),
            ("--profile app-server exec task", "cli"),
            ("--config model=example --no-daemon exec app-server", "cli"),
            ("--profile exec app-server", "gui"),
            ("--config model=example app-server --listen stdio", "gui"),
            ("--config=model=example app-server", "gui"),
        ] {
            assert_eq!(
                surface_from_process_chain(&[process(
                    "??",
                    &format!(
                        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex {arguments}"
                    ),
                )]),
                expected,
                "arguments: {arguments}"
            );
        }
    }
}
