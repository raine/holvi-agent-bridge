use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};

use crate::capabilities::required_capabilities;
use crate::config::{
    BridgeConfig, EXTENSION_ORIGIN, load_config, resolve_receipt_file, socket_path, validate_uuid,
};
use crate::protocol::{
    BridgeRequest, MAX_SOCKET_REQUEST_BYTES, NativeMessageDecoder, encode_native_message,
    now_millis, verify_request,
};

const FILE_CHUNK_BYTES: usize = 480 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

type SocketReply = oneshot::Sender<Value>;

struct LocalRequest {
    request: BridgeRequest,
    reply: SocketReply,
}

struct ActiveRequest {
    id: String,
    reply: SocketReply,
    deadline: Instant,
}

struct SocketGuard {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            if metadata.file_type().is_socket()
                && metadata.dev() == self.device
                && metadata.ino() == self.inode
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

pub async fn run(caller_origin: &str) -> Result<()> {
    ensure!(
        caller_origin == EXTENSION_ORIGIN,
        "Native host caller origin is not the configured extension."
    );
    let (config, _) = load_config()?;
    let target = socket_path();
    prepare_socket(&target).await?;
    let listener = UnixListener::bind(&target)
        .with_context(|| format!("Unable to bind local bridge socket: {}", target.display()))?;
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600))?;
    let metadata = fs::symlink_metadata(&target)?;
    let _socket_guard = SocketGuard {
        path: target.clone(),
        device: metadata.dev(),
        inode: metadata.ino(),
    };

    let (native_tx, native_output) = mpsc::channel::<Value>(8);
    let (native_input, mut native_rx) = mpsc::channel::<Value>(8);
    let writer = tokio::spawn(native_writer(native_output));
    let reader = tokio::spawn(native_reader(native_input));

    let seen_nonces = Arc::new(Mutex::new(HashMap::new()));
    let (local_tx, mut local_rx) = mpsc::channel::<LocalRequest>(8);
    let acceptor = tokio::spawn(accept_connections(
        listener,
        config.hmac_secret.clone(),
        seen_nonces,
        local_tx,
    ));

    native_tx
        .send(json!({"type": "host_ready", "config": config.public()}))
        .await
        .context("Chrome native output closed.")?;

    let mut tab_ready = false;
    let mut active: Option<ActiveRequest> = None;
    let mut timer = tokio::time::interval(Duration::from_millis(100));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;

    loop {
        tokio::select! {
            message = native_rx.recv() => {
                let Some(message) = message else { break };
                handle_native_message(message, &mut tab_ready, &mut active);
            }
            incoming = local_rx.recv() => {
                let Some(incoming) = incoming else { break };
                handle_local_request(incoming, &config, tab_ready, &mut active, &native_tx).await;
            }
            _ = sigterm.recv() => break,
            _ = sigint.recv() => break,
            _ = timer.tick() => {
                if active.as_ref().is_some_and(|item| Instant::now() >= item.deadline) {
                    finish_active(
                        &mut active,
                        json!({
                            "ok": false,
                            "error": "Holvi Agent Bridge timed out. Inspect the transaction before retrying an upload."
                        }),
                    );
                }
            }
        }
    }

    finish_active(
        &mut active,
        json!({"ok": false, "error": "The Chrome connection to Holvi Agent Bridge closed."}),
    );
    acceptor.abort();
    drop(native_tx);
    reader.abort();
    match reader.await {
        Ok(result) => result?,
        Err(error) if error.is_cancelled() => {}
        Err(error) => return Err(error).context("Native input task failed."),
    }
    writer.await.context("Native output task failed.")??;
    Ok(())
}

fn handle_native_message(message: Value, tab_ready: &mut bool, active: &mut Option<ActiveRequest>) {
    match message.get("type").and_then(Value::as_str) {
        Some("tab_ready") => *tab_ready = true,
        Some("tab_unavailable") => *tab_ready = false,
        Some("result") => {
            let Some(id) = message.get("id").and_then(Value::as_str) else {
                return;
            };
            if active.as_ref().is_none_or(|item| item.id != id) {
                return;
            }
            let response = if message.get("ok") == Some(&Value::Bool(true)) {
                json!({"ok": true, "data": message.get("data").cloned().unwrap_or(Value::Null)})
            } else {
                let error = message
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Holvi Agent Bridge request failed.");
                json!({"ok": false, "error": error})
            };
            finish_active(active, response);
        }
        _ => {}
    }
}

async fn handle_local_request(
    incoming: LocalRequest,
    config: &BridgeConfig,
    tab_ready: bool,
    active: &mut Option<ActiveRequest>,
    native_tx: &mpsc::Sender<Value>,
) {
    let request = incoming.request;
    let result = validate_dispatch(&request, config, tab_ready, active.is_some());
    if let Err(error) = result {
        let _ = incoming
            .reply
            .send(json!({"ok": false, "error": error.to_string()}));
        return;
    }

    let id = request.id.clone();
    *active = Some(ActiveRequest {
        id: id.clone(),
        reply: incoming.reply,
        deadline: Instant::now() + REQUEST_TIMEOUT,
    });
    let sent = if request.action == "upload" {
        send_upload(&request, config, native_tx).await
    } else {
        native_tx
            .send(json!({
                "type": "command",
                "id": request.id,
                "action": request.action,
                "params": request.params,
            }))
            .await
            .context("Chrome native output closed.")
    };
    if let Err(error) = sent {
        finish_active(active, json!({"ok": false, "error": error.to_string()}));
    }
}

fn validate_dispatch(
    request: &BridgeRequest,
    config: &BridgeConfig,
    tab_ready: bool,
    active: bool,
) -> Result<()> {
    let requirements = required_capabilities(&request.action)
        .ok_or_else(|| anyhow::anyhow!("Unsupported local bridge action."))?;
    let missing: Vec<_> = requirements
        .iter()
        .filter(|required| {
            !config
                .capabilities
                .iter()
                .any(|enabled| enabled == **required)
        })
        .copied()
        .collect();
    ensure!(
        missing.is_empty(),
        "Action requires disabled capabilities: {}.",
        missing.join(", ")
    );
    ensure!(
        tab_ready,
        "Open or reload the configured signed-in Holvi group tab in Chrome."
    );
    ensure!(!active, "Another Holvi Agent Bridge request is active.");
    if request.action == "upload" {
        ensure!(
            request.params.get("confirmed") == Some(&Value::Bool(true)),
            "Receipt upload requires explicit confirmation."
        );
    }
    Ok(())
}

async fn send_upload(
    request: &BridgeRequest,
    config: &BridgeConfig,
    native_tx: &mpsc::Sender<Value>,
) -> Result<()> {
    let file_path = request
        .params
        .get("filePath")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let debt_uuid = request
        .params
        .get("debtUuid")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_uuid(debt_uuid, "Debt")?;
    let receipt = resolve_receipt_file(config, Path::new(file_path))?;
    let bytes = tokio::fs::read(&receipt.path).await?;
    ensure!(
        bytes.len() as u64 == receipt.size,
        "Receipt size changed while reading the file."
    );
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let chunk_count = bytes.len().div_ceil(FILE_CHUNK_BYTES);
    native_tx
        .send(json!({
            "type": "upload_start",
            "id": request.id,
            "debtUuid": debt_uuid,
            "fileName": receipt.file_name,
            "mimeType": receipt.mime_type,
            "size": bytes.len(),
            "sha256": sha256,
            "chunkCount": chunk_count,
        }))
        .await
        .context("Chrome native output closed.")?;
    for (index, chunk) in bytes.chunks(FILE_CHUNK_BYTES).enumerate() {
        native_tx
            .send(json!({
                "type": "upload_chunk",
                "id": request.id,
                "index": index,
                "data": base64::engine::general_purpose::STANDARD.encode(chunk),
            }))
            .await
            .context("Chrome native output closed.")?;
    }
    native_tx
        .send(json!({"type": "upload_end", "id": request.id}))
        .await
        .context("Chrome native output closed.")?;
    Ok(())
}

fn finish_active(active: &mut Option<ActiveRequest>, response: Value) {
    if let Some(item) = active.take() {
        let _ = item.reply.send(response);
    }
}

async fn prepare_socket(target: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        metadata.file_type().is_socket(),
        "Refused to replace a non-socket path: {}",
        target.display()
    );
    // SAFETY: getuid has no preconditions and cannot fail.
    ensure!(
        metadata.uid() == unsafe { libc::getuid() },
        "Refused to replace a socket owned by another user: {}",
        target.display()
    );
    if tokio::time::timeout(Duration::from_millis(300), UnixStream::connect(target))
        .await
        .is_ok_and(|result| result.is_ok())
    {
        bail!("Another Holvi Agent Bridge native host is active.");
    }
    fs::remove_file(target)?;
    Ok(())
}

async fn accept_connections(
    listener: UnixListener,
    secret: String,
    seen_nonces: Arc<Mutex<HashMap<String, u64>>>,
    local_tx: mpsc::Sender<LocalRequest>,
) -> Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let secret = secret.clone();
        let seen_nonces = Arc::clone(&seen_nonces);
        let local_tx = local_tx.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_socket(stream, &secret, &seen_nonces, &local_tx).await {
                eprintln!("[holvi-agent-bridge] {error}");
            }
        });
    }
}

async fn handle_socket(
    mut stream: UnixStream,
    secret: &str,
    seen_nonces: &Mutex<HashMap<String, u64>>,
    local_tx: &mpsc::Sender<LocalRequest>,
) -> Result<()> {
    let request_value = match read_socket_request(&mut stream).await {
        Ok(value) => value,
        Err(error) => {
            send_socket(
                &mut stream,
                json!({"ok": false, "error": error.to_string()}),
            )
            .await?;
            return Ok(());
        }
    };
    let verified = {
        let mut seen = seen_nonces.lock().expect("nonce mutex poisoned");
        verify_request(secret, request_value, &mut seen, now_millis())
    };
    let request = match verified {
        Ok(request) => request,
        Err(error) => {
            send_socket(
                &mut stream,
                json!({"ok": false, "error": error.to_string()}),
            )
            .await?;
            return Ok(());
        }
    };
    let (reply, response) = oneshot::channel();
    local_tx
        .send(LocalRequest { request, reply })
        .await
        .context("Native host request loop closed.")?;
    let response = response.await.unwrap_or_else(
        |_| json!({"ok": false, "error": "The Chrome connection to Holvi Agent Bridge closed."}),
    );
    send_socket(&mut stream, response).await
}

async fn read_socket_request(stream: &mut UnixStream) -> Result<Value> {
    let mut input = Vec::new();
    loop {
        let mut chunk = [0_u8; 8192];
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            bail!("Local bridge request ended before a newline.");
        }
        input.extend_from_slice(&chunk[..count]);
        ensure!(
            input.len() <= MAX_SOCKET_REQUEST_BYTES,
            "Local bridge request is too large."
        );
        if let Some(newline) = input.iter().position(|byte| *byte == b'\n') {
            return serde_json::from_slice(&input[..newline])
                .context("Local bridge request is not valid JSON.");
        }
    }
}

async fn send_socket(stream: &mut UnixStream, response: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn native_reader(sender: mpsc::Sender<Value>) -> Result<()> {
    let mut stdin = tokio::io::stdin();
    let mut decoder = NativeMessageDecoder::default();
    loop {
        let mut chunk = [0_u8; 64 * 1024];
        let count = stdin.read(&mut chunk).await?;
        if count == 0 {
            decoder.finish()?;
            return Ok(());
        }
        for message in decoder.push(&chunk[..count])? {
            if sender.send(message).await.is_err() {
                return Ok(());
            }
        }
    }
}

async fn native_writer(mut receiver: mpsc::Receiver<Value>) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    while let Some(message) = receiver.recv().await {
        stdout.write_all(&encode_native_message(&message)?).await?;
        stdout.flush().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_dispatch_requires_confirmation() {
        let config = BridgeConfig {
            version: 2,
            group_path_segment: "AbC123+example".into(),
            pool_handle: "AbC123".into(),
            payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
            capabilities: vec!["transactions.read".into(), "attachments.write".into()],
            receipt_roots: vec![PathBuf::from("/tmp")],
            max_file_bytes: 1024,
            hmac_secret: "a".repeat(64),
        };
        let request = BridgeRequest {
            version: 1,
            id: "11111111-1111-4111-8111-111111111111".into(),
            issued_at: 0,
            nonce: "a".repeat(32),
            action: "upload".into(),
            params: json!({}),
        };
        assert!(validate_dispatch(&request, &config, true, false).is_err());
    }
}
