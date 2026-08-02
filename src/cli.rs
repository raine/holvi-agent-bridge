use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use chrono::NaiveDate;
use clap::{Args, CommandFactory, Parser, Subcommand};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::capabilities::enabled_actions;
use crate::config::{load_config, resolve_receipt_file, socket_path, validate_uuid};
use crate::install::{InstallOptions, install_bridge};
use crate::protocol::sign_request;

const HELP_AFTER: &str =
    "Every command requires its configured capability. Upload is a dry check unless
--yes is present. The configured signed-in Holvi group tab must remain open in
Chrome. Attachment paths are restricted by the private local config.";

#[derive(Parser)]
#[command(name = "holvi", about = "Holvi Agent Bridge", after_help = HELP_AFTER)]
pub struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    Install(InstallArgs),
    Capabilities,
    Doctor,
    Transactions(TransactionArgs),
    Preview(PreviewArgs),
    Upload(UploadArgs),
    Bookkeeping {
        #[command(subcommand)]
        command: BookkeepingCommand,
    },
    Audit {
        #[command(subcommand)]
        command: AuditCommand,
    },
}

#[derive(Subcommand)]
enum BookkeepingCommand {
    Get(PreviewArgs),
    Categories,
    Suggestions(PreviewArgs),
}

#[derive(Subcommand)]
enum AuditCommand {
    List {
        #[arg(long, default_value_t = 25, value_parser = clap::value_parser!(u8).range(1..=25))]
        limit: u8,
    },
}

#[derive(Args)]
struct InstallArgs {
    #[arg(long)]
    group_url: String,
    #[arg(long)]
    account: String,
    #[arg(long = "capability", required = true)]
    capabilities: Vec<String>,
    #[arg(long = "receipt-root")]
    receipt_roots: Vec<PathBuf>,
    #[arg(long)]
    yes: bool,
}

#[derive(Args)]
struct TransactionArgs {
    #[arg(long, value_parser = parse_date)]
    from: Option<String>,
    #[arg(long, value_parser = parse_date)]
    to: Option<String>,
    #[arg(long)]
    missing_attachments: bool,
    #[arg(long = "json")]
    json_output: bool,
}

#[derive(Args)]
struct PreviewArgs {
    #[arg(long)]
    debt: String,
}

#[derive(Args)]
struct UploadArgs {
    #[arg(long)]
    debt: String,
    #[arg(long)]
    file: PathBuf,
    #[arg(long)]
    yes: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionResult {
    count: usize,
    pages: usize,
    missing_attachments: bool,
    results: Vec<TransactionRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionRow {
    date: Option<String>,
    counterparty: Option<String>,
    description: Option<String>,
    amount: Option<Value>,
    currency: Option<String>,
    debt_uuid: Option<String>,
}

pub async fn run() -> Result<()> {
    let cli = Cli::parse();
    let Some(command) = cli.command else {
        Cli::command().print_help()?;
        println!();
        return Ok(());
    };
    if let Command::Install(args) = command {
        let result = install_bridge(InstallOptions {
            confirmed: args.yes,
            group_url: args.group_url,
            payment_account_uuid: args.account,
            capabilities: args.capabilities,
            receipt_roots: args.receipt_roots,
        })?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }

    let (config, _) = load_config()?;
    match command {
        Command::Install(_) => unreachable!(),
        Command::Capabilities => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "capabilities": config.capabilities,
                    "operations": enabled_actions(&config.capabilities),
                }))?
            );
        }
        Command::Doctor => {
            print_json(&request_host(&config.hmac_secret, "doctor", json!({})).await?)?;
        }
        Command::Transactions(args) => {
            let from = args.from.unwrap_or_default();
            let to = args.to.unwrap_or_default();
            ensure!(
                from.is_empty() || to.is_empty() || from <= to,
                "--from must be on or before --to."
            );
            let result = request_host(
                &config.hmac_secret,
                "transactions",
                json!({
                    "from": from,
                    "to": to,
                    "missingAttachments": args.missing_attachments,
                }),
            )
            .await?;
            if args.json_output {
                print_json(&result)?;
            } else {
                print_transactions(serde_json::from_value(result)?)
            }
        }
        Command::Preview(args) => {
            validate_uuid(&args.debt, "Debt")?;
            print_json(
                &request_host(
                    &config.hmac_secret,
                    "preview",
                    json!({"debtUuid": args.debt}),
                )
                .await?,
            )?;
        }
        Command::Upload(args) => {
            validate_uuid(&args.debt, "Debt")?;
            let receipt = resolve_receipt_file(&config, &args.file)?;
            if args.yes {
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        "upload",
                        json!({
                            "debtUuid": args.debt,
                            "filePath": receipt.path,
                            "confirmed": true,
                        }),
                    )
                    .await?,
                )?;
            } else {
                let preview = request_host(
                    &config.hmac_secret,
                    "preview",
                    json!({"debtUuid": args.debt}),
                )
                .await?;
                print_json(&json!({
                    "dryRun": true,
                    "transaction": preview,
                    "receipt": receipt,
                    "next": "Repeat the upload command with --yes after checking these values.",
                }))?;
            }
        }
        Command::Bookkeeping { command } => match command {
            BookkeepingCommand::Get(args) => {
                validate_uuid(&args.debt, "Debt")?;
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        "bookkeeping.get",
                        json!({"debtUuid": args.debt}),
                    )
                    .await?,
                )?;
            }
            BookkeepingCommand::Categories => {
                print_json(
                    &request_host(&config.hmac_secret, "bookkeeping.categories", json!({})).await?,
                )?;
            }
            BookkeepingCommand::Suggestions(args) => {
                validate_uuid(&args.debt, "Debt")?;
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        "bookkeeping.suggestions",
                        json!({"debtUuid": args.debt}),
                    )
                    .await?,
                )?;
            }
        },
        Command::Audit { command } => match command {
            AuditCommand::List { limit } => {
                print_json(
                    &request_host(&config.hmac_secret, "audit.list", json!({"limit": limit}))
                        .await?,
                )?;
            }
        },
    }
    Ok(())
}

fn parse_date(value: &str) -> std::result::Result<String, String> {
    if value.len() != 10
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
    {
        return Err("must use YYYY-MM-DD".into());
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|_| value.to_owned())
        .map_err(|_| "must be a calendar date".into())
}

async fn request_host(secret: &str, action: &str, params: Value) -> Result<Value> {
    let target = socket_path();
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            bail!("Open or reload the configured signed-in Holvi tab in Chrome.")
        }
        Err(error) => return Err(error.into()),
    };
    // SAFETY: getuid has no preconditions and cannot fail.
    ensure!(
        metadata.file_type().is_socket()
            && metadata.permissions().mode() & 0o077 == 0
            && metadata.uid() == unsafe { libc::getuid() },
        "The local bridge socket failed its ownership checks."
    );

    let request = sign_request(secret, action, params)?;
    let response = tokio::time::timeout(Duration::from_secs(125), async {
        let mut socket = UnixStream::connect(&target).await.map_err(|error| {
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) {
                anyhow::anyhow!("Open or reload the configured signed-in Holvi tab in Chrome.")
            } else {
                error.into()
            }
        })?;
        let mut encoded = serde_json::to_vec(&request)?;
        encoded.push(b'\n');
        socket.write_all(&encoded).await?;
        let mut line = String::new();
        BufReader::new(socket).read_line(&mut line).await?;
        ensure!(!line.is_empty(), "Holvi Agent Bridge returned no response.");
        let response: Value =
            serde_json::from_str(&line).context("Holvi Agent Bridge returned invalid JSON.")?;
        ensure!(
            response.get("ok") == Some(&Value::Bool(true)),
            "{}",
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Holvi Agent Bridge request failed.")
        );
        Ok::<_, anyhow::Error>(response.get("data").cloned().unwrap_or(Value::Null))
    })
    .await
    .map_err(|_| anyhow::anyhow!("Holvi Agent Bridge request timed out."))??;
    Ok(response)
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn format_cell(value: Option<&Value>, width: usize) -> String {
    let text = match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    };
    let chars: Vec<_> = text.chars().collect();
    if chars.len() > width {
        chars[..width.saturating_sub(1)]
            .iter()
            .chain(std::iter::once(&'…'))
            .collect()
    } else {
        format!("{text:<width$}")
    }
}

fn print_transactions(transactions: TransactionResult) {
    let columns = [10, 28, 12, 8, 36];
    println!(
        "{}  {}  {}  {}  {}",
        format_cell(Some(&Value::String("Date".into())), columns[0]),
        format_cell(Some(&Value::String("Counterparty".into())), columns[1]),
        format_cell(Some(&Value::String("Amount".into())), columns[2]),
        format_cell(Some(&Value::String("Currency".into())), columns[3]),
        format_cell(Some(&Value::String("Debt UUID".into())), columns[4]),
    );
    for row in &transactions.results {
        let counterparty = row.counterparty.as_ref().or(row.description.as_ref());
        let debt = row.debt_uuid.as_deref().unwrap_or("unavailable");
        println!(
            "{}  {}  {}  {}  {}",
            format_cell(
                row.date
                    .as_ref()
                    .map(|value| Value::String(value.clone()))
                    .as_ref(),
                columns[0]
            ),
            format_cell(
                counterparty
                    .map(|value| Value::String(value.clone()))
                    .as_ref(),
                columns[1]
            ),
            format_cell(row.amount.as_ref(), columns[2]),
            format_cell(
                row.currency
                    .as_ref()
                    .map(|value| Value::String(value.clone()))
                    .as_ref(),
                columns[3]
            ),
            format_cell(Some(&Value::String(debt.into())), columns[4]),
        );
    }
    let label = if transactions.missing_attachments {
        "missing attachment transaction(s)"
    } else {
        "transaction(s)"
    };
    println!(
        "\n{} {}, {} API page(s).",
        transactions.count, label, transactions.pages
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_calendar_dates() {
        assert_eq!(parse_date("2026-02-28").unwrap(), "2026-02-28");
        assert_eq!(
            parse_date("2026-02-31").unwrap_err(),
            "must be a calendar date"
        );
    }

    #[test]
    fn parses_new_capability_commands_and_bounds_audit_limit() {
        let bookkeeping = Cli::try_parse_from([
            "holvi",
            "bookkeeping",
            "suggestions",
            "--debt",
            "11111111-1111-4111-8111-111111111111",
        ])
        .unwrap();
        assert!(matches!(
            bookkeeping.command,
            Some(Command::Bookkeeping {
                command: BookkeepingCommand::Suggestions(_)
            })
        ));

        let audit = Cli::try_parse_from(["holvi", "audit", "list", "--limit", "25"]).unwrap();
        assert!(matches!(
            audit.command,
            Some(Command::Audit {
                command: AuditCommand::List { limit: 25 }
            })
        ));
        assert!(Cli::try_parse_from(["holvi", "audit", "list", "--limit", "26"]).is_err());
    }

    #[test]
    fn parses_repeated_install_values() {
        let cli = Cli::try_parse_from([
            "holvi",
            "install",
            "--group-url",
            "https://account.app.holvi.com/group/AbC123+example/",
            "--account",
            "11111111-1111-4111-8111-111111111111",
            "--capability",
            "transactions.read",
            "--capability",
            "attachments.write",
            "--receipt-root",
            "/receipts/one",
            "--receipt-root",
            "/receipts/two",
            "--yes",
        ])
        .unwrap();
        let Some(Command::Install(args)) = cli.command else {
            panic!()
        };
        assert_eq!(args.capabilities.len(), 2);
        assert_eq!(args.receipt_roots.len(), 2);
        assert!(args.yes);
    }
}
