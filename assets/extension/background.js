"use strict";
(() => {

  // src/extension/projections.ts
  var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var decimalPattern = /^-?\d+(?:\.\d+)?$/;
  var maxStringLength = 4096;
  var maxBookkeepingItems = 500;
  var maxCategoryResults = 1000;
  var maxSuggestionResults = 100;
  var maxAuditResults = 25;
  var maxAuditEnvelopeResults = 200;
  var maxProjectionBytes = 512 * 1024;
  function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} has an unexpected shape.`);
    }
    return value;
  }
  function boundedString(value, label) {
    if (typeof value !== "string" || value.length < 1 || value.length > maxStringLength) {
      throw new Error(`${label} must be a nonempty bounded string.`);
    }
    return value;
  }
  function optionalString(value, label) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    return boundedString(value, label);
  }
  function uuid(value, label) {
    const text = boundedString(value, label);
    if (!uuidPattern.test(text)) {
      throw new Error(`${label} must be a UUID.`);
    }
    return text;
  }
  function optionalUuid(value, label) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    return uuid(value, label);
  }
  function decimal(value, label) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.length <= 128 && decimalPattern.test(value)) {
      return value;
    }
    throw new Error(`${label} has an invalid decimal value.`);
  }
  function price(value, label, includeVatRate) {
    if (value === null || value === undefined) {
      return null;
    }
    const source = record(value, label);
    return {
      currency: optionalString(source.currency, `${label} currency`),
      gross: decimal(source.gross, `${label} gross`),
      net: decimal(source.net, `${label} net`),
      ...includeVatRate ? { vatRate: decimal(source.vat_rate, `${label} VAT rate`) } : {}
    };
  }
  function projection(value) {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxProjectionBytes) {
      throw new Error("Holvi projection exceeded its output limit.");
    }
    return value;
  }
  function bookkeepingItem(value) {
    const item = record(value, "Bookkeeping item");
    return {
      itemUuid: uuid(item.uuid, "Bookkeeping item UUID"),
      description: optionalString(item.description, "Bookkeeping description"),
      categoryCode: optionalString(item.category, "Bookkeeping category"),
      costCenterUuid: optionalUuid(item.cost_center_uuid, "Bookkeeping cost center"),
      vatCalculationRule: optionalString(item.vat_calculation_rule, "Bookkeeping VAT calculation rule"),
      vatStatus: optionalString(item.vat_status, "Bookkeeping VAT status"),
      quantity: decimal(item.quantity, "Bookkeeping quantity"),
      unit: optionalString(item.unit, "Bookkeeping unit"),
      unitPrice: price(item.detailed_price, "Bookkeeping unit price", true),
      lineTotal: price(item.detailed_total_price, "Bookkeeping line total", false)
    };
  }
  function projectBookkeepingDebt(value, debtUuid) {
    const debt = record(value, "Bookkeeping debt");
    const items = debt.items === null || debt.items === undefined ? [] : debt.items;
    if (!Array.isArray(items)) {
      throw new Error("Holvi bookkeeping debt has an invalid item list.");
    }
    if (items.length > maxBookkeepingItems) {
      throw new Error("Holvi bookkeeping debt exceeded its item limit.");
    }
    const attachments = debt.attachments === null || debt.attachments === undefined ? [] : debt.attachments;
    if (!Array.isArray(attachments)) {
      throw new Error("Holvi bookkeeping debt has an invalid attachment list.");
    }
    const responseUuid = uuid(debt.uuid, "Bookkeeping debt UUID");
    const requestedUuid = uuid(debtUuid, "Debt UUID");
    if (responseUuid.toLowerCase() !== requestedUuid.toLowerCase()) {
      throw new Error("Holvi bookkeeping debt UUID does not match the request.");
    }
    const retained = items.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }
      const candidate = item;
      return candidate.type === "line_item" && candidate.active === true;
    });
    const merchant = debt.merchant && typeof debt.merchant === "object" ? debt.merchant : {};
    return projection({
      debtUuid: requestedUuid,
      code: optionalString(debt.code, "Bookkeeping debt code"),
      bookingDate: optionalString(debt.booking_date, "Bookkeeping date"),
      counterparty: optionalString(debt.counterparty_name, "Bookkeeping counterparty") ?? optionalString(merchant.name, "Bookkeeping merchant"),
      amount: decimal(debt.amount ?? debt.value ?? debt.total, "Bookkeeping amount"),
      currency: optionalString(debt.currency, "Bookkeeping currency"),
      bookkeepingStatus: optionalString(debt.bookkeeping_status, "Bookkeeping status") ?? optionalString(debt.bookkeeping_state, "Bookkeeping state"),
      exportStatus: optionalString(debt.export_status, "Bookkeeping export status"),
      type: optionalString(debt.type, "Bookkeeping type"),
      subtype: optionalString(debt.subtype, "Bookkeeping subtype"),
      paymentAccountUuid: optionalUuid(debt.payment_account_uuid, "Bookkeeping payment account"),
      connectionUuid: optionalUuid(debt.connection_uuid, "Bookkeeping connection"),
      attachmentCount: attachments.length,
      droppedItemCount: items.length - retained.length,
      items: retained.map(bookkeepingItem)
    });
  }
  function projectCategories(value) {
    if (!Array.isArray(value)) {
      throw new Error("Holvi returned an unexpected category list shape.");
    }
    if (value.length > maxCategoryResults) {
      throw new Error("Holvi category listing exceeded its result limit.");
    }
    return projection(value.map((entry) => {
      const category = record(entry, "Bookkeeping category");
      return {
        code: boundedString(category.code, "Bookkeeping category code"),
        handle: optionalString(category.handle, "Bookkeeping category handle"),
        label: optionalString(category.label, "Bookkeeping category label")
      };
    }));
  }
  function projectSuggestions(value, debtUuid) {
    const suggestions = record(value, "Bookkeeping suggestions");
    if (!Array.isArray(suggestions.categories)) {
      throw new Error("Holvi returned an unexpected suggestion list shape.");
    }
    if (suggestions.categories.length > maxSuggestionResults) {
      throw new Error("Holvi category suggestions exceeded their result limit.");
    }
    const categoryCodes = suggestions.categories.map((entry) => {
      if (typeof entry === "string") {
        return boundedString(entry, "Suggested category code");
      }
      return boundedString(record(entry, "Suggested category").code, "Suggested category code");
    });
    return projection({
      debtUuid: uuid(debtUuid, "Debt UUID"),
      categoryCodes
    });
  }
  function creator(value) {
    if (value === null || value === undefined) {
      return { name: "Holvi", isHolvi: true };
    }
    const source = record(value, "Activity creator");
    const name = optionalString(source.name, "Activity creator name") ?? [
      optionalString(source.firstname, "Activity creator first name"),
      optionalString(source.lastname, "Activity creator last name")
    ].filter(Boolean).join(" ");
    return { name: name || "Unknown", isHolvi: false };
  }
  function auditEntry(value) {
    const entry = record(value, "Activity entry");
    const timestamp = boundedString(entry.timestamp, "Activity timestamp");
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new Error("Activity timestamp is invalid.");
    }
    const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {};
    return {
      code: boundedString(entry.code, "Activity code"),
      timestamp,
      category: optionalString(entry.category, "Activity category"),
      creator: creator(entry.creator),
      action: optionalString(entry.action, "Activity action"),
      title: optionalString(entry.title, "Activity title"),
      content: typeof entry.content === "string" ? optionalString(entry.content, "Activity content") : null,
      status: optionalString(data.status, "Activity status")
    };
  }
  function projectAuditPage(value, limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > maxAuditResults) {
      throw new Error("Activity limit is outside the configured range.");
    }
    const page = record(value, "Activity page");
    if (!Array.isArray(page.results) || page.results.length > maxAuditEnvelopeResults) {
      throw new Error("Holvi returned an unexpected activity feed shape.");
    }
    if (page.next !== null && page.next !== undefined && typeof page.next !== "string") {
      throw new Error("Holvi activity pagination has an unexpected shape.");
    }
    const entries = page.results.map(auditEntry);
    for (let index = 1;index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (!previous || !current || Date.parse(String(previous.timestamp)) < Date.parse(String(current.timestamp))) {
        throw new Error("Holvi activity feed is not ordered newest first.");
      }
    }
    const results = entries.slice(0, limit);
    return projection({
      returnedCount: results.length,
      hasMore: typeof page.next === "string" || entries.length > results.length,
      order: "newest-first",
      results
    });
  }

  // src/extension/policy.ts
  var actionCapabilities = {
    doctor: [],
    transactions: ["transactions.read"],
    preview: ["transactions.read"],
    upload: ["transactions.read", "attachments.write"],
    "bookkeeping.get": ["bookkeeping.read"],
    "bookkeeping.categories": ["bookkeeping.read"],
    "bookkeeping.suggestions": ["bookkeeping.read"],
    "audit.list": ["audit.read"]
  };
  var supportedCapabilities = new Set(Object.values(actionCapabilities).flat());
  function requiredCapabilities(action) {
    return Object.hasOwn(actionCapabilities, action) ? actionCapabilities[action] : null;
  }

  // src/extension/background.ts
  importScripts("config.js");
  var staticConfig = _HOLVI_AGENT_BRIDGE_STATIC_CONFIG;
  var uuidPattern2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var requestIdPattern = /^[0-9a-f-]{16,64}$/i;
  var uploadMimeTypes = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif"
  ]);
  var fileChunkBytes = 480 * 1024;
  var runtimeConfig = null;
  var nativePort = null;
  var reconnectTimer = null;
  var activeUpload = null;
  var tabConnections = new Map;
  var authRequests = new Map;
  function groupPathSegmentFromUrl(value) {
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
  function validateRuntimeConfig(value) {
    const config = value;
    const groupParts = (config.groupPathSegment || "").match(/^([^/+]+)\+([^/]+)$/);
    const groupPoolHandle = groupParts?.[1] || "";
    if (!groupParts || groupPoolHandle !== config.poolHandle || !uuidPattern2.test(config.paymentAccountUuid || "") || !Array.isArray(config.capabilities) || config.capabilities.length < 1 || config.capabilities.some((capability) => !supportedCapabilities.has(capability)) || new Set(config.capabilities).size !== config.capabilities.length || !Number.isSafeInteger(config.maxFileBytes) || (config.maxFileBytes || 0) < 1 || (config.maxFileBytes || 0) > staticConfig.maxFileBytes) {
      throw new Error("The native host supplied an invalid Holvi account boundary.");
    }
    return config;
  }
  function validUploadFileName(value) {
    return typeof value === "string" && value.length >= 1 && value.length <= 255 && !value.includes("/") && !value.includes("\\") && !value.includes("\x00");
  }
  function requireCapabilities(...capabilities) {
    if (!runtimeConfig || capabilities.some((capability) => !runtimeConfig?.capabilities.includes(capability))) {
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
      postNative(ok ? { type: "result", id, ok, data: value } : {
        type: "result",
        id,
        ok,
        error: value instanceof Error ? value.message : String(value)
      });
    } catch {}
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
    if (!runtimeConfig || message.origin !== staticConfig.accountOrigin || groupPathSegmentFromUrl(message.href || "") !== runtimeConfig.groupPathSegment) {
      pending.reject(new Error("The bridge tab is outside the configured Holvi group."));
      return;
    }
    const token = typeof message.token === "string" ? message.token : "";
    if (token.length < 32 || token.length > 8192 || token.split(".").length !== 3) {
      pending.reject(new Error("Sign in to Holvi or reload the configured group tab."));
      return;
    }
    pending.resolve({
      token,
      csrfToken: typeof message.csrfToken === "string" ? message.csrfToken : ""
    });
  }
  chrome.runtime.onConnect.addListener((port) => {
    const tabId = port.sender?.tab?.id;
    const href = port.sender?.tab?.url || "";
    const groupPathSegment = groupPathSegmentFromUrl(href);
    if (port.name !== "holvi-tab" || !Number.isInteger(tabId) || !groupPathSegment) {
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
      redirect: "error"
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
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
      payment_account: runtimeConfig.paymentAccountUuid
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
    const directMatch = Array.isArray(payment.matches) ? payment.matches.find((match) => match?.match_type === "direct") : undefined;
    const uuid2 = asString(directMatch?.uuid);
    return uuidPattern2.test(uuid2) ? uuid2 : null;
  }
  function projectPayment(payment) {
    const paymentUuid = validateUuid(asString(payment.uuid), "payment");
    const timestamp = asString(payment.ux_timestamp);
    const counterparty = asString(payment.counterparty?.display_name) || asString(payment.counterparty_name) || asString(payment.description);
    const originalAmount = payment.fx_meta?.counterparty_amount ?? payment.fx_meta?.counterparty_value ?? null;
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
      attachmentCount: Number(payment.attachment_count || 0)
    };
  }
  function withinDateRange(payment, from, to) {
    const date = asString(payment.date);
    return Boolean(date) && (!from || date >= from) && (!to || date <= to);
  }
  async function listTransactions(auth, params) {
    const results = [];
    const seenCursors = new Set;
    const missingAttachments = params.missingAttachments === true;
    let cursor = "";
    let pages = 0;
    do {
      const page = await apiRequest(auth, feedPath(cursor, missingAttachments));
      if (!Array.isArray(page?.results) || typeof page?.pagination?.has_more !== "boolean") {
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
    if (!uuidPattern2.test(value || "")) {
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
      bookkeepingStatus: asString(debt?.bookkeeping_status) || asString(debt?.bookkeeping_state)
    };
  }
  async function previewDebt(auth, debtUuid) {
    const validUuid = validateUuid(debtUuid, "debt");
    const debt = await apiRequest(auth, debtPath(validUuid));
    return projectDebt(debt, validUuid);
  }
  async function bookkeepingDebt(auth, debtUuid) {
    const validUuid = validateUuid(debtUuid, "debt");
    return projectBookkeepingDebt(await apiRequest(auth, debtPath(validUuid)), validUuid);
  }
  async function bookkeepingCategories(auth) {
    return projectCategories(await apiRequest(auth, `${configuredApiRoot()}category/`));
  }
  async function bookkeepingSuggestions(auth, debtUuid) {
    const validUuid = validateUuid(debtUuid, "debt");
    return projectSuggestions(await apiRequest(auth, `${debtPath(validUuid)}haip/bookkeeping-suggestions/`), validUuid);
  }
  async function recentAudit(auth, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new Error("Activity limit must be between 1 and 25.");
    }
    return projectAuditPage(await apiRequest(auth, `${configuredApiRoot()}log-feed/?o=-timestamp&page_size=25`), limit);
  }
  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0;index < binary.length; index += 1) {
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
    const before = await apiRequest(auth, debtPath(debtUuid));
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
    const form = new FormData;
    form.append("content_type", "debt");
    form.append("object_code", before.code);
    form.append("attachment_file", new File([bytes], upload.fileName, { type: upload.mimeType }));
    await apiRequest(auth, `${configuredApiRoot()}attachment/formpost/`, {
      method: "POST",
      body: form
    });
    let after = {};
    for (const delay of [0, 250, 500, 1000, 2000]) {
      if (delay) {
        await new Promise((resolve) => self.setTimeout(resolve, delay));
      }
      after = await apiRequest(auth, debtPath(debtUuid));
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
      attachmentCountAfter: afterCount
    };
  }
  async function handleCommand(message) {
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
          capabilities: runtimeConfig?.capabilities
        };
        if (runtimeConfig?.capabilities.includes("transactions.read")) {
          requireCapabilities("transactions.read");
          const page = await apiRequest(auth, feedPath());
          return {
            ...base,
            probeAction: "transactions",
            firstPageResults: Array.isArray(page?.results) ? page.results.length : 0
          };
        }
        if (runtimeConfig?.capabilities.includes("bookkeeping.read")) {
          requireCapabilities("bookkeeping.read");
          const categories = await bookkeepingCategories(auth);
          return {
            ...base,
            probeAction: "bookkeeping.categories",
            categoryCount: categories.length
          };
        }
        if (runtimeConfig?.capabilities.includes("audit.read")) {
          requireCapabilities("audit.read");
          const audit = await recentAudit(auth, 1);
          return {
            ...base,
            probeAction: "audit.list",
            recentActivityCount: audit.returnedCount
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
      } catch (_error) {
        nativePort?.disconnect();
      }
      return;
    }
    if (!requestIdPattern.test(message.id || "")) {
      return;
    }
    const id = message.id;
    if (message.type === "command") {
      handleCommand(message).then((data) => postResult(id, true, data)).catch((error) => postResult(id, false, error));
      return;
    }
    if (message.type === "upload_start") {
      try {
        if (activeUpload) {
          throw new Error("Another receipt upload is active.");
        }
        const debtUuid = validateUuid(message.debtUuid || "", "debt");
        if (!Number.isSafeInteger(message.size) || (message.size || 0) < 1 || (message.size || 0) > (runtimeConfig?.maxFileBytes || 0)) {
          throw new Error("Receipt size is outside the configured limit.");
        }
        const expectedChunks = Math.ceil(message.size / fileChunkBytes);
        if (message.chunkCount !== expectedChunks) {
          throw new Error("Receipt chunk count does not match its size.");
        }
        if (!/^[a-f0-9]{64}$/.test(message.sha256 || "")) {
          throw new Error("Receipt checksum is invalid.");
        }
        if (!validUploadFileName(message.fileName) || !uploadMimeTypes.has(message.mimeType || "")) {
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
          chunks: []
        };
      } catch (error) {
        activeUpload = null;
        postResult(id, false, error);
      }
      return;
    }
    if (message.type === "upload_chunk") {
      if (!activeUpload || activeUpload.id !== id || message.index !== activeUpload.chunks.length || typeof message.data !== "string" || message.data.length > 700000) {
        const failedId = activeUpload?.id || id;
        activeUpload = null;
        postResult(failedId, false, new Error("Receipt chunks arrived out of order or exceeded their limit."));
        return;
      }
      activeUpload.chunks.push(message.data);
      return;
    }
    if (message.type === "upload_end") {
      finishUpload(message).then((data) => postResult(id, true, data)).catch((error) => postResult(id, false, error)).finally(() => {
        activeUpload = null;
      });
    }
  }
})();
