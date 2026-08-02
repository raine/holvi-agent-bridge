use std::fs::{self, File, Metadata};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;

pub const MIN_RECEIPT_BYTES: u64 = 1;
pub const UPLOAD_MIME_TYPES: [&str; 4] =
    ["application/pdf", "image/png", "image/jpeg", "image/gif"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptFile {
    pub path: PathBuf,
    pub file_name: String,
    pub mime_type: &'static str,
    pub size: u64,
    #[serde(skip)]
    bytes: Box<[u8]>,
    #[serde(skip)]
    identity: FileIdentity,
}

#[derive(Debug, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

impl ReceiptFile {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn ensure_path_identity(&self) -> Result<()> {
        let path_identity = FileIdentity::from_metadata(
            &fs::metadata(&self.path).context("Receipt path changed while reading the file.")?,
        );
        ensure!(
            path_identity == self.identity,
            "Receipt path changed while reading the file."
        );
        Ok(())
    }
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

pub fn resolve_receipt_file(
    receipt_roots: &[PathBuf],
    max_file_bytes: u64,
    file_path: &Path,
) -> Result<ReceiptFile> {
    ensure!(file_path.is_absolute(), "Receipt path must be absolute.");
    let candidate = fs::canonicalize(file_path)
        .with_context(|| format!("Unable to resolve receipt path: {}", file_path.display()))?;
    let roots = receipt_roots
        .iter()
        .map(|root| resolve_receipt_root(root))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        roots.iter().any(|root| candidate.starts_with(root)),
        "Receipt path is outside the approved receipt folders."
    );
    let mut file = File::open(&candidate).context("Receipt file must be readable.")?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "Receipt path must identify a regular file."
    );
    ensure!(
        (MIN_RECEIPT_BYTES..=max_file_bytes).contains(&metadata.len()),
        "Receipt size must be between 1 and {} bytes.",
        max_file_bytes
    );
    let identity = FileIdentity::from_metadata(&metadata);
    let path_metadata = fs::metadata(&candidate)?;
    ensure!(
        path_metadata.is_file(),
        "Receipt path must identify a regular file."
    );
    ensure!(
        identity == FileIdentity::from_metadata(&path_metadata),
        "Receipt changed while opening the file."
    );
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(max_file_bytes)
        .read_to_end(&mut bytes)
        .context("Unable to read receipt file.")?;
    let final_metadata = file.metadata()?;
    ensure!(
        final_metadata.len() == metadata.len() && bytes.len() as u64 == metadata.len(),
        "Receipt size changed while reading the file."
    );
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime_type = match extension.as_str() {
        "pdf" => UPLOAD_MIME_TYPES[0],
        "png" => UPLOAD_MIME_TYPES[1],
        "jpg" | "jpeg" => UPLOAD_MIME_TYPES[2],
        "gif" => UPLOAD_MIME_TYPES[3],
        _ => bail!("Receipt type must be PDF, PNG, JPEG, or GIF."),
    };
    let file_name = candidate
        .file_name()
        .and_then(|value| value.to_str())
        .context("Receipt filename is not valid UTF-8.")?
        .to_owned();
    let receipt = ReceiptFile {
        path: candidate,
        file_name,
        mime_type,
        size: metadata.len(),
        bytes: bytes.into_boxed_slice(),
        identity,
    };
    receipt.ensure_path_identity()?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::time::{Duration, SystemTime};

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn accepts_canonical_files_in_approved_roots() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        fs::create_dir(&approved).unwrap();
        let receipt = approved.join("receipt.pdf");
        fs::write(&receipt, b"%PDF-1.7\nreceipt\n").unwrap();

        let resolved = resolve_receipt_file(&[approved], 1024 * 1024, &receipt).unwrap();

        assert_eq!(resolved.path, fs::canonicalize(receipt).unwrap());
        assert_eq!(resolved.mime_type, "application/pdf");
    }

    #[test]
    fn blocks_receipt_symlink_escape() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        let outside = temporary.path().join("outside");
        fs::create_dir(&approved).unwrap();
        fs::create_dir(&outside).unwrap();
        let outside_receipt = outside.join("outside.pdf");
        let escaped = approved.join("escaped.pdf");
        fs::write(&outside_receipt, b"%PDF-1.7\noutside\n").unwrap();
        symlink(&outside_receipt, &escaped).unwrap();

        let error = resolve_receipt_file(&[approved], 1024 * 1024, &escaped).unwrap_err();

        assert!(error.to_string().contains("outside the approved"));
    }

    #[test]
    fn keeps_the_approved_snapshot_when_its_path_is_replaced() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        fs::create_dir(&approved).unwrap();
        let receipt = approved.join("receipt.pdf");
        let displaced = approved.join("displaced.pdf");
        fs::write(&receipt, b"approved contents").unwrap();
        let resolved = resolve_receipt_file(&[approved], 1024 * 1024, &receipt).unwrap();

        fs::rename(&receipt, &displaced).unwrap();
        fs::write(&receipt, b"replacement contents").unwrap();

        assert_eq!(resolved.bytes(), b"approved contents");
        assert!(
            resolved
                .ensure_path_identity()
                .unwrap_err()
                .to_string()
                .contains("path changed")
        );
    }

    #[test]
    fn accepts_metadata_changes_after_snapshotting() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        fs::create_dir(&approved).unwrap();
        let receipt = approved.join("receipt.pdf");
        fs::write(&receipt, b"approved contents").unwrap();
        let resolved = resolve_receipt_file(&[approved], 1024 * 1024, &receipt).unwrap();
        let file = File::options().write(true).open(&receipt).unwrap();

        file.set_times(
            fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1)),
        )
        .unwrap();

        resolved.ensure_path_identity().unwrap();
        assert_eq!(resolved.bytes(), b"approved contents");
    }

    #[test]
    fn keeps_snapshot_bytes_when_the_file_content_changes() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        fs::create_dir(&approved).unwrap();
        let receipt = approved.join("receipt.pdf");
        fs::write(&receipt, b"approved contents").unwrap();
        let resolved = resolve_receipt_file(&[approved], 1024 * 1024, &receipt).unwrap();

        fs::write(&receipt, b"changed! contents").unwrap();

        resolved.ensure_path_identity().unwrap();
        assert_eq!(resolved.bytes(), b"approved contents");
    }

    #[test]
    fn enforces_snapshot_size_limits() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        fs::create_dir(&approved).unwrap();
        let receipt = approved.join("receipt.pdf");
        fs::write(&receipt, b"12345").unwrap();

        let error = resolve_receipt_file(&[approved], 4, &receipt).unwrap_err();

        assert!(error.to_string().contains("between 1 and 4 bytes"));
    }

    #[test]
    fn fails_when_any_configured_root_is_unavailable() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        fs::create_dir(&approved).unwrap();
        let receipt = approved.join("receipt.pdf");
        fs::write(&receipt, b"%PDF-1.7\nreceipt\n").unwrap();
        let missing = temporary.path().join("missing");

        let error =
            resolve_receipt_file(&[approved, missing.clone()], 1024 * 1024, &receipt).unwrap_err();

        assert!(error.to_string().contains(&missing.display().to_string()));
    }
}
