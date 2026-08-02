use std::io::SeekFrom;

use anyhow::{Context, Result};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;

use crate::config::BridgeConfig;
use crate::protocol::UploadParams;
use crate::receipt_sandbox::resolve_receipt_file;

const FILE_CHUNK_BYTES: usize = 480 * 1024;

pub async fn transfer(
    id: &str,
    params: &UploadParams,
    config: &BridgeConfig,
    native: &mpsc::Sender<Value>,
) -> Result<()> {
    let receipt = resolve_receipt_file(
        &config.receipt_roots,
        config.max_file_bytes,
        &params.file_path,
    )?;
    let chunk_count = (receipt.size as usize).div_ceil(FILE_CHUNK_BYTES);
    let mut file = tokio::fs::File::from_std(receipt.file.try_clone()?);
    let mut buffer = vec![0_u8; FILE_CHUNK_BYTES];
    let mut remaining = receipt.size;
    let mut hasher = Sha256::new();
    while remaining > 0 {
        let length = remaining.min(FILE_CHUNK_BYTES as u64) as usize;
        file.read_exact(&mut buffer[..length]).await?;
        hasher.update(&buffer[..length]);
        remaining -= length as u64;
    }
    receipt.ensure_unchanged()?;
    let sha256 = hex::encode(hasher.finalize());
    file.seek(SeekFrom::Start(0)).await?;

    native
        .send(json!({
            "type": "upload_start",
            "id": id,
            "debtUuid": params.debt_uuid,
            "fileName": receipt.file_name,
            "mimeType": receipt.mime_type,
            "size": receipt.size,
            "sha256": sha256,
            "chunkCount": chunk_count,
        }))
        .await
        .context("Chrome native output closed.")?;
    for index in 0..chunk_count {
        let length = if index + 1 == chunk_count {
            (receipt.size as usize) - index * FILE_CHUNK_BYTES
        } else {
            FILE_CHUNK_BYTES
        };
        file.read_exact(&mut buffer[..length]).await?;
        native
            .send(json!({
                "type": "upload_chunk",
                "id": id,
                "index": index,
                "data": base64::engine::general_purpose::STANDARD.encode(&buffer[..length]),
            }))
            .await
            .context("Chrome native output closed.")?;
    }
    receipt.ensure_unchanged()?;
    native
        .send(json!({"type": "upload_end", "id": id}))
        .await
        .context("Chrome native output closed.")?;
    Ok(())
}
