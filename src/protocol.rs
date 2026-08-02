use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail, ensure};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use crate::config::is_lower_hex;

pub const MAX_NATIVE_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_NATIVE_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_SOCKET_REQUEST_BYTES: usize = 128 * 1024;
pub const REQUEST_MAX_AGE_MS: u64 = 30_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub version: u8,
    pub id: String,
    pub issued_at: u64,
    pub nonce: String,
    pub action: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedBridgeRequest {
    pub version: u8,
    pub id: String,
    pub issued_at: u64,
    pub nonce: String,
    pub action: String,
    pub params: Value,
    pub mac: String,
}

impl From<&SignedBridgeRequest> for BridgeRequest {
    fn from(value: &SignedBridgeRequest) -> Self {
        Self {
            version: value.version,
            id: value.id.clone(),
            issued_at: value.issued_at,
            nonce: value.nonce.clone(),
            action: value.action.clone(),
            params: value.params.clone(),
        }
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_millis() as u64
}

pub fn sign_request(secret: &str, action: &str, params: Value) -> Result<SignedBridgeRequest> {
    let mut nonce = [0_u8; 16];
    rand::rng().fill_bytes(&mut nonce);
    let request = BridgeRequest {
        version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        issued_at: now_millis(),
        nonce: hex::encode(nonce),
        action: action.to_owned(),
        params,
    };
    let mac = request_mac(secret, &request)?;
    Ok(SignedBridgeRequest {
        version: request.version,
        id: request.id,
        issued_at: request.issued_at,
        nonce: request.nonce,
        action: request.action,
        params: request.params,
        mac,
    })
}

pub fn verify_request(
    secret: &str,
    value: Value,
    seen_nonces: &mut HashMap<String, u64>,
    clock: u64,
) -> Result<BridgeRequest> {
    let signed: SignedBridgeRequest = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("Local bridge request is invalid or expired."))?;
    let valid_id = (16..=64).contains(&signed.id.len())
        && signed
            .id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    ensure!(
        signed.version == 1
            && valid_id
            && clock.abs_diff(signed.issued_at) <= REQUEST_MAX_AGE_MS
            && is_lower_hex(&signed.nonce, 32)
            && !signed.action.is_empty()
            && signed.params.is_object()
            && is_lower_hex(&signed.mac, 64),
        "Local bridge request is invalid or expired."
    );
    ensure!(
        !seen_nonces.contains_key(&signed.nonce),
        "Local bridge request nonce was already used."
    );

    let request = BridgeRequest::from(&signed);
    let supplied = hex::decode(&signed.mac).expect("validated request MAC is hex");
    let verifier = hmac(secret, &request)?;
    verifier
        .verify_slice(&supplied)
        .map_err(|_| anyhow::anyhow!("Local bridge request authentication failed."))?;

    seen_nonces.insert(signed.nonce, signed.issued_at);
    seen_nonces.retain(|_, issued_at| clock.saturating_sub(*issued_at) <= REQUEST_MAX_AGE_MS);
    Ok(request)
}

fn hmac(secret: &str, request: &BridgeRequest) -> Result<Hmac<Sha256>> {
    let key = hex::decode(secret).map_err(|_| anyhow::anyhow!("Invalid request secret."))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("HMAC accepts keys of every size");
    mac.update(&serde_json::to_vec(request)?);
    Ok(mac)
}

fn request_mac(secret: &str, request: &BridgeRequest) -> Result<String> {
    Ok(hex::encode(hmac(secret, request)?.finalize().into_bytes()))
}

pub fn encode_native_message(message: &Value) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(message)?;
    ensure!(
        body.len() <= MAX_NATIVE_OUTPUT_BYTES,
        "Native message exceeds Chrome's 1 MiB host output limit."
    );
    let size = u32::try_from(body.len()).expect("native output limit fits in u32");
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&size.to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

#[derive(Default)]
pub struct NativeMessageDecoder {
    buffer: Vec<u8>,
}

impl NativeMessageDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>> {
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                break;
            }
            let size = u32::from_le_bytes(self.buffer[..4].try_into().unwrap()) as usize;
            ensure!(
                size <= MAX_NATIVE_INPUT_BYTES,
                "Chrome native message exceeds the input limit."
            );
            if self.buffer.len() < size + 4 {
                break;
            }
            let body = self.buffer[4..size + 4].to_vec();
            self.buffer.drain(..size + 4);
            messages.push(serde_json::from_slice(&body)?);
        }
        Ok(messages)
    }

    pub fn finish(&self) -> Result<()> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            bail!("Chrome native message ended before its frame was complete.")
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SECRET: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn decodes_fragmented_native_frames() {
        let frame = encode_native_message(&json!({"type": "result", "ok": true})).unwrap();
        let mut decoder = NativeMessageDecoder::default();
        assert!(decoder.push(&frame[..2]).unwrap().is_empty());
        assert!(decoder.push(&frame[2..7]).unwrap().is_empty());
        assert_eq!(
            decoder.push(&frame[7..]).unwrap(),
            vec![json!({"type": "result", "ok": true})]
        );
    }

    #[test]
    fn matches_the_existing_request_signature_format() {
        let request = BridgeRequest {
            version: 1,
            id: "11111111-1111-4111-8111-111111111111".into(),
            issued_at: 1_720_000_000_000,
            nonce: "0123456789abcdef0123456789abcdef".into(),
            action: "transactions".into(),
            params: json!({"from": "2026-07-01", "to": ""}),
        };
        assert_eq!(
            request_mac(SECRET, &request).unwrap(),
            "117dc57e662dd84046143d6228fdcadece2840274a356aa66a77e08a2e6808bc"
        );
    }

    #[test]
    fn authenticates_signed_request_once() {
        let signed = sign_request(SECRET, "transactions", json!({"from": "2026-07-01"})).unwrap();
        let clock = signed.issued_at;
        let mut seen = HashMap::new();
        let request = verify_request(
            SECRET,
            serde_json::to_value(&signed).unwrap(),
            &mut seen,
            clock,
        )
        .unwrap();
        assert_eq!(request.action, "transactions");
        assert!(
            verify_request(
                SECRET,
                serde_json::to_value(signed).unwrap(),
                &mut seen,
                clock
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_tampering_and_expiration() {
        let signed = sign_request(SECRET, "preview", json!({"debtUuid": "one"})).unwrap();
        let mut tampered = serde_json::to_value(&signed).unwrap();
        tampered["params"] = json!({"debtUuid": "two"});
        assert!(verify_request(SECRET, tampered, &mut HashMap::new(), signed.issued_at).is_err());
        assert!(
            verify_request(
                SECRET,
                serde_json::to_value(&signed).unwrap(),
                &mut HashMap::new(),
                signed.issued_at + REQUEST_MAX_AGE_MS + 1
            )
            .is_err()
        );
    }
}
