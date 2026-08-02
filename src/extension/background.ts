import {
  projectAuditPage,
  projectBookkeepingDebt,
  projectCategories,
  projectDebtPreview,
  projectSuggestions,
  projectTransactionFeedPage,
  projectTransactionListing,
  projectUploadDebtRead,
} from "./projections.js";
import {
  isBridgeAction,
  requiredCapabilities,
  supportedCapabilities,
  type CommandAction,
} from "./policy.js";
import {
  UploadTransferLifecycle,
  type UploadTransfer,
  uploadTransferExpiryMs,
  verifyUploadTransfer,
} from "./upload-transfer.js";

declare function importScripts(...urls: string[]): void;

importScripts("config.js");

const staticConfig = _HOLVI_AGENT_BRIDGE_STATIC_CONFIG;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestIdPattern = /^[0-9a-f-]{16,64}$/i;

interface RuntimeBridgeConfig {
  groupPathSegment: string;
  poolHandle: string;
  paymentAccountUuid: string;
  capabilities: string[];
  maxFileBytes: number;
}

interface TabConnection {
  port: chrome.runtime.Port;
  href: string;
  groupPathSegment: string;
}

interface Auth {
  token: string;
  csrfToken: string;
}

interface PendingAuth {
  resolve: (auth: Auth) => void;
  reject: (error: Error) => void;
  timeout: number;
  tabId: number;
}

interface NativeMessage {
  type?: string;
  id?: string;
  action?: string;
  params?: Record<string, unknown>;
  config?: unknown;
  debtUuid?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
  chunkCount?: number;
  index?: number;
  data?: string;
}

let runtimeConfig: RuntimeBridgeConfig | null = null;
let nativePort: chrome.runtime.Port | null = null;
let reconnectTimer: number | null = null;
let uploadExpiryTimer: number | null = null;
const uploadTransfers = new UploadTransferLifecycle();
const tabConnections = new Map<number, TabConnection>();
const authRequests = new Map<string, PendingAuth>();

function groupPathSegmentFromUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.origin !== staticConfig.accountOrigin) {
      return "";
    }
    const match = url.pathname.match(/^\/group\/([^/]+)(?:\/|$)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function validateRuntimeConfig(value: unknown): RuntimeBridgeConfig {
  const config = value as Partial<RuntimeBridgeConfig>;
  const groupParts = (config.groupPathSegment || "").match(
    /^([^/+]+)\+([^/]+)$/,
  );
  const groupPoolHandle = groupParts?.[1] || "";
  if (
    !groupParts ||
    groupPoolHandle !== config.poolHandle ||
    !uuidPattern.test(config.paymentAccountUuid || "") ||
    !Array.isArray(config.capabilities) ||
    config.capabilities.length < 1 ||
    config.capabilities.some(
      (capability) => !supportedCapabilities.has(capability),
    ) ||
    new Set(config.capabilities).size !== config.capabilities.length ||
    !Number.isSafeInteger(config.maxFileBytes) ||
    (config.maxFileBytes || 0) < 1 ||
    (config.maxFileBytes || 0) > staticConfig.maxFileBytes
  ) {
    throw new Error(
      "The native host supplied an invalid Holvi account boundary.",
    );
  }
  return config as RuntimeBridgeConfig;
}

function requireCapabilities(...capabilities: string[]): void {
  if (
    !runtimeConfig ||
    capabilities.some(
      (capability) => !runtimeConfig?.capabilities.includes(capability),
    )
  ) {
    throw new Error(
      `Action requires capabilities: ${capabilities.join(", ")}.`,
    );
  }
}

function configuredTab(): [number, TabConnection] | null {
  if (!runtimeConfig) {
    return null;
  }
  for (const entry of tabConnections) {
    if (entry[1].groupPathSegment === runtimeConfig.groupPathSegment) {
      return entry;
    }
  }
  return null;
}

function postNative(message: unknown): void {
  if (!nativePort) {
    throw new Error("The local Holvi helper is disconnected.");
  }
  nativePort.postMessage(message);
}

function reportTabState(): void {
  if (!nativePort || !runtimeConfig) {
    return;
  }
  const tab = configuredTab();
  nativePort.postMessage(
    tab ? { type: "tab_ready", tabId: tab[0] } : { type: "tab_unavailable" },
  );
}

function clearUploadExpiry(): void {
  if (uploadExpiryTimer !== null) {
    clearTimeout(uploadExpiryTimer);
    uploadExpiryTimer = null;
  }
}

function scheduleUploadExpiry(): void {
  clearUploadExpiry();
  uploadExpiryTimer = self.setTimeout(() => {
    uploadExpiryTimer = null;
    const expiredId = uploadTransfers.expire(Date.now());
    if (expiredId) {
      postResult(expiredId, false, new Error("Receipt transfer expired."));
    }
  }, uploadTransferExpiryMs);
}

function postResult(id: string, ok: boolean, value: unknown): void {
  try {
    postNative(
      ok
        ? { type: "result", id, ok, data: value }
        : {
            type: "result",
            id,
            ok,
            error: value instanceof Error ? value.message : String(value),
          },
    );
  } catch {
    // A disconnected native port has no response destination.
  }
}

function connectNative(): void {
  if (nativePort || tabConnections.size === 0) {
    return;
  }

  nativePort = chrome.runtime.connectNative(staticConfig.nativeHostName);
  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    nativePort = null;
    runtimeConfig = null;
    uploadTransfers.cancel();
    clearUploadExpiry();
    if (tabConnections.size > 0 && reconnectTimer === null) {
      reconnectTimer = self.setTimeout(() => {
        reconnectTimer = null;
        connectNative();
      }, 1000);
    }
  });
}

function requestAuth(): Promise<Auth> {
  const tab = configuredTab();
  if (!tab) {
    return Promise.reject(
      new Error("Open the configured signed-in Holvi group tab in Chrome."),
    );
  }

  const [tabId, connection] = tab;
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = self.setTimeout(() => {
      authRequests.delete(requestId);
      reject(
        new Error("The Holvi tab did not provide session authentication."),
      );
    }, 5000);

    authRequests.set(requestId, { resolve, reject, timeout, tabId });
    connection.port.postMessage({ type: "auth_request", requestId });
  });
}

interface ContentMessage {
  type?: string;
  requestId?: string;
  href?: string;
  origin?: string;
  pathname?: string;
  token?: string;
  csrfToken?: string;
}

function handleContentMessage(tabId: number, value: unknown): void {
  const message = value as ContentMessage;
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "tab_hello") {
    const groupPathSegment = groupPathSegmentFromUrl(message.href || "");
    const connection = tabConnections.get(tabId);
    if (!connection || !groupPathSegment) {
      connection?.port.disconnect();
      return;
    }
    connection.href = message.href || "";
    connection.groupPathSegment = groupPathSegment;
    connectNative();
    reportTabState();
    return;
  }

  if (message.type !== "auth_response" || !message.requestId) {
    return;
  }

  const pending = authRequests.get(message.requestId);
  if (!pending || pending.tabId !== tabId) {
    return;
  }

  authRequests.delete(message.requestId);
  clearTimeout(pending.timeout);

  if (
    !runtimeConfig ||
    message.origin !== staticConfig.accountOrigin ||
    groupPathSegmentFromUrl(message.href || "") !==
      runtimeConfig.groupPathSegment
  ) {
    pending.reject(
      new Error("The bridge tab is outside the configured Holvi group."),
    );
    return;
  }

  const token = typeof message.token === "string" ? message.token : "";
  if (
    token.length < 32 ||
    token.length > 8192 ||
    token.split(".").length !== 3
  ) {
    pending.reject(
      new Error("Sign in to Holvi or reload the configured group tab."),
    );
    return;
  }

  pending.resolve({
    token,
    csrfToken: typeof message.csrfToken === "string" ? message.csrfToken : "",
  });
}

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  const href = port.sender?.tab?.url || "";
  const groupPathSegment = groupPathSegmentFromUrl(href);
  if (
    port.name !== "holvi-tab" ||
    !Number.isInteger(tabId) ||
    !groupPathSegment
  ) {
    port.disconnect();
    return;
  }

  const validTabId = tabId as number;
  tabConnections.get(validTabId)?.port.disconnect();
  tabConnections.set(validTabId, { port, href, groupPathSegment });
  port.onMessage.addListener((message) =>
    handleContentMessage(validTabId, message),
  );
  port.onDisconnect.addListener(() => {
    if (tabConnections.get(validTabId)?.port === port) {
      tabConnections.delete(validTabId);
      for (const [requestId, pending] of authRequests) {
        if (pending.tabId === validTabId) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("The Holvi tab disconnected."));
          authRequests.delete(requestId);
        }
      }
      reportTabState();
    }
  });
  connectNative();
});

function configuredApiRoot(): string {
  if (!runtimeConfig) {
    throw new Error("The local bridge has no configured Holvi account.");
  }
  return `/api/pool/${encodeURIComponent(runtimeConfig.poolHandle)}/`;
}

async function apiRequest(
  auth: Auth,
  apiPath: string,
  options: RequestInit = {},
): Promise<unknown> {
  if (!apiPath.startsWith(configuredApiRoot())) {
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

  const response = await fetch(`${staticConfig.apiOrigin}${apiPath}`, {
    ...options,
    headers,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
  });

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

function feedPath(cursor = "", missingAttachments = false): string {
  if (!runtimeConfig) {
    throw new Error("The local bridge has no configured Holvi account.");
  }
  const query = new URLSearchParams({
    timeline: "past",
    payment_account: runtimeConfig.paymentAccountUuid,
  });
  if (missingAttachments) {
    query.set("missing_attachments", "true");
  }
  if (cursor) {
    query.set("cursor", cursor);
  }
  return `${configuredApiRoot()}ux/payments-feed/?${query}`;
}

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

async function listTransactions(
  auth: Auth,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  const missingAttachments = params.missingAttachments === true;
  let cursor = "";
  let pages = 0;

  do {
    const page = projectTransactionFeedPage(
      await apiRequest(auth, feedPath(cursor, missingAttachments)),
    );
    for (const item of page.results) {
      if (withinDateRange(item, asString(params.from), asString(params.to))) {
        results.push(item);
      }
    }

    pages += 1;
    if (results.length > staticConfig.maxTransactionResults) {
      throw new Error("The transaction listing exceeded its result limit.");
    }
    if (pages >= staticConfig.maxTransactionPages && page.hasMore) {
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

function validateUuid(value: string, resource: string): string {
  if (!uuidPattern.test(value || "")) {
    throw new Error(`A valid Holvi ${resource} UUID is required.`);
  }
  return value;
}

function debtPath(debtUuid: string): string {
  return `${configuredApiRoot()}debt/${encodeURIComponent(
    validateUuid(debtUuid, "debt"),
  )}/`;
}

async function previewDebt(
  auth: Auth,
  debtUuid: string,
): Promise<Record<string, unknown>> {
  const validUuid = validateUuid(debtUuid, "debt");
  return projectDebtPreview(
    await apiRequest(auth, debtPath(validUuid)),
    validUuid,
  );
}

async function bookkeepingDebt(
  auth: Auth,
  debtUuid: string,
): Promise<Record<string, unknown>> {
  const validUuid = validateUuid(debtUuid, "debt");
  return projectBookkeepingDebt(
    await apiRequest(auth, debtPath(validUuid)),
    validUuid,
  );
}

async function bookkeepingCategories(
  auth: Auth,
): Promise<Record<string, unknown>[]> {
  return projectCategories(
    await apiRequest(auth, `${configuredApiRoot()}category/`),
  );
}

async function bookkeepingSuggestions(
  auth: Auth,
  debtUuid: string,
): Promise<Record<string, unknown>> {
  const validUuid = validateUuid(debtUuid, "debt");
  return projectSuggestions(
    await apiRequest(
      auth,
      `${debtPath(validUuid)}haip/bookkeeping-suggestions/`,
    ),
    validUuid,
  );
}

async function recentAudit(
  auth: Auth,
  limit: unknown,
): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > 25
  ) {
    throw new Error("Activity limit must be between 1 and 25.");
  }
  return projectAuditPage(
    await apiRequest(
      auth,
      `${configuredApiRoot()}log-feed/?o=-timestamp&page_size=25`,
    ),
    limit as number,
  );
}

async function uploadReceipt(
  auth: Auth,
  upload: UploadTransfer,
): Promise<Record<string, unknown>> {
  requireCapabilities("transactions.read", "attachments.write");
  const debtUuid = validateUuid(upload.debtUuid, "debt");
  const before = projectUploadDebtRead(
    await apiRequest(auth, debtPath(debtUuid)),
    debtUuid,
  );
  const beforeCount = before.attachmentCount as number;
  if (beforeCount !== 0) {
    throw new Error(
      `Upload refused because the transaction has ${beforeCount} attachment(s).`,
    );
  }
  if (typeof before?.code !== "string" || !before.code) {
    throw new Error(
      "Holvi did not return the object code required for upload.",
    );
  }

  const bytes = await verifyUploadTransfer(upload);

  const form = new FormData();
  form.append("content_type", "debt");
  form.append("object_code", before.code);
  form.append(
    "attachment_file",
    new File([bytes], upload.fileName, { type: upload.mimeType }),
  );

  await apiRequest(auth, `${configuredApiRoot()}attachment/formpost/`, {
    method: "POST",
    body: form,
  });

  let afterCount = 0;
  for (const delay of [0, 250, 500, 1000, 2000]) {
    if (delay) {
      await new Promise((resolve) => self.setTimeout(resolve, delay));
    }
    const after = projectUploadDebtRead(
      await apiRequest(auth, debtPath(debtUuid)),
      debtUuid,
    );
    afterCount = after.attachmentCount as number;
    if (afterCount > 0) {
      break;
    }
  }

  if (afterCount !== 1) {
    throw new Error(
      `Holvi accepted the upload but verification found ${afterCount} attachment(s). Inspect the transaction before retrying.`,
    );
  }

  return {
    debtUuid,
    fileName: upload.fileName,
    sha256: upload.sha256,
    attachmentCountBefore: beforeCount,
    attachmentCountAfter: afterCount,
  };
}

async function doctor(auth: Auth): Promise<Record<string, unknown>> {
  const base = {
    connected: true,
    groupPathSegment: runtimeConfig?.groupPathSegment,
    poolHandle: runtimeConfig?.poolHandle,
    paymentAccountUuid: runtimeConfig?.paymentAccountUuid,
    capabilities: runtimeConfig?.capabilities,
  };
  if (runtimeConfig?.capabilities.includes("transactions.read")) {
    requireCapabilities("transactions.read");
    const page = projectTransactionFeedPage(await apiRequest(auth, feedPath()));
    return {
      ...base,
      probeAction: "transactions",
      firstPageResults: page.results.length,
    };
  }
  if (runtimeConfig?.capabilities.includes("bookkeeping.read")) {
    requireCapabilities("bookkeeping.read");
    const categories = await bookkeepingCategories(auth);
    return {
      ...base,
      probeAction: "bookkeeping.categories",
      categoryCount: categories.length,
    };
  }
  if (runtimeConfig?.capabilities.includes("audit.read")) {
    requireCapabilities("audit.read");
    const audit = await recentAudit(auth, 1);
    return {
      ...base,
      probeAction: "audit.list",
      recentActivityCount: audit.returnedCount,
    };
  }
  return { ...base, probeAction: null };
}

type CommandHandler = (
  auth: Auth,
  params: Record<string, unknown>,
) => Promise<unknown>;

const commandHandlers = {
  doctor: (auth) => doctor(auth),
  transactions: (auth, params) => listTransactions(auth, params),
  preview: (auth, params) => previewDebt(auth, asString(params.debtUuid)),
  "bookkeeping.get": (auth, params) =>
    bookkeepingDebt(auth, asString(params.debtUuid)),
  "bookkeeping.categories": (auth) => bookkeepingCategories(auth),
  "bookkeeping.suggestions": (auth, params) =>
    bookkeepingSuggestions(auth, asString(params.debtUuid)),
  "audit.list": (auth, params) => recentAudit(auth, params.limit),
} satisfies Record<CommandAction, CommandHandler>;

async function handleCommand(message: NativeMessage): Promise<unknown> {
  const action = message.action || "";
  if (!isBridgeAction(action)) {
    throw new Error("The local helper requested an unsupported action.");
  }
  const requirements = requiredCapabilities(action);
  if (!requirements) {
    throw new Error("The local helper requested an unsupported action.");
  }
  requireCapabilities(...requirements);
  if (action === "upload") {
    throw new Error("Receipt uploads require transfer messages.");
  }
  const auth = await requestAuth();
  return commandHandlers[action](auth, message.params || {});
}

async function finishUpload(upload: UploadTransfer): Promise<unknown> {
  const auth = await requestAuth();
  return uploadReceipt(auth, upload);
}

function handleNativeMessage(value: unknown): void {
  const message = value as NativeMessage;
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "host_ready") {
    try {
      runtimeConfig = validateRuntimeConfig(message.config);
      reportTabState();
    } catch (_error) {
      nativePort?.disconnect();
    }
    return;
  }

  if (!requestIdPattern.test(message.id || "")) {
    return;
  }
  const id = message.id as string;

  if (message.type === "command") {
    handleCommand(message)
      .then((data) => postResult(id, true, data))
      .catch((error) => postResult(id, false, error));
    return;
  }

  if (message.type === "upload_start") {
    try {
      uploadTransfers.start(
        {
          id,
          debtUuid: message.debtUuid,
          fileName: message.fileName,
          mimeType: message.mimeType,
          size: message.size,
          sha256: message.sha256,
          chunkCount: message.chunkCount,
        },
        runtimeConfig?.maxFileBytes || 0,
        Date.now(),
      );
      scheduleUploadExpiry();
    } catch (error) {
      postResult(id, false, error);
    }
    return;
  }

  if (message.type === "upload_chunk") {
    try {
      uploadTransfers.append(id, message.index, message.data, Date.now());
    } catch (error) {
      if (!uploadTransfers.hasActiveTransfer()) {
        clearUploadExpiry();
      }
      postResult(id, false, error);
    }
    return;
  }

  if (message.type === "upload_end") {
    let upload: UploadTransfer;
    try {
      upload = uploadTransfers.complete(id, Date.now());
      clearUploadExpiry();
    } catch (error) {
      if (!uploadTransfers.hasActiveTransfer()) {
        clearUploadExpiry();
      }
      postResult(id, false, error);
      return;
    }
    finishUpload(upload)
      .then((data) => postResult(id, true, data))
      .catch((error) => postResult(id, false, error))
      .finally(() => uploadTransfers.finish(id));
  }
}
