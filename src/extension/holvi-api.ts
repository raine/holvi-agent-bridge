import {
  projectAuditPage,
  projectAuditTraversalPage,
  projectAuditTypes,
  projectAccounts,
  projectBookkeepingPage,
  projectReportJobs,
  projectBookkeepingDebt,
  projectCategories,
  projectCommentListing,
  projectCommentPage,
  projectDebtPreview,
  projectSuggestions,
  projectTransactionAccount,
  projectTransactionCard,
  projectTransactionDetailDebt,
  projectTransactionDetails,
  projectTransactionFeedPage,
  projectTransactionListing,
  projectTransactionPaymentMetadata,
} from "./projections.js";
import type { Auth, StaticBridgeConfig } from "./background-types.js";
import { maximumDownloadBytes } from "./policy.js";
import { BridgeSession, validateUuid } from "./session.js";

export const reportTypes = Object.freeze([
  {
    type: "account-statement",
    backend: "account-statement",
    mode: "direct",
    formats: ["pdf", "xls"],
    accountRequired: true,
    maxMonths: 12,
  },
  {
    type: "journal",
    backend: "journal-v2",
    mode: "direct",
    formats: ["xls"],
    accountRequired: false,
  },
  {
    type: "ledger",
    backend: "ledger-v2",
    mode: "direct",
    formats: ["xls"],
    accountRequired: false,
  },
  {
    type: "camt052",
    backend: "camt052",
    mode: "direct",
    formats: ["xml"],
    accountRequired: true,
  },
  {
    type: "invoicing",
    backend: "invoicing",
    mode: "direct",
    formats: ["xls"],
    accountRequired: false,
  },
  {
    type: "all-in-one-pdf",
    backend: "single_pdf",
    mode: "async",
    formats: ["pdf"],
    accountRequired: true,
    maxMonths: 12,
  },
  {
    type: "all-in-one-zip",
    backend: "zip_export",
    mode: "async",
    formats: ["zip"],
    accountRequired: false,
  },
]);
export const auditLimitMin = 1;
export const auditLimitMax = 5000;
export const auditPageSize = 25;
export const maxApiResponseBytes = 2 * 1024 * 1024;
export const commentPageSize = 25;
export const maxCommentPages = 40;
export const maxCommentResults = 1000;
export const maxCommentResponseBytes = 1024 * 1024;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function boundedResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > maxResponseBytes
    ) {
      throw new Error("Holvi API response exceeded its size limit.");
    }
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > maxResponseBytes) {
      await reader.cancel();
      throw new Error("Holvi API response exceeded its size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Holvi API returned invalid UTF-8.");
  }
}

function withinDateRange(
  payment: Record<string, unknown>,
  from: string,
  to: string,
): boolean {
  const date = asString(payment.date);
  return Boolean(date) && (!from || date >= from) && (!to || date <= to);
}

export class HolviApi {
  constructor(
    private readonly staticConfig: StaticBridgeConfig,
    private readonly session: BridgeSession,
    private readonly fetchRequest: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}

  async request(
    auth: Auth,
    apiPath: string,
    options: RequestInit = {},
    maxResponseBytes: number = maxApiResponseBytes,
  ): Promise<unknown> {
    if (!apiPath.startsWith(this.session.apiRoot())) {
      throw new Error(
        "Refused an API path outside the configured Holvi account.",
      );
    }

    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${auth.token}`);
    if (auth.csrfToken) {
      headers.set("X-CSRFToken", auth.csrfToken);
    }

    const fetchRequest = this.fetchRequest;
    const response = await fetchRequest(
      `${this.staticConfig.apiOrigin}${apiPath}`,
      {
        ...options,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      },
    );

    const contentType = response.headers.get("content-type") || "";
    const text = await boundedResponseText(response, maxResponseBytes);
    let body: unknown = text;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("Holvi API returned malformed JSON.");
      }
    }

    if (!response.ok) {
      const detail =
        typeof body === "string"
          ? body.slice(0, 300)
          : JSON.stringify(body).slice(0, 300);
      throw new Error(`Holvi API returned ${response.status}: ${detail}`);
    }

    return body;
  }

  feedPath(cursor = "", missingAttachments = false): string {
    const query = new URLSearchParams({
      timeline: "past",
      payment_account: this.session.config.paymentAccountUuid,
    });
    if (missingAttachments) {
      query.set("missing_attachments", "true");
    }
    if (cursor) {
      query.set("cursor", cursor);
    }
    return `${this.session.apiRoot()}ux/payments-feed/?${query}`;
  }

  paymentDetailPath(paymentUuid: string): string {
    return `${this.session.apiRoot()}ux/payments-feed/${encodeURIComponent(
      validateUuid(paymentUuid, "payment"),
    )}/`;
  }

  debtPath(debtUuid: string): string {
    return `${this.session.apiRoot()}debt/${encodeURIComponent(
      validateUuid(debtUuid, "debt"),
    )}/`;
  }

  cardPath(cardProfileUuid: string): string {
    return `${this.session.apiRoot()}cardprofile/${encodeURIComponent(
      validateUuid(cardProfileUuid, "card profile"),
    )}/`;
  }

  commentPath(debtUuid: string): string {
    return `${this.debtPath(debtUuid)}comment/`;
  }

  private commentContinuationPath(next: string, debtUuid: string): string {
    if (next.length > 4096) {
      throw new Error("Holvi comment pagination URL exceeded its limit.");
    }
    let url: URL;
    try {
      url = new URL(next, this.staticConfig.apiOrigin);
    } catch {
      throw new Error("Holvi comment pagination URL is invalid.");
    }
    const expectedPath = this.commentPath(debtUuid);
    if (
      url.origin !== this.staticConfig.apiOrigin ||
      url.pathname !== expectedPath ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("Holvi comment pagination changed the target endpoint.");
    }
    return `${expectedPath}${url.search}`;
  }

  async transactionFeedPage(
    auth: Auth,
    cursor = "",
    missingAttachments = false,
  ): Promise<ReturnType<typeof projectTransactionFeedPage>> {
    return projectTransactionFeedPage(
      await this.request(auth, this.feedPath(cursor, missingAttachments)),
    );
  }

  async listTransactions(
    auth: Auth,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    const missingAttachments = params.missingAttachments === true;
    let cursor = "";
    let pages = 0;

    do {
      const page = await this.transactionFeedPage(
        auth,
        cursor,
        missingAttachments,
      );
      for (const item of page.results) {
        if (withinDateRange(item, asString(params.from), asString(params.to))) {
          results.push(item);
        }
      }

      pages += 1;
      if (results.length > this.staticConfig.maxTransactionResults) {
        throw new Error("The transaction listing exceeded its result limit.");
      }
      if (pages >= this.staticConfig.maxTransactionPages && page.hasMore) {
        throw new Error("The transaction listing exceeded its page limit.");
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new Error("Holvi repeated a pagination cursor.");
      }
      seenCursors.add(cursor);
    } while (cursor);

    return projectTransactionListing({
      pages,
      count: results.length,
      missingAttachments,
      results,
    });
  }

  private async paymentUuidForDebt(
    auth: Auth,
    debtUuid: string,
  ): Promise<string | null> {
    const seenCursors = new Set<string>();
    let cursor = "";
    let paymentUuid: string | null = null;
    let pages = 0;
    let results = 0;

    do {
      const page = await this.transactionFeedPage(auth, cursor);
      pages += 1;
      results += page.results.length;
      if (results > this.staticConfig.maxTransactionResults) {
        throw new Error("The transaction lookup exceeded its result limit.");
      }
      const matches = page.results.filter(
        (item) =>
          typeof item.debtUuid === "string" &&
          item.debtUuid.toLowerCase() === debtUuid.toLowerCase(),
      );
      if (
        matches.length > 1 ||
        (matches.length === 1 && paymentUuid !== null)
      ) {
        throw new Error("Holvi returned an ambiguous payment match.");
      }
      if (matches.length === 1) {
        paymentUuid = asString(matches[0]?.paymentUuid) || null;
      }
      if (pages >= this.staticConfig.maxTransactionPages && page.hasMore) {
        throw new Error("The transaction lookup exceeded its page limit.");
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new Error("Holvi repeated a pagination cursor.");
      }
      seenCursors.add(cursor);
    } while (cursor);

    return paymentUuid;
  }

  async transactionDetails(
    auth: Auth,
    debtUuid: string,
  ): Promise<Record<string, unknown>> {
    const validUuid = validateUuid(debtUuid, "debt");
    const paymentAccountUuid = this.session.config.paymentAccountUuid;
    const debtValue = await this.request(auth, this.debtPath(validUuid));
    const debt = projectTransactionDetailDebt(
      debtValue,
      validUuid,
      paymentAccountUuid,
    );
    const preview = projectDebtPreview(
      debtValue,
      validUuid,
      paymentAccountUuid,
    );
    const [paymentUuid, account, card] = await Promise.all([
      this.paymentUuidForDebt(auth, validUuid),
      this.request(auth, this.session.apiRoot()).then((value) =>
        projectTransactionAccount(value, paymentAccountUuid),
      ),
      debt.cardProfileUuid
        ? this.request(auth, this.cardPath(debt.cardProfileUuid)).then(
            (value) =>
              projectTransactionCard(
                value,
                debt.cardProfileUuid as string,
                paymentAccountUuid,
              ),
          )
        : Promise.resolve(null),
    ]);
    const paymentMetadata = paymentUuid
      ? projectTransactionPaymentMetadata(
          await this.request(auth, this.paymentDetailPath(paymentUuid)),
          paymentUuid,
        )
      : null;
    return projectTransactionDetails({
      ...preview,
      paymentUuid,
      debtUuid: debt.debtUuid,
      valueDate: debt.valueDate ?? paymentMetadata?.valueDate ?? null,
      bookingDate: debt.bookingDate ?? paymentMetadata?.bookingDate ?? null,
      counterparty:
        debt.counterparty ??
        paymentMetadata?.counterparty ??
        preview.counterparty,
      bankReference: paymentMetadata?.bankReference ?? null,
      message: paymentMetadata?.message ?? null,
      archiveIdentifier: debt.archiveIdentifier,
      card,
      account,
      cardholder: debt.cardholder,
      exchangeRate: debt.exchangeRate,
      merchantAddress: debt.merchantAddress,
      merchantCategory: debt.merchantCategory,
      paymentType: debt.paymentType,
    });
  }

  async previewDebt(
    auth: Auth,
    debtUuid: string,
  ): Promise<Record<string, unknown>> {
    const validUuid = validateUuid(debtUuid, "debt");
    return projectDebtPreview(
      await this.request(auth, this.debtPath(validUuid)),
      validUuid,
      this.session.config.paymentAccountUuid,
    );
  }

  async listComments(
    auth: Auth,
    debtUuid: string,
  ): Promise<Record<string, unknown>> {
    const validUuid = validateUuid(debtUuid, "debt").toLowerCase();
    await this.previewDebt(auth, validUuid);
    const results: Record<string, unknown>[] = [];
    const seenPages = new Set<string>();
    let path = `${this.commentPath(validUuid)}?${new URLSearchParams({
      o: "-create_time",
      page_size: String(commentPageSize),
    })}`;
    let pages = 0;

    while (path) {
      if (seenPages.has(path)) {
        throw new Error("Holvi repeated a comment pagination URL.");
      }
      seenPages.add(path);
      const page = projectCommentPage(
        await this.request(auth, path, {}, maxCommentResponseBytes),
      );
      results.push(...page.results);
      pages += 1;
      if (results.length > maxCommentResults) {
        throw new Error("The comment listing exceeded its result limit.");
      }
      if (page.next && pages >= maxCommentPages) {
        throw new Error("The comment listing exceeded its page limit.");
      }
      path = page.next
        ? this.commentContinuationPath(page.next, validUuid)
        : "";
    }

    for (let index = 1; index < results.length; index += 1) {
      const previous = results[index - 1];
      const current = results[index];
      if (
        !previous ||
        !current ||
        Date.parse(String(previous.createTime)) <
          Date.parse(String(current.createTime))
      ) {
        throw new Error("Holvi comments are not ordered newest first.");
      }
    }
    return projectCommentListing({
      debtUuid: validUuid,
      pages,
      count: results.length,
      order: "newest-first",
      results,
    });
  }

  async bookkeepingDebt(
    auth: Auth,
    debtUuid: string,
  ): Promise<Record<string, unknown>> {
    const validUuid = validateUuid(debtUuid, "debt");
    return projectBookkeepingDebt(
      await this.request(auth, this.debtPath(validUuid)),
      validUuid,
    );
  }

  async bookkeepingCategories(auth: Auth): Promise<Record<string, unknown>[]> {
    return projectCategories(
      await this.request(auth, `${this.session.apiRoot()}category/`),
    );
  }

  async bookkeepingSuggestions(
    auth: Auth,
    debtUuid: string,
  ): Promise<Record<string, unknown>> {
    const validUuid = validateUuid(debtUuid, "debt");
    return projectSuggestions(
      await this.request(
        auth,
        `${this.debtPath(validUuid)}haip/bookkeeping-suggestions/`,
      ),
      validUuid,
    );
  }

  async downloadResponse(
    auth: Auth,
    action: string,
    params: Record<string, unknown>,
  ): Promise<{
    response: Response;
    fileName: string;
    metadata: Record<string, unknown>;
  }> {
    const fetchRequest = this.fetchRequest;
    if (action === "attachments.download") {
      const debtUuid = validateUuid(asString(params.debtUuid), "debt");
      const preview = await this.previewDebt(auth, debtUuid);
      const matches = (preview.attachments as Record<string, unknown>[]).filter(
        (item) => item.attachmentCode === params.attachmentCode,
      );
      if (matches.length !== 1)
        throw new Error(
          "Attachment does not belong uniquely to the requested debt.",
        );
      const code = asString(params.attachmentCode);
      if (
        !code ||
        Array.from(code).some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error("Attachment code is invalid.");
      const discovery = await fetchRequest(
        `https://app.holvi.com/attachment/${encodeURIComponent(code)}/`,
        { credentials: "include", cache: "no-store", redirect: "follow" },
      );
      if (!discovery.ok) {
        await discovery.body?.cancel();
        throw new Error("Holvi attachment download route failed.");
      }
      const signed = this.signedStorageUrl(discovery.url);
      await discovery.body?.cancel();
      const response = await fetchRequest(signed, {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      this.validateDownloadResponse(
        response,
        ["https://storage.holvi.com"],
        "/media/",
      );
      const attachment = matches[0] as Record<string, unknown>;
      const extension =
        asString(attachment.format)
          .replace(/[^a-z0-9]/gi, "")
          .toLowerCase() || "bin";
      return {
        response,
        fileName: `holvi-attachment-${debtUuid}.${extension}`,
        metadata: { debtUuid, attachmentCode: code },
      };
    }
    if (action === "reports.export") {
      const spec = reportTypes.find(
        (entry) => entry.type === params.reportType && entry.mode === "direct",
      );
      if (!spec || !spec.formats.includes(asString(params.format)))
        throw new Error("Unsupported direct report type or format.");
      if (spec.accountRequired && !params.paymentAccountUuid)
        throw new Error("This report requires a payment account.");
      const accounts = await this.accounts(auth);
      if (
        params.paymentAccountUuid &&
        !(accounts.results as Record<string, unknown>[]).some(
          (account) => account.paymentAccountUuid === params.paymentAccountUuid,
        )
      )
        throw new Error(
          "Payment account does not belong to the configured pool.",
        );
      const query = new URLSearchParams({
        start_date: asString(params.from),
        end_date: asString(params.to),
        format: asString(params.format),
      });
      if (params.paymentAccountUuid)
        query.set("payment_account_uuid", asString(params.paymentAccountUuid));
      const response = await fetchRequest(
        `https://app.holvi.com/group/${encodeURIComponent(this.session.config.poolHandle)}/reports/${spec.backend}/?${query}`,
        { credentials: "include", cache: "no-store", redirect: "error" },
      );
      this.validateDownloadResponse(
        response,
        ["https://app.holvi.com"],
        `/group/${this.session.config.poolHandle}/reports/`,
      );
      const extension = asString(params.format);
      return {
        response,
        fileName: `holvi-${spec.type}-${asString(params.from)}-${asString(params.to)}.${extension}`,
        metadata: { reportType: spec.type },
      };
    }
    if (action === "reports.jobs.download") {
      const reportUuid = validateUuid(asString(params.reportUuid), "report");
      const job = await this.reportJob(auth, reportUuid);
      if (job.status !== "ready")
        throw new Error("Report is not ready for download.");
      const linkValue = await this.reportingRequest(
        auth,
        `/api/reporting/reports/${reportUuid}/download/`,
      );
      const link = asString((linkValue as Record<string, unknown>)?.link);
      const signed = this.signedStorageUrl(link);
      const response = await fetchRequest(signed, {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      this.validateDownloadResponse(
        response,
        ["https://storage.holvi.com"],
        "/media/",
      );
      const extension = job.reportType === "zip_export" ? "zip" : "pdf";
      return {
        response,
        fileName: `holvi-${asString(job.fromDate)}-${asString(job.toDate)}.${extension}`,
        metadata: { reportUuid, reportType: job.reportType },
      };
    }
    throw new Error("Unsupported download action.");
  }

  private signedStorageUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Holvi returned an invalid download link.");
    }
    if (
      url.protocol !== "https:" ||
      url.origin !== "https://storage.holvi.com" ||
      !url.pathname.startsWith("/media/") ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("Holvi returned an invalid download link.");
    return url;
  }

  private validateDownloadResponse(
    response: Response,
    origins: string[],
    pathPrefix: string,
  ): void {
    const finalUrl = new URL(response.url);
    if (
      !response.ok ||
      !origins.includes(finalUrl.origin) ||
      !finalUrl.pathname.startsWith(pathPrefix) ||
      finalUrl.username ||
      finalUrl.password ||
      finalUrl.hash
    )
      throw new Error("Holvi download response failed validation.");
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      (!/^\d+$/.test(contentLength) ||
        Number(contentLength) > maximumDownloadBytes)
    )
      throw new Error("Download exceeds the maximum size.");
    const contentType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "";
    const allowedMimeTypes = new Set([
      "application/pdf",
      "application/zip",
      "application/xml",
      "text/xml",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
      "image/png",
      "image/jpeg",
      "image/gif",
    ]);
    if (!allowedMimeTypes.has(contentType))
      throw new Error("Holvi download content type is invalid.");
    const disposition = response.headers.get("content-disposition");
    if (
      disposition &&
      (disposition.length > 1024 ||
        Array.from(disposition).some(
          (character) => character.charCodeAt(0) < 32 && character !== "\t",
        ))
    )
      throw new Error("Holvi download disposition is invalid.");
  }

  async accounts(auth: Auth): Promise<Record<string, unknown>> {
    return projectAccounts(await this.request(auth, this.session.apiRoot()));
  }

  reportTypeCatalog(): unknown {
    return reportTypes;
  }

  private async reportingRequest(
    auth: Auth,
    path: string,
    options: RequestInit = {},
  ): Promise<unknown> {
    const parsed = new URL(path, this.staticConfig.apiOrigin);
    if (
      (parsed.pathname !== "/api/reporting/reports/" ||
        !["", "?"].includes(
          path.slice(parsed.pathname.length, parsed.pathname.length + 1),
        )) &&
      !/^\/api\/reporting\/reports\/[0-9a-f-]{36}\/download\/$/i.test(path)
    ) {
      throw new Error("Refused an unsupported reporting API path.");
    }
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${auth.token}`);
    if (auth.csrfToken) headers.set("X-CSRFToken", auth.csrfToken);
    const fetchRequest = this.fetchRequest;
    const response = await fetchRequest(
      `${this.staticConfig.apiOrigin}${path}`,
      {
        ...options,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      },
    );
    const text = await boundedResponseText(response, maxApiResponseBytes);
    if (!response.ok)
      throw new Error(`Holvi reporting API returned ${response.status}.`);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Holvi reporting API returned malformed JSON.");
    }
  }

  async reportJobs(
    auth: Auth,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const spec = reportTypes.find(
      (entry) => entry.type === params.reportType && entry.mode === "async",
    );
    if (!spec) throw new Error("Unsupported report type.");
    const query = new URLSearchParams({
      report_type: spec.backend,
      o: "-create_time",
      page_size: "50",
      pool: this.session.config.poolHandle,
    });
    if (typeof params.status === "string") query.set("status", params.status);
    return projectReportJobs(
      await this.reportingRequest(auth, `/api/reporting/reports/?${query}`),
    );
  }

  async reportJob(
    auth: Auth,
    reportUuid: string,
  ): Promise<Record<string, unknown>> {
    validateUuid(reportUuid, "report");
    const matches: Record<string, unknown>[] = [];
    for (const spec of reportTypes.filter((entry) => entry.mode === "async")) {
      const listing = await this.reportJobs(auth, { reportType: spec.type });
      matches.push(
        ...(listing.results as Record<string, unknown>[]).filter(
          (job) =>
            String(job.reportUuid).toLowerCase() === reportUuid.toLowerCase(),
        ),
      );
    }
    if (matches.length !== 1)
      throw new Error(
        "Report does not belong uniquely to the configured pool.",
      );
    return matches[0] as Record<string, unknown>;
  }

  async createReportJob(
    auth: Auth,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (params.confirmed !== true)
      throw new Error("Report generation requires explicit confirmation.");
    const spec = reportTypes.find(
      (entry) => entry.type === params.reportType && entry.mode === "async",
    );
    if (!spec) throw new Error("Unsupported report type.");
    if (spec.accountRequired && !params.paymentAccountUuid)
      throw new Error("This report requires a payment account.");
    const body: Record<string, unknown> = {
      from_date: params.from,
      to_date: params.to,
      report_type: spec.backend,
      pool: this.session.config.poolHandle,
    };
    if (params.paymentAccountUuid) {
      const accounts = await this.accounts(auth);
      if (
        !(accounts.results as Record<string, unknown>[]).some(
          (account) => account.paymentAccountUuid === params.paymentAccountUuid,
        )
      )
        throw new Error(
          "Payment account does not belong to the configured pool.",
        );
      body.payment_account_uuid = params.paymentAccountUuid;
    }
    await this.reportingRequest(auth, "/api/reporting/reports/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { accepted: true };
  }

  private continuation(
    next: string,
    endpoint: string,
    allowed: Set<string>,
  ): string {
    if (next.length > 4096)
      throw new Error("Holvi pagination URL exceeded its limit.");
    const url = new URL(next, this.staticConfig.apiOrigin);
    if (
      url.origin !== this.staticConfig.apiOrigin ||
      url.pathname !== endpoint ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => !allowed.has(key))
    )
      throw new Error("Holvi pagination changed the target endpoint.");
    return `${endpoint}${url.search}`;
  }

  async listBookkeeping(
    auth: Auth,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const endpoint = `${this.session.apiRoot()}debt/`;
    const query = new URLSearchParams({
      booking_date_gte: asString(params.from),
      booking_date_lte: asString(params.to),
      page_size: "100",
    });
    if (params.bookkeepingStatus)
      query.set("bookkeeping_status", asString(params.bookkeepingStatus));
    if (params.paymentAccountUuid) {
      const accounts = await this.accounts(auth);
      if (
        !(accounts.results as Record<string, unknown>[]).some(
          (account) => account.paymentAccountUuid === params.paymentAccountUuid,
        )
      )
        throw new Error(
          "Payment account does not belong to the configured pool.",
        );
      query.set("payment_account_uuid", asString(params.paymentAccountUuid));
    }
    const orOptions: Array<[string, string]> = [
      ["uncategorised", "uncategorised"],
      ["noVat", "no_vat"],
      ["noAttachment", "no_attachment"],
    ];
    const ors = orOptions
      .filter(([key]) => params[key] === true)
      .map(([, value]) => value);
    if (ors.length) query.set("or_filters", ors.join(","));
    if (params.externalTransactions === true)
      query.set("subtype_csv", "external_transaction,card");
    const allowed = new Set([
      "booking_date_gte",
      "booking_date_lte",
      "page_size",
      "page",
      "cursor",
      "bookkeeping_status",
      "payment_account_uuid",
      "or_filters",
      "subtype_csv",
    ]);
    const results: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let path = `${endpoint}?${query}`;
    let pages = 0;
    let truncated = false;
    while (path) {
      if (seen.has(path))
        throw new Error("Holvi repeated a bookkeeping pagination URL.");
      seen.add(path);
      const page = projectBookkeepingPage(await this.request(auth, path));
      results.push(...page.results);
      pages += 1;
      if (results.length > 20000)
        throw new Error("Bookkeeping listing exceeded its result limit.");
      if (page.next && pages >= Number(params.maxPages)) {
        truncated = true;
        break;
      }
      path = page.next ? this.continuation(page.next, endpoint, allowed) : "";
    }
    const ids = results.map((entry) => String(entry.debtUuid).toLowerCase());
    if (new Set(ids).size !== ids.length)
      throw new Error("Holvi returned duplicate bookkeeping debts.");
    return {
      pages,
      count: results.length,
      truncated,
      filters: {
        from: params.from,
        to: params.to,
        paymentAccountUuid: params.paymentAccountUuid ?? null,
        orFilters: ors,
        subtypes:
          params.externalTransactions === true
            ? ["external_transaction", "card"]
            : [],
      },
      results,
    };
  }

  async auditTypes(auth: Auth): Promise<Record<string, unknown>> {
    return projectAuditTypes(
      await this.request(
        auth,
        `${this.session.apiRoot()}log-feed/type-classes/`,
      ),
    );
  }

  async historicalAudit(
    auth: Auth,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const endpoint = `${this.session.apiRoot()}log-feed/`;
    const query = new URLSearchParams({
      o: "-timestamp",
      page_size: String(auditPageSize),
      timestamp_from: asString(params.from),
      timestamp_to: asString(params.to),
    });
    if (params.typeClass) {
      const types = await this.auditTypes(auth);
      if (!(types.results as string[]).includes(asString(params.typeClass))) {
        throw new Error(
          "Activity type class is unavailable for the configured pool.",
        );
      }
      query.set("type_class", asString(params.typeClass));
    }
    if (params.query) query.set("q", asString(params.query));
    const allowed = new Set([
      "o",
      "page_size",
      "timestamp_from",
      "timestamp_to",
      "type_class",
      "q",
      "page",
      "cursor",
    ]);
    const results: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let path = `${endpoint}?${query}`;
    let pages = 0;
    let truncated = false;
    while (path && results.length < Number(params.limit)) {
      if (seen.has(path))
        throw new Error("Holvi repeated an activity pagination URL.");
      seen.add(path);
      const page = projectAuditTraversalPage(await this.request(auth, path));
      results.push(...page.results);
      pages += 1;
      if (
        page.next &&
        (pages >= Number(params.maxPages) ||
          results.length >= Number(params.limit))
      ) {
        truncated = true;
        break;
      }
      path = page.next ? this.continuation(page.next, endpoint, allowed) : "";
    }
    const limited = results.slice(0, Number(params.limit));
    for (let index = 1; index < limited.length; index += 1)
      if (
        Date.parse(String(limited[index - 1]?.timestamp)) <
        Date.parse(String(limited[index]?.timestamp))
      )
        throw new Error("Holvi activity feed is not ordered newest first.");
    return {
      pages,
      count: limited.length,
      returnedCount: limited.length,
      truncated: truncated || results.length > limited.length,
      order: "newest-first",
      filters: {
        from: params.from,
        to: params.to,
        typeClass: params.typeClass ?? null,
        query: params.query ?? null,
      },
      results: limited,
    };
  }

  async recentAudit(
    auth: Auth,
    limit: unknown,
  ): Promise<Record<string, unknown>> {
    if (
      !Number.isSafeInteger(limit) ||
      (limit as number) < auditLimitMin ||
      (limit as number) > auditLimitMax
    ) {
      throw new Error("Activity limit must be between 1 and 25.");
    }
    return projectAuditPage(
      await this.request(
        auth,
        `${this.session.apiRoot()}log-feed/?o=-timestamp&page_size=${auditPageSize}`,
      ),
      limit as number,
    );
  }
}
