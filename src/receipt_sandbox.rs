use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptFile {
    pub path: PathBuf,
    pub file_name: String,
    pub mime_type: &'static str,
    pub size: u64,
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
    let metadata = fs::metadata(&candidate)?;
    ensure!(
        metadata.is_file(),
        "Receipt path must identify a regular file."
    );
    ensure!(
        (1..=max_file_bytes).contains(&metadata.len()),
        "Receipt size must be between 1 and {} bytes.",
        max_file_bytes
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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

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
