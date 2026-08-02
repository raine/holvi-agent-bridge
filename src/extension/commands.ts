import type { Auth, NativeMessage } from "./background-types.js";
import { HolviApi } from "./holvi-api.js";
import {
  isBridgeAction,
  requiredCapabilities,
  type CommandAction,
} from "./policy.js";
import { BridgeSession } from "./session.js";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type CommandHandler = (
  auth: Auth,
  params: Record<string, unknown>,
) => Promise<unknown>;

export class CommandService {
  private readonly handlers: Record<CommandAction, CommandHandler>;

  constructor(
    private readonly session: BridgeSession,
    private readonly api: HolviApi,
    private readonly requestAuth: () => Promise<Auth>,
  ) {
    this.handlers = {
      doctor: (auth) => this.doctor(auth),
      transactions: (auth, params) => this.api.listTransactions(auth, params),
      preview: (auth, params) =>
        this.api.previewDebt(auth, asString(params.debtUuid)),
      "bookkeeping.get": (auth, params) =>
        this.api.bookkeepingDebt(auth, asString(params.debtUuid)),
      "bookkeeping.categories": (auth) => this.api.bookkeepingCategories(auth),
      "bookkeeping.suggestions": (auth, params) =>
        this.api.bookkeepingSuggestions(auth, asString(params.debtUuid)),
      "audit.list": (auth, params) => this.api.recentAudit(auth, params.limit),
    };
  }

  async handle(message: NativeMessage): Promise<unknown> {
    const action = message.action || "";
    if (!isBridgeAction(action)) {
      throw new Error("The local helper requested an unsupported action.");
    }
    const requirements = requiredCapabilities(action);
    if (!requirements) {
      throw new Error("The local helper requested an unsupported action.");
    }
    this.session.requireCapabilities(...requirements);
    if (action === "upload") {
      throw new Error("Receipt uploads require transfer messages.");
    }
    const auth = await this.requestAuth();
    return this.handlers[action](auth, message.params || {});
  }

  private async doctor(auth: Auth): Promise<Record<string, unknown>> {
    const config = this.session.optionalConfig;
    const base = {
      connected: true,
      groupPathSegment: config?.groupPathSegment,
      poolHandle: config?.poolHandle,
      paymentAccountUuid: config?.paymentAccountUuid,
      capabilities: config?.capabilities,
    };
    if (config?.capabilities.includes("transactions.read")) {
      this.session.requireCapabilities("transactions.read");
      const page = await this.api.transactionFeedPage(auth);
      return {
        ...base,
        probeAction: "transactions",
        firstPageResults: page.results.length,
      };
    }
    if (config?.capabilities.includes("bookkeeping.read")) {
      this.session.requireCapabilities("bookkeeping.read");
      const categories = await this.api.bookkeepingCategories(auth);
      return {
        ...base,
        probeAction: "bookkeeping.categories",
        categoryCount: categories.length,
      };
    }
    if (config?.capabilities.includes("audit.read")) {
      this.session.requireCapabilities("audit.read");
      const audit = await this.api.recentAudit(auth, 1);
      return {
        ...base,
        probeAction: "audit.list",
        recentActivityCount: audit.returnedCount,
      };
    }
    return { ...base, probeAction: null };
  }
}
