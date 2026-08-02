use std::env;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use chrono::NaiveDate;
use clap::{Args, CommandFactory, Parser, Subcommand};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::capabilities::enabled_actions;
use crate::config::{config_path, load_config, resolve_receipt_file, socket_path, validate_uuid};
use crate::install::{InstallOptions, install_bridge};
use crate::protocol::{
    Action, AuditListParams, DebtParams, EmptyParams, TransactionParams, UploadParams, sign_request,
};
use crate::skill::{self, CodingAgentArg};

const HELP_AFTER: &str =
    "Commands that contact Holvi require their configured capability. Upload is a dry
check unless --yes is present. The configured signed-in Holvi group tab must
remain open in Chrome. Attachment paths are restricted by the private local
config.";

#[derive(Parser)]
#[command(
    name = "holvi",
    version,
    about = "Access Holvi through the local agent bridge",
    after_help = HELP_AFTER
)]
pub struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Configure the account and register the extension
    Install(InstallArgs),
    /// Print or install the coding-agent skill
    Skill(SkillCommand),
    /// Inspect or edit the private configuration file
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Show enabled capabilities and operations
    Capabilities,
    /// Verify the Chrome connection and an API surface
    Doctor,
    /// List payment-account transactions
    Transactions(TransactionArgs),
    /// Inspect one accounting debt
    Preview(PreviewArgs),
    /// Validate or upload one receipt
    Upload(UploadArgs),
    /// Read bookkeeping details and category data
    Bookkeeping {
        #[command(subcommand)]
        command: BookkeepingCommand,
    },
    /// Read recent account activity
    Audit {
        #[command(subcommand)]
        command: AuditCommand,
    },
}

#[derive(Subcommand)]
enum ConfigCommand {
    /// Open the configuration file in $VISUAL or $EDITOR
    Edit,
    /// Print the configuration file path
    Path,
}

#[derive(Subcommand)]
enum BookkeepingCommand {
    /// Inspect bookkeeping details and active line items
    Get(PreviewArgs),
    /// List bookkeeping categories
    Categories,
    /// List suggested category codes for one debt
    Suggestions(PreviewArgs),
}

#[derive(Subcommand)]
enum AuditCommand {
    /// List recent pool activity
    List {
        #[arg(long, default_value_t = 25, value_parser = clap::value_parser!(u8).range(1..=25))]
        limit: u8,
    },
}

#[derive(Args)]
struct SkillCommand {
    #[command(subcommand)]
    command: Option<SkillSubcommand>,
}

#[derive(Subcommand)]
enum SkillSubcommand {
    /// Install the holvi skill for coding agents
    Install(SkillInstallArgs),
}

#[derive(Args)]
struct SkillInstallArgs {
    /// Target a coding agent (default: all detected)
    #[arg(long = "agent", value_enum)]
    agent: Vec<CodingAgentArg>,
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
    if let Command::Skill(args) = command {
        match args.command {
            None => skill::print(),
            Some(SkillSubcommand::Install(args)) => skill::install(&args.agent)?,
        }
        return Ok(());
    }
    if let Command::Config { command } = command {
        let path = config_path()?;
        match command {
            ConfigCommand::Edit => edit_config(&path)?,
            ConfigCommand::Path => println!("{}", path.display()),
        }
        return Ok(());
    }

    let (config, _) = load_config()?;
    match command {
        Command::Install(_) | Command::Skill(_) | Command::Config { .. } => unreachable!(),
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
            print_json(&request_host(&config.hmac_secret, Action::Doctor(EmptyParams {})).await?)?;
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
                Action::Transactions(TransactionParams {
                    from,
                    to,
                    missing_attachments: args.missing_attachments,
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
                    Action::Preview(DebtParams {
                        debt_uuid: args.debt,
                    }),
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
                        Action::Upload(UploadParams {
                            debt_uuid: args.debt,
                            file_path: receipt.path,
                            confirmed: true,
                        }),
                    )
                    .await?,
                )?;
            } else {
                let preview = request_host(
                    &config.hmac_secret,
                    Action::Preview(DebtParams {
                        debt_uuid: args.debt,
                    }),
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
                        Action::BookkeepingGet(DebtParams {
                            debt_uuid: args.debt,
                        }),
                    )
                    .await?,
                )?;
            }
            BookkeepingCommand::Categories => {
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        Action::BookkeepingCategories(EmptyParams {}),
                    )
                    .await?,
                )?;
            }
            BookkeepingCommand::Suggestions(args) => {
                validate_uuid(&args.debt, "Debt")?;
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        Action::BookkeepingSuggestions(DebtParams {
                            debt_uuid: args.debt,
                        }),
                    )
                    .await?,
                )?;
            }
        },
        Command::Audit { command } => match command {
            AuditCommand::List { limit } => {
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        Action::AuditList(AuditListParams { limit }),
                    )
                    .await?,
                )?;
            }
        },
    }
    Ok(())
}

fn edit_config(path: &Path) -> Result<()> {
    let (source, editor) = [
        ("VISUAL", env::var_os("VISUAL")),
        ("EDITOR", env::var_os("EDITOR")),
    ]
    .into_iter()
    .find_map(|(source, value)| {
        value
            .filter(|value| !value.is_empty())
            .map(|value| (source, value))
    })
    .unwrap_or(("default editor", OsString::from("vi")));
    let status = ProcessCommand::new("sh")
        .arg("-c")
        .arg(r#"eval "$1 \"\$2\"""#)
        .arg("holvi config edit")
        .arg(editor)
        .arg(path)
        .status()
        .with_context(|| format!("Unable to launch editor command from {source}."))?;
    ensure!(
        status.success(),
        "Editor command from {source} failed with {status}."
    );
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

async fn request_host(secret: &str, action: Action) -> Result<Value> {
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

    let request = sign_request(secret, action)?;
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
    fn exposes_package_version() {
        let error = Cli::try_parse_from(["holvi", "--version"])
            .err()
            .expect("--version should stop argument parsing");
        assert_eq!(error.kind(), clap::error::ErrorKind::DisplayVersion);
        assert_eq!(
            error.to_string(),
            format!("holvi {}\n", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn parses_config_commands() {
        let edit = Cli::try_parse_from(["holvi", "config", "edit"]).unwrap();
        assert!(matches!(
            edit.command,
            Some(Command::Config {
                command: ConfigCommand::Edit
            })
        ));

        let path = Cli::try_parse_from(["holvi", "config", "path"]).unwrap();
        assert!(matches!(
            path.command,
            Some(Command::Config {
                command: ConfigCommand::Path
            })
        ));
    }

    #[test]
    fn validates_calendar_dates() {
        assert_eq!(parse_date("2026-02-28").unwrap(), "2026-02-28");
        assert_eq!(
            parse_date("2026-02-31").unwrap_err(),
            "must be a calendar date"
        );
    }

    #[test]
    fn every_command_help_includes_a_description() {
        fn assert_described(mut command: clap::Command, path: &str) {
            let description = command
                .get_about()
                .unwrap_or_else(|| panic!("{path} has no description"))
                .to_string();
            let help = command.render_help().to_string();
            assert!(
                help.contains(&description),
                "{path} help does not contain its description: {description}"
            );

            let subcommands = command.get_subcommands().cloned().collect::<Vec<_>>();
            for subcommand in subcommands {
                let subcommand_path = format!("{path} {}", subcommand.get_name());
                assert_described(subcommand, &subcommand_path);
            }
        }

        assert_described(Cli::command(), "holvi");
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
    fn parses_skill_print_and_install_targets() {
        let print = Cli::try_parse_from(["holvi", "skill"]).unwrap();
        assert!(matches!(
            print.command,
            Some(Command::Skill(SkillCommand { command: None }))
        ));

        let install = Cli::try_parse_from([
            "holvi", "skill", "install", "--agent", "claude", "--agent", "codex",
        ])
        .unwrap();
        let Some(Command::Skill(SkillCommand {
            command: Some(SkillSubcommand::Install(args)),
        })) = install.command
        else {
            panic!()
        };
        assert_eq!(
            args.agent,
            vec![CodingAgentArg::Claude, CodingAgentArg::Codex]
        );
        assert!(Cli::try_parse_from(["holvi", "skill", "install", "--agent", "unknown"]).is_err());
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
