import type { Auth, NativeMessage } from "./background-types.js";
import { AttachmentDeletionWorkflow } from "./attachment-deletion-workflow.js";
import { BookkeepingDescriptionWorkflow } from "./bookkeeping-description-workflow.js";
import { CommentWorkflow } from "./comment-workflow.js";
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

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("The local helper supplied invalid description data.");
  }
  return value;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("The local helper supplied invalid confirmation data.");
  }
  return value;
}

type CommandHandler = (
  auth: Auth,
  params: Record<string, unknown>,
) => Promise<unknown>;

export class CommandService {
  private readonly handlers: Record<CommandAction, CommandHandler>;
  private readonly attachmentDeletion: AttachmentDeletionWorkflow;
  private readonly bookkeepingDescriptions: BookkeepingDescriptionWorkflow;
  private readonly comments: CommentWorkflow;

  constructor(
    private readonly session: BridgeSession,
    private readonly api: HolviApi,
    private readonly requestAuth: () => Promise<Auth>,
  ) {
    this.attachmentDeletion = new AttachmentDeletionWorkflow(session, api);
    this.bookkeepingDescriptions = new BookkeepingDescriptionWorkflow(
      session,
      api,
    );
    this.comments = new CommentWorkflow(session, api);
    this.handlers = {
      doctor: (auth) => this.doctor(auth),
      "transactions.list": (auth, params) =>
        this.api.listTransactions(auth, params),
      "debts.get": (auth, params) =>
        this.api.previewDebt(auth, asString(params.debtUuid)),
      "comments.list": (auth, params) =>
        this.api.listComments(auth, asString(params.debtUuid)),
      "comments.create": (auth, params) =>
        this.comments.createComment(auth, params),
      "attachments.delete": (auth, params) =>
        this.attachmentDeletion.deleteAttachment(auth, params),
      "bookkeeping.get": (auth, params) =>
        this.api.bookkeepingDebt(auth, asString(params.debtUuid)),
      "bookkeeping.categories": (auth) => this.api.bookkeepingCategories(auth),
      "bookkeeping.suggestions": (auth, params) =>
        this.api.bookkeepingSuggestions(auth, asString(params.debtUuid)),
      "bookkeeping.set-description": (auth, params) =>
        this.bookkeepingDescriptions.change(auth, {
          debtUuid: asString(params.debtUuid),
          itemUuid: asString(params.itemUuid),
          description: requiredString(params.description),
          confirmed: asBoolean(params.confirmed),
        }),
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
    if (action === "attachments.upload") {
      throw new Error("Receipt uploads require transfer messages.");
    }
    const auth = await this.requestAuth();
    return this.handlers[action](auth, message.params || {});
  }

  private async doctor(auth: Auth): Promise<Record<string, unknown>> {
    const config = this.session.optionalConfig;
    const identity = this.session.identity;
    const base = {
      connected: true,
      groupPathSegment: config?.groupPathSegment,
      poolHandle: config?.poolHandle,
      paymentAccountUuid: config?.paymentAccountUuid,
      capabilities: config?.capabilities,
      protocolVersion: identity.protocolVersion,
      hostVersion: identity.hostVersion,
      extensionVersion: this.session.extensionVersion,
    };
    if (config?.capabilities.includes("transactions.read")) {
      this.session.requireCapabilities("transactions.read");
      const page = await this.api.transactionFeedPage(auth);
      return {
        ...base,
        probeAction: "transactions.list",
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
