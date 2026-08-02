import {
  projectAuditPage,
  projectBookkeepingDebt,
  projectCategories,
  projectSuggestions,
} from "./projections.js";
import { requiredCapabilities, supportedCapabilities } from "./policy.js";

declare function importScripts(...urls: string[]): void;

importScripts("config.js");

const staticConfig = _HOLVI_AGENT_BRIDGE_STATIC_CONFIG;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestIdPattern = /^[0-9a-f-]{16,64}$/i;
const uploadMimeTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
]);
const fileChunkBytes = 480 * 1024;

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

interface PaymentRecord {
  uuid?: unknown;
  ux_timestamp?: unknown;
  description?: unknown;
  counterparty?: { display_name?: unknown };
  counterparty_name?: unknown;
  direction?: unknown;
  amount?: unknown;
  value?: unknown;
  currency?: unknown;
  state?: unknown;
  fx_meta?: {
    counterparty_amount?: unknown;
    counterparty_value?: unknown;
    counterparty_currency?: unknown;
  } | null;
  attachment_count?: unknown;
  matches?: Array<{
    match_type?: unknown;
    uuid?: unknown;
  }>;
}

interface UploadTransfer {
  id: string;
  debtUuid: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkCount: number;
  chunks: string[];
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
let activeUpload: UploadTransfer | null = null;
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

function validUploadFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
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
    activeUpload = null;
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

function directDebtUuid(payment: PaymentRecord): string | null {
  const directMatch = Array.isArray(payment.matches)
    ? payment.matches.find((match) => match?.match_type === "direct")
    : undefined;
  const uuid = asString(directMatch?.uuid);
  return uuidPattern.test(uuid) ? uuid : null;
}

function projectPayment(payment: PaymentRecord): Record<string, unknown> {
  const paymentUuid = validateUuid(asString(payment.uuid), "payment");
  const timestamp = asString(payment.ux_timestamp);
  const counterparty =
    asString(payment.counterparty?.display_name) ||
    asString(payment.counterparty_name) ||
    asString(payment.description);
  const originalAmount =
    payment.fx_meta?.counterparty_amount ??
    payment.fx_meta?.counterparty_value ??
    null;
  const originalCurrency = payment.fx_meta?.counterparty_currency ?? null;

  return {
    paymentUuid,
    debtUuid: directDebtUuid(payment),
    date: timestamp.slice(0, 10),
    timestamp,
    counterparty,
    description: asString(payment.description),
    direction: asString(payment.direction),
    amount: payment.amount ?? payment.value ?? null,
    currency: asString(payment.currency) || "EUR",
    originalAmount,
    originalCurrency,
    state: asString(payment.state),
    attachmentCount: Number(payment.attachment_count || 0),
  };
}

function withinDateRange(
  payment: Record<string, unknown>,
  from: string,
  to: string,
): boolean {
  const date = asString(payment.date);
  return Boolean(date) && (!from || date >= from) && (!to || date <= to);
}

interface FeedPage {
  results?: PaymentRecord[];
  pagination?: { has_more?: boolean; next_cursor?: string };
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
    const page = (await apiRequest(
      auth,
      feedPath(cursor, missingAttachments),
    )) as FeedPage;
    if (
      !Array.isArray(page?.results) ||
      typeof page?.pagination?.has_more !== "boolean"
    ) {
      throw new Error("Holvi returned an unexpected payments feed shape.");
    }
    for (const item of page.results) {
      const projected = projectPayment(item);
      if (
        withinDateRange(projected, asString(params.from), asString(params.to))
      ) {
        results.push(projected);
      }
    }

    pages += 1;
    if (results.length > staticConfig.maxTransactionResults) {
      throw new Error("The transaction listing exceeded its result limit.");
    }
    if (pages >= staticConfig.maxTransactionPages && page.pagination.has_more) {
      throw new Error("The transaction listing exceeded its page limit.");
    }
    cursor = page.pagination.has_more ? page.pagination.next_cursor || "" : "";
    if (page.pagination.has_more && !cursor) {
      throw new Error("Holvi pagination omitted its next cursor.");
    }
    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Holvi repeated a pagination cursor.");
    }
    seenCursors.add(cursor);
  } while (cursor);

  return { pages, count: results.length, missingAttachments, results };
}

function validateUuid(value: string, resource: string): string {
  if (!uuidPattern.test(value || "")) {
    throw new Error(`A valid Holvi ${resource} UUID is required.`);
  }
  return value;
}

interface DebtRecord {
  code?: unknown;
  counterparty_name?: unknown;
  merchant?: { name?: unknown };
  amount?: unknown;
  value?: unknown;
  total?: unknown;
  currency?: unknown;
  attachments?: unknown[];
  bookkeeping_status?: unknown;
  bookkeeping_state?: unknown;
}

function attachmentCount(debt: DebtRecord): number {
  return Array.isArray(debt?.attachments) ? debt.attachments.length : 0;
}

function debtPath(debtUuid: string): string {
  return `${configuredApiRoot()}debt/${encodeURIComponent(
    validateUuid(debtUuid, "debt"),
  )}/`;
}

function projectDebt(
  debt: DebtRecord,
  debtUuid: string,
): Record<string, unknown> {
  return {
    debtUuid,
    code: asString(debt?.code),
    counterparty:
      asString(debt?.counterparty_name) || asString(debt?.merchant?.name),
    amount: debt?.amount ?? debt?.value ?? debt?.total ?? null,
    currency: asString(debt?.currency) || "EUR",
    attachmentCount: attachmentCount(debt),
    bookkeepingStatus:
      asString(debt?.bookkeeping_status) || asString(debt?.bookkeeping_state),
  };
}

async function previewDebt(
  auth: Auth,
  debtUuid: string,
): Promise<Record<string, unknown>> {
  const validUuid = validateUuid(debtUuid, "debt");
  const debt = (await apiRequest(auth, debtPath(validUuid))) as DebtRecord;
  return projectDebt(debt, validUuid);
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

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function uploadReceipt(
  auth: Auth,
  upload: UploadTransfer,
): Promise<Record<string, unknown>> {
  requireCapabilities("transactions.read", "attachments.write");
  const debtUuid = validateUuid(upload.debtUuid, "debt");
  const before = (await apiRequest(auth, debtPath(debtUuid))) as DebtRecord;
  const beforeCount = attachmentCount(before);
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

  const bytes = base64ToBytes(upload.chunks.join(""));
  if (bytes.byteLength !== upload.size) {
    throw new Error(
      "Receipt byte count changed during native messaging transfer.",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  if (bytesToHex(new Uint8Array(digest)) !== upload.sha256) {
    throw new Error(
      "Receipt checksum changed during native messaging transfer.",
    );
  }

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

  let after: DebtRecord = {};
  for (const delay of [0, 250, 500, 1000, 2000]) {
    if (delay) {
      await new Promise((resolve) => self.setTimeout(resolve, delay));
    }
    after = (await apiRequest(auth, debtPath(debtUuid))) as DebtRecord;
    if (attachmentCount(after) > 0) {
      break;
    }
  }

  const afterCount = attachmentCount(after);
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

async function handleCommand(message: NativeMessage): Promise<unknown> {
  const action = message.action || "";
  const requirements = requiredCapabilities(action);
  if (!requirements) {
    throw new Error("The local helper requested an unsupported action.");
  }
  requireCapabilities(...requirements);
  const auth = await requestAuth();
  switch (action) {
    case "doctor": {
      const base = {
        connected: true,
        groupPathSegment: runtimeConfig?.groupPathSegment,
        poolHandle: runtimeConfig?.poolHandle,
        paymentAccountUuid: runtimeConfig?.paymentAccountUuid,
        capabilities: runtimeConfig?.capabilities,
      };
      if (runtimeConfig?.capabilities.includes("transactions.read")) {
        requireCapabilities("transactions.read");
        const page = (await apiRequest(auth, feedPath())) as FeedPage;
        return {
          ...base,
          probeAction: "transactions",
          firstPageResults: Array.isArray(page?.results)
            ? page.results.length
            : 0,
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
    case "transactions":
      return listTransactions(auth, message.params || {});
    case "preview":
      return previewDebt(auth, asString(message.params?.debtUuid));
    case "bookkeeping.get":
      return bookkeepingDebt(auth, asString(message.params?.debtUuid));
    case "bookkeeping.categories":
      return bookkeepingCategories(auth);
    case "bookkeeping.suggestions":
      return bookkeepingSuggestions(auth, asString(message.params?.debtUuid));
    case "audit.list":
      return recentAudit(auth, message.params?.limit);
    default:
      throw new Error("The local helper requested an unsupported action.");
  }
}

async function finishUpload(message: NativeMessage): Promise<unknown> {
  if (!activeUpload || activeUpload.id !== message.id) {
    throw new Error("Upload completion did not match an active transfer.");
  }
  if (activeUpload.chunks.length !== activeUpload.chunkCount) {
    throw new Error("Receipt transfer ended before every chunk arrived.");
  }
  const auth = await requestAuth();
  return uploadReceipt(auth, activeUpload);
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
      if (activeUpload) {
        throw new Error("Another receipt upload is active.");
      }
      const debtUuid = validateUuid(message.debtUuid || "", "debt");
      if (
        !Number.isSafeInteger(message.size) ||
        (message.size || 0) < 1 ||
        (message.size || 0) > (runtimeConfig?.maxFileBytes || 0)
      ) {
        throw new Error("Receipt size is outside the configured limit.");
      }
      const expectedChunks = Math.ceil(
        (message.size as number) / fileChunkBytes,
      );
      if (message.chunkCount !== expectedChunks) {
        throw new Error("Receipt chunk count does not match its size.");
      }
      if (!/^[a-f0-9]{64}$/.test(message.sha256 || "")) {
        throw new Error("Receipt checksum is invalid.");
      }
      if (
        !validUploadFileName(message.fileName) ||
        !uploadMimeTypes.has(message.mimeType || "")
      ) {
        throw new Error("Receipt filename or media type is invalid.");
      }
      activeUpload = {
        id,
        debtUuid,
        fileName: message.fileName,
        mimeType: message.mimeType as string,
        size: message.size as number,
        sha256: message.sha256 as string,
        chunkCount: message.chunkCount,
        chunks: [],
      };
    } catch (error) {
      activeUpload = null;
      postResult(id, false, error);
    }
    return;
  }

  if (message.type === "upload_chunk") {
    if (
      !activeUpload ||
      activeUpload.id !== id ||
      message.index !== activeUpload.chunks.length ||
      typeof message.data !== "string" ||
      message.data.length > 700_000
    ) {
      const failedId = activeUpload?.id || id;
      activeUpload = null;
      postResult(
        failedId,
        false,
        new Error(
          "Receipt chunks arrived out of order or exceeded their limit.",
        ),
      );
      return;
    }
    activeUpload.chunks.push(message.data);
    return;
  }

  if (message.type === "upload_end") {
    finishUpload(message)
      .then((data) => postResult(id, true, data))
      .catch((error) => postResult(id, false, error))
      .finally(() => {
        activeUpload = null;
      });
  }
}
