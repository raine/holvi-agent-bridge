use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail, ensure};
use chrono::NaiveDate;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use crate::config::{is_lower_hex, validate_uuid};

pub const MAX_NATIVE_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_NATIVE_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_SOCKET_REQUEST_BYTES: usize = 128 * 1024;
pub const REQUEST_MAX_AGE_MS: u64 = 30_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WireBridgeRequest {
    version: u8,
    id: String,
    issued_at: u64,
    nonce: String,
    action: String,
    params: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeRequest {
    pub version: u8,
    pub id: String,
    pub issued_at: u64,
    pub nonce: String,
    pub action: Action,
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

impl From<&SignedBridgeRequest> for WireBridgeRequest {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionParams {
    pub from: String,
    pub to: String,
    pub missing_attachments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebtParams {
    pub debt_uuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadParams {
    pub debt_uuid: String,
    pub file_path: PathBuf,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuditListParams {
    pub limit: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Doctor(EmptyParams),
    Transactions(TransactionParams),
    Preview(DebtParams),
    Upload(UploadParams),
    BookkeepingGet(DebtParams),
    BookkeepingCategories(EmptyParams),
    BookkeepingSuggestions(DebtParams),
    AuditList(AuditListParams),
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Doctor(_) => "doctor",
            Self::Transactions(_) => "transactions",
            Self::Preview(_) => "preview",
            Self::Upload(_) => "upload",
            Self::BookkeepingGet(_) => "bookkeeping.get",
            Self::BookkeepingCategories(_) => "bookkeeping.categories",
            Self::BookkeepingSuggestions(_) => "bookkeeping.suggestions",
            Self::AuditList(_) => "audit.list",
        }
    }

    pub fn params(&self) -> Value {
        match self {
            Self::Doctor(params) | Self::BookkeepingCategories(params) => {
                serde_json::to_value(params)
            }
            Self::Transactions(params) => serde_json::to_value(params),
            Self::Preview(params)
            | Self::BookkeepingGet(params)
            | Self::BookkeepingSuggestions(params) => serde_json::to_value(params),
            Self::Upload(params) => serde_json::to_value(params),
            Self::AuditList(params) => serde_json::to_value(params),
        }
        .expect("action parameters serialize")
    }

    fn parse(name: &str, params: Value) -> Result<Self> {
        fn decode<T: serde::de::DeserializeOwned>(params: Value) -> Result<T> {
            serde_json::from_value(params)
                .map_err(|_| anyhow::anyhow!("Local bridge action parameters are invalid."))
        }

        let action = match name {
            "doctor" => Self::Doctor(decode(params)?),
            "transactions" => {
                let params: TransactionParams = decode(params)?;
                validate_date(&params.from)?;
                validate_date(&params.to)?;
                ensure!(
                    params.from.is_empty() || params.to.is_empty() || params.from <= params.to,
                    "Transaction start date must be on or before the end date."
                );
                Self::Transactions(params)
            }
            "preview" => Self::Preview(validated_debt_params(decode(params)?)?),
            "upload" => {
                let params: UploadParams = decode(params)?;
                validate_uuid(&params.debt_uuid, "Debt")?;
                ensure!(
                    params.file_path.is_absolute(),
                    "Receipt path must be absolute."
                );
                ensure!(
                    params.confirmed,
                    "Receipt upload requires explicit confirmation."
                );
                Self::Upload(params)
            }
            "bookkeeping.get" => Self::BookkeepingGet(validated_debt_params(decode(params)?)?),
            "bookkeeping.categories" => Self::BookkeepingCategories(decode(params)?),
            "bookkeeping.suggestions" => {
                Self::BookkeepingSuggestions(validated_debt_params(decode(params)?)?)
            }
            "audit.list" => {
                let params: AuditListParams = decode(params)?;
                ensure!(
                    (1..=25).contains(&params.limit),
                    "Activity limit must be between 1 and 25."
                );
                Self::AuditList(params)
            }
            _ => bail!("Unsupported local bridge action."),
        };
        Ok(action)
    }
}

fn validated_debt_params(params: DebtParams) -> Result<DebtParams> {
    validate_uuid(&params.debt_uuid, "Debt")?;
    Ok(params)
}

fn validate_date(value: &str) -> Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    ensure!(
        value.len() == 10
            && value.as_bytes().get(4) == Some(&b'-')
            && value.as_bytes().get(7) == Some(&b'-')
            && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok(),
        "Transaction dates must use YYYY-MM-DD calendar dates."
    );
    Ok(())
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_millis() as u64
}

pub fn sign_request(secret: &str, action: Action) -> Result<SignedBridgeRequest> {
    let mut nonce = [0_u8; 16];
    rand::rng().fill_bytes(&mut nonce);
    let request = WireBridgeRequest {
        version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        issued_at: now_millis(),
        nonce: hex::encode(nonce),
        action: action.name().to_owned(),
        params: action.params(),
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

    let wire = WireBridgeRequest::from(&signed);
    let supplied = hex::decode(&signed.mac).expect("validated request MAC is hex");
    let verifier = hmac(secret, &wire)?;
    verifier
        .verify_slice(&supplied)
        .map_err(|_| anyhow::anyhow!("Local bridge request authentication failed."))?;

    seen_nonces.insert(signed.nonce.clone(), signed.issued_at);
    seen_nonces.retain(|_, issued_at| clock.saturating_sub(*issued_at) <= REQUEST_MAX_AGE_MS);
    let action = Action::parse(&signed.action, signed.params)?;
    Ok(BridgeRequest {
        version: signed.version,
        id: signed.id,
        issued_at: signed.issued_at,
        nonce: signed.nonce,
        action,
    })
}

fn hmac(secret: &str, request: &WireBridgeRequest) -> Result<Hmac<Sha256>> {
    let key = hex::decode(secret).map_err(|_| anyhow::anyhow!("Invalid request secret."))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("HMAC accepts keys of every size");
    mac.update(&serde_json::to_vec(request)?);
    Ok(mac)
}

fn request_mac(secret: &str, request: &WireBridgeRequest) -> Result<String> {
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
        let request = WireBridgeRequest {
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
    fn authenticates_and_parses_a_typed_request_once() {
        let signed = sign_request(
            SECRET,
            Action::Transactions(TransactionParams {
                from: "2026-07-01".into(),
                to: "".into(),
                missing_attachments: false,
            }),
        )
        .unwrap();
        let clock = signed.issued_at;
        let mut seen = HashMap::new();
        let request = verify_request(
            SECRET,
            serde_json::to_value(&signed).unwrap(),
            &mut seen,
            clock,
        )
        .unwrap();
        assert_eq!(
            request.action,
            Action::Transactions(TransactionParams {
                from: "2026-07-01".into(),
                to: "".into(),
                missing_attachments: false,
            })
        );
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
        let signed = sign_request(
            SECRET,
            Action::Preview(DebtParams {
                debt_uuid: "11111111-1111-4111-8111-111111111111".into(),
            }),
        )
        .unwrap();
        let mut tampered = serde_json::to_value(&signed).unwrap();
        tampered["params"] = json!({"debtUuid": "22222222-2222-4222-8222-222222222222"});
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

    #[test]
    fn rejects_unknown_actions_after_authentication() {
        let signed = signed_value("fetch", json!({}));
        let clock = signed["issuedAt"].as_u64().unwrap();
        let error = verify_request(SECRET, signed, &mut HashMap::new(), clock).unwrap_err();
        assert_eq!(error.to_string(), "Unsupported local bridge action.");
    }

    #[test]
    fn validates_every_action_parameter_shape() {
        let invalid = [
            ("doctor", json!({"probe": true})),
            (
                "transactions",
                json!({"from": "2026-02-30", "to": "", "missingAttachments": false}),
            ),
            (
                "transactions",
                json!({"from": "2026-07-02", "to": "2026-07-01", "missingAttachments": false}),
            ),
            (
                "transactions",
                json!({"from": "", "to": "", "missingAttachments": "false"}),
            ),
            ("preview", json!({"debtUuid": "not-a-uuid"})),
            (
                "upload",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "filePath": "receipt.pdf",
                    "confirmed": true
                }),
            ),
            (
                "upload",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "filePath": "/tmp/receipt.pdf",
                    "confirmed": false
                }),
            ),
            ("bookkeeping.get", json!({"debtUuid": ""})),
            ("bookkeeping.categories", json!({"limit": 1})),
            ("bookkeeping.suggestions", json!({})),
            ("audit.list", json!({"limit": 0})),
            ("audit.list", json!({"limit": 26})),
        ];

        for (action, params) in invalid {
            let signed = signed_value(action, params);
            let clock = signed["issuedAt"].as_u64().unwrap();
            assert!(
                verify_request(SECRET, signed, &mut HashMap::new(), clock).is_err(),
                "accepted malformed parameters for {action}"
            );
        }
    }

    fn signed_value(action: &str, params: Value) -> Value {
        let request = WireBridgeRequest {
            version: 1,
            id: "11111111-1111-4111-8111-111111111111".into(),
            issued_at: 1_720_000_000_000,
            nonce: "0123456789abcdef0123456789abcdef".into(),
            action: action.into(),
            params,
        };
        let mac = request_mac(SECRET, &request).unwrap();
        json!({
            "version": request.version,
            "id": request.id,
            "issuedAt": request.issued_at,
            "nonce": request.nonce,
            "action": request.action,
            "params": request.params,
            "mac": mac,
        })
    }
}
