"use strict";
importScripts("config.js");
const staticConfig = _HOLVI_AGENT_BRIDGE_STATIC_CONFIG;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestIdPattern = /^[0-9a-f-]{16,64}$/i;
const uploadMimeTypes = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
]);
const supportedCapabilities = new Set([
    "transactions.read",
    "attachments.write",
]);
const fileChunkBytes = 480 * 1024;
let runtimeConfig = null;
let nativePort = null;
let reconnectTimer = null;
let activeUpload = null;
const tabConnections = new Map();
const authRequests = new Map();
function groupPathSegmentFromUrl(value) {
    try {
        const url = new URL(value);
        if (url.origin !== staticConfig.accountOrigin) {
            return "";
        }
        const match = url.pathname.match(/^\/group\/([^/]+)(?:\/|$)/);
        return match?.[1] ? decodeURIComponent(match[1]) : "";
    }
    catch {
        return "";
    }
}
function validateRuntimeConfig(value) {
    const config = value;
    const groupParts = (config.groupPathSegment || "").match(/^([^/+]+)\+([^/]+)$/);
    const groupPoolHandle = groupParts?.[1] || "";
    if (!groupParts ||
        groupPoolHandle !== config.poolHandle ||
        !uuidPattern.test(config.paymentAccountUuid || "") ||
        !Array.isArray(config.capabilities) ||
        config.capabilities.length < 1 ||
        config.capabilities.some((capability) => !supportedCapabilities.has(capability)) ||
        new Set(config.capabilities).size !== config.capabilities.length ||
        !Number.isSafeInteger(config.maxFileBytes) ||
        (config.maxFileBytes || 0) < 1 ||
        (config.maxFileBytes || 0) > staticConfig.maxFileBytes) {
        throw new Error("The native host supplied an invalid Holvi account boundary.");
    }
    return config;
}
function validUploadFileName(value) {
    return (typeof value === "string" &&
        value.length >= 1 &&
        value.length <= 255 &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !value.includes("\0"));
}
function requireCapabilities(...capabilities) {
    if (!runtimeConfig ||
        capabilities.some((capability) => !runtimeConfig?.capabilities.includes(capability))) {
        throw new Error(`Action requires capabilities: ${capabilities.join(", ")}.`);
    }
}
function configuredTab() {
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
function postNative(message) {
    if (!nativePort) {
        throw new Error("The local Holvi helper is disconnected.");
    }
    nativePort.postMessage(message);
}
function reportTabState() {
    if (!nativePort || !runtimeConfig) {
        return;
    }
    const tab = configuredTab();
    nativePort.postMessage(tab ? { type: "tab_ready", tabId: tab[0] } : { type: "tab_unavailable" });
}
function postResult(id, ok, value) {
    try {
        postNative(ok
            ? { type: "result", id, ok, data: value }
            : {
                type: "result",
                id,
                ok,
                error: value instanceof Error ? value.message : String(value),
            });
    }
    catch {
        // A disconnected native port has no response destination.
    }
}
function connectNative() {
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
function requestAuth() {
    const tab = configuredTab();
    if (!tab) {
        return Promise.reject(new Error("Open the configured signed-in Holvi group tab in Chrome."));
    }
    const [tabId, connection] = tab;
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timeout = self.setTimeout(() => {
            authRequests.delete(requestId);
            reject(new Error("The Holvi tab did not provide session authentication."));
        }, 5000);
        authRequests.set(requestId, { resolve, reject, timeout, tabId });
        connection.port.postMessage({ type: "auth_request", requestId });
    });
}
function handleContentMessage(tabId, value) {
    const message = value;
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
    if (!runtimeConfig ||
        message.origin !== staticConfig.accountOrigin ||
        groupPathSegmentFromUrl(message.href || "") !==
            runtimeConfig.groupPathSegment) {
        pending.reject(new Error("The bridge tab is outside the configured Holvi group."));
        return;
    }
    const token = typeof message.token === "string" ? message.token : "";
    if (token.length < 32 ||
        token.length > 8192 ||
        token.split(".").length !== 3) {
        pending.reject(new Error("Sign in to Holvi or reload the configured group tab."));
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
    if (port.name !== "holvi-tab" ||
        !Number.isInteger(tabId) ||
        !groupPathSegment) {
        port.disconnect();
        return;
    }
    const validTabId = tabId;
    tabConnections.get(validTabId)?.port.disconnect();
    tabConnections.set(validTabId, { port, href, groupPathSegment });
    port.onMessage.addListener((message) => handleContentMessage(validTabId, message));
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
function configuredApiRoot() {
    if (!runtimeConfig) {
        throw new Error("The local bridge has no configured Holvi account.");
    }
    return `/api/pool/${encodeURIComponent(runtimeConfig.poolHandle)}/`;
}
async function apiRequest(auth, apiPath, options = {}) {
    if (!apiPath.startsWith(configuredApiRoot())) {
        throw new Error("Refused an API path outside the configured Holvi account.");
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
    const body = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
    if (!response.ok) {
        const detail = typeof body === "string"
            ? body.slice(0, 300)
            : JSON.stringify(body).slice(0, 300);
        throw new Error(`Holvi API returned ${response.status}: ${detail}`);
    }
    return body;
}
function feedPath(cursor = "", missingAttachments = false) {
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
function asString(value) {
    return typeof value === "string" ? value : "";
}
function directDebtUuid(payment) {
    const directMatch = Array.isArray(payment.matches)
        ? payment.matches.find((match) => match?.match_type === "direct")
        : undefined;
    const uuid = asString(directMatch?.uuid);
    return uuidPattern.test(uuid) ? uuid : null;
}
function projectPayment(payment) {
    const paymentUuid = validateUuid(asString(payment.uuid), "payment");
    const timestamp = asString(payment.ux_timestamp);
    const counterparty = asString(payment.counterparty?.display_name) ||
        asString(payment.counterparty_name) ||
        asString(payment.description);
    const originalAmount = payment.fx_meta?.counterparty_amount ??
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
function withinDateRange(payment, from, to) {
    const date = asString(payment.date);
    return Boolean(date) && (!from || date >= from) && (!to || date <= to);
}
async function listTransactions(auth, params) {
    const results = [];
    const seenCursors = new Set();
    const missingAttachments = params.missingAttachments === true;
    let cursor = "";
    let pages = 0;
    do {
        const page = (await apiRequest(auth, feedPath(cursor, missingAttachments)));
        if (!Array.isArray(page?.results) ||
            typeof page?.pagination?.has_more !== "boolean") {
            throw new Error("Holvi returned an unexpected payments feed shape.");
        }
        for (const item of page.results) {
            const projected = projectPayment(item);
            if (withinDateRange(projected, asString(params.from), asString(params.to))) {
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
function validateUuid(value, resource) {
    if (!uuidPattern.test(value || "")) {
        throw new Error(`A valid Holvi ${resource} UUID is required.`);
    }
    return value;
}
function attachmentCount(debt) {
    return Array.isArray(debt?.attachments) ? debt.attachments.length : 0;
}
function debtPath(debtUuid) {
    return `${configuredApiRoot()}debt/${encodeURIComponent(validateUuid(debtUuid, "debt"))}/`;
}
function projectDebt(debt, debtUuid) {
    return {
        debtUuid,
        code: asString(debt?.code),
        counterparty: asString(debt?.counterparty_name) || asString(debt?.merchant?.name),
        amount: debt?.amount ?? debt?.value ?? debt?.total ?? null,
        currency: asString(debt?.currency) || "EUR",
        attachmentCount: attachmentCount(debt),
        bookkeepingStatus: asString(debt?.bookkeeping_status) || asString(debt?.bookkeeping_state),
    };
}
async function previewDebt(auth, debtUuid) {
    const validUuid = validateUuid(debtUuid, "debt");
    const debt = (await apiRequest(auth, debtPath(validUuid)));
    return projectDebt(debt, validUuid);
}
function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}
function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function uploadReceipt(auth, upload) {
    requireCapabilities("transactions.read", "attachments.write");
    const debtUuid = validateUuid(upload.debtUuid, "debt");
    const before = (await apiRequest(auth, debtPath(debtUuid)));
    const beforeCount = attachmentCount(before);
    if (beforeCount !== 0) {
        throw new Error(`Upload refused because the transaction has ${beforeCount} attachment(s).`);
    }
    if (typeof before?.code !== "string" || !before.code) {
        throw new Error("Holvi did not return the object code required for upload.");
    }
    const bytes = base64ToBytes(upload.chunks.join(""));
    if (bytes.byteLength !== upload.size) {
        throw new Error("Receipt byte count changed during native messaging transfer.");
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (bytesToHex(new Uint8Array(digest)) !== upload.sha256) {
        throw new Error("Receipt checksum changed during native messaging transfer.");
    }
    const form = new FormData();
    form.append("content_type", "debt");
    form.append("object_code", before.code);
    form.append("attachment_file", new File([bytes], upload.fileName, { type: upload.mimeType }));
    await apiRequest(auth, `${configuredApiRoot()}attachment/formpost/`, {
        method: "POST",
        body: form,
    });
    let after = {};
    for (const delay of [0, 250, 500, 1000, 2000]) {
        if (delay) {
            await new Promise((resolve) => self.setTimeout(resolve, delay));
        }
        after = (await apiRequest(auth, debtPath(debtUuid)));
        if (attachmentCount(after) > 0) {
            break;
        }
    }
    const afterCount = attachmentCount(after);
    if (afterCount !== 1) {
        throw new Error(`Holvi accepted the upload but verification found ${afterCount} attachment(s). Inspect the transaction before retrying.`);
    }
    return {
        debtUuid,
        fileName: upload.fileName,
        sha256: upload.sha256,
        attachmentCountBefore: beforeCount,
        attachmentCountAfter: afterCount,
    };
}
async function handleCommand(message) {
    requireCapabilities("transactions.read");
    const auth = await requestAuth();
    switch (message.action) {
        case "doctor": {
            const page = (await apiRequest(auth, feedPath()));
            return {
                connected: true,
                groupPathSegment: runtimeConfig?.groupPathSegment,
                poolHandle: runtimeConfig?.poolHandle,
                paymentAccountUuid: runtimeConfig?.paymentAccountUuid,
                capabilities: runtimeConfig?.capabilities,
                firstPageResults: Array.isArray(page?.results)
                    ? page.results.length
                    : 0,
            };
        }
        case "transactions":
            return listTransactions(auth, message.params || {});
        case "preview":
            return previewDebt(auth, asString(message.params?.debtUuid));
        default:
            throw new Error("The local helper requested an unsupported action.");
    }
}
async function finishUpload(message) {
    if (!activeUpload || activeUpload.id !== message.id) {
        throw new Error("Upload completion did not match an active transfer.");
    }
    if (activeUpload.chunks.length !== activeUpload.chunkCount) {
        throw new Error("Receipt transfer ended before every chunk arrived.");
    }
    const auth = await requestAuth();
    return uploadReceipt(auth, activeUpload);
}
function handleNativeMessage(value) {
    const message = value;
    if (!message || typeof message !== "object") {
        return;
    }
    if (message.type === "host_ready") {
        try {
            runtimeConfig = validateRuntimeConfig(message.config);
            reportTabState();
        }
        catch (_error) {
            nativePort?.disconnect();
        }
        return;
    }
    if (!requestIdPattern.test(message.id || "")) {
        return;
    }
    const id = message.id;
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
            if (!Number.isSafeInteger(message.size) ||
                (message.size || 0) < 1 ||
                (message.size || 0) > (runtimeConfig?.maxFileBytes || 0)) {
                throw new Error("Receipt size is outside the configured limit.");
            }
            const expectedChunks = Math.ceil(message.size / fileChunkBytes);
            if (message.chunkCount !== expectedChunks) {
                throw new Error("Receipt chunk count does not match its size.");
            }
            if (!/^[a-f0-9]{64}$/.test(message.sha256 || "")) {
                throw new Error("Receipt checksum is invalid.");
            }
            if (!validUploadFileName(message.fileName) ||
                !uploadMimeTypes.has(message.mimeType || "")) {
                throw new Error("Receipt filename or media type is invalid.");
            }
            activeUpload = {
                id,
                debtUuid,
                fileName: message.fileName,
                mimeType: message.mimeType,
                size: message.size,
                sha256: message.sha256,
                chunkCount: message.chunkCount,
                chunks: [],
            };
        }
        catch (error) {
            activeUpload = null;
            postResult(id, false, error);
        }
        return;
    }
    if (message.type === "upload_chunk") {
        if (!activeUpload ||
            activeUpload.id !== id ||
            message.index !== activeUpload.chunks.length ||
            typeof message.data !== "string" ||
            message.data.length > 700_000) {
            const failedId = activeUpload?.id || id;
            activeUpload = null;
            postResult(failedId, false, new Error("Receipt chunks arrived out of order or exceeded their limit."));
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
