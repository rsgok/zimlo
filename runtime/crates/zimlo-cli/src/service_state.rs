use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{SecondsFormat, Utc};
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde::{Deserialize, Serialize};
use tokio::time::{Instant, sleep};
use uuid::Uuid;
use zimlo_protocol::{ZIMLO_PROTOCOL_VERSION, ZIMLO_VERSION};

use crate::paths::ZimloPaths;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceOwner {
    pub pid: u32,
    pub token: String,
    pub entrypoint: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDescriptor {
    pub pid: u32,
    pub port: u16,
    pub version: String,
    pub protocol_version: u32,
    pub started_at: String,
    pub socket_path: String,
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupDiagnostics {
    pub at: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub struct ServiceLease {
    lock_path: PathBuf,
    token: String,
}

impl ServiceLease {
    pub fn acquire(paths: &ZimloPaths) -> io::Result<Self> {
        secure_directory(&paths.run)?;
        let owner = ServiceOwner {
            pid: std::process::id(),
            token: Uuid::now_v7().to_string(),
            entrypoint: std::env::current_exe()?.display().to_string(),
            started_at: now(),
        };
        for _ in 0..4 {
            match fs::create_dir(&paths.service_lock) {
                Ok(()) => {
                    write_json_atomic(&paths.service_lock.join("owner.json"), &owner)?;
                    return Ok(Self {
                        lock_path: paths.service_lock.clone(),
                        token: owner.token,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if let Some(existing) =
                        read_json::<ServiceOwner>(&paths.service_lock.join("owner.json"))
                        && process_alive(existing.pid)
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::AlreadyExists,
                            format!("Zimlo 已在运行（PID {}）。", existing.pid),
                        ));
                    }
                    fs::remove_dir_all(&paths.service_lock)?;
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::other(
            "无法取得 Zimlo 服务所有权，请重新打开应用。",
        ))
    }
}

impl Drop for ServiceLease {
    fn drop(&mut self) {
        let owner = read_json::<ServiceOwner>(&self.lock_path.join("owner.json"));
        if owner
            .as_ref()
            .is_some_and(|owner| owner.token == self.token)
        {
            let _ = fs::remove_dir_all(&self.lock_path);
        }
    }
}

pub fn clear_manual_stop(paths: &ZimloPaths) -> io::Result<()> {
    match fs::remove_file(&paths.manual_stop) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn mark_manual_stop(paths: &ZimloPaths) -> io::Result<()> {
    secure_directory(&paths.run)?;
    write_private(&paths.manual_stop, format!("{}\n", now()).as_bytes())
}

pub fn write_descriptor(paths: &ZimloPaths, port: u16) -> io::Result<ServiceDescriptor> {
    let descriptor = ServiceDescriptor {
        pid: std::process::id(),
        port,
        version: ZIMLO_VERSION.to_owned(),
        protocol_version: ZIMLO_PROTOCOL_VERSION,
        started_at: now(),
        socket_path: paths.socket.display().to_string(),
        log_path: (std::env::var("ZIMLO_AUTOSTARTED").ok().as_deref() == Some("1"))
            .then(|| paths.autostart_log.display().to_string()),
    };
    write_json_atomic(&paths.service, &descriptor)?;
    write_json_atomic(
        &paths.startup_diagnostics,
        &StartupDiagnostics {
            at: now(),
            ok: true,
            pid: Some(descriptor.pid),
            port: Some(port),
            code: None,
            message: None,
        },
    )?;
    Ok(descriptor)
}

pub fn clear_descriptor(paths: &ZimloPaths, expected_pid: u32) -> io::Result<bool> {
    let Some(descriptor) = read_json::<ServiceDescriptor>(&paths.service) else {
        return Ok(false);
    };
    if descriptor.pid != expected_pid {
        return Ok(false);
    }
    match fs::remove_file(&paths.service) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn descriptor(paths: &ZimloPaths) -> Option<ServiceDescriptor> {
    read_json(&paths.service)
}

pub fn owner(paths: &ZimloPaths) -> Option<ServiceOwner> {
    read_json(&paths.service_lock.join("owner.json"))
}

pub async fn stop(paths: &ZimloPaths) -> io::Result<Option<u32>> {
    let descriptor = descriptor(paths);
    let owner = owner(paths);
    let target = match (descriptor.as_ref(), owner.as_ref()) {
        (Some(descriptor), Some(owner))
            if descriptor.pid == owner.pid && process_alive(owner.pid) =>
        {
            owner.pid
        }
        (None, Some(owner)) if process_alive(owner.pid) => owner.pid,
        (Some(descriptor), _) if process_alive(descriptor.pid) => {
            return Err(io::Error::other(format!(
                "PID {} 仍在运行，但实例锁无法证明归属，已放弃停止。",
                descriptor.pid
            )));
        }
        _ => {
            mark_manual_stop(paths)?;
            return Ok(None);
        }
    };
    kill(Pid::from_raw(target as i32), Signal::SIGTERM).map_err(io::Error::other)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !process_alive(target) {
            mark_manual_stop(paths)?;
            return Ok(Some(target));
        }
        sleep(Duration::from_millis(100)).await;
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("已向 PID {target} 发送 SIGTERM，但进程未在 10 秒内退出。"),
    ))
}

pub fn process_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    match kill(Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(nix::errno::Errno::EPERM) => true,
        Err(_) => false,
    }
}

pub fn secure_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    secure_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.zimlo-{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state"),
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    let data = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    write_private(&temporary, &[data, b"\n".to_vec()].concat())?;
    fs::rename(temporary, path)
}

fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    use std::io::Write as _;
    file.write_all(data)?;
    file.sync_all()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::{descriptor, mark_manual_stop, write_descriptor};
    use crate::paths::ZimloPaths;

    fn paths(root: &std::path::Path) -> ZimloPaths {
        let run = root.join("run");
        let logs = root.join("logs");
        ZimloPaths {
            root: root.into(),
            database: root.join("zimlo.db"),
            socket: run.join("bridge.sock"),
            service_lock: run.join("service.lock"),
            service: run.join("service.json"),
            startup_diagnostics: run.join("startup-diagnostics.json"),
            manual_stop: run.join("manual-stop"),
            autostart_log: logs.join("autostart.log"),
            run,
            logs,
        }
    }

    #[test]
    fn writes_node_compatible_descriptor_and_manual_stop_marker() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let paths = paths(directory.path());
        let written = write_descriptor(&paths, 4747).expect("descriptor");
        assert_eq!(descriptor(&paths), Some(written));
        mark_manual_stop(&paths).expect("manual stop");
        assert!(paths.manual_stop.exists());
    }
}
