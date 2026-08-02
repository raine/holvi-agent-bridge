mod capabilities;
mod cli;
mod config;
mod host;
mod install;
mod protocol;
mod skill;

use anyhow::Result;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if let Some(origin) = arguments
        .first()
        .filter(|value| value.starts_with("chrome-extension://"))
    {
        return host::run(origin).await;
    }
    if arguments
        .first()
        .is_some_and(|value| value == "native-host")
    {
        let origin = arguments.get(1).map(String::as_str).unwrap_or_default();
        return host::run(origin).await;
    }
    cli::run().await
}
