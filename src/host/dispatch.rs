use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::receipt;
use crate::capabilities::required_capabilities;
use crate::config::BridgeConfig;
use crate::protocol::{Action, BridgeRequest};

pub fn validate(
    request: &BridgeRequest,
    config: &BridgeConfig,
    tab_ready: bool,
    active: bool,
) -> Result<()> {
    let requirements = required_capabilities(&request.action);
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
    Ok(())
}

pub async fn send(
    request: BridgeRequest,
    config: BridgeConfig,
    native: mpsc::Sender<Value>,
) -> Result<()> {
    match &request.action {
        Action::Upload(params) => receipt::transfer(&request.id, params, &config, &native).await,
        action => native
            .send(json!({
                "type": "command",
                "id": request.id,
                "action": action.name(),
                "params": action.params(),
            }))
            .await
            .context("Chrome native output closed."),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::protocol::{AuditListParams, DebtParams, EmptyParams, UploadParams};

    use super::*;

    #[test]
    fn typed_actions_enforce_their_own_capabilities() {
        let mut config = test_config(vec!["bookkeeping.read".into()]);
        let mut request = test_request(Action::BookkeepingGet(DebtParams {
            debt_uuid: "11111111-1111-4111-8111-111111111111".into(),
        }));
        assert!(validate(&request, &config, true, false).is_ok());
        request.action = Action::AuditList(AuditListParams { limit: 1 });
        assert!(validate(&request, &config, true, false).is_err());
        config.capabilities = vec!["audit.read".into()];
        assert!(validate(&request, &config, true, false).is_ok());
    }

    #[test]
    fn doctor_accepts_every_valid_capability_set() {
        let config = test_config(vec!["audit.read".into()]);
        let request = test_request(Action::Doctor(EmptyParams {}));
        assert!(validate(&request, &config, true, false).is_ok());
    }

    #[test]
    fn upload_dispatch_requires_both_capabilities() {
        let config = test_config(vec!["transactions.read".into()]);
        let request = test_request(Action::Upload(UploadParams {
            debt_uuid: "11111111-1111-4111-8111-111111111111".into(),
            file_path: PathBuf::from("/tmp/receipt.pdf"),
            confirmed: true,
        }));
        assert!(validate(&request, &config, true, false).is_err());
    }

    pub(crate) fn test_config(capabilities: Vec<String>) -> BridgeConfig {
        BridgeConfig {
            version: 2,
            group_path_segment: "AbC123+example".into(),
            pool_handle: "AbC123".into(),
            payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
            capabilities,
            receipt_roots: vec![PathBuf::from("/tmp")],
            max_file_bytes: 1024,
            hmac_secret: "a".repeat(64),
        }
    }

    pub(crate) fn test_request(action: Action) -> BridgeRequest {
        BridgeRequest {
            version: 1,
            id: "11111111-1111-4111-8111-111111111111".into(),
            issued_at: 0,
            nonce: "a".repeat(32),
            action,
        }
    }
}
