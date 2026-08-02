use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result, bail, ensure};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::filesystem::{
    current_user_uid, has_mode_0600, is_owned_by_current_user, is_regular_file,
};

pub const EXTENSION_ID: &str = "oeedcemphbobfehfmcllmjhhhjgahgeb";
pub const EXTENSION_ORIGIN: &str = "chrome-extension://oeedcemphbobfehfmcllmjhhhjgahgeb/";
pub const HOST_NAME: &str = "app.holvi_agent_bridge";
pub const ACCOUNT_ORIGIN: &str = "https://account.app.holvi.com";
pub const MIN_FILE_BYTES: u64 = 1;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub const SUPPORTED_CAPABILITIES: [&str; 5] = [
    "transactions.read",
    "attachments.write",
    "attachments.delete",
    "bookkeeping.read",
    "audit.read",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfig {
    pub group_path_segment: String,
    pub pool_handle: String,
    pub payment_account_uuid: String,
    pub capabilities: Vec<String>,
    pub receipt_roots: Vec<PathBuf>,
    pub max_file_bytes: u64,
    pub hmac_secret: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicBridgeConfig<'a> {
    group_path_segment: &'a str,
    pool_handle: &'a str,
    payment_account_uuid: &'a str,
    capabilities: &'a [String],
    max_file_bytes: u64,
}

impl BridgeConfig {
    pub fn validate(self) -> Result<Self> {
        ensure!(
            is_lower_hex(&self.hmac_secret, 64),
            "Holvi Agent Bridge config has no valid request secret."
        );
        let (group_path_segment, pool_handle) = parse_group_url(&format!(
            "{ACCOUNT_ORIGIN}/group/{}/",
            percent_encoding::utf8_percent_encode(
                &self.group_path_segment,
                percent_encoding::NON_ALPHANUMERIC
            )
        ))?;
        ensure!(
            group_path_segment == self.group_path_segment && pool_handle == self.pool_handle,
            "Holvi Agent Bridge config has an invalid group target."
        );
        validate_uuid(&self.payment_account_uuid, "Payment account")?;

        let unique: HashSet<_> = self.capabilities.iter().collect();
        ensure!(
            !self.capabilities.is_empty()
                && unique.len() == self.capabilities.len()
                && self
                    .capabilities
                    .iter()
                    .all(|value| SUPPORTED_CAPABILITIES.contains(&value.as_str())),
            "Holvi Agent Bridge config has invalid capabilities."
        );
        ensure!(
            self.receipt_roots.iter().all(|root| root.is_absolute()),
            "Holvi Agent Bridge config has an invalid attachment folder."
        );
        ensure!(
            !self
                .capabilities
                .iter()
                .any(|value| value == "attachments.write")
                || !self.receipt_roots.is_empty(),
            "attachments.write requires an approved attachment folder."
        );
        ensure!(
            (MIN_FILE_BYTES..=DEFAULT_MAX_FILE_BYTES).contains(&self.max_file_bytes),
            "Holvi Agent Bridge config has an invalid file-size limit."
        );
        Ok(self)
    }

    pub fn public(&self) -> PublicBridgeConfig<'_> {
        PublicBridgeConfig {
            group_path_segment: &self.group_path_segment,
            pool_handle: &self.pool_handle,
            payment_account_uuid: &self.payment_account_uuid,
            capabilities: &self.capabilities,
            max_file_bytes: self.max_file_bytes,
        }
    }
}

pub fn default_config_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("The current user has no home directory.")?;
    if cfg!(target_os = "macos") {
        Ok(home.join("Library/Application Support/Holvi Agent Bridge/config.json"))
    } else if cfg!(target_os = "linux") {
        let root = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        Ok(root.join("holvi-agent-bridge/config.json"))
    } else {
        bail!("Holvi Agent Bridge supports macOS and Linux.")
    }
}

pub fn config_path() -> Result<PathBuf> {
    env::var_os("HOLVI_AGENT_BRIDGE_CONFIG")
        .map(PathBuf::from)
        .map_or_else(default_config_path, Ok)
}

pub fn socket_path() -> PathBuf {
    std::env::temp_dir().join(format!("holvi-agent-bridge-{}.sock", current_user_uid()))
}

pub fn load_config() -> Result<(BridgeConfig, PathBuf)> {
    let path = config_path()?;
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("Unable to read config metadata: {}", path.display()))?;
    ensure!(
        is_regular_file(&metadata) && has_mode_0600(&metadata),
        "Config must be a regular file with 0600 permissions: {}",
        path.display()
    );
    ensure!(
        is_owned_by_current_user(&metadata),
        "Config must be owned by the current user: {}",
        path.display()
    );
    let bytes =
        fs::read(&path).with_context(|| format!("Unable to read config: {}", path.display()))?;
    let config: BridgeConfig =
        serde_json::from_slice(&bytes).context("Holvi Agent Bridge config is not valid JSON.")?;
    Ok((config.validate()?, path))
}

pub fn parse_group_url(value: &str) -> Result<(String, String)> {
    let url = Url::parse(value).map_err(|_| anyhow::anyhow!("--group-url must be a valid URL."))?;
    ensure!(
        url.origin().ascii_serialization() == ACCOUNT_ORIGIN,
        "--group-url must use {ACCOUNT_ORIGIN}."
    );
    let encoded = url
        .path()
        .strip_prefix("/group/")
        .and_then(|rest| rest.split('/').next())
        .filter(|segment| !segment.is_empty())
        .ok_or_else(|| anyhow::anyhow!("--group-url must identify a Holvi group page."))?;
    let segment = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| anyhow::anyhow!("--group-url contains an unsupported Holvi group path."))?
        .into_owned();
    let (pool, _slug) = segment
        .split_once('+')
        .filter(|(pool, slug)| !pool.is_empty() && !slug.is_empty() && !slug.contains(['/', '+']))
        .ok_or_else(|| anyhow::anyhow!("--group-url contains an unsupported Holvi group path."))?;
    ensure!(
        pool.len() <= 128
            && pool
                .bytes()
                .enumerate()
                .all(|(index, byte)| byte.is_ascii_alphanumeric()
                    || (index > 0 && matches!(byte, b'_' | b'-'))),
        "--group-url contains an unsupported Holvi group path."
    );
    Ok((segment.clone(), pool.to_owned()))
}

pub fn validate_uuid<'a>(value: &'a str, label: &str) -> Result<&'a str> {
    let valid = value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    ensure!(valid, "{label} must be a UUID.");
    Ok(value)
}

pub fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(roots: Vec<PathBuf>) -> BridgeConfig {
        BridgeConfig {
            group_path_segment: "AbC123+example-company".into(),
            pool_handle: "AbC123".into(),
            payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
            capabilities: vec!["transactions.read".into(), "attachments.write".into()],
            receipt_roots: roots,
            max_file_bytes: 1024 * 1024,
            hmac_secret: "b".repeat(64),
        }
    }

    #[test]
    fn parses_group_url() {
        assert_eq!(
            parse_group_url(
                "https://account.app.holvi.com/group/AbC123+example-company/payments-feed/"
            )
            .unwrap(),
            ("AbC123+example-company".into(), "AbC123".into())
        );
        assert!(parse_group_url("https://example.com/group/AbC123+example/").is_err());
    }

    #[test]
    fn validates_config_boundaries() {
        assert!(config(vec![PathBuf::from("/tmp")]).validate().is_ok());
        let mut invalid = config(vec![PathBuf::from("/tmp")]);
        invalid.pool_handle = "Other".into();
        assert!(invalid.validate().is_err());
        let mut read_only = config(vec![]);
        read_only.capabilities = vec!["transactions.read".into()];
        assert!(read_only.validate().is_ok());
    }

    #[test]
    fn accepts_capabilities_without_receipt_roots_when_they_do_not_read_files() {
        let mut config = config(vec![]);
        config.capabilities = vec![
            "attachments.delete".into(),
            "bookkeeping.read".into(),
            "audit.read".into(),
        ];
        assert!(config.validate().is_ok());
    }
}
