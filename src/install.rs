use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use rand::RngCore;
use serde::Serialize;
use serde_json::json;

use crate::config::{
    BridgeConfig, DEFAULT_MAX_FILE_BYTES, EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME,
    SUPPORTED_CAPABILITIES, default_config_path, is_lower_hex, parse_group_url,
    resolve_receipt_root, validate_uuid,
};

const EXTENSION_FILES: [(&str, &[u8]); 4] = [
    (
        "background.js",
        include_bytes!("../assets/extension/background.js"),
    ),
    ("config.js", include_bytes!("../assets/extension/config.js")),
    (
        "content.js",
        include_bytes!("../assets/extension/content.js"),
    ),
    (
        "manifest.json",
        include_bytes!("../assets/extension/manifest.json"),
    ),
];

pub struct InstallOptions {
    pub confirmed: bool,
    pub group_url: String,
    pub payment_account_uuid: String,
    pub capabilities: Vec<String>,
    pub receipt_roots: Vec<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    config_path: PathBuf,
    extension_id: &'static str,
    extension_path: PathBuf,
    native_host_manifest: PathBuf,
}

pub fn install_bridge(options: InstallOptions) -> Result<InstallResult> {
    let config_path = default_config_path()?;
    let manifest_directory = chrome_manifest_directory()?;
    let executable = env::current_exe()
        .context("Unable to locate the Holvi executable.")?
        .canonicalize()
        .context("Unable to resolve the Holvi executable path.")?;
    install_bridge_with_layout(options, config_path, manifest_directory, executable)
}

fn install_bridge_with_layout(
    options: InstallOptions,
    config_path: PathBuf,
    manifest_directory: PathBuf,
    executable: PathBuf,
) -> Result<InstallResult> {
    ensure!(
        options.confirmed,
        "Installation requires --yes because it registers a Chrome native host."
    );
    ensure!(
        !options.capabilities.is_empty(),
        "Installation requires at least one --capability."
    );
    let capabilities = unique(options.capabilities);
    if capabilities
        .iter()
        .any(|value| !SUPPORTED_CAPABILITIES.contains(&value.as_str()))
    {
        bail!(
            "Supported capabilities: {}.",
            SUPPORTED_CAPABILITIES.join(", ")
        );
    }
    ensure!(
        !capabilities
            .iter()
            .any(|value| value == "attachments.write")
            || !options.receipt_roots.is_empty(),
        "attachments.write requires at least one --receipt-root."
    );

    let (group_path_segment, pool_handle) = parse_group_url(&options.group_url)?;
    validate_uuid(&options.payment_account_uuid, "Payment account")?;
    let receipt_roots = unique(
        options
            .receipt_roots
            .iter()
            .map(|root| resolve_receipt_root(root))
            .collect::<Result<Vec<_>>>()?,
    );

    let support_directory = config_path
        .parent()
        .context("Config path has no parent directory.")?;
    fs::create_dir_all(support_directory)?;
    fs::set_permissions(support_directory, fs::Permissions::from_mode(0o700))?;

    let extension_path = support_directory.join("extension");
    fs::create_dir_all(&extension_path)?;
    fs::set_permissions(&extension_path, fs::Permissions::from_mode(0o700))?;
    for (name, contents) in EXTENSION_FILES {
        write_atomic(&extension_path.join(name), contents, 0o644)?;
    }

    fs::create_dir_all(&manifest_directory)?;
    let native_host_manifest = manifest_directory.join(format!("{HOST_NAME}.json"));

    let config = BridgeConfig {
        version: 2,
        group_path_segment,
        pool_handle,
        payment_account_uuid: options.payment_account_uuid,
        capabilities,
        receipt_roots,
        max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        hmac_secret: reusable_secret(&config_path).unwrap_or_else(random_secret),
    };
    let config_bytes = serde_json::to_vec_pretty(&config)?;
    write_json(&config_path, &config_bytes, 0o600)?;

    let manifest = json!({
        "name": HOST_NAME,
        "description": "Holvi Agent Bridge native host",
        "path": executable,
        "type": "stdio",
        "allowed_origins": [EXTENSION_ORIGIN],
    });
    write_json(
        &native_host_manifest,
        &serde_json::to_vec_pretty(&manifest)?,
        0o600,
    )?;

    Ok(InstallResult {
        config_path,
        extension_id: EXTENSION_ID,
        extension_path,
        native_host_manifest,
    })
}

fn chrome_manifest_directory() -> Result<PathBuf> {
    let home = dirs::home_dir().context("The current user has no home directory.")?;
    if cfg!(target_os = "macos") {
        Ok(home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts"))
    } else if cfg!(target_os = "linux") {
        let root = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        Ok(root.join("google-chrome/NativeMessagingHosts"))
    } else {
        bail!("The installer supports Google Chrome on macOS and Linux.")
    }
}

fn reusable_secret(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    if !metadata.file_type().is_file()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.uid() != uid
    {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let secret = value.get("hmacSecret")?.as_str()?;
    is_lower_hex(secret, 64).then(|| secret.to_owned())
}

fn random_secret() -> String {
    let mut secret = [0_u8; 32];
    rand::rng().fill_bytes(&mut secret);
    hex::encode(secret)
}

fn unique<T: Eq + std::hash::Hash + Clone>(values: Vec<T>) -> Vec<T> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn write_json(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut contents = bytes.to_vec();
    contents.push(b'\n');
    write_atomic(path, &contents, mode)
}

fn write_atomic(path: &Path, contents: &[u8], mode: u32) -> Result<()> {
    let parent = path
        .parent()
        .context("Output path has no parent directory.")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("holvi"),
        std::process::id()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(&temporary)?;
    file.write_all(contents)?;
    file.sync_all()?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
    fs::rename(&temporary, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn installs_private_config_host_manifest_and_extension() {
        let temporary = tempdir().unwrap();
        let receipt_root = temporary.path().join("receipts");
        fs::create_dir(&receipt_root).unwrap();
        let config_path = temporary.path().join("support/config.json");
        let manifest_directory = temporary.path().join("chrome");
        let executable = env::current_exe().unwrap().canonicalize().unwrap();
        let result = install_bridge_with_layout(
            InstallOptions {
                confirmed: true,
                group_url: "https://account.app.holvi.com/group/AbC123+example/".into(),
                payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
                capabilities: vec!["transactions.read".into(), "attachments.write".into()],
                receipt_roots: vec![receipt_root.canonicalize().unwrap()],
            },
            config_path.clone(),
            manifest_directory,
            executable.clone(),
        )
        .unwrap();

        assert_eq!(
            fs::metadata(&config_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(result.extension_path.join("background.js").is_file());
        let config: BridgeConfig = serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
        assert!(config.validate().is_ok());
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(result.native_host_manifest).unwrap()).unwrap();
        assert_eq!(manifest["path"], executable.to_string_lossy().as_ref());
        assert_eq!(manifest["allowed_origins"], json!([EXTENSION_ORIGIN]));
    }

    #[test]
    fn embedded_manifest_has_stable_extension_id_and_scope() {
        let manifest: serde_json::Value = serde_json::from_slice(
            EXTENSION_FILES
                .iter()
                .find(|(name, _)| *name == "manifest.json")
                .unwrap()
                .1,
        )
        .unwrap();
        let key = base64::engine::general_purpose::STANDARD
            .decode(manifest["key"].as_str().unwrap())
            .unwrap();
        let digest = Sha256::digest(key);
        let id: String = digest[..16]
            .iter()
            .flat_map(|byte| {
                [
                    char::from(b'a' + (byte >> 4)),
                    char::from(b'a' + (byte & 15)),
                ]
            })
            .collect();
        assert_eq!(id, EXTENSION_ID);
        assert_eq!(
            manifest["content_scripts"][0]["matches"],
            json!(["https://account.app.holvi.com/group/*"])
        );
    }
}
