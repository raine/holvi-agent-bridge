use anyhow::{Context, Result};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::protocol::{NativeMessageDecoder, encode_native_message};

pub async fn reader(sender: mpsc::Sender<Value>) -> Result<()> {
    let mut stdin = tokio::io::stdin();
    let mut decoder = NativeMessageDecoder::default();
    loop {
        let mut chunk = [0_u8; 64 * 1024];
        let count = stdin.read(&mut chunk).await?;
        if count == 0 {
            decoder.finish()?;
            return Ok(());
        }
        for message in decoder.push(&chunk[..count])? {
            if sender.send(message).await.is_err() {
                return Ok(());
            }
        }
    }
}

pub async fn writer(mut receiver: mpsc::Receiver<Value>) -> Result<()> {
    let mut stdout = tokio::io::stdout();
    while let Some(message) = receiver.recv().await {
        stdout
            .write_all(&encode_native_message(&message)?)
            .await
            .context("Unable to write a Chrome native message.")?;
        stdout
            .flush()
            .await
            .context("Unable to flush Chrome native output.")?;
    }
    Ok(())
}
