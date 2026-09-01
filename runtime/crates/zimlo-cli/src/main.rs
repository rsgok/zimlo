use std::{error::Error, net::IpAddr, path::PathBuf};

use clap::{Parser, Subcommand};
use tokio::sync::watch;
use zimlo_protocol::ZIMLO_VERSION;
use zimlo_store::{Store, StoreMode};

#[derive(Debug, Parser)]
#[command(
    name = "zimlo",
    about = "Rust foundation for the Zimlo Bridge Runtime",
    version = ZIMLO_VERSION
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the Rust Bridge; database access is read-only unless --write is explicit.
    Start {
        /// Listen on trusted LAN addresses instead of loopback only.
        #[arg(long)]
        lan: bool,
        /// HTTP port. Use 0 in tests to request an ephemeral port.
        #[arg(long, default_value_t = 4747)]
        port: u16,
        /// Open an existing Node-compatible SQLite database.
        #[arg(long, value_name = "PATH")]
        database: Option<PathBuf>,
        /// Explicitly take exclusive SQLite write ownership of an existing database.
        #[arg(long, requires = "database")]
        write: bool,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    match Cli::parse().command {
        Command::Start {
            lan,
            port,
            database,
            write,
        } => start(lan, port, database, write).await,
    }
}

async fn start(
    lan: bool,
    port: u16,
    database: Option<PathBuf>,
    write: bool,
) -> Result<(), Box<dyn Error>> {
    let listener = zimlo_bridge::bind(port, lan).await?;
    let address = listener.local_addr()?;
    let display_ip = if address.ip().is_unspecified() {
        IpAddr::from([127, 0, 0, 1])
    } else {
        address.ip()
    };
    println!(
        "Zimlo Rust foundation 已启动：http://{display_ip}:{}",
        address.port()
    );
    if let Some(path) = database {
        let mode = if write {
            StoreMode::ReadWriteExisting
        } else {
            StoreMode::ReadOnly
        };
        let store = Store::open(&path, mode).await?;
        if write {
            println!("独占加载 Node 兼容数据库：{}", path.display());
            let pairing_base_url =
                lan_address()
                    .filter(|_| lan)
                    .map(|lan_address| match lan_address {
                        IpAddr::V4(address_ip) => {
                            format!("http://{address_ip}:{}", address.port())
                        }
                        IpAddr::V6(address_ip) => {
                            format!("http://[{address_ip}]:{}", address.port())
                        }
                    });
            if pairing_base_url.is_none() {
                println!("本地配对未启用；使用 --lan 并确保可识别局域网地址。");
            }
            println!("已启用配对、幂等写命令与 Rust 原生 Codex / Claude 托管任务。");
            let broker = zimlo_bridge::ActionBroker::new(store.clone());
            let runner = zimlo_bridge::TaskCommandRunner::new(
                store.clone(),
                zimlo_bridge::NativeTaskExecutor::new(store.clone(), broker.clone()),
            );
            let (stop, bridge_stop) = watch::channel(false);
            let runner_stop = stop.subscribe();
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
            broker.cancel_all().await?;
        } else {
            println!("只读加载 Node 兼容数据库：{}", path.display());
            println!(
                "当前提供 /healthz、Snapshot、session events 与加密 WebSocket；尚未接管 Node Runtime 写入。"
            );
            zimlo_bridge::serve_with_store(listener, store, host_name(), shutdown_signal()).await?;
        }
    } else {
        println!("当前仅提供 /healthz；使用 --database 可启用只读 session events 查询。");
        zimlo_bridge::serve(listener, shutdown_signal()).await?;
    }
    Ok(())
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
        .unwrap_or_else(|| "Mac".into())
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory as _, Parser as _};

    use super::{Cli, Command};

    #[test]
    fn clap_contract_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn start_defaults_to_the_existing_bridge_port() {
        let cli = Cli::try_parse_from(["zimlo", "start"]).expect("CLI parses");
        assert!(matches!(
            cli.command,
            Command::Start {
                lan: false,
                port: 4747,
                database: None,
                write: false,
            }
        ));
    }

    #[test]
    fn start_accepts_a_read_only_compatibility_database() {
        let cli = Cli::try_parse_from(["zimlo", "start", "--database", "/tmp/zimlo.db"])
            .expect("CLI parses");
        assert!(matches!(
            cli.command,
            Command::Start {
                database: Some(path),
                ..
            } if path == std::path::Path::new("/tmp/zimlo.db")
        ));
    }

    #[test]
    fn write_mode_requires_an_explicit_database() {
        assert!(Cli::try_parse_from(["zimlo", "start", "--write"]).is_err());
        let cli = Cli::try_parse_from(["zimlo", "start", "--database", "/tmp/zimlo.db", "--write"])
            .expect("write mode parses");
        assert!(matches!(cli.command, Command::Start { write: true, .. }));
    }
}
