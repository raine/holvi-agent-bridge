import {
  projectAuditPage,
  projectBookkeepingDebt,
  projectCategories,
  projectDebtPreview,
  projectSuggestions,
  projectTransactionFeedPage,
  projectTransactionListing,
} from "./projections.js";
import type { Auth, StaticBridgeConfig } from "./background-types.js";
import { BridgeSession, validateUuid } from "./session.js";

export const auditLimitMin = 1;
export const auditLimitMax = 25;
export const auditPageSize = 25;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
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
    const body: unknown = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

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
