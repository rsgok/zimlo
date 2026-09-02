use std::{path::PathBuf, sync::OnceLock, time::Duration};

use serde_json::Value;
use tokio::{
    process::Command,
    sync::Mutex,
    time::{Instant, timeout},
};

const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);
type ProbeCache = Mutex<Option<(Instant, Vec<Value>)>>;

pub async fn statuses() -> Result<Vec<Value>, String> {
    let mut cache = probe_cache().lock().await;
    if let Some((at, statuses)) = cache.as_ref()
        && at.elapsed() < Duration::from_secs(10)
    {
        return Ok(statuses.clone());
    }
    let output = run(&["integrations", "status", "--json"]).await?;
    let statuses: Vec<Value> =
        serde_json::from_slice(&output).map_err(|error| error.to_string())?;
    *cache = Some((Instant::now(), statuses.clone()));
    Ok(statuses)
}

pub async fn install(target: &str) -> Result<Vec<Value>, String> {
    run(&["integrations", "install", "--target", target]).await?;
    *probe_cache().lock().await = None;
    statuses().await
}

pub async fn plugin_status() -> Result<Value, String> {
    let output = run(&["codex-plugin", "status", "--json"]).await?;
    serde_json::from_slice(&output).map_err(|error| error.to_string())
}

pub async fn install_plugin() -> Result<Value, String> {
    let output = run(&["codex-plugin", "install", "--json"]).await?;
    *probe_cache().lock().await = None;
    serde_json::from_slice(&output).map_err(|error| error.to_string())
}

fn probe_cache() -> &'static ProbeCache {
    static CACHE: OnceLock<ProbeCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

async fn run(arguments: &[&str]) -> Result<Vec<u8>, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    run_executable(executable, arguments).await
}

async fn run_executable(executable: PathBuf, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let output = timeout(
        COMMAND_TIMEOUT,
        Command::new(executable).args(arguments).output(),
    )
    .await
    .map_err(|_| "集成检查超时。".to_owned())?
    .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}
