use std::collections::HashSet;
use std::env;
use std::fs::{self, File};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use rand::RngCore;
use serde::Serialize;
use serde_json::json;

use crate::config::{
    BridgeConfig, DEFAULT_MAX_FILE_BYTES, EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME,
    SUPPORTED_CAPABILITIES, default_config_path, is_lower_hex, parse_group_url, validate_uuid,
};
use crate::filesystem::{has_private_permissions, is_owned_by_current_user, is_regular_file};
use crate::receipt_sandbox::resolve_receipt_root;

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
    let extension_path = config_path
        .parent()
        .context("Config path has no parent directory.")?
        .join("extension");
    let manifest_directory = chrome_manifest_directory()?;
    let executable = env::current_exe()
        .context("Unable to locate the Holvi executable.")?
        .canonicalize()
        .context("Unable to resolve the Holvi executable path.")?;
    install_bridge_with_layout(
        options,
        config_path,
        extension_path,
        manifest_directory,
        executable,
    )
}

fn install_bridge_with_layout(
    options: InstallOptions,
    config_path: PathBuf,
    extension_path: PathBuf,
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
    let staged_extension = stage_extension(&extension_path, &EXTENSION_FILES)?;

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
    publish_extension(staged_extension, &extension_path)?;

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
    if !is_regular_file(&metadata)
        || !has_private_permissions(&metadata)
        || !is_owned_by_current_user(&metadata)
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
    let mut temporary = create_temporary_file(parent, path.file_name(), "tmp", mode)?;
    let file = temporary
        .file
        .as_mut()
        .context("Temporary output file is unavailable.")?;
    file.write_all(contents)?;
    fs::set_permissions(&temporary.path, fs::Permissions::from_mode(mode))?;
    file.sync_all()?;
    temporary.file.take();
    fs::rename(&temporary.path, path)?;
    temporary.keep();
    sync_directory(parent)?;
    Ok(())
}

struct TemporaryFile {
    path: PathBuf,
    file: Option<File>,
    remove_on_drop: bool,
}

impl TemporaryFile {
    fn keep(&mut self) {
        self.remove_on_drop = false;
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if self.remove_on_drop {
            self.file.take();
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct TemporaryDirectory {
    path: PathBuf,
    remove_on_drop: bool,
}

impl TemporaryDirectory {
    fn keep(&mut self) {
        self.remove_on_drop = false;
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = remove_path(&self.path);
        }
    }
}

fn temporary_name(file_name: Option<&std::ffi::OsStr>, purpose: &str) -> String {
    let mut random = [0_u8; 16];
    rand::rng().fill_bytes(&mut random);
    format!(
        ".{}.{}-{}",
        file_name
            .and_then(|value| value.to_str())
            .unwrap_or("holvi"),
        purpose,
        hex::encode(random)
    )
}

fn create_temporary_file(
    parent: &Path,
    file_name: Option<&std::ffi::OsStr>,
    purpose: &str,
    mode: u32,
) -> Result<TemporaryFile> {
    loop {
        let path = parent.join(temporary_name(file_name, purpose));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&path)
        {
            Ok(file) => {
                return Ok(TemporaryFile {
                    path,
                    file: Some(file),
                    remove_on_drop: true,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
}

fn create_temporary_directory(path: &Path, purpose: &str) -> Result<TemporaryDirectory> {
    let parent = path
        .parent()
        .context("Extension path has no parent directory.")?;
    fs::create_dir_all(parent)?;
    loop {
        let temporary = parent.join(temporary_name(path.file_name(), purpose));
        match fs::create_dir(&temporary) {
            Ok(()) => {
                let staged = TemporaryDirectory {
                    path: temporary,
                    remove_on_drop: true,
                };
                fs::set_permissions(&staged.path, fs::Permissions::from_mode(0o700))?;
                return Ok(staged);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
}

fn stage_extension(extension_path: &Path, files: &[(&str, &[u8])]) -> Result<TemporaryDirectory> {
    let staged = create_temporary_directory(extension_path, "stage")?;
    for (name, contents) in files {
        let path = staged.path.join(name);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o644)
            .open(&path)?;
        file.write_all(contents)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
        file.sync_all()?;
    }
    for (name, contents) in files {
        let path = staged.path.join(name);
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            metadata.is_file(),
            "Staged extension artifact is not a file."
        );
        ensure!(
            metadata.permissions().mode() & 0o777 == 0o644,
            "Staged extension artifact has incorrect permissions."
        );
        ensure!(
            fs::read(&path)? == *contents,
            "Staged extension artifact failed validation."
        );
    }
    let manifest_path = staged.path.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path).context("Staged extension has no manifest.")?;
    serde_json::from_slice::<serde_json::Value>(&manifest_bytes)
        .context("Staged extension manifest is invalid.")?;
    File::open(&staged.path)?.sync_all()?;
    Ok(staged)
}

fn publish_extension(mut staged: TemporaryDirectory, extension_path: &Path) -> Result<()> {
    let parent = extension_path
        .parent()
        .context("Extension path has no parent directory.")?;
    match fs::symlink_metadata(extension_path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::rename(&staged.path, extension_path)?;
            staged.keep();
            sync_directory(parent)?;
            return Ok(());
        }
        Ok(_) => {}
        Err(error) => return Err(error.into()),
    }

    let backup_path = loop {
        let candidate = parent.join(temporary_name(extension_path.file_name(), "backup"));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => break candidate,
            Ok(_) => {}
            Err(error) => return Err(error.into()),
        }
    };
    fs::rename(extension_path, &backup_path)?;
    let mut backup = TemporaryDirectory {
        path: backup_path,
        remove_on_drop: true,
    };
    if let Err(error) = fs::rename(&staged.path, extension_path) {
        let restore = fs::rename(&backup.path, extension_path);
        return match restore {
            Ok(()) => {
                backup.keep();
                Err(error.into())
            }
            Err(restore_error) => {
                backup.keep();
                Err(anyhow::anyhow!(
                    "Unable to publish extension ({error}) or restore existing extension ({restore_error})."
                ))
            }
        };
    }
    staged.keep();
    sync_directory(parent)?;
    remove_path(&backup.path)?;
    backup.keep();
    sync_directory(parent)?;
    Ok(())
}

fn remove_path(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    match File::open(path).and_then(|directory| directory.sync_all()) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EINVAL) | Some(libc::ENOTSUP)
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
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
        let extension_path = temporary.path().join("browser-extension/extension");
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
            extension_path.clone(),
            manifest_directory,
            executable.clone(),
        )
        .unwrap();

        assert_eq!(
            fs::metadata(&config_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(result.extension_path, extension_path);
        assert_eq!(
            fs::metadata(&result.extension_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(result.extension_path.join("background.js"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
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
    fn cleans_temporary_file_when_atomic_publication_fails() {
        let temporary = tempdir().unwrap();
        let output = temporary.path().join("config.json");
        fs::create_dir(&output).unwrap();

        write_atomic(&output, b"contents", 0o600).unwrap_err();

        let names = fs::read_dir(temporary.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![output.file_name().unwrap()]);
    }

    #[test]
    fn cleans_staged_extension_when_artifact_creation_fails() {
        let temporary = tempdir().unwrap();
        let extension = temporary.path().join("extension");
        let files: [(&str, &[u8]); 2] = [("manifest.json", b"{}"), ("manifest.json", b"duplicate")];

        assert!(stage_extension(&extension, &files).is_err());

        assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 0);
    }

    #[test]
    fn reinstallation_reuses_valid_secret_and_replaces_extension_as_a_unit() {
        let temporary = tempdir().unwrap();
        let receipt_root = temporary.path().join("receipts");
        fs::create_dir(&receipt_root).unwrap();
        let config_path = temporary.path().join("config/config.json");
        let extension_path = temporary.path().join("extension/installed");
        let manifest_directory = temporary.path().join("chrome");
        let executable = env::current_exe().unwrap().canonicalize().unwrap();
        let options = || InstallOptions {
            confirmed: true,
            group_url: "https://account.app.holvi.com/group/AbC123+example/".into(),
            payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
            capabilities: vec!["transactions.read".into(), "attachments.write".into()],
            receipt_roots: vec![receipt_root.canonicalize().unwrap()],
        };

        install_bridge_with_layout(
            options(),
            config_path.clone(),
            extension_path.clone(),
            manifest_directory.clone(),
            executable.clone(),
        )
        .unwrap();
        let first: BridgeConfig = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        fs::write(extension_path.join("background.js"), b"damaged").unwrap();
        install_bridge_with_layout(
            options(),
            config_path.clone(),
            extension_path.clone(),
            manifest_directory,
            executable,
        )
        .unwrap();
        let second: BridgeConfig =
            serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();

        assert_eq!(second.hmac_secret, first.hmac_secret);
        assert_eq!(
            fs::read(extension_path.join("background.js")).unwrap(),
            EXTENSION_FILES[0].1
        );
        assert_eq!(
            fs::read_dir(extension_path.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
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
