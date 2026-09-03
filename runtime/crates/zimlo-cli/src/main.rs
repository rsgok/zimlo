use std::{
    error::Error,
    fs,
    net::IpAddr,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
};

use clap::{Parser, Subcommand};
use qrcode::{QrCode, render::unicode};
use serde_json::json;
use tokio::sync::watch;
use uuid::Uuid;
use zimlo_protocol::ZIMLO_VERSION;
use zimlo_store::{Store, StoreMode};

mod integration;
mod mcp;
mod paths;
mod service_install;
mod service_state;

use paths::ZimloPaths;
use service_state::ServiceLease;

#[derive(Debug, Parser)]
#[command(
    name = "zimlo",
    about = "Zimlo native Bridge Runtime",
    version = ZIMLO_VERSION
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the native Bridge. The default Zimlo database is writable.
    Start {
        /// Listen on trusted LAN addresses instead of loopback only.
        #[arg(long)]
        lan: bool,
        /// HTTP port. Use 0 in tests to request an ephemeral port.
        #[arg(long, default_value_t = 4747)]
        port: u16,
        /// Open a specific Node-compatible SQLite database. Explicit databases remain read-only
        /// unless --write is also provided.
        #[arg(long, value_name = "PATH")]
        database: Option<PathBuf>,
        /// Explicitly take exclusive SQLite write ownership of --database.
        #[arg(long, requires = "database", conflicts_with = "read_only")]
        write: bool,
        /// Open the selected database without taking write ownership.
        #[arg(long, conflicts_with = "write")]
        read_only: bool,
    },
    /// Show the Bridge service status.
    Status {
        /// Print machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Stop the running Bridge after verifying its service ownership.
    Stop,
    /// Print Bridge or desktop app logs.
    Logs {
        #[arg(long)]
        follow: bool,
        #[arg(long, conflicts_with = "desktop")]
        cli: bool,
        #[arg(long, conflicts_with = "cli")]
        desktop: bool,
    },
    /// Check the native Runtime, directories, integrations and Bridge.
    Doctor,
    /// Manage Codex and Claude hook configuration.
    Hooks {
        #[command(subcommand)]
        command: HooksCommand,
    },
    /// Inspect or install local Agent integrations.
    Integrations {
        #[command(subcommand)]
        command: IntegrationsCommand,
    },
    /// Manage the Codex GUI plugin source.
    CodexPlugin {
        #[command(subcommand)]
        command: CodexPluginCommand,
    },
    /// Manage paired devices.
    Devices {
        #[command(subcommand)]
        command: DevicesCommand,
    },
    /// Create a short-lived pairing code for an iPhone from a terminal.
    Pair {
        /// Print the pairing payload as JSON instead of a terminal QR code.
        #[arg(long)]
        json: bool,
    },
    /// Install or inspect the Linux systemd user service.
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
    /// Open the local management page after checking the Runtime protocol.
    Open,
    /// Run the stdio MCP server used by Codex or Claude.
    Mcp {
        #[arg(long)]
        provider: String,
    },
    /// Forward one Agent hook payload to the running Bridge.
    Hook {
        #[arg(long)]
        provider: String,
        #[arg(long, default_value = "auto")]
        surface: String,
    },
}

#[derive(Debug, Subcommand)]
enum HooksCommand {
    Diff {
        #[arg(long)]
        json: bool,
    },
    Status,
    Install,
    Uninstall,
}

#[derive(Debug, Subcommand)]
enum IntegrationsCommand {
    Status {
        #[arg(long)]
        json: bool,
    },
    Install {
        #[arg(long, default_value = "all")]
        target: String,
    },
}

#[derive(Debug, Subcommand)]
enum CodexPluginCommand {
    Status {
        #[arg(long)]
        json: bool,
    },
    Install {
        #[arg(long)]
        json: bool,
    },
    Uninstall,
}

#[derive(Debug, Subcommand)]
enum DevicesCommand {
    List,
    Revoke { device_id: String },
}

#[derive(Debug, Subcommand)]
enum ServiceCommand {
    /// Install, enable and start the Linux systemd user service.
    Install,
    /// Show the Linux systemd user service state.
    Status,
    /// Stop, disable and remove the Linux systemd user service.
    Uninstall,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    match Cli::parse().command {
        Command::Start {
            lan,
            port,
            database,
            write,
            read_only,
        } => start(lan, port, database, write, read_only).await,
        Command::Status { json } => status(json).await,
        Command::Stop => stop().await,
        Command::Logs {
            follow,
            cli: _,
            desktop,
        } => logs(follow, desktop),
        Command::Doctor => doctor().await,
        Command::Hooks { command } => hooks(command),
        Command::Integrations { command } => integrations(command).await,
        Command::CodexPlugin { command } => codex_plugin(command).await,
        Command::Devices { command } => devices(command).await,
        Command::Pair { json } => pair(json).await,
        Command::Service { command } => service(command).await,
        Command::Open => open_management().await,
        Command::Mcp { provider } => {
            validate_provider(&provider)?;
            let paths = ZimloPaths::discover()?;
            mcp::ensure_bridge_running(&paths).await?;
            mcp::run(&provider, &paths.socket).await.map_err(Into::into)
        }
        Command::Hook { provider, surface } => {
            validate_provider(&provider)?;
            if !matches!(surface.as_str(), "auto" | "gui" | "cli" | "managed") {
                return Err("surface 仅支持 auto、gui、cli、managed。".into());
            }
            let paths = ZimloPaths::discover()?;
            mcp::run_hook(&provider, &surface, &paths.socket)
                .await
                .map_err(Into::into)
        }
    }
}

fn validate_provider(provider: &str) -> Result<(), Box<dyn Error>> {
    if matches!(provider, "codex" | "claude") {
        Ok(())
    } else {
        Err("provider 仅支持 codex、claude。".into())
    }
}

fn hooks(command: HooksCommand) -> Result<(), Box<dyn Error>> {
    let executable = std::env::current_exe()?;
    match command {
        HooksCommand::Diff { json } => {
            let changes = integration::hooks_diff(&executable)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&changes)?);
            } else {
                for change in changes {
                    println!(
                        "{}：{}",
                        change["path"].as_str().unwrap_or("配置"),
                        if change["before"] == change["after"] {
                            "已是最新"
                        } else {
                            "需要更新"
                        }
                    );
                }
            }
        }
        HooksCommand::Status => {
            let ready = integration::hooks_diff(&executable)?
                .iter()
                .all(|change| change["before"] == change["after"]);
            println!(
                "{}",
                if ready {
                    "Zimlo hooks 已安装且为当前 Rust Runtime。"
                } else {
                    "Zimlo hooks 未安装或需要升级。"
                }
            );
            if !ready {
                return Err("hooks are not current".into());
            }
        }
        HooksCommand::Install => {
            integration::install_hooks(&executable, false)?;
            println!("Zimlo hooks 已原子合并；用户原配置已保留。");
        }
        HooksCommand::Uninstall => {
            integration::install_hooks(&executable, true)?;
            println!("仅 Zimlo 自己的 hook 项已移除；用户原配置已保留。");
        }
    }
    Ok(())
}

async fn integrations(command: IntegrationsCommand) -> Result<(), Box<dyn Error>> {
    let executable = std::env::current_exe()?;
    match command {
        IntegrationsCommand::Status { json } => {
            let statuses = integration::statuses(&executable).await;
            if json {
                println!("{}", serde_json::to_string(&statuses)?);
            } else {
                for status in statuses {
                    println!("{}：{}", status["label"], status["detail"]);
                }
            }
        }
        IntegrationsCommand::Install { target } => match target.as_str() {
            "all" => {
                let _ = integration::install_plugin(&executable).await?;
                integration::install_cli(&executable).await?;
            }
            "cli" => integration::install_cli(&executable).await?,
            "codex_gui" => {
                let _ = integration::install_plugin(&executable).await?;
            }
            _ => return Err("target 仅支持 all、codex_gui、cli。".into()),
        },
    }
    Ok(())
}

async fn codex_plugin(command: CodexPluginCommand) -> Result<(), Box<dyn Error>> {
    let executable = std::env::current_exe()?;
    let (status, json) = match command {
        CodexPluginCommand::Status { json } => {
            (integration::plugin_status(&executable).await, json)
        }
        CodexPluginCommand::Install { json } => {
            (integration::install_plugin(&executable).await?, json)
        }
        CodexPluginCommand::Uninstall => (integration::uninstall_plugin(&executable).await?, false),
    };
    if json {
        println!("{}", serde_json::to_string(&status)?);
    } else {
        println!(
            "{}",
            status["detail"]
                .as_str()
                .unwrap_or("Codex 插件状态不可用。")
        );
    }
    Ok(())
}

async fn start(
    lan: bool,
    port: u16,
    database: Option<PathBuf>,
    write: bool,
    read_only: bool,
) -> Result<(), Box<dyn Error>> {
    let paths = ZimloPaths::discover()?;
    service_state::secure_directory(&paths.root)?;
    service_state::secure_directory(&paths.logs)?;
    service_state::clear_manual_stop(&paths)?;
    let _lease = ServiceLease::acquire(&paths)?;

    let explicit_database = database.is_some();
    let database = database.unwrap_or_else(|| paths.database.clone());
    let writable = if explicit_database { write } else { !read_only };
    let mode = match (explicit_database, writable) {
        (true, true) => StoreMode::ReadWriteExisting,
        (true, false) => StoreMode::ReadOnly,
        (false, true) => StoreMode::ReadWriteCreate,
        (false, false) => StoreMode::ReadOnly,
    };
    let store = Store::open(&database, mode).await?;
    if writable && store.get_metadata("host_identity_v1").await?.is_none() {
        store
            .set_metadata("host_identity_v1", format!("host_{}", Uuid::now_v7()))
            .await?;
    }

    let listener = zimlo_bridge::bind(port, lan).await?;
    let address = listener.local_addr()?;
    let display_ip = if address.ip().is_unspecified() {
        IpAddr::from([127, 0, 0, 1])
    } else {
        address.ip()
    };
    let descriptor = service_state::write_descriptor(&paths, address.port())?;
    println!(
        "Zimlo Rust Runtime 已启动：http://{display_ip}:{}",
        address.port()
    );
    println!(
        "{}加载数据库：{}",
        if writable { "独占写入" } else { "只读" },
        database.display()
    );

    let runtime_result: Result<(), Box<dyn Error>> = async {
        if writable {
            let pairing_base_url =
                lan_address()
                    .filter(|_| lan)
                    .map(|lan_address| match lan_address {
                        IpAddr::V4(address_ip) => format!("http://{address_ip}:{}", address.port()),
                        IpAddr::V6(address_ip) => {
                            format!("http://[{address_ip}]:{}", address.port())
                        }
                    });
            if pairing_base_url.is_none() {
                println!("本地配对未启用；使用 --lan 并确保可识别局域网地址。");
            }
            let cloud = zimlo_bridge::CloudService::new(store.clone()).ok();
            let push = cloud
                .clone()
                .map(|cloud| zimlo_bridge::PushService::new(store.clone(), cloud));
            let broker = zimlo_bridge::ActionBroker::with_push(store.clone(), push.clone());
            let runner = zimlo_bridge::TaskCommandRunner::new(
                store.clone(),
                zimlo_bridge::NativeTaskExecutor::new(store.clone(), broker.clone()),
            );
            let (stop, bridge_stop) = watch::channel(false);
            let runner_stop = stop.subscribe();
            let local_stop = stop.subscribe();
            let discovery_stop = stop.subscribe();
            let socket_path = paths.socket.clone();
            let local_store = store.clone();
            let local_broker = broker.clone();
            let local_control = tokio::spawn(async move {
                zimlo_bridge::run_local_control_until_shutdown(
                    &socket_path,
                    local_store,
                    local_broker,
                    push,
                    local_stop,
                )
                .await
            });
            let discovery = zimlo_bridge::DiscoveryService::new(store.clone())?;
            let discovery = tokio::spawn(async move {
                discovery.run_until_shutdown(discovery_stop).await;
            });
            let relay = cloud
                .clone()
                .filter(zimlo_bridge::CloudService::enabled)
                .map(|cloud| {
                    let relay_stop = stop.subscribe();
                    tokio::spawn(async move {
                        zimlo_bridge::CloudRelay::new(cloud, address.port())
                            .run_until_shutdown(relay_stop)
                            .await;
                    })
                });
            let signal_stop = stop.clone();
            let signal = tokio::spawn(async move {
                shutdown_signal().await;
                let _ = signal_stop.send(true);
            });
            let runner =
                tokio::spawn(
                    async move { runner.run_until_shutdown(wait_for_stop(runner_stop)).await },
                );
            let bridge = zimlo_bridge::serve_runtime_with_broker(
                listener,
                store.clone(),
                zimlo_bridge::BridgeConfig {
                    host_name: host_name(),
                    writable: true,
                    pairing_base_url,
                    web_root: web_root(),
                    cloud,
                },
                broker.clone(),
                wait_for_stop(bridge_stop),
            )
            .await;
            let _ = stop.send(true);
            signal.abort();
            let runner = runner.await.map_err(std::io::Error::other)?;
            bridge?;
            runner?;
            local_control.await.map_err(std::io::Error::other)??;
            discovery.await.map_err(std::io::Error::other)?;
            if let Some(relay) = relay {
                let _ = relay.await;
            }
            broker.cancel_all().await?;
        } else {
            zimlo_bridge::serve_with_store(listener, store, host_name(), shutdown_signal()).await?;
        }
        Ok(())
    }
    .await;
    let _ = service_state::clear_descriptor(&paths, descriptor.pid);
    runtime_result
}

async fn status(machine_readable: bool) -> Result<(), Box<dyn Error>> {
    let paths = ZimloPaths::discover()?;
    let descriptor = service_state::descriptor(&paths);
    let owner = service_state::owner(&paths);
    let pid_alive = descriptor
        .as_ref()
        .is_some_and(|descriptor| service_state::process_alive(descriptor.pid));
    let ownership = match (&descriptor, &owner, pid_alive) {
        (None, _, _) => "not_running",
        (Some(_), _, false) => "stale",
        (Some(descriptor), Some(owner), true) if descriptor.pid == owner.pid => "verified",
        _ => "unverifiable",
    };
    let port = descriptor
        .as_ref()
        .map_or(4747, |descriptor| descriptor.port);
    let health = if pid_alive {
        match reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1_500))
            .build()?
            .get(format!("http://127.0.0.1:{port}/healthz"))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                response.json::<serde_json::Value>().await.ok()
            }
            _ => None,
        }
    } else {
        None
    };
    let port_reachable = tokio::time::timeout(
        std::time::Duration::from_millis(400),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|result| result.is_ok());
    let socket_protocol_version = mcp::bridge_protocol_version(&paths.socket)
        .await
        .ok()
        .flatten();
    let socket_reachable = socket_protocol_version.is_some();
    let value = json!({
        "descriptor": descriptor,
        "manualStop": paths.manual_stop.exists(),
        "pidAlive": pid_alive,
        "ownership": ownership,
        "port": port,
        "portReachable": port_reachable,
        "health": health,
        "socketExists": paths.socket.exists(),
        "socketReachable": socket_reachable,
        "socketProtocolVersion": socket_protocol_version,
        "logPath": descriptor.as_ref().and_then(|descriptor| descriptor.log_path.clone()),
    });
    let operational = ownership == "verified"
        && pid_alive
        && value["health"]["ok"] == true
        && value["health"]["protocolVersion"] == zimlo_protocol::ZIMLO_PROTOCOL_VERSION;
    if machine_readable {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else if operational {
        println!(
            "✓ Zimlo Bridge 正在运行（PID {}，端口 {}，Rust Runtime，协议 v{}）",
            value["descriptor"]["pid"],
            value["descriptor"]["port"],
            value["health"]["protocolVersion"]
        );
    } else {
        println!("! Zimlo Bridge 未正常运行（{ownership}）");
    }
    if !operational {
        return Err("Bridge service is not operational".into());
    }
    Ok(())
}

async fn stop() -> Result<(), Box<dyn Error>> {
    let paths = ZimloPaths::discover()?;
    match service_state::stop(&paths).await? {
        Some(pid) => println!("已停止 Zimlo Bridge（PID {pid}）。"),
        None => println!("Zimlo Bridge 未在运行。已记录手动停止标记。"),
    }
    Ok(())
}

async fn service(command: ServiceCommand) -> Result<(), Box<dyn Error>> {
    match command {
        ServiceCommand::Install => {
            service_install::ensure_supported()?;
            let paths = ZimloPaths::discover()?;
            if service_state::descriptor(&paths)
                .is_some_and(|descriptor| service_state::process_alive(descriptor.pid))
            {
                service_state::stop(&paths).await?;
            }
            let path = service_install::install().await?;
            wait_for_installed_service().await?;
            println!(
                "Zimlo 已作为 systemd user service 安装并启动：{}",
                path.display()
            );
        }
        ServiceCommand::Status => service_install::status().await?,
        ServiceCommand::Uninstall => {
            let path = service_install::uninstall().await?;
            println!("Zimlo systemd user service 已移除：{}", path.display());
        }
    }
    Ok(())
}

async fn wait_for_installed_service() -> Result<(), Box<dyn Error>> {
    for _ in 0..40 {
        if let Some(health) = fetch_health(4747).await
            && health["ok"] == true
            && health["protocolVersion"] == zimlo_protocol::ZIMLO_PROTOCOL_VERSION
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(
        "systemd service 已启动，但 Zimlo Bridge 未在 10 秒内就绪。请运行 zimlo logs 查看日志。"
            .into(),
    )
}

fn logs(follow: bool, desktop: bool) -> Result<(), Box<dyn Error>> {
    if !desktop && service_install::is_installed() {
        let mut command = ProcessCommand::new("journalctl");
        command.args(["--user-unit=zimlo.service", "-n", "200", "--no-pager"]);
        if follow {
            command.arg("-f");
        }
        let status = command.status()?;
        if !status.success() {
            return Err("读取 Zimlo systemd journal 失败。".into());
        }
        return Ok(());
    }
    let paths = ZimloPaths::discover()?;
    let path = if desktop {
        dirs::home_dir().map(|home| home.join("Library/Logs/Zimlo/service.log"))
    } else {
        service_state::descriptor(&paths)
            .and_then(|descriptor| descriptor.log_path.map(PathBuf::from))
            .filter(|path| path.is_file())
            .or_else(|| latest_log_file(&paths.logs))
    };
    let Some(path) = path.filter(|path| path.is_file()) else {
        if desktop {
            println!("暂无 macOS 应用日志。");
        } else {
            println!("暂无日志文件（{}）。", paths.logs.display());
        }
        return Ok(());
    };
    eprintln!("# {}", path.display());
    let mut command = ProcessCommand::new("tail");
    command.args(["-n", "200"]);
    if follow {
        command.arg("-f");
    }
    let status = command.arg(&path).status()?;
    if !status.success() {
        return Err(format!("读取日志失败：{}", path.display()).into());
    }
    Ok(())
}

fn latest_log_file(directory: &Path) -> Option<PathBuf> {
    fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata
                .is_file()
                .then(|| (metadata.modified().ok(), entry.path()))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

async fn doctor() -> Result<(), Box<dyn Error>> {
    let paths = ZimloPaths::discover()?;
    let executable = std::env::current_exe()?;
    let mut blocking_failure = false;
    let supported_os = matches!(std::env::consts::OS, "macos" | "linux");
    print_doctor_check(
        supported_os,
        "操作系统",
        std::env::consts::OS,
        Some("当前仅支持 macOS 与 Linux。"),
    );
    blocking_failure |= !supported_os;
    let executable_ready = executable.is_file();
    print_doctor_check(
        executable_ready,
        "Rust Runtime",
        &format!("v{} · {}", ZIMLO_VERSION, executable.display()),
        Some("重新安装 Zimlo Runtime。"),
    );
    blocking_failure |= !executable_ready;

    let root_ready = service_state::secure_directory(&paths.root)
        .and_then(|_| service_state::secure_directory(&paths.logs));
    match root_ready {
        Ok(()) => print_doctor_check(true, "~/.zimlo", &paths.root.display().to_string(), None),
        Err(error) => {
            print_doctor_check(
                false,
                "~/.zimlo",
                &error.to_string(),
                Some("检查目录所有权和读写权限。"),
            );
            blocking_failure = true;
        }
    }

    let descriptor = service_state::descriptor(&paths);
    let bridge_ok = if let Some(descriptor) = descriptor.as_ref()
        && service_state::process_alive(descriptor.pid)
    {
        fetch_health(descriptor.port).await.is_some_and(|health| {
            health["ok"] == true
                && health["protocolVersion"] == zimlo_protocol::ZIMLO_PROTOCOL_VERSION
        })
    } else {
        false
    };
    let bridge_detail = descriptor.as_ref().map_or_else(
        || "未运行".to_owned(),
        |descriptor| {
            format!(
                "{}（PID {}，端口 {}，协议 v{}）",
                if bridge_ok { "运行中" } else { "不可用" },
                descriptor.pid,
                descriptor.port,
                descriptor.protocol_version
            )
        },
    );
    print_doctor_check(
        bridge_ok,
        "Bridge 服务",
        &bridge_detail,
        Some("运行 zimlo status；必要时执行 zimlo stop && zimlo start。"),
    );
    blocking_failure |= !bridge_ok;

    for status in integration::statuses(&executable).await {
        let ready = matches!(status["state"].as_str(), Some("ready" | "shared"));
        print_doctor_check(
            ready,
            status["label"].as_str().unwrap_or("Agent 集成"),
            status["detail"].as_str().unwrap_or("状态不可用"),
            (!ready).then_some("运行 zimlo integrations install。"),
        );
    }

    if std::env::var("ZIMLO_CLOUD_DISABLED").ok().as_deref() == Some("1") {
        print_doctor_check(true, "云同步", "已禁用（ZIMLO_CLOUD_DISABLED=1）", None);
    } else {
        let base = std::env::var("ZIMLO_CLOUD_URL")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| zimlo_bridge::DEFAULT_CLOUD_URL.into());
        let reachable = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()?
            .get(format!("{base}/healthz"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success());
        print_doctor_check(
            reachable,
            "云同步",
            if reachable {
                "已连接"
            } else {
                "无法连接（不影响本地功能）"
            },
            (!reachable).then_some("检查网络，或设置 ZIMLO_CLOUD_DISABLED=1。"),
        );
    }

    if blocking_failure {
        Err("doctor found a blocking failure".into())
    } else {
        Ok(())
    }
}

fn print_doctor_check(ok: bool, name: &str, detail: &str, fix: Option<&str>) {
    println!("{} {:<18} {}", if ok { "✓" } else { "!" }, name, detail);
    if !ok && let Some(fix) = fix {
        println!("  → 修复: {fix}");
    }
}

async fn devices(command: DevicesCommand) -> Result<(), Box<dyn Error>> {
    let paths = ZimloPaths::discover()?;
    match command {
        DevicesCommand::List => {
            if !paths.database.is_file() {
                println!("暂无已配对设备。运行 zimlo pair 生成手机配对码。");
                return Ok(());
            }
            let store = Store::open(&paths.database, StoreMode::ReadOnly).await?;
            print_devices(&store.list_devices().await?);
        }
        DevicesCommand::Revoke { device_id } => {
            if let Some(descriptor) = service_state::descriptor(&paths)
                && service_state::process_alive(descriptor.pid)
            {
                revoke_running_device(descriptor.port, &device_id).await?;
                println!("已撤销设备 {device_id}。");
                return Ok(());
            }
            if !paths.database.is_file() {
                return Err(format!(
                    "找不到设备 {device_id}。先运行 zimlo devices list 查看已配对设备。"
                )
                .into());
            }
            let store = Store::open(&paths.database, StoreMode::ReadWriteExisting).await?;
            let device = store
                .list_devices()
                .await?
                .into_iter()
                .find(|device| device.id == device_id)
                .ok_or_else(|| {
                    format!("找不到设备 {device_id}。先运行 zimlo devices list 查看已配对设备。")
                })?;
            if device.is_local_admin {
                return Err("本机管理设备不能撤销；它只可通过 loopback 获取。".into());
            }
            if device.revoked_at.is_some()
                || !store
                    .revoke_device(&device_id, chrono::Utc::now().to_rfc3339())
                    .await?
            {
                return Err("设备已经撤销。".into());
            }
            let cloud = zimlo_bridge::CloudService::new(store)?;
            cloud.revoke_device(&device_id).await?;
            println!("已撤销 {} ({})。", device.name, device.id);
        }
    }
    Ok(())
}

fn print_devices(devices: &[zimlo_store::DeviceRecord]) {
    let paired = devices
        .iter()
        .filter(|device| !device.is_local_admin)
        .collect::<Vec<_>>();
    if paired.is_empty() {
        println!("暂无已配对设备。运行 zimlo pair 生成手机配对码。");
        return;
    }
    println!("{:<10}{:<38}{:<20}最近活跃", "状态", "ID", "名称");
    for device in paired {
        println!(
            "{:<10}{:<38}{:<20}{}",
            if device.revoked_at.is_some() {
                "revoked"
            } else {
                "active"
            },
            device.id,
            device.name,
            device.last_seen_at
        );
    }
}

async fn pair(machine_readable: bool) -> Result<(), Box<dyn Error>> {
    let paths = ZimloPaths::discover()?;
    mcp::ensure_bridge_running(&paths)
        .await
        .map_err(std::io::Error::other)?;
    let descriptor = service_state::descriptor(&paths)
        .ok_or("Zimlo Bridge 已启动但缺少服务描述文件，请运行 zimlo status 检查。")?;
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(65))
        .build()?
        .post(format!(
            "http://127.0.0.1:{}/api/local/pairing",
            descriptor.port
        ))
        .send()
        .await?;
    let status = response.status();
    let payload: serde_json::Value = response.json().await?;
    if !status.is_success() {
        return Err(payload["message"]
            .as_str()
            .unwrap_or("无法创建配对码，请运行 zimlo doctor 检查 Runtime 和云连接。")
            .to_owned()
            .into());
    }
    if machine_readable {
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    let pair_url = payload["pairUrl"]
        .as_str()
        .ok_or("Bridge 返回的配对码格式无效。")?;
    let qr = QrCode::new(pair_url.as_bytes())?
        .render::<unicode::Dense1x2>()
        .build();
    println!("用 iPhone 上的 Zimlo 扫描下面的二维码（2 分钟内有效）：\n");
    println!("{qr}\n");
    println!("也可以复制这个连接码：\n{pair_url}");
    Ok(())
}

async fn revoke_running_device(port: u16, device_id: &str) -> Result<(), Box<dyn Error>> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?
        .post(format!("http://127.0.0.1:{port}/api/local/commands"))
        .json(&json!({ "type": "device.revoke", "deviceId": device_id }))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(format!("撤销设备失败：HTTP {}", response.status()).into());
    }
    let value: serde_json::Value = response.json().await?;
    if let Some(error) = value["messages"]
        .as_array()
        .and_then(|messages| messages.iter().find(|message| message["type"] == "error"))
    {
        return Err(error["message"]
            .as_str()
            .unwrap_or("撤销设备失败。")
            .to_owned()
            .into());
    }
    Ok(())
}

async fn open_management() -> Result<(), Box<dyn Error>> {
    let paths = ZimloPaths::discover()?;
    let descriptor = service_state::descriptor(&paths)
        .ok_or("Zimlo 未在运行，请先 zimlo start 启动（zimlo status 可查看状态）。")?;
    let health = fetch_health(descriptor.port)
        .await
        .ok_or("Zimlo Bridge 未在运行或端口被其他程序占用，请运行 zimlo status 查看。")?;
    if health["ok"] != true || health["protocolVersion"] != zimlo_protocol::ZIMLO_PROTOCOL_VERSION {
        return Err(format!(
            "Zimlo Bridge 协议版本不匹配（v{}，期望 v{}）。请运行 zimlo stop && zimlo start。",
            health["protocolVersion"],
            zimlo_protocol::ZIMLO_PROTOCOL_VERSION
        )
        .into());
    }
    let url = format!("http://127.0.0.1:{}", descriptor.port);
    if cfg!(target_os = "linux")
        && std::env::var_os("DISPLAY").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_none()
    {
        println!("Zimlo 管理页：{url}");
        println!(
            "这是无界面服务器。需要本机管理页时，请通过 SSH 转发端口 {}。",
            descriptor.port
        );
        return Ok(());
    }
    let opener = if cfg!(target_os = "macos") {
        "/usr/bin/open"
    } else {
        "xdg-open"
    };
    let status = match ProcessCommand::new(opener).arg(&url).status() {
        Ok(status) => status,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            println!("Zimlo 管理页：{url}");
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    if !status.success() {
        return Err(format!("无法打开 {url}").into());
    }
    Ok(())
}

async fn fetch_health(port: u16) -> Option<serde_json::Value> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1_500))
        .build()
        .ok()?
        .get(format!("http://127.0.0.1:{port}/healthz"))
        .send()
        .await
        .ok()?;
    response.status().is_success().then_some(())?;
    response.json().await.ok()
}

async fn wait_for_stop(mut receiver: watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    let _ = receiver.changed().await;
}

fn lan_address() -> Option<IpAddr> {
    if let Ok(value) = std::env::var("ZIMLO_LAN_HOST")
        && let Ok(address) = value.parse::<IpAddr>()
        && trusted_lan_address(address)
    {
        return Some(address);
    }
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    trusted_lan_address(address).then_some(address)
}

fn trusted_lan_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_private() && !address.is_loopback(),
        IpAddr::V6(address) => address.segments()[0] & 0xfe00 == 0xfc00,
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
        match terminate {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn host_name() -> String {
    std::env::var("ZIMLO_HOST_NAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|value| value.trim().chars().take(120).collect::<String>())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| match std::env::consts::OS {
            "macos" => "Mac".into(),
            "linux" => "Linux Server".into(),
            _ => "Zimlo Host".into(),
        })
}

fn web_root() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("ZIMLO_WEB_ROOT").map(PathBuf::from) {
        return path.join("index.html").is_file().then_some(path);
    }
    let current = std::env::current_dir().ok()?.join("public");
    if current.join("index.html").is_file() {
        return Some(current);
    }
    let executable = std::env::current_exe().ok()?;
    let prefix = executable.parent()?.parent()?;
    [
        prefix.join("Resources/public"),
        prefix.join("share/zimlo/public"),
    ]
    .into_iter()
    .find(|candidate| candidate.join("index.html").is_file())
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory as _, Parser as _};

    use super::{Cli, CodexPluginCommand, Command, DevicesCommand, ServiceCommand};

    #[test]
    fn clap_contract_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn start_defaults_to_the_product_port_and_native_write_mode() {
        let cli = Cli::try_parse_from(["zimlo", "start"]).expect("CLI parses");
        assert!(matches!(
            cli.command,
            Command::Start {
                lan: false,
                port: 4747,
                database: None,
                write: false,
                read_only: false,
            }
        ));
    }

    #[test]
    fn explicit_database_remains_read_only_without_write() {
        let cli = Cli::try_parse_from(["zimlo", "start", "--database", "/tmp/zimlo.db"])
            .expect("CLI parses");
        assert!(matches!(
            cli.command,
            Command::Start {
                database: Some(path),
                write: false,
                ..
            } if path == std::path::Path::new("/tmp/zimlo.db")
        ));
    }

    #[test]
    fn write_mode_requires_an_explicit_database() {
        assert!(Cli::try_parse_from(["zimlo", "start", "--write"]).is_err());
        assert!(
            Cli::try_parse_from(["zimlo", "start", "--database", "/tmp/zimlo.db", "--write",])
                .is_ok()
        );
    }

    #[test]
    fn exposes_status_and_stop_for_desktop_service_management() {
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "status", "--json"])
                .expect("status")
                .command,
            Command::Status { json: true }
        ));
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "stop"])
                .expect("stop")
                .command,
            Command::Stop
        ));
    }

    #[test]
    fn exposes_the_node_operator_command_surface() {
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "logs", "--follow"])
                .expect("logs")
                .command,
            Command::Logs {
                follow: true,
                desktop: false,
                ..
            }
        ));
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "doctor"])
                .expect("doctor")
                .command,
            Command::Doctor
        ));
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "devices", "revoke", "mobile-1"])
                .expect("devices revoke")
                .command,
            Command::Devices {
                command: DevicesCommand::Revoke { device_id }
            } if device_id == "mobile-1"
        ));
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "open"])
                .expect("open")
                .command,
            Command::Open
        ));
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "pair", "--json"])
                .expect("pair")
                .command,
            Command::Pair { json: true }
        ));
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "service", "install"])
                .expect("service install")
                .command,
            Command::Service {
                command: ServiceCommand::Install
            }
        ));
        assert!(matches!(
            Cli::try_parse_from(["zimlo", "codex-plugin", "uninstall"])
                .expect("plugin uninstall")
                .command,
            Command::CodexPlugin {
                command: CodexPluginCommand::Uninstall
            }
        ));
    }
}
