import {
  projectAuditPage,
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
} from "./projections.js";
import type { Auth, StaticBridgeConfig } from "./background-types.js";
import { BridgeSession, validateUuid } from "./session.js";

export const auditLimitMin = 1;
export const auditLimitMax = 25;
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
    return projectTransactionDetails({
      ...preview,
      paymentUuid,
      debtUuid: debt.debtUuid,
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
