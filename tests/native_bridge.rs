#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use holvi_agent_bridge::bridge::{
    Action, AuditListParams, BridgeConfig, EmptyParams, NativeMessageDecoder, SignedBridgeRequest,
    encode_native_message, sign_request,
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;
use tempfile::TempDir;

const SECRET: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORIGIN: &str = "chrome-extension://oeedcemphbobfehfmcllmjhhhjgahgeb/";
const CLOSED_ERROR: &str = "The Chrome connection to Holvi Agent Bridge closed.";

struct HostProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    socket_path: PathBuf,
    _directory: TempDir,
}

impl HostProcess {
    fn spawn() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("config.json");
        let config = BridgeConfig {
            version: 2,
            group_path_segment: "AbC123+example".into(),
            pool_handle: "AbC123".into(),
            payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
            capabilities: vec!["transactions.read".into()],
            receipt_roots: vec![],
            max_file_bytes: 1024,
            hmac_secret: SECRET.into(),
        };
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        fs::set_permissions(&config_path, fs::Permissions::from_mode(0o600)).unwrap();

        let mut child = Command::new(env!("CARGO_BIN_EXE_holvi"))
            .args(["native-host", ORIGIN])
            .env("HOLVI_AGENT_BRIDGE_CONFIG", &config_path)
            .env("TMPDIR", directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let socket_path = directory
            .path()
            .join(format!("holvi-agent-bridge-{}.sock", unsafe {
                libc::geteuid()
            }));
        let mut host = Self {
            child,
            stdin: Some(stdin),
            stdout,
            socket_path,
            _directory: directory,
        };

        let ready = host.read_native();
        assert_eq!(ready["type"], "host_ready");
        assert_eq!(ready["protocolVersion"], 1);
        assert_eq!(ready["hostVersion"], env!("CARGO_PKG_VERSION"));
        host.send_native(&json!({"type": "tab_ready", "tabId": 7}));
        wait_for_path(&host.socket_path);
        assert_eq!(
            fs::symlink_metadata(&host.socket_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        host
    }

    fn send_native(&mut self, message: &Value) {
        let stdin = self.stdin.as_mut().expect("native input is open");
        stdin
            .write_all(&encode_native_message(message).unwrap())
            .unwrap();
        stdin.flush().unwrap();
    }

    fn read_native(&mut self) -> Value {
        let mut header = [0_u8; 4];
        self.stdout.read_exact(&mut header).unwrap();
        let size = u32::from_le_bytes(header) as usize;
        let mut body = vec![0_u8; size];
        self.stdout.read_exact(&mut body).unwrap();

        let mut decoder = NativeMessageDecoder::default();
        assert!(decoder.push(&header[..2]).unwrap().is_empty());
        let mut messages = decoder.push(&header[2..]).unwrap();
        messages.extend(decoder.push(&body).unwrap());
        decoder.finish().unwrap();
        assert_eq!(messages.len(), 1);
        messages.pop().unwrap()
    }

    fn request(&self, request: &SignedBridgeRequest) -> UnixStream {
        self.request_value(&serde_json::to_value(request).unwrap())
    }

    fn request_value(&self, request: &Value) -> UnixStream {
        let mut stream = UnixStream::connect(&self.socket_path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        serde_json::to_writer(&mut stream, request).unwrap();
        stream.write_all(b"\n").unwrap();
        stream
    }

    fn close_input(&mut self) {
        drop(self.stdin.take());
    }

    fn wait_for_exit(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "native host exited with {status}");
                return;
            }
            assert!(Instant::now() < deadline, "native host did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[test]
fn native_bridge_routes_signed_requests_across_real_transports() {
    let mut host = HostProcess::spawn();

    let successful = sign_request(SECRET, Action::Doctor(EmptyParams {})).unwrap();
    let mut success_socket = host.request(&successful);
    let command = host.read_native();
    assert_eq!(
        command,
        json!({
            "type": "command",
            "id": successful.id,
            "action": "doctor",
            "params": {},
        })
    );
    host.send_native(&json!({
        "type": "result",
        "id": successful.id,
        "ok": true,
        "data": {"status": "ready"},
    }));
    assert_eq!(
        read_socket_response(&mut success_socket),
        json!({"ok": true, "data": {"status": "ready"}})
    );

    let malformed = signed_value("audit.list", json!({"limit": 0}), "b".repeat(32));
    assert_eq!(
        read_socket_response(&mut host.request_value(&malformed)),
        json!({"ok": false, "error": "Activity limit must be between 1 and 25."})
    );

    let authenticated = sign_request(SECRET, Action::Doctor(EmptyParams {})).unwrap();
    let mut tampered = serde_json::to_value(authenticated).unwrap();
    tampered["params"] = json!({"unexpected": true});
    assert_eq!(
        read_socket_response(&mut host.request_value(&tampered)),
        json!({
            "ok": false,
            "error": "Local bridge request authentication failed."
        })
    );

    let disabled = sign_request(SECRET, Action::AuditList(AuditListParams { limit: 1 })).unwrap();
    assert_eq!(
        read_socket_response(&mut host.request(&disabled)),
        json!({
            "ok": false,
            "error": "Action requires disabled capabilities: audit.read."
        })
    );

    let replayed = sign_request(SECRET, Action::Doctor(EmptyParams {})).unwrap();
    let mut first_socket = host.request(&replayed);
    assert_eq!(host.read_native()["id"], replayed.id);
    host.send_native(&json!({
        "type": "result",
        "id": replayed.id,
        "ok": true,
        "data": null,
    }));
    assert_eq!(
        read_socket_response(&mut first_socket),
        json!({"ok": true, "data": null})
    );
    assert_eq!(
        read_socket_response(&mut host.request(&replayed)),
        json!({
            "ok": false,
            "error": "Local bridge request nonce was already used."
        })
    );

    let interrupted = sign_request(SECRET, Action::Doctor(EmptyParams {})).unwrap();
    let mut interrupted_socket = host.request(&interrupted);
    assert_eq!(host.read_native()["id"], interrupted.id);
    host.close_input();
    assert_eq!(
        read_socket_response(&mut interrupted_socket),
        json!({"ok": false, "error": CLOSED_ERROR})
    );
    host.wait_for_exit();
    assert!(!host.socket_path.exists());
}

#[test]
fn extension_protocol_rejection_reaches_local_clients() {
    let mut host = HostProcess::spawn();
    host.send_native(&json!({
        "type": "host_rejected",
        "error": "Native host protocol 2 is incompatible with extension protocol 1.",
    }));
    thread::sleep(Duration::from_millis(20));
    let request = sign_request(SECRET, Action::Doctor(EmptyParams {})).unwrap();

    assert_eq!(
        read_socket_response(&mut host.request(&request)),
        json!({
            "ok": false,
            "error": "Native host protocol 2 is incompatible with extension protocol 1."
        })
    );
    host.close_input();
    host.wait_for_exit();
}

#[test]
fn signed_restart_finishes_the_socket_response_and_native_host() {
    let mut host = HostProcess::spawn();
    let restart = sign_request(SECRET, Action::HostRestart(EmptyParams {})).unwrap();
    let mut socket = host.request(&restart);

    assert_eq!(
        read_socket_response(&mut socket),
        json!({"ok": true, "data": {"restarting": true}})
    );
    assert_eq!(host.read_native(), json!({"type": "host_restart"}));
    host.close_input();
    host.wait_for_exit();
    assert!(!host.socket_path.exists());
}

fn read_socket_response(stream: &mut UnixStream) -> Value {
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    assert!(!line.is_empty());
    serde_json::from_str(&line).unwrap()
}

fn wait_for_path(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !path.exists() {
        assert!(Instant::now() < deadline, "socket was not created");
        thread::sleep(Duration::from_millis(10));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRequest<'a> {
    version: u8,
    id: &'a str,
    issued_at: u64,
    nonce: &'a str,
    action: &'a str,
    params: &'a Value,
}

fn signed_value(action: &str, params: Value, nonce: String) -> Value {
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let wire = WireRequest {
        version: 1,
        id: "22222222-2222-4222-8222-222222222222",
        issued_at,
        nonce: &nonce,
        action,
        params: &params,
    };
    let key = hex::decode(SECRET).unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
    mac.update(&serde_json::to_vec(&wire).unwrap());
    json!({
        "version": wire.version,
        "id": wire.id,
        "issuedAt": wire.issued_at,
        "nonce": wire.nonce,
        "action": wire.action,
        "params": wire.params,
        "mac": hex::encode(mac.finalize().into_bytes()),
    })
}
