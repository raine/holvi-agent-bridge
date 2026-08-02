mod dispatch;
mod native_messaging;
mod receipt;
mod runtime;
mod socket;

use anyhow::{Result, ensure};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::config::{EXTENSION_ORIGIN, load_config, socket_path};
use crate::protocol::BridgeRequest;

pub(super) type SocketReply = oneshot::Sender<Value>;

pub(super) struct LocalRequest {
    pub request: BridgeRequest,
    pub reply: SocketReply,
}

pub async fn run(caller_origin: &str) -> Result<()> {
    ensure!(
        caller_origin == EXTENSION_ORIGIN,
        "Native host caller origin is not the configured extension."
    );

    let (config, _) = load_config()?;
    let socket = socket::LocalSocket::bind(&socket_path()).await?;
    runtime::run(config, socket).await
}
