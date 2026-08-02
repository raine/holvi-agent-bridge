use anyhow::{Context, Result};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::config::BridgeConfig;
use crate::protocol::{
    UPLOAD_CHUNK_MESSAGE, UPLOAD_END_MESSAGE, UPLOAD_START_MESSAGE, UploadParams,
};
use crate::receipt_sandbox::resolve_receipt_file;

pub const FILE_CHUNK_BYTES: usize = 480 * 1024;

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
    let chunk_count = receipt.bytes().len().div_ceil(FILE_CHUNK_BYTES);
    let sha256 = hex::encode(Sha256::digest(receipt.bytes()));
    receipt.ensure_path_identity()?;

    native
        .send(json!({
            "type": UPLOAD_START_MESSAGE,
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
    for (index, chunk) in receipt.bytes().chunks(FILE_CHUNK_BYTES).enumerate() {
        native
            .send(json!({
                "type": UPLOAD_CHUNK_MESSAGE,
                "id": id,
                "index": index,
                "data": base64::engine::general_purpose::STANDARD.encode(chunk),
            }))
            .await
            .context("Chrome native output closed.")?;
    }
    receipt.ensure_path_identity()?;
    native
        .send(json!({"type": UPLOAD_END_MESSAGE, "id": id}))
        .await
        .context("Chrome native output closed.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn transfers_the_bytes_used_for_the_snapshot_hash() {
        let temporary = tempdir().unwrap();
        let approved = temporary.path().join("approved");
        fs::create_dir(&approved).unwrap();
        let receipt = approved.join("receipt.pdf");
        let original = vec![b'a'; FILE_CHUNK_BYTES + 17];
        fs::write(&receipt, &original).unwrap();
        let params = UploadParams {
            debt_uuid: "11111111-1111-4111-8111-111111111111".into(),
            file_path: receipt.clone(),
            confirmed: true,
        };
        let config = BridgeConfig {
            version: 2,
            group_path_segment: "AbC123+example".into(),
            pool_handle: "AbC123".into(),
            payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
            capabilities: vec!["transactions.read".into(), "attachments.write".into()],
            receipt_roots: vec![approved],
            max_file_bytes: original.len() as u64,
            hmac_secret: "a".repeat(64),
        };
        let (sender, mut receiver) = mpsc::channel(1);

        let transfer =
            tokio::spawn(
                async move { super::transfer("request-id", &params, &config, &sender).await },
            );
        let start = receiver.recv().await.unwrap();
        fs::write(&receipt, vec![b'b'; original.len()]).unwrap();
        let mut transferred = Vec::new();
        while let Some(message) = receiver.recv().await {
            match message["type"].as_str().unwrap() {
                UPLOAD_CHUNK_MESSAGE => transferred.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(message["data"].as_str().unwrap())
                        .unwrap(),
                ),
                UPLOAD_END_MESSAGE => break,
                message_type => panic!("unexpected message type: {message_type}"),
            }
        }

        transfer.await.unwrap().unwrap();
        assert_eq!(transferred, original);
        assert_eq!(start["size"], original.len());
        assert_eq!(start["sha256"], hex::encode(Sha256::digest(&transferred)));
        assert_eq!(start["chunkCount"], 2);
    }
}
