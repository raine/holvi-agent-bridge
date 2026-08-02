use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

use super::LocalRequest;
use crate::filesystem::{has_mode_0600, is_owned_by_current_user, is_socket};
use crate::protocol::{MAX_SOCKET_REQUEST_BYTES, now_millis, verify_request};

const SOCKET_REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(2);

pub struct LocalSocket {
    listener: UnixListener,
    guard: SocketGuard,
}

struct SocketGuard {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            if is_socket(&metadata) && metadata.dev() == self.device && metadata.ino() == self.inode
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

impl LocalSocket {
    pub async fn bind(target: &Path) -> Result<Self> {
        prepare(target).await?;
        let listener = UnixListener::bind(target)
            .with_context(|| format!("Unable to bind local bridge socket: {}", target.display()))?;
        fs::set_permissions(target, fs::Permissions::from_mode(0o600))?;
        let metadata = fs::symlink_metadata(target)?;
        ensure!(
            is_socket(&metadata) && is_owned_by_current_user(&metadata) && has_mode_0600(&metadata),
            "Local bridge socket does not have the required ownership and 0600 permissions: {}",
            target.display()
        );
        let guard = SocketGuard {
            path: target.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        Ok(Self { listener, guard })
    }

    pub async fn accept(
        self,
        secret: String,
        sender: mpsc::Sender<LocalRequest>,
        mut shutdown: oneshot::Receiver<()>,
    ) -> Result<()> {
        let Self { listener, guard } = self;
        let _guard = guard;
        let seen_nonces = Arc::new(Mutex::new(HashMap::new()));
        let mut connections = JoinSet::new();

        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = accepted.context("Unable to accept a local bridge connection.")?;
                    let secret = secret.clone();
                    let seen_nonces = Arc::clone(&seen_nonces);
                    let sender = sender.clone();
                    connections.spawn(async move {
                        if let Err(error) = handle(stream, &secret, &seen_nonces, &sender).await {
                            eprintln!("[holvi-agent-bridge] {error}");
                        }
                    });
                }
                completed = connections.join_next(), if !connections.is_empty() => {
                    if let Some(Err(error)) = completed {
                        return Err(error).context("Local bridge connection task failed.");
                    }
                }
                _ = &mut shutdown => break,
            }
        }

        drop(listener);
        drop(sender);
        let deadline = tokio::time::sleep(Duration::from_secs(1));
        tokio::pin!(deadline);
        while !connections.is_empty() {
            tokio::select! {
                completed = connections.join_next() => {
                    if let Some(Err(error)) = completed {
                        return Err(error).context("Local bridge connection task failed.");
                    }
                }
                _ = &mut deadline => {
                    connections.abort_all();
                    while let Some(result) = connections.join_next().await {
                        if let Err(error) = result {
                            if !error.is_cancelled() {
                                return Err(error).context("Local bridge connection task failed.");
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

async fn prepare(target: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        is_socket(&metadata),
        "Refused to replace a non-socket path: {}",
        target.display()
    );
    ensure!(
        is_owned_by_current_user(&metadata),
        "Refused to replace a socket owned by another user: {}",
        target.display()
    );
    ensure!(
        has_mode_0600(&metadata),
        "Refused to replace a socket without 0600 permissions: {}",
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

async fn handle(
    mut stream: UnixStream,
    secret: &str,
    seen_nonces: &Mutex<HashMap<String, u64>>,
    sender: &mpsc::Sender<LocalRequest>,
) -> Result<()> {
    let request_value = match read_request(&mut stream).await {
        Ok(value) => value,
        Err(error) => {
            send_response(
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
            send_response(
                &mut stream,
                json!({"ok": false, "error": error.to_string()}),
            )
            .await?;
            return Ok(());
        }
    };
    let (reply, response) = oneshot::channel();
    sender
        .send(LocalRequest { request, reply })
        .await
        .context("Native host request loop closed.")?;
    let response = response.await.unwrap_or_else(
        |_| json!({"ok": false, "error": "The Chrome connection to Holvi Agent Bridge closed."}),
    );
    send_response(&mut stream, response).await
}

async fn read_request(stream: &mut UnixStream) -> Result<Value> {
    read_request_with_timeout(stream, SOCKET_REQUEST_READ_TIMEOUT).await
}

async fn read_request_with_timeout(stream: &mut UnixStream, timeout: Duration) -> Result<Value> {
    tokio::time::timeout(timeout, read_request_body(stream))
        .await
        .map_err(|_| anyhow::anyhow!("Local bridge request timed out."))?
}

async fn read_request_body(stream: &mut UnixStream) -> Result<Value> {
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

async fn send_response(stream: &mut UnixStream, response: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    stream.shutdown().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn times_out_incomplete_socket_requests() {
        let (mut server, mut client) = UnixStream::pair().unwrap();
        client.write_all(b"{\"version\":1").await.unwrap();

        let error = read_request_with_timeout(&mut server, Duration::from_millis(20))
            .await
            .unwrap_err();

        assert_eq!(error.to_string(), "Local bridge request timed out.");
    }

    #[tokio::test]
    async fn binds_private_socket_and_removes_it_on_drop() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("bridge.sock");
        let socket = LocalSocket::bind(&path).await.unwrap();

        assert_eq!(
            fs::symlink_metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(socket);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn shutdown_stops_accepting_and_removes_the_socket() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("bridge.sock");
        let socket = LocalSocket::bind(&path).await.unwrap();
        let (sender, _requests) = mpsc::channel(1);
        let (shutdown, shutdown_rx) = oneshot::channel();
        let acceptor = tokio::spawn(socket.accept("a".repeat(64), sender, shutdown_rx));

        shutdown.send(()).unwrap();
        acceptor.await.unwrap().unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn refuses_to_replace_sockets_without_mode_0600() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("bridge.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();

        let error = match LocalSocket::bind(&path).await {
            Ok(_) => panic!("permissive socket was replaced"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("without 0600 permissions"));
        assert!(path.exists());
    }

    #[tokio::test]
    async fn refuses_to_replace_regular_files() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("bridge.sock");
        fs::write(&path, b"keep").unwrap();

        let error = match LocalSocket::bind(&path).await {
            Ok(_) => panic!("regular file was replaced"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("non-socket path"));
        assert_eq!(fs::read(&path).unwrap(), b"keep");
    }
}
