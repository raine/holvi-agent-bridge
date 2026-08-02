mod capabilities;
mod cli;
mod config;
#[cfg(test)]
mod contract_tests;
mod filesystem;
mod host;
mod install;
mod protocol;
mod receipt_sandbox;
mod skill;

use anyhow::Result;

pub mod bridge {
    pub use crate::config::BridgeConfig;
    pub use crate::protocol::{
        Action, AuditListParams, EmptyParams, NativeMessageDecoder, SignedBridgeRequest,
        encode_native_message, sign_request,
    };
}

pub async fn run(arguments: Vec<String>) -> Result<()> {
    if let Some(origin) = arguments
        .first()
        .filter(|value| value.starts_with("chrome-extension://"))
    {
        return host::run(origin).await;
    }
    if arguments
        .first()
        .is_some_and(|value| value == "native-host")
    {
        let origin = arguments.get(1).map(String::as_str).unwrap_or_default();
        return host::run(origin).await;
    }
    cli::run().await
}
