use std::time::Duration;

use serde_json::Value;

use crate::config::{
    ACCOUNT_ORIGIN, CONFIG_VERSION, DEFAULT_MAX_FILE_BYTES, EXTENSION_ID, EXTENSION_ORIGIN,
    HOST_NAME, MIN_FILE_BYTES,
};
use crate::host::{FILE_CHUNK_BYTES, REQUEST_TIMEOUT};
use crate::protocol::{
    AUDIT_LIMIT_MAX, AUDIT_LIMIT_MIN, EXTENSION_TO_HOST_MESSAGES, HOST_BUILD_VERSION,
    HOST_TO_EXTENSION_MESSAGES, NATIVE_PROTOCOL_VERSION, REQUEST_MAX_AGE_MS,
    SIGNED_REQUEST_VERSION,
};
use crate::receipt_sandbox::{MIN_RECEIPT_BYTES, UPLOAD_MIME_TYPES};

fn contract() -> Value {
    serde_json::from_str(include_str!("../bridge-contract.json")).unwrap()
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap())
        .collect()
}

#[test]
fn native_constants_match_the_bridge_contract() {
    let contract = contract();

    assert_eq!(u64::from(CONFIG_VERSION), contract["versions"]["config"]);
    assert_eq!(
        u64::from(SIGNED_REQUEST_VERSION),
        contract["versions"]["signedRequest"]
    );
    assert_eq!(
        u64::from(NATIVE_PROTOCOL_VERSION),
        contract["versions"]["nativeProtocol"]
    );
    assert_eq!(HOST_BUILD_VERSION, contract["versions"]["host"]);
    assert_eq!(HOST_NAME, contract["identity"]["nativeHostName"]);
    assert_eq!(EXTENSION_ID, contract["identity"]["extensionId"]);
    assert_eq!(
        EXTENSION_ORIGIN,
        format!("chrome-extension://{EXTENSION_ID}/")
    );
    assert_eq!(ACCOUNT_ORIGIN, contract["origins"]["account"]);

    assert_eq!(MIN_FILE_BYTES, contract["fileBytes"]["min"]);
    assert_eq!(MIN_RECEIPT_BYTES, contract["fileBytes"]["min"]);
    assert_eq!(DEFAULT_MAX_FILE_BYTES, contract["fileBytes"]["max"]);
    assert_eq!(
        FILE_CHUNK_BYTES as u64,
        contract["fileBytes"]["uploadChunk"]
    );
    assert_eq!(
        UPLOAD_MIME_TYPES.to_vec(),
        strings(&contract["uploadMimeTypes"])
    );
    assert_eq!(u64::from(AUDIT_LIMIT_MIN), contract["auditLimit"]["min"]);
    assert_eq!(u64::from(AUDIT_LIMIT_MAX), contract["auditLimit"]["max"]);

    assert_eq!(
        REQUEST_MAX_AGE_MS,
        contract["timeoutsMs"]["signedRequestMaxAge"]
    );
    assert_eq!(
        REQUEST_TIMEOUT,
        Duration::from_millis(contract["timeoutsMs"]["nativeRequest"].as_u64().unwrap())
    );
    assert_eq!(
        HOST_TO_EXTENSION_MESSAGES.to_vec(),
        strings(&contract["nativeMessaging"]["hostToExtension"])
    );
    assert_eq!(
        EXTENSION_TO_HOST_MESSAGES.to_vec(),
        strings(&contract["nativeMessaging"]["extensionToHost"])
    );
}
