use std::{
    env, fs,
    path::{Path, PathBuf},
};

use tokio::process::Command;

const UNIT_NAME: &str = "zimlo.service";
const MANAGED_MARKER: &str = "# Managed by Zimlo.";

pub async fn install() -> Result<PathBuf, String> {
    require_linux()?;
    let executable = env::current_exe().map_err(display)?;
    let unit_path = unit_path()?;
    let parent = unit_path
        .parent()
        .ok_or_else(|| "systemd unit 路径无效。".to_owned())?;
    fs::create_dir_all(parent).map_err(display)?;
    if unit_path.is_file() {
        let existing = fs::read_to_string(&unit_path).map_err(display)?;
        if !existing.starts_with(MANAGED_MARKER) {
            return Err(format!(
                "{} 已存在且不是 Zimlo 管理的服务文件，未覆盖。",
                unit_path.display()
            ));
        }
    }
    write_atomic(&unit_path, render_unit(&executable)?)?;
    systemctl(&["daemon-reload"]).await?;
    systemctl(&["enable", UNIT_NAME]).await?;
    systemctl(&["restart", UNIT_NAME]).await?;
    Ok(unit_path)
}

pub fn ensure_supported() -> Result<(), String> {
    require_linux()
}

pub async fn uninstall() -> Result<PathBuf, String> {
    require_linux()?;
    let unit_path = unit_path()?;
    if unit_path.is_file() {
        let existing = fs::read_to_string(&unit_path).map_err(display)?;
        if !existing.starts_with(MANAGED_MARKER) {
            return Err(format!(
                "{} 不是 Zimlo 管理的服务文件，未删除。",
                unit_path.display()
            ));
        }
        systemctl(&["disable", "--now", UNIT_NAME]).await?;
        fs::remove_file(&unit_path).map_err(display)?;
    }
    systemctl(&["daemon-reload"]).await?;
    Ok(unit_path)
}

pub async fn status() -> Result<(), String> {
    require_linux()?;
    let active = systemctl_output(&["is-active", UNIT_NAME]).await;
    let enabled = systemctl_output(&["is-enabled", UNIT_NAME]).await;
    println!("systemd user service：{}", active.trim());
    println!("开机/登录启动：{}", enabled.trim());
    if active.trim() != "active" {
        return Err(
            "Zimlo systemd user service 未运行。执行 zimlo service install 安装并启动。".into(),
        );
    }
    Ok(())
}

pub fn is_installed() -> bool {
    cfg!(target_os = "linux") && unit_path().is_ok_and(|path| path.is_file())
}

fn require_linux() -> Result<(), String> {
    if cfg!(target_os = "linux") {
        Ok(())
    } else {
        Err("zimlo service 仅用于 Linux systemd user service。".into())
    }
}

fn unit_path() -> Result<PathBuf, String> {
    let config = env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .ok_or_else(|| "无法定位用户配置目录。".to_owned())?;
    Ok(config.join("systemd/user").join(UNIT_NAME))
}

fn render_unit(executable: &Path) -> Result<String, String> {
    let executable = systemd_quote(&executable.to_string_lossy())?;
    let path =
        systemd_quote(&env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into()))?;
    Ok(format!(
        "{MANAGED_MARKER} Manual edits may be overwritten.\n\
[Unit]\n\
Description=Zimlo headless host runtime\n\
After=network-online.target\n\
Wants=network-online.target\n\
\n\
[Service]\n\
Type=simple\n\
ExecStart=\"{executable}\" start\n\
Environment=ZIMLO_AUTOSTARTED=1\n\
Environment=\"PATH={path}\"\n\
Restart=on-failure\n\
RestartSec=2\n\
TimeoutStopSec=15\n\
\n\
[Install]\n\
WantedBy=default.target\n"
    ))
}

fn systemd_quote(value: &str) -> Result<String, String> {
    if value.contains(['\n', '\r']) {
        return Err("systemd 服务参数不能包含换行符。".into());
    }
    Ok(value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$"))
}

fn write_atomic(path: &Path, contents: String) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "systemd unit 路径无效。".to_owned())?;
    let temporary = parent.join(format!(".{UNIT_NAME}.{}.tmp", std::process::id()));
    fs::write(&temporary, contents).map_err(display)?;
    fs::rename(&temporary, path).map_err(display)
}

async fn systemctl(arguments: &[&str]) -> Result<(), String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(arguments)
        .output()
        .await
        .map_err(|error| systemctl_error(&error.to_string()))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(systemctl_error(&detail))
    }
}

async fn systemctl_output(arguments: &[&str]) -> String {
    Command::new("systemctl")
        .arg("--user")
        .args(arguments)
        .output()
        .await
        .map(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if stdout.is_empty() {
                String::from_utf8_lossy(&output.stderr).trim().to_owned()
            } else {
                stdout
            }
        })
        .unwrap_or_else(|error| error.to_string())
}

fn systemctl_error(detail: &str) -> String {
    format!(
        "无法管理 systemd user service：{detail}\n请确认服务器使用 systemd 并允许用户服务；若需退出 SSH 后继续运行，可由管理员执行 loginctl enable-linger \"$USER\"。"
    )
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::{MANAGED_MARKER, render_unit, systemd_quote};

    #[test]
    fn renders_restartable_user_service_with_absolute_executable() {
        let unit =
            render_unit(std::path::Path::new("/home/kai/.local/bin/zimlo")).expect("unit renders");
        assert!(unit.starts_with(MANAGED_MARKER));
        assert!(unit.contains("ExecStart=\"/home/kai/.local/bin/zimlo\" start"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(!unit.contains("User="));
    }

    #[test]
    fn escapes_systemd_specifiers_and_rejects_newlines() {
        assert_eq!(
            systemd_quote("/tmp/a%b$c").expect("escaped"),
            "/tmp/a%%b$$c"
        );
        assert!(systemd_quote("bad\nvalue").is_err());
    }
}
