use std::{env, io, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZimloPaths {
    pub root: PathBuf,
    pub database: PathBuf,
    pub run: PathBuf,
    pub socket: PathBuf,
    pub service_lock: PathBuf,
    pub service: PathBuf,
    pub startup_diagnostics: PathBuf,
    pub manual_stop: PathBuf,
    pub logs: PathBuf,
    pub autostart_log: PathBuf,
}

impl ZimloPaths {
    pub fn discover() -> io::Result<Self> {
        let root = match env::var_os("ZIMLO_HOME").filter(|value| !value.is_empty()) {
            Some(configured) => absolute(PathBuf::from(configured))?,
            None => dirs::home_dir()
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "home directory unavailable")
                })?
                .join(".zimlo"),
        };
        let run = root.join("run");
        let logs = root.join("logs");
        Ok(Self {
            database: root.join("zimlo.db"),
            socket: run.join("bridge.sock"),
            service_lock: run.join("service.lock"),
            service: run.join("service.json"),
            startup_diagnostics: run.join("startup-diagnostics.json"),
            manual_stop: run.join("manual-stop"),
            autostart_log: logs.join("autostart.log"),
            root,
            run,
            logs,
        })
    }
}

fn absolute(path: PathBuf) -> io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::absolute;

    #[test]
    fn relative_paths_are_resolved_without_canonicalizing_missing_directories() {
        let path = absolute("runtime-home".into()).expect("absolute path");
        assert!(path.is_absolute());
        assert!(path.ends_with("runtime-home"));
    }
}
