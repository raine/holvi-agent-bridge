#[tokio::main]
async fn main() {
    let arguments = std::env::args().skip(1).collect();
    if let Err(error) = holvi_agent_bridge::run(arguments).await {
        eprintln!("{}", holvi_agent_bridge::sanitize_error(&error.to_string()));
        std::process::exit(1);
    }
}
