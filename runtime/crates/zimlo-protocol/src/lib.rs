mod contract_generated;

pub mod crypto;
pub mod policy;

pub use contract_generated::{ZIMLO_PROTOCOL_VERSION, ZIMLO_VERSION};

pub fn host_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        "windows" => "windows",
        _ => "unknown",
    }
}
