use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use base64::Engine;
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::filesystem::resolve_export_directory;
use crate::protocol::DOWNLOAD_CHUNK_BYTES;

pub struct DownloadReceiver {
    directory: PathBuf,
    max_bytes: u64,
    transfer: Option<Transfer>,
    completed: Option<Value>,
}

struct Transfer {
    temporary_path: PathBuf,
    final_path: PathBuf,
    file: File,
    mime_type: String,
    expected_size: Option<u64>,
    next_index: u64,
    size: u64,
    digest: Sha256,
}

impl DownloadReceiver {
    pub fn prepare(output: &Path, roots: &[PathBuf], max_bytes: u64) -> Result<Self> {
        Ok(Self {
            directory: resolve_export_directory(output, roots)?,
            max_bytes,
            transfer: None,
            completed: None,
        })
    }

    pub fn start(&mut self, message: &Value) -> Result<()> {
        ensure!(
            self.transfer.is_none() && self.completed.is_none(),
            "Download transfer started more than once."
        );
        let file_name = message
            .get("fileName")
            .and_then(Value::as_str)
            .unwrap_or("");
        ensure!(safe_file_name(file_name), "Download filename is unsafe.");
        let mime_type = message
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("");
        ensure!(
            !mime_type.is_empty() && mime_type.len() <= 128,
            "Download MIME type is invalid."
        );
        let chunk_size = message
            .get("chunkSize")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        ensure!(
            chunk_size == DOWNLOAD_CHUNK_BYTES as u64,
            "Download chunk size is invalid."
        );
        let expected_size = message.get("expectedSize").and_then(Value::as_u64);
        ensure!(
            expected_size.is_none_or(|size| size <= self.max_bytes),
            "Download exceeds the configured size limit."
        );
        let final_path = self.directory.join(file_name);
        ensure!(!final_path.exists(), "Export destination already exists.");
        let mut random = [0_u8; 16];
        rand::rng().fill_bytes(&mut random);
        let temporary_path = self
            .directory
            .join(format!(".holvi-download-{}", hex::encode(random)));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary_path)?;
        self.transfer = Some(Transfer {
            temporary_path,
            final_path,
            file,
            mime_type: mime_type.to_owned(),
            expected_size,
            next_index: 0,
            size: 0,
            digest: Sha256::new(),
        });
        Ok(())
    }

    pub fn chunk(&mut self, message: &Value) -> Result<()> {
        let transfer = self
            .transfer
            .as_mut()
            .context("Download chunk arrived before download start.")?;
        let index = message
            .get("index")
            .and_then(Value::as_u64)
            .context("Download chunk index is invalid.")?;
        ensure!(
            index == transfer.next_index,
            "Download chunks are missing, duplicated, or reordered."
        );
        let encoded = message
            .get("data")
            .and_then(Value::as_str)
            .context("Download chunk data is invalid.")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .context("Download chunk is not valid base64.")?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= DOWNLOAD_CHUNK_BYTES,
            "Download chunk size is invalid."
        );
        let size = transfer
            .size
            .checked_add(bytes.len() as u64)
            .context("Download size overflowed.")?;
        ensure!(
            size <= self.max_bytes
                && transfer
                    .expected_size
                    .is_none_or(|expected| size <= expected),
            "Download exceeds its declared or configured size."
        );
        transfer.file.write_all(&bytes)?;
        transfer.digest.update(&bytes);
        transfer.size = size;
        transfer.next_index += 1;
        Ok(())
    }

    pub fn end(&mut self, message: &Value) -> Result<()> {
        let mut transfer = self
            .transfer
            .take()
            .context("Download end arrived before download start.")?;
        let chunk_count = message
            .get("chunkCount")
            .and_then(Value::as_u64)
            .context("Download chunk count is invalid.")?;
        let size = message
            .get("size")
            .and_then(Value::as_u64)
            .context("Download size is invalid.")?;
        ensure!(
            chunk_count == transfer.next_index
                && size == transfer.size
                && transfer
                    .expected_size
                    .is_none_or(|expected| expected == size),
            "Download integrity metadata does not match received bytes."
        );
        let temporary_path = transfer.temporary_path.clone();
        let final_path = transfer.final_path.clone();
        let mut published = false;
        let result = (|| -> Result<Value> {
            transfer.file.flush()?;
            transfer.file.sync_all()?;
            fs::set_permissions(&transfer.temporary_path, fs::Permissions::from_mode(0o600))?;
            drop(transfer.file);
            fs::hard_link(&transfer.temporary_path, &transfer.final_path)
                .context("Export destination already exists or cannot be published.")?;
            published = true;
            fs::remove_file(&transfer.temporary_path)?;
            File::open(&self.directory)?.sync_all()?;
            let digest = hex::encode(transfer.digest.finalize());
            Ok(
                json!({"path": transfer.final_path, "mimeType": transfer.mime_type, "size": size, "sha256": digest}),
            )
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary_path);
            if published {
                let _ = fs::remove_file(final_path);
            }
        }
        self.completed = Some(result?);
        Ok(())
    }

    pub fn take_completed(&mut self) -> Option<Value> {
        self.completed.take()
    }

    pub fn is_complete(&self) -> bool {
        self.completed.is_some()
    }
}

impl Drop for DownloadReceiver {
    fn drop(&mut self) {
        if let Some(transfer) = self.transfer.take() {
            drop(transfer.file);
            let _ = fs::remove_file(transfer.temporary_path);
        }
    }
}

fn safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn streams_ordered_chunks_and_hashes_written_bytes() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let mut receiver =
            DownloadReceiver::prepare(&root, std::slice::from_ref(&root), 100).unwrap();
        receiver.start(&json!({"fileName":"report.zip","mimeType":"application/zip","expectedSize":3,"chunkSize":DOWNLOAD_CHUNK_BYTES})).unwrap();
        receiver.chunk(&json!({"index":0,"data":"YWJj"})).unwrap();
        receiver.end(&json!({"chunkCount":1,"size":3})).unwrap();
        let result = receiver.take_completed().unwrap();
        assert_eq!(
            result["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(fs::read(root.join("report.zip")).unwrap(), b"abc");
        assert_eq!(
            fs::metadata(root.join("report.zip"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn rejects_reordered_chunks_and_removes_the_temporary_file() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        {
            let mut receiver =
                DownloadReceiver::prepare(&root, std::slice::from_ref(&root), 100).unwrap();
            receiver.start(&json!({"fileName":"report.zip","mimeType":"application/zip","chunkSize":DOWNLOAD_CHUNK_BYTES})).unwrap();
            assert!(receiver.chunk(&json!({"index":1,"data":"YWJj"})).is_err());
        }
        assert!(fs::read_dir(&root).unwrap().next().is_none());
    }

    #[test]
    fn rejects_declared_oversize_and_destination_collisions() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let mut receiver =
            DownloadReceiver::prepare(&root, std::slice::from_ref(&root), 2).unwrap();
        assert!(receiver.start(&json!({"fileName":"large.zip","mimeType":"application/zip","expectedSize":3,"chunkSize":DOWNLOAD_CHUNK_BYTES})).is_err());
        fs::write(root.join("report.zip"), b"existing").unwrap();
        let mut receiver =
            DownloadReceiver::prepare(&root, std::slice::from_ref(&root), 100).unwrap();
        assert!(receiver.start(&json!({"fileName":"report.zip","mimeType":"application/zip","chunkSize":DOWNLOAD_CHUNK_BYTES})).is_err());
        assert_eq!(fs::read(root.join("report.zip")).unwrap(), b"existing");
    }

    #[test]
    fn rejects_unsafe_filenames() {
        let directory = tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let mut receiver =
            DownloadReceiver::prepare(&root, std::slice::from_ref(&root), 100).unwrap();
        assert!(receiver.start(&json!({"fileName":"../report.zip","mimeType":"application/zip","chunkSize":DOWNLOAD_CHUNK_BYTES})).is_err());
    }
}
