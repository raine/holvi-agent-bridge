use std::env;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use chrono::NaiveDate;
use clap::{Args, CommandFactory, Parser, Subcommand};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use url::Url;

use crate::capabilities::{EnabledActions, enabled_actions};
use crate::config::{
    ACCOUNT_ORIGIN, BridgeConfig, SUPPORTED_CAPABILITIES, config_path, load_config, socket_path,
    validate_uuid,
};
use crate::filesystem::{has_mode_0600, is_owned_by_current_user, is_socket};
use crate::install::{HostRestartStatus, InstallOptions, InstallResult, install_bridge};
use crate::protocol::{
    Action, AttachmentDeleteParams, AuditListParams, BOOKKEEPING_DESCRIPTION_MAX_BYTES,
    BookkeepingDescriptionParams, CommentCreateParams, DebtParams, EmptyParams, HOST_BUILD_VERSION,
    MAX_COMMENT_CONTENT_BYTES, MAX_SOCKET_RESPONSE_BYTES, NATIVE_PROTOCOL_VERSION,
    TransactionParams, UploadParams, sign_request, validate_attachment_code,
};
use crate::receipt_sandbox::resolve_receipt_file;
use crate::skill::{self, CodingAgentArg};

const HELP_AFTER: &str =
    "Commands that contact Holvi require their configured capability. Writes are a dry
run unless --yes is present. The configured signed-in Holvi group tab must remain
open in Chrome. Attachment paths are restricted by the private local config.";

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
    Capabilities(OutputArgs),
    /// Verify the Chrome connection and an API surface
    Doctor(OutputArgs),
    /// List transactions or inspect their details and comments
    Transactions(TransactionsArgs),
    /// Upload or delete debt attachments
    Attachments {
        #[command(subcommand)]
        command: AttachmentsCommand,
    },
    /// Access scoped bookkeeping operations
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
enum AttachmentsCommand {
    /// Validate or upload one receipt
    Upload(UploadArgs),
    /// Preview or delete one attachment from one debt
    Delete(AttachmentDeleteArgs),
}

#[derive(Subcommand)]
enum BookkeepingCommand {
    /// Inspect bookkeeping details and active line items
    Get(DebtArgs),
    /// List bookkeeping categories
    Categories,
    /// List suggested category codes for one debt
    Suggestions(DebtArgs),
    /// Replace one bookkeeping line-item description
    SetDescription(BookkeepingDescriptionArgs),
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
struct OutputArgs {
    /// Print machine-readable JSON
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct InstallArgs {
    /// Full Holvi company group URL
    #[arg(long)]
    group_url: String,
    /// Payment account UUID used by the transaction feed
    #[arg(long)]
    account: String,
    /// Enable a capability (repeatable)
    #[arg(long = "capability", required = true)]
    capabilities: Vec<String>,
    /// Allow receipt files below this directory (repeatable)
    #[arg(long = "receipt-root")]
    receipt_roots: Vec<PathBuf>,
    /// Print machine-readable JSON
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct TransactionsArgs {
    #[command(subcommand)]
    command: TransactionCommand,
}

#[derive(Subcommand)]
enum TransactionCommand {
    /// List payment-account transactions
    List(TransactionArgs),
    /// Inspect one transaction's payment details
    Get(DebtArgs),
    /// Read or create internal transaction comments
    Comments {
        #[command(subcommand)]
        command: CommentCommand,
    },
}

#[derive(Subcommand)]
enum CommentCommand {
    /// List internal comments for one transaction debt
    List(DebtArgs),
    /// Create an internal comment after an authoritative preflight
    Create(CommentCreateArgs),
}

#[derive(Args)]
struct CommentCreateArgs {
    #[arg(long, value_name = "DEBT_OR_PAYMENT_URL")]
    debt: String,
    #[arg(long, value_parser = parse_comment_content)]
    content: String,
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
struct DebtArgs {
    /// Debt UUID or exact payment-page URL for the configured Holvi group
    #[arg(long, value_name = "DEBT_OR_PAYMENT_URL")]
    debt: String,
}

#[derive(Args)]
struct UploadArgs {
    #[arg(long, value_name = "DEBT_OR_PAYMENT_URL")]
    debt: String,
    #[arg(long)]
    file: PathBuf,
    #[arg(long)]
    yes: bool,
}

#[derive(Args)]
struct AttachmentDeleteArgs {
    /// Debt that owns the attachment
    #[arg(long, value_name = "DEBT_OR_PAYMENT_URL")]
    debt: String,
    /// Exact attachment code from the debt preview
    #[arg(long)]
    attachment: String,
    /// Confirm the irreversible deletion
    #[arg(long)]
    yes: bool,
}

#[derive(Args)]
struct BookkeepingDescriptionArgs {
    #[arg(long, value_name = "DEBT_OR_PAYMENT_URL")]
    debt: String,
    #[arg(long)]
    item: String,
    #[arg(long, value_parser = parse_description, allow_hyphen_values = true)]
    description: String,
    #[arg(long)]
    yes: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoctorResult {
    connected: bool,
    group_path_segment: String,
    pool_handle: String,
    payment_account_uuid: String,
    capabilities: Vec<String>,
    protocol_version: Option<u8>,
    host_version: Option<String>,
    extension_version: Option<String>,
    probe_action: Option<String>,
    first_page_results: Option<usize>,
    category_count: Option<usize>,
    recent_activity_count: Option<usize>,
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
        let json_output = args.json;
        let result = install_bridge(InstallOptions {
            group_url: args.group_url,
            payment_account_uuid: args.account,
            capabilities: args.capabilities,
            receipt_roots: args.receipt_roots,
        })?;
        if json_output {
            println!("{}", serde_json::to_string_pretty(&result)?);
        } else {
            print!("{}", format_install(&result, ReportRenderer::auto()));
        }
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
        Command::Capabilities(args) => {
            let actions = enabled_actions(&config.capabilities);
            if args.json {
                print_json(&json!({
                    "capabilities": config.capabilities,
                    "operations": actions,
                }))?;
            } else {
                print!(
                    "{}",
                    format_capabilities(&config.capabilities, &actions, ReportRenderer::auto(),)
                );
            }
        }
        Command::Doctor(args) => {
            let result = request_host(&config.hmac_secret, Action::Doctor(EmptyParams {})).await?;
            let doctor: DoctorResult = serde_json::from_value(result.clone())?;
            validate_doctor(&config, &doctor)?;
            if args.json {
                print_json(&result)?;
            } else {
                print!("{}", format_doctor(doctor, ReportRenderer::auto()));
            }
        }
        Command::Transactions(args) => match args.command {
            TransactionCommand::List(args) => {
                let from = args.from.unwrap_or_default();
                let to = args.to.unwrap_or_default();
                ensure!(
                    from.is_empty() || to.is_empty() || from <= to,
                    "--from must be on or before --to."
                );
                let result = request_host(
                    &config.hmac_secret,
                    Action::TransactionsList(TransactionParams {
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
            TransactionCommand::Get(args) => {
                let debt_uuid = parse_debt_target(&args.debt, &config.group_path_segment)?;
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        Action::TransactionsGet(DebtParams { debt_uuid }),
                    )
                    .await?,
                )?;
            }
            TransactionCommand::Comments { command } => match command {
                CommentCommand::List(args) => {
                    let debt_uuid = parse_debt_target(&args.debt, &config.group_path_segment)?;
                    print_json(
                        &request_host(
                            &config.hmac_secret,
                            Action::CommentsList(DebtParams { debt_uuid }),
                        )
                        .await?,
                    )?;
                }
                CommentCommand::Create(args) => {
                    let debt_uuid = parse_debt_target(&args.debt, &config.group_path_segment)?;
                    if args.yes {
                        print_json(
                            &request_host(
                                &config.hmac_secret,
                                Action::CommentsCreate(CommentCreateParams {
                                    debt_uuid,
                                    content: args.content,
                                    confirmed: true,
                                }),
                            )
                            .await?,
                        )?;
                    } else {
                        let preview = request_host(
                            &config.hmac_secret,
                            Action::DebtGet(DebtParams { debt_uuid }),
                        )
                        .await?;
                        print_json(&comment_dry_run(preview, args.content))?;
                    }
                }
            },
        },
        Command::Attachments { command } => match command {
            AttachmentsCommand::Upload(args) => {
                let debt_uuid = parse_debt_target(&args.debt, &config.group_path_segment)?;
                let receipt =
                    resolve_receipt_file(&config.receipt_roots, config.max_file_bytes, &args.file)?;
                if args.yes {
                    print_json(
                        &request_host(
                            &config.hmac_secret,
                            Action::AttachmentUpload(UploadParams {
                                debt_uuid,
                                file_path: receipt.path,
                                confirmed: true,
                            }),
                        )
                        .await?,
                    )?;
                } else {
                    let debt = request_host(
                        &config.hmac_secret,
                        Action::DebtGet(DebtParams { debt_uuid }),
                    )
                    .await?;
                    print_json(&json!({
                        "dryRun": true,
                        "transaction": debt,
                        "receipt": receipt,
                        "next": "Repeat the attachment upload command with --yes after checking these values.",
                    }))?;
                }
            }
            AttachmentsCommand::Delete(args) => {
                let debt_uuid = parse_debt_target(&args.debt, &config.group_path_segment)?;
                validate_attachment_code(&args.attachment)?;
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        Action::AttachmentDelete(AttachmentDeleteParams {
                            debt_uuid,
                            attachment_code: args.attachment,
                            confirmed: args.yes,
                        }),
                    )
                    .await?,
                )?;
            }
        },
        Command::Bookkeeping { command } => match command {
            BookkeepingCommand::Get(args) => {
                let debt_uuid = parse_debt_target(&args.debt, &config.group_path_segment)?;
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        Action::BookkeepingGet(DebtParams { debt_uuid }),
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
                let debt_uuid = parse_debt_target(&args.debt, &config.group_path_segment)?;
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        Action::BookkeepingSuggestions(DebtParams { debt_uuid }),
                    )
                    .await?,
                )?;
            }
            BookkeepingCommand::SetDescription(args) => {
                let debt_uuid = parse_debt_target(&args.debt, &config.group_path_segment)?;
                validate_uuid(&args.item, "Item")?;
                print_json(
                    &request_host(
                        &config.hmac_secret,
                        Action::BookkeepingSetDescription(BookkeepingDescriptionParams {
                            debt_uuid,
                            item_uuid: args.item,
                            description: args.description,
                            confirmed: args.yes,
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

fn parse_description(value: &str) -> std::result::Result<String, String> {
    if value.len() > BOOKKEEPING_DESCRIPTION_MAX_BYTES {
        return Err("must be at most 4096 bytes".into());
    }
    Ok(value.to_owned())
}

fn comment_dry_run(transaction: Value, content: String) -> Value {
    json!({
        "dryRun": true,
        "transaction": transaction,
        "content": content,
        "next": "Repeat the comment creation command with --yes after checking these values.",
    })
}

fn parse_comment_content(value: &str) -> std::result::Result<String, String> {
    if value.trim().is_empty() {
        return Err("must contain non-whitespace text".into());
    }
    if value.len() > MAX_COMMENT_CONTENT_BYTES {
        return Err(format!(
            "must not exceed {MAX_COMMENT_CONTENT_BYTES} UTF-8 bytes"
        ));
    }
    Ok(value.to_owned())
}

fn parse_debt_target(value: &str, configured_group: &str) -> Result<String> {
    if validate_uuid(value, "Debt").is_ok() {
        return Ok(value.to_owned());
    }

    let url = Url::parse(value)
        .context("Transaction target must be a debt UUID or an exact Holvi payment-page URL.")?;
    ensure!(
        url.origin().ascii_serialization() == ACCOUNT_ORIGIN
            && url.username().is_empty()
            && url.password().is_none(),
        "Holvi payment-page URL must use {ACCOUNT_ORIGIN}."
    );
    ensure!(
        url.query().is_none() && url.fragment().is_none(),
        "Holvi payment-page URL must not contain a query or fragment."
    );
    let segments = url
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    ensure!(
        segments.len() == 5
            && segments[0] == "group"
            && segments[1] == configured_group
            && segments[2] == "payment"
            && segments[4].is_empty(),
        "Holvi payment-page URL must target the configured group and one payment debt."
    );
    let debt_uuid = segments[3];
    validate_uuid(debt_uuid, "Debt")?;
    Ok(debt_uuid.to_owned())
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
    ensure!(
        is_socket(&metadata) && has_mode_0600(&metadata) && is_owned_by_current_user(&metadata),
        "The local bridge socket failed its ownership and permission checks."
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
        let response = read_host_response(&mut socket).await?;
        ensure!(
            response.get("ok") == Some(&Value::Bool(true)),
            "{}",
            sanitize_terminal_text(
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Holvi Agent Bridge request failed.")
            )
        );
        Ok::<_, anyhow::Error>(response.get("data").cloned().unwrap_or(Value::Null))
    })
    .await
    .map_err(|_| anyhow::anyhow!("Holvi Agent Bridge request timed out."))??;
    Ok(response)
}

async fn read_host_response(stream: &mut UnixStream) -> Result<Value> {
    read_host_response_with_limit(stream, MAX_SOCKET_RESPONSE_BYTES).await
}

async fn read_host_response_with_limit(stream: &mut UnixStream, max_bytes: usize) -> Result<Value> {
    let mut input = Vec::new();
    loop {
        let mut chunk = [0_u8; 8192];
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            ensure!(
                !input.is_empty(),
                "Holvi Agent Bridge returned no response."
            );
            break;
        }
        input.extend_from_slice(&chunk[..count]);
        if let Some(newline) = input.iter().position(|byte| *byte == b'\n') {
            ensure!(
                newline <= max_bytes,
                "Holvi Agent Bridge response is too large."
            );
            input.truncate(newline);
            break;
        }
        ensure!(
            input.len() <= max_bytes,
            "Holvi Agent Bridge response is too large."
        );
    }
    serde_json::from_slice(&input).context("Holvi Agent Bridge returned invalid JSON.")
}

fn sanitize_terminal_text(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2066}'..='\u{2069}'
                )
            {
                '\u{fffd}'
            } else {
                character
            }
        })
        .collect()
}

fn validate_doctor(config: &BridgeConfig, doctor: &DoctorResult) -> Result<()> {
    let protocol = doctor
        .protocol_version
        .map_or_else(|| "unknown".into(), |value| value.to_string());
    ensure!(
        doctor.protocol_version == Some(NATIVE_PROTOCOL_VERSION),
        "Running native host protocol {protocol} is incompatible with CLI protocol \
         {NATIVE_PROTOCOL_VERSION}. Reload Holvi Agent Bridge in chrome://extensions or restart \
         Chrome."
    );
    ensure!(
        doctor.host_version.as_deref() == Some(HOST_BUILD_VERSION),
        "Running native host version {} differs from CLI version {HOST_BUILD_VERSION}. Reload \
         Holvi Agent Bridge in chrome://extensions or restart Chrome.",
        doctor.host_version.as_deref().unwrap_or("unknown")
    );
    ensure!(
        doctor.extension_version.as_deref() == Some(HOST_BUILD_VERSION),
        "Running extension version {} differs from CLI version {HOST_BUILD_VERSION}. Reload Holvi \
         Agent Bridge in chrome://extensions or restart Chrome.",
        doctor.extension_version.as_deref().unwrap_or("unknown")
    );
    ensure!(
        doctor.connected
            && doctor.group_path_segment == config.group_path_segment
            && doctor.pool_handle == config.pool_handle
            && doctor.payment_account_uuid == config.payment_account_uuid
            && doctor.capabilities == config.capabilities,
        "Running native host account scope differs from the local config. Reload Holvi Agent \
         Bridge in chrome://extensions or restart Chrome."
    );
    Ok(())
}

#[derive(Clone, Copy)]
struct ReportRenderer {
    styled: bool,
}

impl ReportRenderer {
    fn auto() -> Self {
        Self {
            styled: io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
        }
    }

    #[cfg(test)]
    fn plain() -> Self {
        Self { styled: false }
    }

    #[cfg(test)]
    fn styled() -> Self {
        Self { styled: true }
    }

    fn paint(self, text: &str, style: &str) -> String {
        if self.styled {
            format!("\x1b[{style}m{text}\x1b[0m")
        } else {
            text.to_owned()
        }
    }

    fn write_title(self, output: &mut String, title: &str) {
        writeln!(output, "{}", self.paint(title, "1;38;2;45;174;135")).unwrap();
    }

    fn write_heading(self, output: &mut String, title: &str) {
        output.push('\n');
        writeln!(output, "{}", self.paint(title, "1;36")).unwrap();
        if !self.styled {
            writeln!(output, "{}", "-".repeat(title.chars().count())).unwrap();
        }
    }

    fn write_rows(self, output: &mut String, rows: &[ReportRow]) {
        let label_width = rows
            .iter()
            .map(|row| row.label.chars().count())
            .max()
            .unwrap_or_default();
        for row in rows {
            let label = format!("{:<label_width$}", row.label);
            if self.styled {
                writeln!(
                    output,
                    "  {} {}  {}",
                    self.paint(row.status.icon(), row.status.icon_style()),
                    self.paint(&label, row.status.label_style()),
                    self.paint(&row.value, "38;2;150;150;150"),
                )
                .unwrap();
            } else {
                writeln!(output, "  {} {label}  {}", row.status.marker(), row.value).unwrap();
            }
        }
    }

    fn write_section(self, output: &mut String, title: &str, rows: &[ReportRow]) {
        self.write_heading(output, title);
        self.write_rows(output, rows);
    }

    fn write_steps(self, output: &mut String, steps: &[&str]) {
        for (index, step) in steps.iter().enumerate() {
            let number = format!("{}.", index + 1);
            if self.styled {
                writeln!(
                    output,
                    "  {}  {}",
                    self.paint(&number, "1;38;2;45;174;135"),
                    self.paint(step, "38;2;150;150;150"),
                )
                .unwrap();
            } else {
                writeln!(output, "  {number} {step}").unwrap();
            }
        }
    }
}

#[derive(Clone, Copy)]
enum ReportStatus {
    Ok,
    Warning,
    Error,
    Info,
}

impl ReportStatus {
    fn marker(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warning | Self::Error => "!!",
            Self::Info => "..",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Ok => "✓",
            Self::Warning => "!",
            Self::Error => "✗",
            Self::Info => "·",
        }
    }

    fn icon_style(self) -> &'static str {
        match self {
            Self::Ok => "1;32",
            Self::Warning => "1;33",
            Self::Error => "1;31",
            Self::Info => "1;90",
        }
    }

    fn label_style(self) -> &'static str {
        match self {
            Self::Ok | Self::Warning | Self::Error => "37",
            Self::Info => "90",
        }
    }
}

struct ReportRow {
    status: ReportStatus,
    label: String,
    value: String,
}

impl ReportRow {
    fn new(status: ReportStatus, label: impl Into<String>, value: impl Into<String>) -> Self {
        let label = label.into();
        let value = value.into();
        Self {
            status,
            label: sanitize_terminal_text(&label),
            value: sanitize_terminal_text(&value),
        }
    }
}

fn format_install(result: &InstallResult, renderer: ReportRenderer) -> String {
    let mut output = String::new();
    renderer.write_title(&mut output, "holvi install");
    renderer.write_section(
        &mut output,
        "Installation",
        &[
            ReportRow::new(
                ReportStatus::Ok,
                "config file",
                result.config_path.to_string_lossy(),
            ),
            ReportRow::new(
                ReportStatus::Ok,
                "extension files",
                result.extension_path.to_string_lossy(),
            ),
            ReportRow::new(ReportStatus::Info, "extension id", result.extension_id),
            ReportRow::new(
                ReportStatus::Ok,
                "native host",
                result.native_host_manifest.to_string_lossy(),
            ),
            ReportRow::new(
                match result.host_restart {
                    HostRestartStatus::Requested => ReportStatus::Ok,
                    HostRestartStatus::NotRunning => ReportStatus::Info,
                    HostRestartStatus::ManualRequired => ReportStatus::Warning,
                },
                "active host",
                match result.host_restart {
                    HostRestartStatus::Requested => "restart requested",
                    HostRestartStatus::NotRunning => "starts on demand",
                    HostRestartStatus::ManualRequired => "extension reload required",
                },
            ),
        ],
    );
    renderer.write_heading(&mut output, "Next steps");
    renderer.write_steps(
        &mut output,
        &[
            "In chrome://extensions, load or reload the unpacked extension.",
            "Open or reload the configured Holvi group tab.",
            "Run holvi doctor.",
        ],
    );
    output
}

fn format_capabilities(
    capabilities: &[String],
    actions: &EnabledActions,
    renderer: ReportRenderer,
) -> String {
    let mut output = String::new();
    renderer.write_title(&mut output, "holvi capabilities");
    let capability_rows = SUPPORTED_CAPABILITIES
        .iter()
        .map(|capability| {
            let enabled = capabilities.iter().any(|item| item == capability);
            ReportRow::new(
                if enabled {
                    ReportStatus::Ok
                } else {
                    ReportStatus::Info
                },
                *capability,
                if enabled { "enabled" } else { "disabled" },
            )
        })
        .collect::<Vec<_>>();
    renderer.write_section(&mut output, "Capabilities", &capability_rows);

    let operation_rows = actions
        .iter()
        .map(|(action, enabled)| {
            ReportRow::new(
                if enabled {
                    ReportStatus::Ok
                } else {
                    ReportStatus::Info
                },
                action,
                if enabled { "enabled" } else { "disabled" },
            )
        })
        .collect::<Vec<_>>();
    renderer.write_section(&mut output, "Operations", &operation_rows);
    output
}

fn count_label(count: usize, singular: &str, plural: &str) -> String {
    format!("{count} {}", if count == 1 { singular } else { plural })
}

fn format_doctor(doctor: DoctorResult, renderer: ReportRenderer) -> String {
    let mut output = String::new();
    renderer.write_title(&mut output, "holvi doctor");
    renderer.write_section(
        &mut output,
        "Connection",
        &[
            ReportRow::new(
                if doctor.connected {
                    ReportStatus::Ok
                } else {
                    ReportStatus::Error
                },
                "Chrome bridge",
                if doctor.connected {
                    "connected"
                } else {
                    "disconnected"
                },
            ),
            ReportRow::new(ReportStatus::Ok, "Holvi session", "authenticated"),
            ReportRow::new(
                ReportStatus::Ok,
                "native protocol",
                doctor
                    .protocol_version
                    .map_or_else(|| "unknown".into(), |value| value.to_string()),
            ),
            ReportRow::new(
                ReportStatus::Ok,
                "host version",
                doctor.host_version.as_deref().unwrap_or("unknown"),
            ),
            ReportRow::new(
                ReportStatus::Ok,
                "extension version",
                doctor.extension_version.as_deref().unwrap_or("unknown"),
            ),
        ],
    );
    renderer.write_section(
        &mut output,
        "Account",
        &[
            ReportRow::new(ReportStatus::Info, "group", doctor.group_path_segment),
            ReportRow::new(ReportStatus::Info, "pool", doctor.pool_handle),
            ReportRow::new(
                ReportStatus::Info,
                "payment account",
                doctor.payment_account_uuid,
            ),
        ],
    );

    let capability_rows = doctor
        .capabilities
        .into_iter()
        .map(|capability| ReportRow::new(ReportStatus::Ok, capability, "enabled"))
        .collect::<Vec<_>>();
    renderer.write_section(&mut output, "Capabilities", &capability_rows);

    let probe_row = match doctor.probe_action.as_deref() {
        Some("transactions.list") => ReportRow::new(
            ReportStatus::Ok,
            "transactions",
            format!(
                "{} on first page",
                count_label(
                    doctor.first_page_results.unwrap_or_default(),
                    "result",
                    "results"
                )
            ),
        ),
        Some("bookkeeping.categories") => ReportRow::new(
            ReportStatus::Ok,
            "bookkeeping categories",
            count_label(
                doctor.category_count.unwrap_or_default(),
                "category",
                "categories",
            ),
        ),
        Some("audit.list") => ReportRow::new(
            ReportStatus::Ok,
            "audit activity",
            count_label(
                doctor.recent_activity_count.unwrap_or_default(),
                "result",
                "results",
            ),
        ),
        Some(action) => ReportRow::new(ReportStatus::Ok, action, "completed"),
        None => ReportRow::new(ReportStatus::Info, "API probe", "read capability required"),
    };
    renderer.write_section(&mut output, "API probe", &[probe_row]);
    output
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn format_cell(value: Option<&Value>, width: usize) -> String {
    let text = match value {
        Some(Value::String(value)) => sanitize_terminal_text(value),
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
    fn sanitizes_terminal_cells_and_preserves_ordinary_unicode() {
        let source = "München 東京\x1b[31mred\x1b[0m\r\n\x1b]8;;https://example.test\x07link\x1b]8;;\x07\u{202e}tail\u{2066}";
        let value = Value::String(source.into());
        let output = format_cell(Some(&value), 100);

        assert!(output.starts_with("München 東京�[31mred�[0m��"));
        assert!(output.contains("�]8;;https://example.test�link�]8;;��tail�"));
        assert!(!output.chars().any(char::is_control));
        assert!(!output.contains(['\u{202e}', '\u{2066}']));
    }

    #[test]
    fn terminal_cell_sanitization_does_not_change_json_output() {
        let value = json!({
            "counterparty": "München\n\x1b]0;title\x07\u{202e}tail",
        });
        let json_before = serde_json::to_string_pretty(&value).unwrap();

        let cell = format_cell(value.get("counterparty"), 80);

        assert!(cell.contains('�'));
        assert_eq!(serde_json::to_string_pretty(&value).unwrap(), json_before);
    }

    #[tokio::test]
    async fn rejects_oversized_socket_responses() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let writer = tokio::spawn(async move {
            server.write_all(&[b'a'; 33]).await.unwrap();
            server.shutdown().await.unwrap();
        });

        let error = read_host_response_with_limit(&mut client, 32)
            .await
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "Holvi Agent Bridge response is too large."
        );
        writer.await.unwrap();
    }

    #[test]
    fn accepts_debt_uuids_and_exact_configured_payment_page_urls() {
        let debt_uuid = "11111111-1111-4111-8111-111111111111";
        let group = "AbC123+example-company";
        assert_eq!(parse_debt_target(debt_uuid, group).unwrap(), debt_uuid);
        assert_eq!(
            parse_debt_target(
                &format!("{ACCOUNT_ORIGIN}/group/{group}/payment/{debt_uuid}/"),
                group,
            )
            .unwrap(),
            debt_uuid,
        );
    }

    #[test]
    fn rejects_ambiguous_or_out_of_scope_payment_page_urls() {
        let debt_uuid = "11111111-1111-4111-8111-111111111111";
        let group = "AbC123+example-company";
        let invalid = [
            format!("https://example.com/group/{group}/payment/{debt_uuid}/"),
            format!("{ACCOUNT_ORIGIN}/group/other+company/payment/{debt_uuid}/"),
            format!("{ACCOUNT_ORIGIN}/group/{group}/payments/{debt_uuid}/"),
            format!("{ACCOUNT_ORIGIN}/group/{group}/payment/{debt_uuid}"),
            format!("{ACCOUNT_ORIGIN}/group/{group}/payment/{debt_uuid}/extra/"),
            format!("{ACCOUNT_ORIGIN}/group/{group}/payment/{debt_uuid}/?uuid={debt_uuid}"),
            format!("{ACCOUNT_ORIGIN}/group/{group}/payment/{debt_uuid}/#details"),
        ];
        for value in invalid {
            assert!(
                parse_debt_target(&value, group).is_err(),
                "accepted invalid target {value}"
            );
        }
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
    fn parses_capability_commands_and_bounds_their_values() {
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

        let deletion = Cli::try_parse_from([
            "holvi",
            "attachments",
            "delete",
            "--debt",
            "11111111-1111-4111-8111-111111111111",
            "--attachment",
            "ATTACHMENT-1",
            "--yes",
        ])
        .unwrap();
        assert!(matches!(
            deletion.command,
            Some(Command::Attachments {
                command: AttachmentsCommand::Delete(AttachmentDeleteArgs { yes: true, .. })
            })
        ));

        let transactions =
            Cli::try_parse_from(["holvi", "transactions", "list", "--json"]).unwrap();
        assert!(matches!(
            transactions.command,
            Some(Command::Transactions(TransactionsArgs {
                command: TransactionCommand::List(TransactionArgs {
                    json_output: true,
                    ..
                })
            }))
        ));

        let transaction = Cli::try_parse_from([
            "holvi",
            "transactions",
            "get",
            "--debt",
            "11111111-1111-4111-8111-111111111111",
        ])
        .unwrap();
        assert!(matches!(
            transaction.command,
            Some(Command::Transactions(TransactionsArgs {
                command: TransactionCommand::Get(_)
            }))
        ));

        let upload = Cli::try_parse_from([
            "holvi",
            "attachments",
            "upload",
            "--debt",
            "11111111-1111-4111-8111-111111111111",
            "--file",
            "/tmp/receipt.pdf",
        ])
        .unwrap();
        assert!(matches!(
            upload.command,
            Some(Command::Attachments {
                command: AttachmentsCommand::Upload(_)
            })
        ));
        assert!(Cli::try_parse_from(["holvi", "preview"]).is_err());
        assert!(Cli::try_parse_from(["holvi", "upload"]).is_err());
        assert!(Cli::try_parse_from(["holvi", "debts"]).is_err());

        let description = Cli::try_parse_from([
            "holvi",
            "bookkeeping",
            "set-description",
            "--debt",
            "11111111-1111-4111-8111-111111111111",
            "--item",
            "22222222-2222-4222-8222-222222222222",
            "--description",
            "Replacement",
            "--yes",
        ])
        .unwrap();
        let Some(Command::Bookkeeping {
            command: BookkeepingCommand::SetDescription(args),
        }) = description.command
        else {
            panic!()
        };
        assert_eq!(args.description, "Replacement");
        assert!(args.yes);
        let too_long = "x".repeat(BOOKKEEPING_DESCRIPTION_MAX_BYTES + 1);
        assert!(
            Cli::try_parse_from([
                "holvi",
                "bookkeeping",
                "set-description",
                "--debt",
                "11111111-1111-4111-8111-111111111111",
                "--item",
                "22222222-2222-4222-8222-222222222222",
                "--description",
                &too_long,
            ])
            .is_err()
        );

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
    fn parses_transaction_comment_commands_and_validates_content() {
        let list = Cli::try_parse_from([
            "holvi",
            "transactions",
            "comments",
            "list",
            "--debt",
            "11111111-1111-4111-8111-111111111111",
        ])
        .unwrap();
        assert!(matches!(
            list.command,
            Some(Command::Transactions(TransactionsArgs {
                command: TransactionCommand::Comments {
                    command: CommentCommand::List(_)
                },
            }))
        ));

        let create = Cli::try_parse_from([
            "holvi",
            "transactions",
            "comments",
            "create",
            "--debt",
            "11111111-1111-4111-8111-111111111111",
            "--content",
            "exact content",
            "--yes",
        ])
        .unwrap();
        assert!(matches!(
            create.command,
            Some(Command::Transactions(TransactionsArgs {
                command: TransactionCommand::Comments {
                    command: CommentCommand::Create(CommentCreateArgs { yes: true, .. })
                },
            }))
        ));
        assert!(
            Cli::try_parse_from([
                "holvi",
                "transactions",
                "comments",
                "create",
                "--debt",
                "11111111-1111-4111-8111-111111111111",
                "--content",
                " \n ",
            ])
            .is_err()
        );
    }

    #[test]
    fn comment_dry_run_preserves_the_authoritative_target_and_exact_content() {
        let transaction = json!({
            "debtUuid": "11111111-1111-4111-8111-111111111111",
            "counterparty": "Example merchant"
        });
        let content = "exact\ncontent\u{1b}".to_owned();
        let result = comment_dry_run(transaction.clone(), content.clone());
        assert_eq!(result["dryRun"], true);
        assert_eq!(result["transaction"], transaction);
        assert_eq!(result["content"], content);
        assert_eq!(
            serde_json::to_string(&result)
                .unwrap()
                .matches("\\n")
                .count(),
            1
        );
        assert!(!serde_json::to_string(&result).unwrap().contains('\u{1b}'));
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
    fn renders_plain_capabilities_as_a_scannable_status_report() {
        let configured = vec!["transactions.read".into(), "attachments.write".into()];
        let output = format_capabilities(
            &configured,
            &enabled_actions(&configured),
            ReportRenderer::plain(),
        );

        assert!(output.starts_with("holvi capabilities\n\nCapabilities\n------------\n"));
        assert!(
            output
                .lines()
                .any(|line| line.starts_with("  ok transactions.read") && line.ends_with("enabled"))
        );
        assert!(
            output
                .lines()
                .any(|line| line.starts_with("  .. bookkeeping.read") && line.ends_with("disabled"))
        );
        assert!(output.contains("\nOperations\n----------\n"));
        assert!(
            output
                .lines()
                .any(|line| line.starts_with("  ok doctor") && line.ends_with("enabled"))
        );
        assert!(
            output
                .lines()
                .any(|line| line.starts_with("  .. audit.list") && line.ends_with("disabled"))
        );
        assert!(!output.contains("\x1b["));
    }

    #[test]
    fn rejects_stale_doctor_identity_and_scope() {
        let config = BridgeConfig {
            group_path_segment: "AbC123+example-company".into(),
            pool_handle: "AbC123".into(),
            payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
            capabilities: vec!["transactions.read".into()],
            receipt_roots: vec![],
            max_file_bytes: 1024,
            hmac_secret: "a".repeat(64),
        };
        let mut doctor = DoctorResult {
            connected: true,
            group_path_segment: config.group_path_segment.clone(),
            pool_handle: config.pool_handle.clone(),
            payment_account_uuid: config.payment_account_uuid.clone(),
            capabilities: config.capabilities.clone(),
            protocol_version: Some(NATIVE_PROTOCOL_VERSION),
            host_version: Some(HOST_BUILD_VERSION.into()),
            extension_version: Some(HOST_BUILD_VERSION.into()),
            probe_action: Some("transactions.list".into()),
            first_page_results: Some(3),
            category_count: None,
            recent_activity_count: None,
        };

        assert!(validate_doctor(&config, &doctor).is_ok());
        doctor.protocol_version = Some(NATIVE_PROTOCOL_VERSION + 1);
        assert!(
            validate_doctor(&config, &doctor)
                .unwrap_err()
                .to_string()
                .contains("protocol")
        );
        doctor.protocol_version = Some(NATIVE_PROTOCOL_VERSION);
        doctor.capabilities.push("audit.read".into());
        assert!(
            validate_doctor(&config, &doctor)
                .unwrap_err()
                .to_string()
                .contains("account scope")
        );
    }

    #[test]
    fn renders_styled_doctor_connection_scope_and_probe() {
        let output = format_doctor(
            DoctorResult {
                connected: true,
                group_path_segment: "AbC123+example-company".into(),
                pool_handle: "example-company".into(),
                payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
                capabilities: vec!["transactions.read".into()],
                protocol_version: Some(NATIVE_PROTOCOL_VERSION),
                host_version: Some(HOST_BUILD_VERSION.into()),
                extension_version: Some(HOST_BUILD_VERSION.into()),
                probe_action: Some("transactions.list".into()),
                first_page_results: Some(3),
                category_count: None,
                recent_activity_count: None,
            },
            ReportRenderer::styled(),
        );

        assert!(output.starts_with(
            "\x1b[1;38;2;45;174;135mholvi doctor\x1b[0m\n\n\x1b[1;36mConnection\x1b[0m\n"
        ));
        assert!(output.contains("\x1b[1;32m✓\x1b[0m"));
        assert!(output.contains("\x1b[1;90m·\x1b[0m"));
        assert!(output.contains("\x1b[38;2;150;150;150m3 results on first page\x1b[0m"));
    }

    #[test]
    fn renders_failed_doctor_check_in_red() {
        let output = format_doctor(
            DoctorResult {
                connected: false,
                group_path_segment: "group".into(),
                pool_handle: "pool".into(),
                payment_account_uuid: "11111111-1111-4111-8111-111111111111".into(),
                capabilities: vec![],
                protocol_version: Some(NATIVE_PROTOCOL_VERSION),
                host_version: Some(HOST_BUILD_VERSION.into()),
                extension_version: Some(HOST_BUILD_VERSION.into()),
                probe_action: None,
                first_page_results: None,
                category_count: None,
                recent_activity_count: None,
            },
            ReportRenderer::styled(),
        );

        assert!(output.contains("\x1b[1;31m✗\x1b[0m"));
        assert!(output.contains("\x1b[38;2;150;150;150mdisconnected\x1b[0m"));
    }

    #[test]
    fn renders_install_paths_and_next_steps_in_plain_text() {
        let result = InstallResult {
            config_path: "/support/config.json".into(),
            extension_id: "extension-id",
            extension_path: "/support/extension".into(),
            native_host_manifest: "/chrome/native-host.json".into(),
            host_restart: HostRestartStatus::Requested,
        };
        let output = format_install(&result, ReportRenderer::plain());

        assert!(
            output.starts_with("holvi install\n\nInstallation\n------------\n  ok config file")
        );
        assert!(output.contains("/support/config.json"));
        assert!(output.contains("  .. extension id     extension-id\n"));
        assert!(output.contains("Next steps\n----------\n"));
        assert!(output.ends_with("  3. Run holvi doctor.\n"));
        assert!(!output.contains("\x1b["));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "configPath": "/support/config.json",
                "extensionId": "extension-id",
                "extensionPath": "/support/extension",
                "nativeHostManifest": "/chrome/native-host.json",
                "hostRestart": "requested",
            })
        );
    }

    #[test]
    fn renders_styled_install_steps() {
        let result = InstallResult {
            config_path: "/support/config.json".into(),
            extension_id: "extension-id",
            extension_path: "/support/extension".into(),
            native_host_manifest: "/chrome/native-host.json".into(),
            host_restart: HostRestartStatus::Requested,
        };
        let output = format_install(&result, ReportRenderer::styled());

        assert!(output.contains("\x1b[1;36mNext steps\x1b[0m"));
        assert!(output.contains("\x1b[1;38;2;45;174;135m1.\x1b[0m"));
        assert!(output.contains(
            "\x1b[38;2;150;150;150mIn chrome://extensions, load or reload the unpacked extension.\x1b[0m"
        ));
    }

    #[test]
    fn parses_json_output_for_human_facing_reports() {
        let capabilities = Cli::try_parse_from(["holvi", "capabilities", "--json"]).unwrap();
        assert!(matches!(
            capabilities.command,
            Some(Command::Capabilities(OutputArgs { json: true }))
        ));

        let doctor = Cli::try_parse_from(["holvi", "doctor", "--json"]).unwrap();
        assert!(matches!(
            doctor.command,
            Some(Command::Doctor(OutputArgs { json: true }))
        ));

        let install = Cli::try_parse_from([
            "holvi",
            "install",
            "--group-url",
            "https://account.app.holvi.com/group/AbC123+example/",
            "--account",
            "11111111-1111-4111-8111-111111111111",
            "--capability",
            "transactions.read",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            install.command,
            Some(Command::Install(InstallArgs { json: true, .. }))
        ));
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
        ])
        .unwrap();
        let Some(Command::Install(args)) = cli.command else {
            panic!()
        };
        assert_eq!(args.capabilities.len(), 2);
        assert_eq!(args.receipt_roots.len(), 2);
    }
}
