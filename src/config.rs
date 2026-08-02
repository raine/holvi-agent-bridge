use std::collections::HashSet;
use std::env;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use url::Url;

pub const EXTENSION_ID: &str = "oeedcemphbobfehfmcllmjhhhjgahgeb";
pub const EXTENSION_ORIGIN: &str = "chrome-extension://oeedcemphbobfehfmcllmjhhhjgahgeb/";
pub const HOST_NAME: &str = "app.holvi_agent_bridge";
pub const ACCOUNT_ORIGIN: &str = "https://account.app.holvi.com";
pub const DEFAULT_MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub const SUPPORTED_CAPABILITIES: [&str; 2] = ["transactions.read", "attachments.write"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfig {
    pub version: u8,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptFile {
    pub path: PathBuf,
    pub file_name: String,
    pub mime_type: &'static str,
    pub size: u64,
}

impl BridgeConfig {
    pub fn validate(self) -> Result<Self> {
        ensure!(
            self.version == 2,
            "Holvi Agent Bridge config version is invalid."
        );
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
            (1..=DEFAULT_MAX_FILE_BYTES).contains(&self.max_file_bytes),
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
    std::env::temp_dir().join(format!(
        "holvi-agent-bridge-{}.sock",
        // SAFETY: getuid has no preconditions and cannot fail.
        unsafe { libc::getuid() }
    ))
}

pub fn load_config() -> Result<(BridgeConfig, PathBuf)> {
    let path = config_path()?;
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("Unable to read config metadata: {}", path.display()))?;
    ensure!(
        metadata.file_type().is_file() && metadata.permissions().mode() & 0o077 == 0,
        "Config must be a regular file with 0600 permissions: {}",
        path.display()
    );
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    ensure!(
        metadata.uid() == uid,
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

pub fn resolve_receipt_root(root: &Path) -> Result<PathBuf> {
    ensure!(root.is_absolute(), "Receipt roots must be absolute paths.");
    let resolved = fs::canonicalize(root)
        .with_context(|| format!("Unable to resolve receipt root: {}", root.display()))?;
    let metadata = fs::metadata(&resolved)?;
    ensure!(
        metadata.is_dir(),
        "Receipt root must be a directory: {}",
        root.display()
    );
    fs::read_dir(&resolved)
        .with_context(|| format!("Receipt root must be readable: {}", root.display()))?;
    Ok(resolved)
}

pub fn resolve_receipt_file(config: &BridgeConfig, file_path: &Path) -> Result<ReceiptFile> {
    ensure!(file_path.is_absolute(), "Receipt path must be absolute.");
    let candidate = fs::canonicalize(file_path)
        .with_context(|| format!("Unable to resolve receipt path: {}", file_path.display()))?;
    let roots = config
        .receipt_roots
        .iter()
        .map(|root| resolve_receipt_root(root))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        roots.iter().any(|root| candidate.starts_with(root)),
        "Receipt path is outside the approved receipt folders."
    );
    let metadata = fs::metadata(&candidate)?;
    ensure!(
        metadata.is_file(),
        "Receipt path must identify a regular file."
    );
    ensure!(
        (1..=config.max_file_bytes).contains(&metadata.len()),
        "Receipt size must be between 1 and {} bytes.",
        config.max_file_bytes
    );
    fs::File::open(&candidate).context("Receipt file must be readable.")?;
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime_type = match extension.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        _ => bail!("Receipt type must be PDF, PNG, JPEG, or GIF."),
    };
    let file_name = candidate
        .file_name()
        .and_then(|value| value.to_str())
        .context("Receipt filename is not valid UTF-8.")?
        .to_owned();
    Ok(ReceiptFile {
        path: candidate,
        file_name,
        mime_type,
        size: metadata.len(),
    })
}

pub fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use tempfile::tempdir;

    use super::*;

    fn config(roots: Vec<PathBuf>) -> BridgeConfig {
        BridgeConfig {
            version: 2,
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
    fn blocks_receipt_symlink_escape() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        let outside = temporary.path().join("outside");
        fs::create_dir(&approved).unwrap();
        fs::create_dir(&outside).unwrap();
        let receipt = approved.join("receipt.pdf");
        let outside_receipt = outside.join("outside.pdf");
        let escaped = approved.join("escaped.pdf");
        fs::write(&receipt, b"%PDF-1.7\nreceipt\n").unwrap();
        fs::write(&outside_receipt, b"%PDF-1.7\noutside\n").unwrap();
        symlink(&outside_receipt, &escaped).unwrap();

        let resolved = resolve_receipt_file(&config(vec![approved]), &receipt).unwrap();
        assert_eq!(resolved.path, fs::canonicalize(receipt).unwrap());
        assert_eq!(resolved.mime_type, "application/pdf");
        assert!(
            resolve_receipt_file(
                &config(vec![resolved.path.parent().unwrap().to_path_buf()]),
                &escaped
            )
            .is_err()
        );
    }
}
