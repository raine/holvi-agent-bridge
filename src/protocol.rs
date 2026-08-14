use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail, ensure};
use chrono::NaiveDate;
use hmac::{Hmac, KeyInit, Mac};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use crate::config::{is_lower_hex, validate_uuid};

pub const SIGNED_REQUEST_VERSION: u8 = 1;
pub const NATIVE_PROTOCOL_VERSION: u8 = 2;
pub const HOST_BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAX_NATIVE_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_NATIVE_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_SOCKET_REQUEST_BYTES: usize = 128 * 1024;
pub const MAX_SOCKET_RESPONSE_BYTES: usize = MAX_NATIVE_INPUT_BYTES;
pub const REQUEST_MAX_AGE_MS: u64 = 30_000;
pub const AUDIT_LIMIT_MIN: u16 = 1;
pub const AUDIT_LIMIT_MAX: u16 = 5000;
pub const MAX_PAGES: u16 = 200;
pub const DOWNLOAD_CHUNK_BYTES: usize = 491_520;
pub const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
pub const BOOKKEEPING_DESCRIPTION_MAX_BYTES: usize = 4096;
pub const MAX_COMMENT_CONTENT_BYTES: usize = 16 * 1024;
pub const HOST_READY_MESSAGE: &str = "host_ready";
pub const HOST_RESTART_MESSAGE: &str = "host_restart";
pub const COMMAND_MESSAGE: &str = "command";
pub const UPLOAD_START_MESSAGE: &str = "upload_start";
pub const UPLOAD_CHUNK_MESSAGE: &str = "upload_chunk";
pub const UPLOAD_END_MESSAGE: &str = "upload_end";
pub const TAB_READY_MESSAGE: &str = "tab_ready";
pub const TAB_UNAVAILABLE_MESSAGE: &str = "tab_unavailable";
pub const HOST_REJECTED_MESSAGE: &str = "host_rejected";
pub const DOWNLOAD_START_MESSAGE: &str = "download_start";
pub const DOWNLOAD_CHUNK_MESSAGE: &str = "download_chunk";
pub const DOWNLOAD_END_MESSAGE: &str = "download_end";
pub const RESULT_MESSAGE: &str = "result";
#[cfg(test)]
pub const HOST_TO_EXTENSION_MESSAGES: [&str; 6] = [
    HOST_READY_MESSAGE,
    HOST_RESTART_MESSAGE,
    COMMAND_MESSAGE,
    UPLOAD_START_MESSAGE,
    UPLOAD_CHUNK_MESSAGE,
    UPLOAD_END_MESSAGE,
];
#[cfg(test)]
pub const EXTENSION_TO_HOST_MESSAGES: [&str; 7] = [
    TAB_READY_MESSAGE,
    TAB_UNAVAILABLE_MESSAGE,
    HOST_REJECTED_MESSAGE,
    DOWNLOAD_START_MESSAGE,
    DOWNLOAD_CHUNK_MESSAGE,
    DOWNLOAD_END_MESSAGE,
    RESULT_MESSAGE,
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WireBridgeRequest {
    version: u8,
    id: String,
    issued_at: u64,
    nonce: String,
    action: String,
    params: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeRequest {
    pub version: u8,
    pub id: String,
    pub issued_at: u64,
    pub nonce: String,
    pub action: Action,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedBridgeRequest {
    pub version: u8,
    pub id: String,
    pub issued_at: u64,
    pub nonce: String,
    pub action: String,
    pub params: Value,
    pub mac: String,
}

impl From<&SignedBridgeRequest> for WireBridgeRequest {
    fn from(value: &SignedBridgeRequest) -> Self {
        Self {
            version: value.version,
            id: value.id.clone(),
            issued_at: value.issued_at,
            nonce: value.nonce.clone(),
            action: value.action.clone(),
            params: value.params.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionParams {
    pub from: String,
    pub to: String,
    pub missing_attachments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebtParams {
    pub debt_uuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookkeepingDescriptionParams {
    pub debt_uuid: String,
    pub item_uuid: String,
    pub description: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommentCreateParams {
    pub debt_uuid: String,
    pub content: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadParams {
    pub debt_uuid: String,
    pub file_path: PathBuf,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDeleteParams {
    pub debt_uuid: String,
    pub attachment_code: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDownloadParams {
    pub debt_uuid: String,
    pub attachment_code: String,
    pub output_directory: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportExportParams {
    pub report_type: String,
    pub from: String,
    pub to: String,
    pub format: String,
    pub payment_account_uuid: Option<String>,
    pub output_directory: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportJobListParams {
    pub report_type: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportJobParams {
    pub report_uuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportJobDownloadParams {
    pub report_uuid: String,
    pub output_directory: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportJobCreateParams {
    pub report_type: String,
    pub from: String,
    pub to: String,
    pub payment_account_uuid: Option<String>,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookkeepingListParams {
    pub from: String,
    pub to: String,
    pub bookkeeping_status: Option<String>,
    pub payment_account_uuid: Option<String>,
    pub uncategorised: bool,
    pub no_vat: bool,
    pub no_attachment: bool,
    pub external_transactions: bool,
    pub max_pages: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditListParams {
    pub from: String,
    pub to: String,
    pub type_class: Option<String>,
    pub query: Option<String>,
    pub limit: u16,
    pub max_pages: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    HostRestart(EmptyParams),
    Doctor(EmptyParams),
    TransactionsList(TransactionParams),
    TransactionsGet(DebtParams),
    DebtGet(DebtParams),
    CommentsList(DebtParams),
    CommentsCreate(CommentCreateParams),
    AttachmentUpload(UploadParams),
    AttachmentDelete(AttachmentDeleteParams),
    AttachmentDownload(AttachmentDownloadParams),
    AccountsList(EmptyParams),
    ReportsTypes(EmptyParams),
    ReportsExport(ReportExportParams),
    ReportJobsList(ReportJobListParams),
    ReportJobsGet(ReportJobParams),
    ReportJobsCreate(ReportJobCreateParams),
    ReportJobsDownload(ReportJobDownloadParams),
    BookkeepingList(BookkeepingListParams),
    BookkeepingGet(DebtParams),
    BookkeepingCategories(EmptyParams),
    BookkeepingSuggestions(DebtParams),
    BookkeepingSetDescription(BookkeepingDescriptionParams),
    AuditTypes(EmptyParams),
    AuditList(AuditListParams),
}

impl Action {
    pub fn download_output(&self) -> Option<&PathBuf> {
        match self {
            Self::AttachmentDownload(params) => Some(&params.output_directory),
            Self::ReportsExport(params) => Some(&params.output_directory),
            Self::ReportJobsDownload(params) => Some(&params.output_directory),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::HostRestart(_) => "host.restart",
            Self::Doctor(_) => "doctor",
            Self::TransactionsList(_) => "transactions.list",
            Self::TransactionsGet(_) => "transactions.get",
            Self::DebtGet(_) => "debts.get",
            Self::CommentsList(_) => "comments.list",
            Self::CommentsCreate(_) => "comments.create",
            Self::AttachmentUpload(_) => "attachments.upload",
            Self::AttachmentDelete(_) => "attachments.delete",
            Self::AttachmentDownload(_) => "attachments.download",
            Self::AccountsList(_) => "accounts.list",
            Self::ReportsTypes(_) => "reports.types",
            Self::ReportsExport(_) => "reports.export",
            Self::ReportJobsList(_) => "reports.jobs.list",
            Self::ReportJobsGet(_) => "reports.jobs.get",
            Self::ReportJobsCreate(_) => "reports.jobs.create",
            Self::ReportJobsDownload(_) => "reports.jobs.download",
            Self::BookkeepingList(_) => "bookkeeping.list",
            Self::BookkeepingGet(_) => "bookkeeping.get",
            Self::BookkeepingCategories(_) => "bookkeeping.categories",
            Self::BookkeepingSuggestions(_) => "bookkeeping.suggestions",
            Self::BookkeepingSetDescription(_) => "bookkeeping.set-description",
            Self::AuditTypes(_) => "audit.types",
            Self::AuditList(_) => "audit.list",
        }
    }

    pub fn params(&self) -> Value {
        match self {
            Self::HostRestart(params)
            | Self::Doctor(params)
            | Self::AccountsList(params)
            | Self::ReportsTypes(params)
            | Self::BookkeepingCategories(params)
            | Self::AuditTypes(params) => serde_json::to_value(params),
            Self::TransactionsList(params) => serde_json::to_value(params),
            Self::TransactionsGet(params)
            | Self::DebtGet(params)
            | Self::CommentsList(params)
            | Self::BookkeepingGet(params)
            | Self::BookkeepingSuggestions(params) => serde_json::to_value(params),
            Self::CommentsCreate(params) => serde_json::to_value(params),
            Self::AttachmentUpload(params) => serde_json::to_value(params),
            Self::AttachmentDelete(params) => serde_json::to_value(params),
            Self::AttachmentDownload(params) => serde_json::to_value(params),
            Self::ReportsExport(params) => serde_json::to_value(params),
            Self::ReportJobsList(params) => serde_json::to_value(params),
            Self::ReportJobsGet(params) => serde_json::to_value(params),
            Self::ReportJobsCreate(params) => serde_json::to_value(params),
            Self::ReportJobsDownload(params) => serde_json::to_value(params),
            Self::BookkeepingList(params) => serde_json::to_value(params),
            Self::BookkeepingSetDescription(params) => serde_json::to_value(params),
            Self::AuditList(params) => serde_json::to_value(params),
        }
        .expect("action parameters serialize")
    }

    fn parse(name: &str, params: Value) -> Result<Self> {
        fn decode<T: serde::de::DeserializeOwned>(params: Value) -> Result<T> {
            serde_json::from_value(params)
                .map_err(|_| anyhow::anyhow!("Local bridge action parameters are invalid."))
        }

        let action = match name {
            "host.restart" => Self::HostRestart(decode(params)?),
            "doctor" => Self::Doctor(decode(params)?),
            "transactions.list" => {
                let params: TransactionParams = decode(params)?;
                validate_date(&params.from)?;
                validate_date(&params.to)?;
                ensure!(
                    params.from.is_empty() || params.to.is_empty() || params.from <= params.to,
                    "Transaction start date must be on or before the end date."
                );
                Self::TransactionsList(params)
            }
            "transactions.get" => Self::TransactionsGet(validated_debt_params(decode(params)?)?),
            "debts.get" => Self::DebtGet(validated_debt_params(decode(params)?)?),
            "comments.list" => Self::CommentsList(validated_debt_params(decode(params)?)?),
            "comments.create" => {
                let params: CommentCreateParams = decode(params)?;
                validate_uuid(&params.debt_uuid, "Debt")?;
                validate_comment_content(&params.content)?;
                ensure!(
                    params.confirmed,
                    "Comment creation requires explicit confirmation."
                );
                Self::CommentsCreate(params)
            }
            "attachments.upload" => {
                let params: UploadParams = decode(params)?;
                validate_uuid(&params.debt_uuid, "Debt")?;
                ensure!(
                    params.file_path.is_absolute(),
                    "Receipt path must be absolute."
                );
                ensure!(
                    params.confirmed,
                    "Receipt upload requires explicit confirmation."
                );
                Self::AttachmentUpload(params)
            }
            "attachments.delete" => {
                let params: AttachmentDeleteParams = decode(params)?;
                validate_uuid(&params.debt_uuid, "Debt")?;
                validate_attachment_code(&params.attachment_code)?;
                Self::AttachmentDelete(params)
            }
            "attachments.download" => {
                let params: AttachmentDownloadParams = decode(params)?;
                validate_uuid(&params.debt_uuid, "Debt")?;
                validate_attachment_code(&params.attachment_code)?;
                validate_output_directory(&params.output_directory)?;
                Self::AttachmentDownload(params)
            }
            "accounts.list" => Self::AccountsList(decode(params)?),
            "reports.types" => Self::ReportsTypes(decode(params)?),
            "reports.export" => {
                let params: ReportExportParams = decode(params)?;
                validate_report_range(&params.from, &params.to)?;
                validate_direct_report(
                    &params.report_type,
                    &params.format,
                    params.payment_account_uuid.as_deref(),
                )?;
                if params.report_type == "account-statement" && params.format == "pdf" {
                    validate_twelve_month_range(&params.from, &params.to)?;
                }
                validate_output_directory(&params.output_directory)?;
                Self::ReportsExport(params)
            }
            "reports.jobs.list" => {
                let params: ReportJobListParams = decode(params)?;
                validate_async_report(&params.report_type)?;
                if let Some(status) = &params.status {
                    ensure!(
                        ["initiated", "ready", "error"].contains(&status.as_str()),
                        "Unsupported report status."
                    );
                }
                Self::ReportJobsList(params)
            }
            "reports.jobs.get" => {
                let params: ReportJobParams = decode(params)?;
                validate_uuid(&params.report_uuid, "Report")?;
                Self::ReportJobsGet(params)
            }
            "reports.jobs.create" => {
                let params: ReportJobCreateParams = decode(params)?;
                validate_async_report(&params.report_type)?;
                validate_report_range(&params.from, &params.to)?;
                ensure!(
                    params.confirmed,
                    "Report generation requires explicit confirmation."
                );
                if params.report_type == "all-in-one-pdf" {
                    ensure!(
                        params.payment_account_uuid.is_some(),
                        "This report requires a payment account."
                    );
                    validate_twelve_month_range(&params.from, &params.to)?;
                }
                if let Some(account) = &params.payment_account_uuid {
                    validate_uuid(account, "Payment account")?;
                }
                Self::ReportJobsCreate(params)
            }
            "reports.jobs.download" => {
                let params: ReportJobDownloadParams = decode(params)?;
                validate_uuid(&params.report_uuid, "Report")?;
                validate_output_directory(&params.output_directory)?;
                Self::ReportJobsDownload(params)
            }
            "bookkeeping.list" => {
                let params: BookkeepingListParams = decode(params)?;
                validate_report_range(&params.from, &params.to)?;
                ensure!(
                    (1..=MAX_PAGES).contains(&params.max_pages),
                    "Bookkeeping max pages must be between 1 and 200."
                );
                if let Some(account) = &params.payment_account_uuid {
                    validate_uuid(account, "Payment account")?;
                }
                Self::BookkeepingList(params)
            }
            "bookkeeping.get" => Self::BookkeepingGet(validated_debt_params(decode(params)?)?),
            "bookkeeping.categories" => Self::BookkeepingCategories(decode(params)?),
            "bookkeeping.suggestions" => {
                Self::BookkeepingSuggestions(validated_debt_params(decode(params)?)?)
            }
            "bookkeeping.set-description" => {
                let params: BookkeepingDescriptionParams = decode(params)?;
                validate_uuid(&params.debt_uuid, "Debt")?;
                validate_uuid(&params.item_uuid, "Item")?;
                ensure!(
                    params.description.len() <= BOOKKEEPING_DESCRIPTION_MAX_BYTES,
                    "Bookkeeping description must be at most 4096 bytes."
                );
                Self::BookkeepingSetDescription(params)
            }
            "audit.types" => Self::AuditTypes(decode(params)?),
            "audit.list" => {
                let params: AuditListParams = decode(params)?;
                validate_report_range(&params.from, &params.to)?;
                ensure!(
                    (AUDIT_LIMIT_MIN..=AUDIT_LIMIT_MAX).contains(&params.limit),
                    "Activity limit must be between 1 and 5000."
                );
                ensure!(
                    (1..=MAX_PAGES).contains(&params.max_pages),
                    "Activity max pages must be between 1 and 200."
                );
                ensure!(
                    params.query.as_ref().is_none_or(|value| value.len() <= 256),
                    "Activity query must be at most 256 bytes."
                );
                Self::AuditList(params)
            }
            _ => bail!("Unsupported local bridge action."),
        };
        Ok(action)
    }
}

fn validate_output_directory(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute(),
        "Export output directory must be absolute."
    );
    Ok(())
}

fn validate_report_range(from: &str, to: &str) -> Result<()> {
    ensure!(
        !from.is_empty() && !to.is_empty(),
        "Report dates are required."
    );
    validate_date(from)?;
    validate_date(to)?;
    ensure!(from <= to, "Start date must be on or before end date.");
    Ok(())
}

fn validate_twelve_month_range(from: &str, to: &str) -> Result<()> {
    let start = NaiveDate::parse_from_str(from, "%Y-%m-%d")?;
    let end = NaiveDate::parse_from_str(to, "%Y-%m-%d")?;
    let maximum = start
        .checked_add_months(chrono::Months::new(12))
        .ok_or_else(|| anyhow::anyhow!("Report range overflowed."))?;
    ensure!(
        end <= maximum,
        "This report supports at most a 12-month range."
    );
    Ok(())
}

fn validate_async_report(report_type: &str) -> Result<()> {
    ensure!(
        ["all-in-one-pdf", "all-in-one-zip"].contains(&report_type),
        "Unsupported asynchronous report type."
    );
    Ok(())
}

fn validate_direct_report(report_type: &str, format: &str, account: Option<&str>) -> Result<()> {
    let formats: &[&str] = match report_type {
        "account-statement" => &["pdf", "xls"],
        "journal" | "ledger" | "invoicing" => &["xls"],
        "camt052" => &["xml"],
        _ => bail!("Unsupported direct report type."),
    };
    ensure!(
        formats.contains(&format),
        "Unsupported format for report type."
    );
    if ["account-statement", "camt052"].contains(&report_type) {
        ensure!(account.is_some(), "This report requires a payment account.");
    }
    if let Some(value) = account {
        validate_uuid(value, "Payment account")?;
    }
    Ok(())
}

fn validated_debt_params(params: DebtParams) -> Result<DebtParams> {
    validate_uuid(&params.debt_uuid, "Debt")?;
    Ok(params)
}

pub fn validate_attachment_code(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        "Attachment code must be a nonempty bounded string."
    );
    Ok(())
}

fn validate_comment_content(content: &str) -> Result<()> {
    ensure!(
        !content.trim().is_empty(),
        "Comment content must contain non-whitespace text."
    );
    ensure!(
        content.len() <= MAX_COMMENT_CONTENT_BYTES,
        "Comment content exceeds the 16384-byte bridge limit."
    );
    Ok(())
}

fn validate_date(value: &str) -> Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    ensure!(
        value.len() == 10
            && value.as_bytes().get(4) == Some(&b'-')
            && value.as_bytes().get(7) == Some(&b'-')
            && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok(),
        "Dates must use YYYY-MM-DD calendar dates."
    );
    Ok(())
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_millis() as u64
}

pub fn sign_request(secret: &str, action: Action) -> Result<SignedBridgeRequest> {
    let mut nonce = [0_u8; 16];
    rand::rng().fill_bytes(&mut nonce);
    let request = WireBridgeRequest {
        version: SIGNED_REQUEST_VERSION,
        id: uuid::Uuid::new_v4().to_string(),
        issued_at: now_millis(),
        nonce: hex::encode(nonce),
        action: action.name().to_owned(),
        params: action.params(),
    };
    let mac = request_mac(secret, &request)?;
    Ok(SignedBridgeRequest {
        version: request.version,
        id: request.id,
        issued_at: request.issued_at,
        nonce: request.nonce,
        action: request.action,
        params: request.params,
        mac,
    })
}

pub fn verify_request(
    secret: &str,
    value: Value,
    seen_nonces: &mut HashMap<String, u64>,
    clock: u64,
) -> Result<BridgeRequest> {
    let signed: SignedBridgeRequest = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("Local bridge request is invalid or expired."))?;
    let valid_id = (16..=64).contains(&signed.id.len())
        && signed
            .id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    ensure!(
        signed.version == SIGNED_REQUEST_VERSION
            && valid_id
            && clock.abs_diff(signed.issued_at) <= REQUEST_MAX_AGE_MS
            && is_lower_hex(&signed.nonce, 32)
            && !signed.action.is_empty()
            && signed.params.is_object()
            && is_lower_hex(&signed.mac, 64),
        "Local bridge request is invalid or expired."
    );
    ensure!(
        !seen_nonces.contains_key(&signed.nonce),
        "Local bridge request nonce was already used."
    );

    let wire = WireBridgeRequest::from(&signed);
    let supplied = hex::decode(&signed.mac).expect("validated request MAC is hex");
    let verifier = hmac(secret, &wire)?;
    verifier
        .verify_slice(&supplied)
        .map_err(|_| anyhow::anyhow!("Local bridge request authentication failed."))?;

    seen_nonces.insert(signed.nonce.clone(), signed.issued_at);
    seen_nonces.retain(|_, issued_at| clock.saturating_sub(*issued_at) <= REQUEST_MAX_AGE_MS);
    let action = Action::parse(&signed.action, signed.params)?;
    Ok(BridgeRequest {
        version: signed.version,
        id: signed.id,
        issued_at: signed.issued_at,
        nonce: signed.nonce,
        action,
    })
}

fn hmac(secret: &str, request: &WireBridgeRequest) -> Result<Hmac<Sha256>> {
    let key = hex::decode(secret).map_err(|_| anyhow::anyhow!("Invalid request secret."))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("HMAC accepts keys of every size");
    mac.update(&serde_json::to_vec(request)?);
    Ok(mac)
}

fn request_mac(secret: &str, request: &WireBridgeRequest) -> Result<String> {
    Ok(hex::encode(hmac(secret, request)?.finalize().into_bytes()))
}

pub fn encode_native_message(message: &Value) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(message)?;
    ensure!(
        body.len() <= MAX_NATIVE_OUTPUT_BYTES,
        "Native message exceeds Chrome's 1 MiB host output limit."
    );
    let size = u32::try_from(body.len()).expect("native output limit fits in u32");
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&size.to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

#[derive(Default)]
pub struct NativeMessageDecoder {
    buffer: Vec<u8>,
}

impl NativeMessageDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>> {
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                break;
            }
            let size = u32::from_le_bytes(self.buffer[..4].try_into().unwrap()) as usize;
            ensure!(
                size <= MAX_NATIVE_INPUT_BYTES,
                "Chrome native message exceeds the input limit."
            );
            if self.buffer.len() < size + 4 {
                break;
            }
            let body = self.buffer[4..size + 4].to_vec();
            self.buffer.drain(..size + 4);
            messages.push(serde_json::from_slice(&body)?);
        }
        Ok(messages)
    }

    pub fn finish(&self) -> Result<()> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            bail!("Chrome native message ended before its frame was complete.")
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SECRET: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn decodes_fragmented_native_frames() {
        let frame = encode_native_message(&json!({"type": "result", "ok": true})).unwrap();
        let mut decoder = NativeMessageDecoder::default();
        assert!(decoder.push(&frame[..2]).unwrap().is_empty());
        assert!(decoder.push(&frame[2..7]).unwrap().is_empty());
        assert_eq!(
            decoder.push(&frame[7..]).unwrap(),
            vec![json!({"type": "result", "ok": true})]
        );
    }

    #[test]
    fn matches_the_existing_request_signature_format() {
        let request = WireBridgeRequest {
            version: SIGNED_REQUEST_VERSION,
            id: "11111111-1111-4111-8111-111111111111".into(),
            issued_at: 1_720_000_000_000,
            nonce: "0123456789abcdef0123456789abcdef".into(),
            action: "transactions.list".into(),
            params: json!({"from": "2026-07-01", "to": ""}),
        };
        assert_eq!(
            request_mac(SECRET, &request).unwrap(),
            "7d7b88ed228a05c90a55606b99c2017fbd2119c15415937adba8c9bb406d5cd7"
        );
    }

    #[test]
    fn authenticates_and_parses_a_typed_request_once() {
        let signed = sign_request(
            SECRET,
            Action::TransactionsList(TransactionParams {
                from: "2026-07-01".into(),
                to: "".into(),
                missing_attachments: false,
            }),
        )
        .unwrap();
        let clock = signed.issued_at;
        let mut seen = HashMap::new();
        let request = verify_request(
            SECRET,
            serde_json::to_value(&signed).unwrap(),
            &mut seen,
            clock,
        )
        .unwrap();
        assert_eq!(
            request.action,
            Action::TransactionsList(TransactionParams {
                from: "2026-07-01".into(),
                to: "".into(),
                missing_attachments: false,
            })
        );
        assert!(
            verify_request(
                SECRET,
                serde_json::to_value(signed).unwrap(),
                &mut seen,
                clock
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_tampering_and_expiration() {
        let signed = sign_request(
            SECRET,
            Action::DebtGet(DebtParams {
                debt_uuid: "11111111-1111-4111-8111-111111111111".into(),
            }),
        )
        .unwrap();
        let mut tampered = serde_json::to_value(&signed).unwrap();
        tampered["params"] = json!({"debtUuid": "22222222-2222-4222-8222-222222222222"});
        assert!(verify_request(SECRET, tampered, &mut HashMap::new(), signed.issued_at).is_err());
        assert!(
            verify_request(
                SECRET,
                serde_json::to_value(&signed).unwrap(),
                &mut HashMap::new(),
                signed.issued_at + REQUEST_MAX_AGE_MS + 1
            )
            .is_err()
        );
    }

    #[test]
    fn accepts_attachment_deletion_preview_and_confirmation() {
        for confirmed in [false, true] {
            let signed = signed_value(
                "attachments.delete",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "attachmentCode": "ATTACHMENT / 1",
                    "confirmed": confirmed
                }),
            );
            let clock = signed["issuedAt"].as_u64().unwrap();
            let request = verify_request(SECRET, signed, &mut HashMap::new(), clock).unwrap();
            assert_eq!(
                request.action,
                Action::AttachmentDelete(AttachmentDeleteParams {
                    debt_uuid: "11111111-1111-4111-8111-111111111111".into(),
                    attachment_code: "ATTACHMENT / 1".into(),
                    confirmed,
                })
            );
        }
    }

    #[test]
    fn rejects_unknown_actions_after_authentication() {
        let signed = signed_value("fetch", json!({}));
        let clock = signed["issuedAt"].as_u64().unwrap();
        let error = verify_request(SECRET, signed, &mut HashMap::new(), clock).unwrap_err();
        assert_eq!(error.to_string(), "Unsupported local bridge action.");
    }

    #[test]
    fn validates_every_action_parameter_shape() {
        let invalid = [
            ("doctor", json!({"probe": true})),
            (
                "transactions.list",
                json!({"from": "2026-02-30", "to": "", "missingAttachments": false}),
            ),
            (
                "transactions.list",
                json!({"from": "2026-07-02", "to": "2026-07-01", "missingAttachments": false}),
            ),
            (
                "transactions.list",
                json!({"from": "", "to": "", "missingAttachments": "false"}),
            ),
            ("transactions.get", json!({"debtUuid": "not-a-uuid"})),
            ("debts.get", json!({"debtUuid": "not-a-uuid"})),
            ("comments.list", json!({"debtUuid": "not-a-uuid"})),
            (
                "comments.create",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "content": "  \n",
                    "confirmed": true
                }),
            ),
            (
                "comments.create",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "content": "comment",
                    "confirmed": false
                }),
            ),
            (
                "attachments.upload",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "filePath": "receipt.pdf",
                    "confirmed": true
                }),
            ),
            (
                "attachments.upload",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "filePath": "/tmp/receipt.pdf",
                    "confirmed": false
                }),
            ),
            (
                "attachments.delete",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "attachmentCode": "",
                    "confirmed": false
                }),
            ),
            (
                "attachments.delete",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "attachmentCode": "ATTACHMENT-1",
                    "confirmed": "yes"
                }),
            ),
            (
                "attachments.download",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "attachmentCode": "ATTACHMENT-1",
                    "outputDirectory": "relative"
                }),
            ),
            (
                "reports.export",
                json!({
                    "reportType": "journal",
                    "from": "2026-01-01",
                    "to": "2026-01-31",
                    "format": "pdf",
                    "paymentAccountUuid": null,
                    "outputDirectory": "/tmp"
                }),
            ),
            (
                "reports.jobs.create",
                json!({
                    "reportType": "all-in-one-zip",
                    "from": "2026-01-01",
                    "to": "2026-01-31",
                    "paymentAccountUuid": null,
                    "confirmed": false
                }),
            ),
            (
                "bookkeeping.list",
                json!({
                    "from": "2026-01-01",
                    "to": "2026-01-31",
                    "bookkeepingStatus": null,
                    "paymentAccountUuid": null,
                    "uncategorised": false,
                    "noVat": false,
                    "noAttachment": false,
                    "externalTransactions": false,
                    "maxPages": 0
                }),
            ),
            (
                "audit.list",
                json!({
                    "from": "2026-01-01",
                    "to": "2026-01-31",
                    "typeClass": null,
                    "query": null,
                    "limit": 5001,
                    "maxPages": 1
                }),
            ),
            ("bookkeeping.get", json!({"debtUuid": ""})),
            ("bookkeeping.categories", json!({"limit": 1})),
            ("bookkeeping.suggestions", json!({})),
            (
                "bookkeeping.set-description",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "itemUuid": "not-a-uuid",
                    "description": "replacement",
                    "confirmed": false
                }),
            ),
            (
                "bookkeeping.set-description",
                json!({
                    "debtUuid": "11111111-1111-4111-8111-111111111111",
                    "itemUuid": "22222222-2222-4222-8222-222222222222",
                    "description": "x".repeat(BOOKKEEPING_DESCRIPTION_MAX_BYTES + 1),
                    "confirmed": true
                }),
            ),
            ("audit.list", json!({"limit": 0})),
            ("audit.list", json!({"limit": 26})),
        ];

        for (action, params) in invalid {
            let signed = signed_value(action, params);
            let clock = signed["issuedAt"].as_u64().unwrap();
            assert!(
                verify_request(SECRET, signed, &mut HashMap::new(), clock).is_err(),
                "accepted malformed parameters for {action}"
            );
        }
    }

    #[test]
    fn enforces_source_confirmed_report_range_limits() {
        assert!(validate_twelve_month_range("2026-01-01", "2027-01-01").is_ok());
        assert!(validate_twelve_month_range("2026-01-01", "2027-01-02").is_err());
        assert!(validate_twelve_month_range("2024-02-29", "2025-02-28").is_ok());
    }

    #[test]
    fn accepts_confirmed_bounded_comment_content_and_rejects_oversized_content() {
        let params = json!({
            "debtUuid": "11111111-1111-4111-8111-111111111111",
            "content": " exact content\n",
            "confirmed": true
        });
        let signed = signed_value("comments.create", params);
        let clock = signed["issuedAt"].as_u64().unwrap();
        let request = verify_request(SECRET, signed, &mut HashMap::new(), clock).unwrap();
        assert!(matches!(request.action, Action::CommentsCreate(_)));

        let oversized = signed_value(
            "comments.create",
            json!({
                "debtUuid": "11111111-1111-4111-8111-111111111111",
                "content": "x".repeat(MAX_COMMENT_CONTENT_BYTES + 1),
                "confirmed": true
            }),
        );
        let clock = oversized["issuedAt"].as_u64().unwrap();
        assert!(verify_request(SECRET, oversized, &mut HashMap::new(), clock).is_err());
    }

    fn signed_value(action: &str, params: Value) -> Value {
        let request = WireBridgeRequest {
            version: SIGNED_REQUEST_VERSION,
            id: "11111111-1111-4111-8111-111111111111".into(),
            issued_at: 1_720_000_000_000,
            nonce: "0123456789abcdef0123456789abcdef".into(),
            action: action.into(),
            params,
        };
        let mac = request_mac(SECRET, &request).unwrap();
        json!({
            "version": request.version,
            "id": request.id,
            "issuedAt": request.issued_at,
            "nonce": request.nonce,
            "action": request.action,
            "params": request.params,
            "mac": mac,
        })
    }
}
