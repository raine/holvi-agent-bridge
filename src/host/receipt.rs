use anyhow::{Context, Result, ensure};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::config::{BridgeConfig, resolve_receipt_file};
use crate::protocol::UploadParams;

const FILE_CHUNK_BYTES: usize = 480 * 1024;

pub async fn transfer(
    id: &str,
    params: &UploadParams,
    config: &BridgeConfig,
    native: &mpsc::Sender<Value>,
) -> Result<()> {
    let receipt = resolve_receipt_file(config, &params.file_path)?;
    let bytes = tokio::fs::read(&receipt.path).await?;
    ensure!(
        bytes.len() as u64 == receipt.size,
        "Receipt size changed while reading the file."
    );
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let chunk_count = bytes.len().div_ceil(FILE_CHUNK_BYTES);
    native
        .send(json!({
            "type": "upload_start",
            "id": id,
            "debtUuid": params.debt_uuid,
            "fileName": receipt.file_name,
            "mimeType": receipt.mime_type,
            "size": bytes.len(),
            "sha256": sha256,
            "chunkCount": chunk_count,
        }))
        .await
        .context("Chrome native output closed.")?;
    for (index, chunk) in bytes.chunks(FILE_CHUNK_BYTES).enumerate() {
        native
            .send(json!({
                "type": "upload_chunk",
                "id": id,
                "index": index,
                "data": base64::engine::general_purpose::STANDARD.encode(chunk),
            }))
            .await
            .context("Chrome native output closed.")?;
    }
    native
        .send(json!({"type": "upload_end", "id": id}))
        .await
        .context("Chrome native output closed.")?;
    Ok(())
}
