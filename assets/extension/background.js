"use strict";
(() => {

  // src/extension/policy.ts
  var minimumFileBytes = 1;
  var maximumDownloadBytes = 1024 * 1024 * 1024;
  var actionCapabilities = {
    doctor: [],
    "transactions.list": ["transactions.read"],
    "transactions.get": ["transactions.read"],
    "debts.get": ["transactions.read"],
    "comments.list": ["transactions.read"],
    "comments.create": ["transactions.read", "comments.write"],
    "attachments.upload": ["transactions.read", "attachments.write"],
    "attachments.delete": ["transactions.read", "attachments.delete"],
    "attachments.download": ["bookkeeping.read", "attachments.read"],
    "accounts.list": ["accounts.read"],
    "reports.types": ["reports.read"],
    "reports.export": ["reports.read"],
    "reports.jobs.list": ["reports.read"],
    "reports.jobs.get": ["reports.read"],
    "reports.jobs.create": ["reports.generate"],
    "reports.jobs.download": ["reports.read"],
    "bookkeeping.list": ["bookkeeping.read"],
    "bookkeeping.get": ["bookkeeping.read"],
    "bookkeeping.categories": ["bookkeeping.read"],
    "bookkeeping.suggestions": ["bookkeeping.read"],
    "bookkeeping.set-description": ["bookkeeping.write"],
    "audit.types": ["audit.read"],
    "audit.list": ["audit.read"],
    "payments.create": ["payments.write"],
    "payments.send": ["payments.send"]
  };
  var supportedCapabilities = new Set(Object.values(actionCapabilities).flat());
  function isBridgeAction(action) {
    return Object.hasOwn(actionCapabilities, action);
  }
  function requiredCapabilities(action) {
    return isBridgeAction(action) ? actionCapabilities[action] : null;
  }

  // src/extension/session.ts
  var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var poolHandlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  function groupPathSegmentFromUrl(value, accountOrigin) {
    try {
      const url = new URL(value);
      if (url.origin !== accountOrigin) {
        return "";
      }
      const match = url.pathname.match(/^\/group\/([^/]+)(?:\/|$)/);
      return match?.[1] ? decodeURIComponent(match[1]) : "";
    } catch {
      return "";
    }
  }
  function validateHostIdentity(protocolVersion, hostVersion, staticConfig) {
    if (protocolVersion !== staticConfig.nativeProtocolVersion) {
      const receivedProtocol = typeof protocolVersion === "number" ? protocolVersion : "unknown";
      throw new Error(`Native host protocol ${receivedProtocol} is incompatible with extension protocol ${staticConfig.nativeProtocolVersion}. Reload Holvi Agent Bridge in chrome://extensions or restart Chrome.`);
    }
    if (typeof hostVersion !== "string" || hostVersion.length < 1 || hostVersion.length > 64) {
      throw new Error("The native host supplied an invalid build version.");
    }
    return { protocolVersion, hostVersion };
  }
  function validateRuntimeConfig(value, staticConfig) {
    const config = value;
    const groupParts = (config.groupPathSegment || "").match(/^([^/+]+)\+([^/]+)$/);
    const groupPoolHandle = groupParts?.[1] || "";
    if (!groupParts || !poolHandlePattern.test(config.poolHandle || "") || groupPoolHandle !== config.poolHandle || !uuidPattern.test(config.paymentAccountUuid || "") || !Array.isArray(config.capabilities) || config.capabilities.length < 1 || config.capabilities.some((capability) => !supportedCapabilities.has(capability)) || new Set(config.capabilities).size !== config.capabilities.length || !Number.isSafeInteger(config.maxFileBytes) || (config.maxFileBytes || 0) < minimumFileBytes || (config.maxFileBytes || 0) > staticConfig.maxFileBytes) {
      throw new Error("The native host supplied an invalid Holvi account boundary.");
    }
    return config;
  }
  function validateUuid(value, resource) {
    if (!uuidPattern.test(value || "")) {
      throw new Error(`A valid Holvi ${resource} UUID is required.`);
    }
    return value;
  }

  class BridgeSession {
    staticConfig;
    runtimeConfig = null;
    hostIdentity = null;
    constructor(staticConfig) {
      this.staticConfig = staticConfig;
    }
    configure(value, protocolVersion = this.staticConfig.nativeProtocolVersion, hostVersion = this.staticConfig.extensionVersion) {
      const identity = validateHostIdentity(protocolVersion, hostVersion, this.staticConfig);
      const config = validateRuntimeConfig(value, this.staticConfig);
      this.hostIdentity = identity;
      this.runtimeConfig = config;
      return config;
    }
    clear() {
      this.runtimeConfig = null;
      this.hostIdentity = null;
    }
    get identity() {
      if (!this.hostIdentity) {
        throw new Error("The local bridge has no native host identity.");
      }
      return this.hostIdentity;
    }
    get extensionVersion() {
      return this.staticConfig.extensionVersion;
    }
    get optionalConfig() {
      return this.runtimeConfig;
    }
    get config() {
      if (!this.runtimeConfig) {
        throw new Error("The local bridge has no configured Holvi account.");
      }
      return this.runtimeConfig;
    }
    requireCapabilities(...capabilities) {
      if (!this.runtimeConfig || capabilities.some((capability) => !this.runtimeConfig?.capabilities.includes(capability))) {
        throw new Error(`Action requires capabilities: ${capabilities.join(", ")}.`);
      }
    }
    apiRoot() {
      return `/api/pool/${encodeURIComponent(this.config.poolHandle)}/`;
    }
  }

  // src/extension/auth-proxy.ts
  var basePath = "/api/auth-proxy/2fa/v1/token/";
  var maxResponseBytes = 128 * 1024;
  var tokenIdPattern = /^[A-Za-z0-9_-]{1,256}$/;
  function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} has an unexpected shape.`);
    }
    return value;
  }
  function boundedSecret(value, label) {
    if (typeof value !== "string" || value.length < 1 || value.length > 16384) {
      throw new Error(`${label} has an unexpected shape.`);
    }
    return value;
  }
  function tokenId(value) {
    const id = boundedSecret(value, "Holvi 2FA token ID");
    if (!tokenIdPattern.test(id)) {
      throw new Error("Holvi 2FA token ID has an unexpected shape.");
    }
    return id;
  }
  async function responseJson(response) {
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) {
      throw new Error("Holvi 2FA response exceeded its size limit.");
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxResponseBytes) {
      throw new Error("Holvi 2FA response exceeded its size limit.");
    }
    if (!response.ok) {
      throw new Error(`Holvi 2FA request returned ${response.status}.`);
    }
    if (!buffer.byteLength)
      return {};
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    } catch {
      throw new Error("Holvi 2FA response was malformed.");
    }
  }

  class AuthProxyClient {
    origin;
    fetchRequest;
    constructor(origin = "https://holvi.com", fetchRequest = fetch) {
      this.origin = origin;
      this.fetchRequest = fetchRequest;
      const url = new URL(origin);
      if (url.href !== "https://holvi.com/" || url.username || url.password || url.port || url.hash) {
        throw new Error("Holvi 2FA origin is invalid.");
      }
    }
    async initiatePaymentConfirmation(auth, debtUuid) {
      const uuid = validateUuid(debtUuid, "debt");
      const body = await this.request(`${basePath}initiate/`, "POST", `Bearer ${auth.token}`, auth.csrfToken, {
        action_name: "payment_confirm",
        action_data: { debt_uuid: uuid }
      });
      const source = record(body, "Holvi 2FA initiation response");
      const meta = record(source.token_meta, "Holvi 2FA token metadata");
      const authorization = `${boundedSecret(source.token_type, "Holvi 2FA token type")} ${boundedSecret(source.id_token, "Holvi 2FA authorization token")}`;
      const devices = meta.totp_devices;
      if (!Array.isArray(devices) || devices.length > 20) {
        throw new Error("Holvi 2FA device list has an unexpected shape.");
      }
      const hasMobileDevice = devices.some((value) => {
        const device = record(value, "Holvi 2FA device");
        boundedSecret(device.id, "Holvi 2FA device ID");
        return device.device_type === "user_device";
      });
      const expirationSeconds = Number(source.expiration_delta ?? source.expires_in ?? 300);
      if (!Number.isSafeInteger(expirationSeconds) || expirationSeconds < 0 || expirationSeconds > 3600) {
        throw new Error("Holvi 2FA expiration has an unexpected shape.");
      }
      return {
        authorization,
        tokenId: tokenId(meta.twofactor_token_id),
        expirationSeconds,
        hasMobileDevice
      };
    }
    async status(session) {
      const body = await this.request(`${basePath}${tokenId(session.tokenId)}/`, "GET", session.authorization);
      const source = record(body, "Holvi 2FA status response");
      const rawState = source.state;
      const expirationSeconds = Number(source.expiration_delta ?? 0);
      if (!Number.isSafeInteger(expirationSeconds) || expirationSeconds < 0 || expirationSeconds > 3600) {
        throw new Error("Holvi 2FA status expiration has an unexpected shape.");
      }
      if (rawState === "activated" || rawState === "expired" || rawState === "cancelled" || rawState === "rejected") {
        return { state: rawState, expirationSeconds };
      }
      if (expirationSeconds > 0) {
        return { state: "pending", expirationSeconds };
      }
      return { state: "expired", expirationSeconds: 0 };
    }
    async cancel(session) {
      await this.request(`${basePath}${tokenId(session.tokenId)}/`, "DELETE", session.authorization);
    }
    async request(path, method, authorization, csrfToken = "", body) {
      const allowed = method === "POST" && path === `${basePath}initiate/` || (method === "GET" || method === "DELETE") && new RegExp(`^${basePath}[A-Za-z0-9_-]{1,256}/$`).test(path);
      if (!allowed)
        throw new Error("Refused an unsupported Holvi 2FA path.");
      const headers = new Headers({
        Accept: "application/json",
        Authorization: authorization
      });
      if (csrfToken)
        headers.set("X-CSRFToken", csrfToken);
      if (body !== undefined)
        headers.set("Content-Type", "application/json");
      const fetchRequest = this.fetchRequest;
      const response = await fetchRequest(`${this.origin}${path}`, {
        method,
        headers,
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        credentials: "include",
        cache: "no-store",
        redirect: "error"
      });
      return responseJson(response);
    }
  }

  // src/extension/projections.ts
  var uuidPattern2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var decimalPattern = /^-?\d+(?:\.\d+)?$/;
  var maxStringLength = 4096;
  var maxBookkeepingItems = 500;
  var maxCategoryResults = 1000;
  var maxSuggestionResults = 100;
  var maxAuditResults = 25;
  var maxAuditEnvelopeResults = 200;
  var maxFeedPageResults = 1e4;
  var maxPaymentMatches = 1000;
  var maxPaymentAccounts = 100;
  var maxDebtAttachments = 1000;
  var maxCommentPageResults = 25;
  var maxCommentResults = 1000;
  var maxCommentContentBytes = 16 * 1024;
  var maxProjectionBytes = 512 * 1024;
  function record2(value, label) {
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
    if (!uuidPattern2.test(text)) {
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
  function optionalBoolean(value, label) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "boolean") {
      throw new Error(`${label} must be a boolean.`);
    }
    return value;
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
  function vatRate(value, label) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    return boundedString(value, label);
  }
  function requiredDecimal(value, label) {
    const result = decimal(value, label);
    if (result === null) {
      throw new Error(`${label} is required.`);
    }
    return result;
  }
  function paymentDirection(value, amount) {
    const sourceDirection = optionalString(value, "Payment direction");
    if (sourceDirection) {
      return sourceDirection;
    }
    if (typeof amount === "number") {
      return amount < 0 ? "out" : amount > 0 ? "in" : "";
    }
    if (typeof amount === "string" && /[1-9]/.test(amount)) {
      return amount.startsWith("-") ? "out" : "in";
    }
    return "";
  }
  function price(value, label, includeVatRate) {
    if (value === null || value === undefined) {
      return null;
    }
    const source = record2(value, label);
    return {
      currency: optionalString(source.currency, `${label} currency`),
      gross: decimal(source.gross, `${label} gross`),
      net: decimal(source.net, `${label} net`),
      ...includeVatRate ? { vatRate: vatRate(source.vat_rate, `${label} VAT rate`) } : {}
    };
  }
  function projection(value) {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxProjectionBytes) {
      throw new Error("Holvi projection exceeded its output limit.");
    }
    return value;
  }
  function stringOrEmpty(value, label) {
    return optionalString(value, label) ?? "";
  }
  function timestamp(value, label) {
    const text = boundedString(value, label);
    if (!Number.isFinite(Date.parse(text))) {
      throw new Error(`${label} is invalid.`);
    }
    return text;
  }
  function optionalDate(value, label) {
    const text = optionalString(value, label);
    if (!text) {
      return null;
    }
    timestamp(text, label);
    return text.slice(0, 10);
  }
  function nonnegativeInteger(value, label) {
    const count = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label} must be a nonnegative integer.`);
    }
    return count;
  }
  function optionalRecord(value, label) {
    if (value === null || value === undefined) {
      return {};
    }
    return record2(value, label);
  }
  function boundedArray(value, label, limit, optional = false) {
    if (optional && (value === null || value === undefined)) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(`${label} has an unexpected shape.`);
    }
    if (value.length > limit) {
      throw new Error(`${label} exceeded its result limit.`);
    }
    return value;
  }
  function directDebtUuid(value) {
    const matches = boundedArray(value, "Payment matches", maxPaymentMatches, true);
    let direct = null;
    for (const entry of matches) {
      const match = record2(entry, "Payment match");
      const matchType = optionalString(match.match_type, "Payment match type");
      if (matchType === "direct") {
        if (direct !== null) {
          throw new Error("Payment has ambiguous direct debt matches.");
        }
        direct = match;
      }
    }
    return direct ? uuid(direct.uuid, "Payment debt UUID") : null;
  }
  function payment(value) {
    const source = record2(value, "Payment");
    const counterparty = optionalRecord(source.counterparty, "Payment counterparty");
    const fx = optionalRecord(source.fx_meta, "Payment foreign exchange metadata");
    const paymentTimestamp = timestamp(source.ux_timestamp, "Payment timestamp");
    const amount = decimal(source.amount ?? source.value, "Payment amount");
    const rawAttachmentCount = source.attachment_count ?? 0;
    return {
      paymentUuid: uuid(source.uuid, "Payment UUID"),
      debtUuid: directDebtUuid(source.matches),
      date: paymentTimestamp.slice(0, 10),
      timestamp: paymentTimestamp,
      counterparty: optionalString(counterparty.display_name, "Payment counterparty name") ?? optionalString(source.counterparty_name, "Payment counterparty name") ?? stringOrEmpty(source.description, "Payment description"),
      description: stringOrEmpty(source.description, "Payment description"),
      direction: paymentDirection(source.direction, amount),
      amount,
      currency: optionalString(source.currency, "Payment currency") ?? "EUR",
      originalAmount: decimal(fx.counterparty_amount ?? fx.counterparty_value, "Payment original amount"),
      originalCurrency: optionalString(fx.counterparty_currency, "Payment original currency"),
      state: stringOrEmpty(source.state, "Payment state"),
      attachmentCount: nonnegativeInteger(rawAttachmentCount, "Payment attachment count")
    };
  }
  function projectTransactionFeedPage(value) {
    const page = record2(value, "Payments feed page");
    const results = boundedArray(page.results, "Payments feed results", maxFeedPageResults).map(payment);
    const pagination = record2(page.pagination, "Payments feed pagination");
    if (typeof pagination.has_more !== "boolean") {
      throw new Error("Payments feed pagination has an unexpected shape.");
    }
    const nextCursor = stringOrEmpty(pagination.next_cursor, "Payments feed cursor");
    if (pagination.has_more && !nextCursor) {
      throw new Error("Holvi pagination omitted its next cursor.");
    }
    return projection({
      results,
      hasMore: pagination.has_more,
      nextCursor: pagination.has_more ? nextCursor : ""
    });
  }
  function projectTransactionListing(value) {
    return projection(value);
  }
  function projectTransactionDetailDebt(value, debtUuid, paymentAccountUuid) {
    const debt = record2(value, "Transaction detail debt");
    const requestedUuid = uuid(debtUuid, "Debt UUID");
    const responseUuid = uuid(debt.uuid, "Transaction detail debt UUID");
    if (responseUuid.toLowerCase() !== requestedUuid.toLowerCase()) {
      throw new Error("Holvi transaction detail debt UUID does not match the request.");
    }
    const configuredAccount = uuid(paymentAccountUuid, "Configured payment account UUID");
    const responseAccount = uuid(debt.payment_account_uuid, "Transaction detail payment account UUID");
    if (responseAccount.toLowerCase() !== configuredAccount.toLowerCase()) {
      throw new Error("Holvi transaction detail debt is outside the configured payment account.");
    }
    const links = optionalRecord(debt.links, "Transaction detail links");
    const receiver = optionalRecord(debt.receiver, "Transaction detail receiver");
    const merchant = optionalRecord(receiver.merchant_info, "Transaction detail merchant");
    const address = optionalRecord(merchant.address, "Transaction detail merchant address");
    const merchantAddress = {
      street: optionalString(address.street, "Merchant address street"),
      postcode: optionalString(address.postcode, "Merchant address postcode"),
      city: optionalString(address.city, "Merchant address city"),
      country: optionalString(address.country, "Merchant address country")
    };
    const conversion = optionalRecord(debt.currency_conversion, "Transaction detail currency conversion");
    const exchangeRate = Object.keys(conversion).length ? {
      baseCurrency: boundedString(debt.currency, "Payment currency"),
      counterpartyCurrency: boundedString(conversion.counterparty_currency, "Exchange counterparty currency"),
      counterpartyAmount: requiredDecimal(conversion.counterparty_amount, "Exchange counterparty amount"),
      rate: requiredDecimal(conversion.rate, "Exchange rate")
    } : null;
    const creator = optionalRecord(debt.creator, "Transaction detail creator");
    const cardProfileUuid = optionalUuid(links.card_profile, "Transaction detail card profile UUID");
    const status = debt.status && typeof debt.status === "object" ? optionalString(record2(debt.status, "Transaction status").value, "Transaction status") : optionalString(debt.status ?? debt.state, "Transaction status");
    const referenceFields = [
      ["finnish", debt.fi_reference],
      ["rf", debt.rf_reference],
      ["message", debt.unstructured_reference]
    ];
    const referenceCandidates = referenceFields.map(([kind, value2]) => ({
      kind,
      value: optionalString(value2, `Transaction ${kind} reference`)
    })).filter((candidate) => candidate.value !== null);
    if (referenceCandidates.length > 1) {
      throw new Error("Transaction has ambiguous payment references.");
    }
    return projection({
      debtUuid: requestedUuid,
      paymentAccountUuid: responseAccount,
      valueDate: optionalDate(debt.value_date, "Transaction value date"),
      bookingDate: optionalDate(debt.booking_date, "Transaction booking date"),
      counterparty: optionalString(debt.counterparty_name, "Transaction counterparty"),
      recipientIban: optionalString(debt.iban, "Transaction recipient IBAN"),
      recipientBic: optionalString(debt.bic, "Transaction recipient BIC"),
      reference: referenceCandidates[0] ?? null,
      dueDate: optionalDate(debt.due_date, "Transaction due date"),
      instant: optionalBoolean(debt.sctinst_requested, "Instant payment flag"),
      status,
      type: optionalString(debt.type, "Transaction type"),
      subtype: optionalString(debt.subtype, "Transaction subtype"),
      archiveIdentifier: optionalString(debt.code, "Holvi archive identifier"),
      cardProfileUuid,
      cardholder: cardProfileUuid ? optionalString(creator.displayname, "Transaction detail cardholder") : null,
      exchangeRate,
      merchantAddress: Object.values(merchantAddress).some(Boolean) ? merchantAddress : null,
      merchantCategory: optionalString(merchant.category, "Transaction detail merchant category"),
      paymentType: optionalString(merchant.payment_type, "Transaction detail payment type")
    });
  }
  function projectTransactionAccount(value, paymentAccountUuid) {
    const pool = record2(value, "Pool account response");
    const requestedUuid = uuid(paymentAccountUuid, "Configured payment account UUID");
    const accounts = boundedArray(pool.paymentaccounts, "Pool payment accounts", maxPaymentAccounts);
    const matches = accounts.filter((entry) => {
      const account2 = record2(entry, "Pool payment account");
      return uuid(account2.uuid, "Pool payment account UUID").toLowerCase() === requestedUuid.toLowerCase();
    });
    if (matches.length !== 1) {
      throw new Error("Holvi pool response did not contain one configured payment account.");
    }
    const account = record2(matches[0], "Configured payment account");
    const iban = boundedString(account.iban, "Payment account IBAN");
    if (iban.length < 8 || iban.length > 64 || !/^[a-z0-9]+$/i.test(iban)) {
      throw new Error("Payment account IBAN has an unexpected shape.");
    }
    return projection({
      paymentAccountUuid: requestedUuid,
      name: boundedString(account.name, "Payment account name"),
      iban: `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`,
      currency: boundedString(account.currency, "Payment account currency")
    });
  }
  function projectTransactionCard(value, cardProfileUuid, paymentAccountUuid) {
    const card = record2(value, "Transaction card profile");
    const requestedCard = uuid(cardProfileUuid, "Card profile UUID");
    const responseCard = uuid(card.uuid, "Transaction card profile UUID");
    if (responseCard.toLowerCase() !== requestedCard.toLowerCase()) {
      throw new Error("Holvi card profile UUID does not match the debt link.");
    }
    const requestedAccount = uuid(paymentAccountUuid, "Configured payment account UUID");
    const responseAccount = uuid(card.payment_account_uuid, "Card payment account UUID");
    if (responseAccount.toLowerCase() !== requestedAccount.toLowerCase()) {
      throw new Error("Holvi card profile is outside the configured payment account.");
    }
    const maskedPan = boundedString(card.masked_pan, "Card masked PAN");
    const lastFour = maskedPan.length <= 64 ? maskedPan.match(/(\d{4})$/)?.[1] : undefined;
    if (!lastFour) {
      throw new Error("Holvi card profile has an invalid masked PAN.");
    }
    return projection({
      cardProfileUuid: requestedCard,
      lastFour
    });
  }
  function projectTransactionPaymentMetadata(value, paymentUuid) {
    const payment2 = record2(value, "Transaction payment details");
    const requestedUuid = uuid(paymentUuid, "Payment UUID");
    const responseUuid = uuid(payment2.uuid, "Transaction payment details UUID");
    if (responseUuid.toLowerCase() !== requestedUuid.toLowerCase()) {
      throw new Error("Holvi transaction payment UUID does not match the request.");
    }
    const counterparty = optionalRecord(payment2.counterparty, "Transaction payment counterparty");
    const paymentTimestamp = timestamp(payment2.ux_timestamp, "Transaction payment timestamp");
    const bookingDate = optionalDate(payment2.booking_date ?? paymentTimestamp, "Transaction booking date");
    const valueDate = optionalDate(payment2.value_date ?? paymentTimestamp, "Transaction value date");
    const bankReference = optionalString(payment2.structured_reference, "Transaction bank reference");
    const message = optionalString(payment2.unstructured_reference, "Transaction payment message");
    const reference = bankReference ? {
      kind: /^RF/i.test(bankReference) ? "rf" : "finnish",
      value: bankReference
    } : message ? { kind: "message", value: message } : null;
    return projection({
      timestamp: paymentTimestamp,
      valueDate,
      bookingDate,
      counterparty: optionalString(counterparty.display_name, "Transaction payment counterparty name"),
      bankReference,
      message,
      reference
    });
  }
  function projectTransactionDetails(value) {
    return projection(record2(value, "Transaction details"));
  }
  function attachmentCode(value) {
    const code = boundedString(value, "Attachment code");
    if (code.length > 256 || Array.from({ length: code.length }, (_, index) => code.charCodeAt(index)).some((value2) => value2 < 32 || value2 === 127)) {
      throw new Error("Attachment code must be a nonempty bounded string.");
    }
    return code;
  }
  function debtAttachments(value, label) {
    const codes = new Set;
    return boundedArray(value, `${label} attachments`, maxDebtAttachments, true).map((entry) => {
      const source = record2(entry, `${label} attachment`);
      const code = attachmentCode(source.code);
      if (codes.has(code)) {
        throw new Error(`${label} contains an ambiguous attachment code.`);
      }
      codes.add(code);
      return {
        attachmentCode: code,
        title: boundedString(source.title, `${label} attachment title`),
        format: optionalString(source.format, `${label} attachment format`)
      };
    });
  }
  function debtRecord(value, debtUuid, paymentAccountUuid, label) {
    const debt = record2(value, label);
    const requestedUuid = uuid(debtUuid, "Debt UUID");
    const responseUuid = uuid(debt.uuid, `${label} UUID`);
    if (responseUuid.toLowerCase() !== requestedUuid.toLowerCase()) {
      throw new Error(`Holvi ${label.toLowerCase()} UUID does not match the request.`);
    }
    const configuredPaymentAccountUuid = uuid(paymentAccountUuid, "Configured payment account");
    const responsePaymentAccountUuid = uuid(debt.payment_account_uuid, `${label} payment account`);
    if (responsePaymentAccountUuid.toLowerCase() !== configuredPaymentAccountUuid.toLowerCase()) {
      throw new Error(`Holvi ${label.toLowerCase()} payment account does not match the configured payment account.`);
    }
    const attachments = debtAttachments(debt.attachments, label);
    const merchant = optionalRecord(debt.merchant, `${label} merchant`);
    return projection({
      debtUuid: requestedUuid,
      code: stringOrEmpty(debt.code, `${label} code`),
      counterparty: optionalString(debt.counterparty_name, `${label} counterparty`) ?? stringOrEmpty(merchant.name, `${label} merchant name`),
      amount: decimal(debt.amount ?? debt.value ?? debt.total, `${label} amount`),
      currency: optionalString(debt.currency, `${label} currency`) ?? "EUR",
      attachmentCount: attachments.length,
      attachments,
      bookkeepingStatus: optionalString(debt.bookkeeping_status, `${label} bookkeeping status`) ?? stringOrEmpty(debt.bookkeeping_state, `${label} bookkeeping state`)
    });
  }
  function projectDebtPreview(value, debtUuid, paymentAccountUuid) {
    return debtRecord(value, debtUuid, paymentAccountUuid, "Debt");
  }
  function commentContent(value, label) {
    if (typeof value !== "string" || value.length < 1 || new TextEncoder().encode(value).byteLength > maxCommentContentBytes) {
      throw new Error(`${label} must be a nonempty bounded string.`);
    }
    return value;
  }
  function commentCreator(value) {
    if (value === null || value === undefined) {
      return { uuid: null, name: "Holvi", isHolvi: true };
    }
    const source = record2(value, "Comment creator");
    const creatorUuid = optionalUuid(source.uuid, "Comment creator UUID");
    const firstName = optionalString(source.first_name, "Comment creator first name") ?? optionalString(source.firstname, "Comment creator first name");
    const lastName = optionalString(source.last_name, "Comment creator last name") ?? optionalString(source.lastname, "Comment creator last name");
    const name = optionalString(source.name, "Comment creator name") ?? optionalString(source.display_name, "Comment creator display name") ?? [firstName, lastName].filter(Boolean).join(" ");
    if (!name) {
      throw new Error("Comment creator has no bounded display name.");
    }
    return { uuid: creatorUuid, name, isHolvi: false };
  }
  function comment(value) {
    const source = record2(value, "Comment");
    if (typeof source.push_notified !== "boolean") {
      throw new Error("Comment notification state has an unexpected shape.");
    }
    return {
      uuid: optionalUuid(source.uuid, "Comment UUID"),
      content: commentContent(source.content, "Comment content"),
      creator: commentCreator(source.creator),
      createTime: timestamp(source.create_time, "Comment creation time"),
      pushNotified: source.push_notified
    };
  }
  function projectCommentPage(value) {
    if (Array.isArray(value)) {
      return projection({
        results: boundedArray(value, "Comment results", maxCommentResults).map(comment),
        next: ""
      });
    }
    const page = record2(value, "Comment page");
    const results = boundedArray(page.results, "Comment page results", maxCommentPageResults).map(comment);
    const next = optionalString(page.next, "Comment next page") ?? "";
    return projection({ results, next });
  }
  function projectCommentListing(value) {
    return projection(value);
  }
  function projectCommentWriteResponse(value) {
    return projection(comment(value));
  }
  function projectUploadDebtRead(value, debtUuid, paymentAccountUuid) {
    return debtRecord(value, debtUuid, paymentAccountUuid, "Upload debt");
  }
  function projectAttachmentDeletionDebt(value, debtUuid, paymentAccountUuid) {
    const debt = record2(value, "Attachment deletion debt");
    const expectedAccount = uuid(paymentAccountUuid, "Configured payment account UUID");
    const actualAccount = uuid(debt.payment_account_uuid, "Attachment deletion payment account UUID");
    if (actualAccount.toLowerCase() !== expectedAccount.toLowerCase()) {
      throw new Error("Holvi attachment deletion debt is outside the configured payment account.");
    }
    return projection({
      ...debtRecord(debt, debtUuid, paymentAccountUuid, "Attachment deletion debt"),
      paymentAccountUuid: actualAccount
    });
  }
  function bookkeepingItem(value) {
    const item = record2(value, "Bookkeeping item");
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
    const debt = record2(value, "Bookkeeping debt");
    const items = debt.items === null || debt.items === undefined ? [] : debt.items;
    if (!Array.isArray(items)) {
      throw new Error("Holvi bookkeeping debt has an invalid item list.");
    }
    if (items.length > maxBookkeepingItems) {
      throw new Error("Holvi bookkeeping debt exceeded its item limit.");
    }
    const attachments = debtAttachments(debt.attachments, "Bookkeeping debt");
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
      attachments,
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
      const category = record2(entry, "Bookkeeping category");
      return {
        code: boundedString(category.code, "Bookkeeping category code"),
        handle: optionalString(category.handle, "Bookkeeping category handle"),
        label: optionalString(category.label, "Bookkeeping category label")
      };
    }));
  }
  function projectSuggestions(value, debtUuid) {
    const suggestions = record2(value, "Bookkeeping suggestions");
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
      return boundedString(record2(entry, "Suggested category").code, "Suggested category code");
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
    const source = record2(value, "Activity creator");
    const name = optionalString(source.name, "Activity creator name") ?? [
      optionalString(source.firstname, "Activity creator first name"),
      optionalString(source.lastname, "Activity creator last name")
    ].filter(Boolean).join(" ");
    return { name: name || "Unknown", isHolvi: false };
  }
  function auditEntry(value) {
    const entry = record2(value, "Activity entry");
    const timestamp2 = boundedString(entry.timestamp, "Activity timestamp");
    if (!Number.isFinite(Date.parse(timestamp2))) {
      throw new Error("Activity timestamp is invalid.");
    }
    const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {};
    return {
      code: boundedString(entry.code, "Activity code"),
      timestamp: timestamp2,
      category: optionalString(entry.category, "Activity category"),
      creator: creator(entry.creator),
      action: optionalString(entry.action, "Activity action"),
      title: optionalString(entry.title, "Activity title"),
      content: typeof entry.content === "string" ? optionalString(entry.content, "Activity content") : null,
      status: optionalString(data.status, "Activity status")
    };
  }
  function projectAccounts(value) {
    const pool = record2(value, "Pool");
    const accounts = boundedArray(pool.paymentaccounts, "Payment accounts", 100);
    const seen = new Set;
    const results = accounts.map((entry) => {
      const account = record2(entry, "Payment account");
      const paymentAccountUuid = uuid(account.uuid, "Payment account UUID");
      if (seen.has(paymentAccountUuid.toLowerCase()))
        throw new Error("Holvi returned duplicate payment accounts.");
      seen.add(paymentAccountUuid.toLowerCase());
      return {
        paymentAccountUuid,
        name: optionalString(account.name, "Payment account name"),
        iban: optionalString(account.iban, "Payment account IBAN"),
        currency: optionalString(account.currency, "Payment account currency"),
        balance: decimal(account.balance, "Payment account balance"),
        availableBalance: decimal(account.available_balance, "Payment account available balance"),
        blockedBalance: decimal(account.blocked_balance, "Payment account blocked balance"),
        state: optionalString(account.state ?? account.status, "Payment account state")
      };
    });
    return projection({ count: results.length, results });
  }
  function projectBookkeepingPage(value) {
    const page = record2(value, "Bookkeeping page");
    const results = boundedArray(page.results, "Bookkeeping results", 100).map((entry) => {
      const debt = record2(entry, "Bookkeeping list debt");
      return projectBookkeepingDebt(debt, uuid(debt.uuid, "Bookkeeping debt UUID"));
    });
    return projection({
      results,
      next: optionalString(page.next, "Bookkeeping next page") ?? ""
    });
  }
  function projectReportJobs(value) {
    const page = record2(value, "Report jobs");
    const seen = new Set;
    const results = boundedArray(page.results, "Report job results", 100).map((entry) => {
      const job = record2(entry, "Report job");
      const reportUuid = uuid(job.uuid, "Report UUID");
      if (seen.has(reportUuid.toLowerCase()))
        throw new Error("Holvi returned duplicate report jobs.");
      seen.add(reportUuid.toLowerCase());
      const reportType = boundedString(job.report_type, "Report type");
      if (!["single_pdf", "zip_export"].includes(reportType))
        throw new Error("Holvi returned an unsupported report type.");
      const status = boundedString(job.status, "Report status");
      if (!["initiated", "ready", "error"].includes(status))
        throw new Error("Holvi returned an unsupported report status.");
      return {
        reportUuid,
        reportType,
        status,
        fromDate: boundedString(job.from_date, "Report start date"),
        toDate: boundedString(job.to_date, "Report end date"),
        paymentAccountUuid: optionalUuid(job.payment_account_uuid, "Report payment account"),
        createTime: timestamp(job.create_time, "Report creation time"),
        availableUntil: job.available_until ? timestamp(job.available_until, "Report availability") : null
      };
    });
    return projection({ count: results.length, results });
  }
  function projectAuditTypes(value) {
    let source;
    if (Array.isArray(value)) {
      source = value;
    } else {
      const typeClasses = record2(value, "Activity types");
      if (Array.isArray(typeClasses.results)) {
        source = boundedArray(typeClasses.results, "Activity types", 200);
      } else {
        const keys = Object.keys(typeClasses);
        if (keys.length > 200) {
          throw new Error("Activity types exceeded their result limit.");
        }
        source = keys;
      }
    }
    const results = source.map((entry) => typeof entry === "string" ? boundedString(entry, "Activity type") : boundedString(record2(entry, "Activity type").value ?? record2(entry, "Activity type").code, "Activity type"));
    if (new Set(results).size !== results.length) {
      throw new Error("Activity types contain duplicate values.");
    }
    return projection({ count: results.length, results });
  }
  function projectAuditTraversalPage(value) {
    const page = record2(value, "Activity page");
    return projection({
      results: boundedArray(page.results, "Activity results", 25).map(auditEntry),
      next: optionalString(page.next, "Activity next page") ?? ""
    });
  }
  function projectAuditPage(value, limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > maxAuditResults) {
      throw new Error("Activity limit is outside the configured range.");
    }
    const page = record2(value, "Activity page");
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

  // src/extension/attachment-deletion-workflow.ts
  function validateAttachmentCode(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)).some((code) => code < 32 || code === 127)) {
      throw new Error("Attachment code must be a nonempty bounded string.");
    }
    return value;
  }
  function attachments(debt) {
    if (!Array.isArray(debt.attachments)) {
      throw new Error("Holvi attachment deletion projection is invalid.");
    }
    return debt.attachments;
  }
  function sameRemainingAttachments(before, after, deletedCode) {
    const expected = before.filter((attachment) => attachment.attachmentCode !== deletedCode);
    if (after.length !== expected.length) {
      return false;
    }
    const actualByCode = new Map(after.map((attachment) => [attachment.attachmentCode, attachment]));
    return expected.every((attachment) => {
      const actual = actualByCode.get(attachment.attachmentCode);
      return actual && JSON.stringify(actual) === JSON.stringify(attachment);
    });
  }

  class AttachmentDeletionWorkflow {
    session;
    api;
    sleep;
    constructor(session, api, sleep = (delay) => new Promise((resolve) => self.setTimeout(resolve, delay))) {
      this.session = session;
      this.api = api;
      this.sleep = sleep;
    }
    async deleteAttachment(auth, params) {
      this.session.requireCapabilities("transactions.read", "attachments.delete");
      const debtUuid = validateUuid(typeof params.debtUuid === "string" ? params.debtUuid : "", "debt");
      const attachmentCode2 = validateAttachmentCode(params.attachmentCode);
      if (typeof params.confirmed !== "boolean") {
        throw new Error("Attachment deletion confirmation is invalid.");
      }
      const before = projectAttachmentDeletionDebt(await this.api.request(auth, this.api.debtPath(debtUuid)), debtUuid, this.session.config.paymentAccountUuid);
      const beforeAttachments = attachments(before);
      const matches = beforeAttachments.filter((attachment) => attachment.attachmentCode === attachmentCode2);
      if (matches.length !== 1) {
        throw new Error(matches.length === 0 ? "Attachment deletion target does not exist on the selected debt." : "Attachment deletion target is ambiguous on the selected debt.");
      }
      const target = matches[0];
      if (!params.confirmed) {
        return {
          dryRun: true,
          debt: before,
          attachment: target,
          next: "Repeat the attachment deletion command with --yes after checking these values."
        };
      }
      await this.api.request(auth, `${this.session.apiRoot()}attachment/${encodeURIComponent(attachmentCode2)}/`, { method: "DELETE" });
      let after = null;
      for (const delay of [0, 250, 500, 1000, 2000]) {
        if (delay) {
          await this.sleep(delay);
        }
        after = projectAttachmentDeletionDebt(await this.api.request(auth, this.api.debtPath(debtUuid)), debtUuid, this.session.config.paymentAccountUuid);
        if (sameRemainingAttachments(beforeAttachments, attachments(after), attachmentCode2)) {
          return {
            dryRun: false,
            debtUuid,
            attachment: target,
            attachmentCountBefore: beforeAttachments.length,
            attachmentCountAfter: attachments(after).length,
            verified: true
          };
        }
      }
      throw new Error("Holvi accepted the deletion but the resulting attachment state could not be verified. Inspect the debt before retrying.");
    }
  }

  // src/extension/bookkeeping-description-workflow.ts
  var bookkeepingDescriptionMaxBytes = 4096;
  var maxBookkeepingItems2 = 500;
  var maxDiagnosticPaths = 32;
  var maxDiagnosticDepth = 8;
  var maxDiagnosticFieldBytes = 128;
  var criticalDebtFields = [
    "uuid",
    "payment_account_uuid",
    "code",
    "booking_date",
    "amount",
    "value",
    "total",
    "currency",
    "bookkeeping_status",
    "bookkeeping_state",
    "type",
    "subtype",
    "connection_uuid",
    "attachments"
  ];
  function record3(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} has an unexpected shape.`);
    }
    return value;
  }
  function boundedDescription(value, label) {
    if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > bookkeepingDescriptionMaxBytes) {
      throw new Error(`${label} must be at most 4096 bytes.`);
    }
    return value;
  }
  function sameUuid(left, right) {
    return left.toLowerCase() === right.toLowerCase();
  }
  function responseUuid(value, label) {
    if (typeof value !== "string") {
      throw new Error(`${label} must be a UUID.`);
    }
    return validateUuid(value, label);
  }
  function canonicalJson(value) {
    function normalize(entry) {
      if (Array.isArray(entry)) {
        return entry.map(normalize);
      }
      if (entry && typeof entry === "object") {
        return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]));
      }
      return entry;
    }
    return JSON.stringify(normalize(value));
  }
  function parseSnapshot(value, debtUuid, itemUuid, paymentAccountUuid) {
    const debt = record3(value, "Bookkeeping debt");
    const responseDebtUuid = responseUuid(debt.uuid, "bookkeeping debt");
    if (!sameUuid(responseDebtUuid, debtUuid)) {
      throw new Error("Holvi bookkeeping debt UUID does not match the request.");
    }
    const responsePaymentAccountUuid = responseUuid(debt.payment_account_uuid, "bookkeeping debt payment account");
    if (!sameUuid(responsePaymentAccountUuid, paymentAccountUuid)) {
      throw new Error("Holvi bookkeeping debt payment account does not match the configured payment account.");
    }
    if (!Array.isArray(debt.items)) {
      throw new Error("Holvi bookkeeping debt has an invalid item list.");
    }
    if (debt.items.length > maxBookkeepingItems2) {
      throw new Error("Holvi bookkeeping debt exceeded its item limit.");
    }
    const matchingItems = [];
    const items = [];
    for (const [index, value2] of debt.items.entries()) {
      const item = record3(value2, `Bookkeeping item ${index + 1}`);
      const responseItemUuid = responseUuid(item.uuid, `bookkeeping item ${index + 1}`);
      if (typeof item.type !== "string" || typeof item.active !== "boolean") {
        throw new Error(`Bookkeeping item ${index + 1} has an unexpected shape.`);
      }
      if (sameUuid(responseItemUuid, itemUuid)) {
        matchingItems.push(item);
      }
      if (item.type === "line_item" && item.active) {
        boundedDescription(item.description, `Bookkeeping item ${index + 1} description`);
        items.push(item);
      }
    }
    if (matchingItems.length !== 1) {
      throw new Error("Holvi bookkeeping debt must contain exactly one matching item UUID.");
    }
    const targetIndex = items.indexOf(matchingItems[0]);
    if (targetIndex < 0) {
      throw new Error("The matching bookkeeping item is not an active line item.");
    }
    const currentDescription = boundedDescription(items[targetIndex].description, "Current bookkeeping description");
    return { debt, items, targetIndex, currentDescription };
  }
  function verifyCriticalDebtFields(before, after) {
    for (const field of criticalDebtFields) {
      if (canonicalJson(before[field]) !== canonicalJson(after[field])) {
        throw new Error(`Bookkeeping verification found a changed debt field: ${field}.`);
      }
    }
  }
  function withoutMutableTargetFields(item) {
    const copy = { ...item };
    delete copy.description;
    delete copy.timestamp;
    return copy;
  }
  function diagnosticPath(parent, field) {
    const boundedField = new TextEncoder().encode(field).byteLength <= maxDiagnosticFieldBytes ? field : "<oversized-field-name>";
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(boundedField) ? parent ? `${parent}.${boundedField}` : boundedField : `${parent}[${JSON.stringify(boundedField)}]`;
  }
  function changedFieldPaths(expected, actual) {
    const paths = [];
    let truncated = false;
    function visit(left, right, path, depth) {
      if (canonicalJson(left) === canonicalJson(right)) {
        return;
      }
      if (paths.length >= maxDiagnosticPaths) {
        truncated = true;
        return;
      }
      if (depth < maxDiagnosticDepth && left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
        const leftRecord = left;
        const rightRecord = right;
        const fields = Array.from(new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])).sort();
        for (const field of fields) {
          const fieldPath = diagnosticPath(path, field);
          if (!Object.hasOwn(leftRecord, field) || !Object.hasOwn(rightRecord, field)) {
            if (paths.length >= maxDiagnosticPaths) {
              truncated = true;
              return;
            }
            paths.push(fieldPath);
          } else {
            visit(leftRecord[field], rightRecord[field], fieldPath, depth + 1);
          }
        }
        return;
      }
      paths.push(path || "value");
    }
    visit(expected, actual, "", 0);
    return { paths, truncated };
  }
  function verifyItems(expected, after, itemUuid, description) {
    if (after.items.length !== expected.length) {
      throw new Error("Bookkeeping verification found a changed line-item count.");
    }
    for (let index = 0;index < expected.length; index += 1) {
      const expectedItem = expected[index];
      const actualItem = after.items[index];
      const expectedUuid = responseUuid(expectedItem.uuid, "expected bookkeeping item");
      const actualUuid = responseUuid(actualItem.uuid, "verified bookkeeping item");
      if (!sameUuid(expectedUuid, actualUuid)) {
        throw new Error("Bookkeeping verification found changed sibling item identity.");
      }
      if (sameUuid(expectedUuid, itemUuid)) {
        if (actualItem.description !== description) {
          throw new Error("Bookkeeping verification found an unexpected description.");
        }
        const expectedFields = withoutMutableTargetFields(expectedItem);
        const actualFields = withoutMutableTargetFields(actualItem);
        if (canonicalJson(expectedFields) !== canonicalJson(actualFields)) {
          const changes = changedFieldPaths(expectedFields, actualFields);
          const omitted = changes.truncated ? " Additional fields were omitted." : "";
          throw new Error(`Bookkeeping verification found changed target item fields: ${JSON.stringify(changes.paths)}.${omitted}`);
        }
      } else if (canonicalJson(expectedItem) !== canonicalJson(actualItem)) {
        throw new Error("Bookkeeping verification found a changed sibling item.");
      }
    }
  }

  class BookkeepingDescriptionWorkflow {
    session;
    api;
    constructor(session, api) {
      this.session = session;
      this.api = api;
    }
    async change(auth, change) {
      this.session.requireCapabilities("bookkeeping.write");
      const debtUuid = validateUuid(change.debtUuid, "debt");
      const itemUuid = validateUuid(change.itemUuid, "item");
      const description = boundedDescription(change.description, "Bookkeeping description");
      if (typeof change.confirmed !== "boolean") {
        throw new Error("Bookkeeping confirmation has an unexpected shape.");
      }
      const path = this.api.debtPath(debtUuid);
      const before = parseSnapshot(await this.api.request(auth, path), debtUuid, itemUuid, this.session.config.paymentAccountUuid);
      const report = {
        debtUuid,
        itemUuid,
        currentDescription: before.currentDescription,
        proposedDescription: description
      };
      if (!change.confirmed) {
        return {
          ...report,
          dryRun: true,
          writePerformed: false,
          next: "Repeat the command with --yes after checking these descriptions."
        };
      }
      const items = before.items.map((item, index) => index === before.targetIndex ? { ...item, description } : item);
      try {
        await this.api.request(auth, path, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items })
        });
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        throw new Error(`Bookkeeping description write failed or had an ambiguous outcome.${detail} Inspect the debt before retrying.`);
      }
      try {
        const after = parseSnapshot(await this.api.request(auth, path), debtUuid, itemUuid, this.session.config.paymentAccountUuid);
        verifyCriticalDebtFields(before.debt, after.debt);
        verifyItems(items, after, itemUuid, description);
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        throw new Error(`Holvi accepted the write but post-write verification failed.${detail} Inspect the debt before retrying.`);
      }
      return {
        ...report,
        dryRun: false,
        writePerformed: true,
        verified: true
      };
    }
  }

  // src/extension/holvi-api.ts
  var reportTypes = Object.freeze([
    {
      type: "account-statement",
      backend: "account-statement",
      mode: "direct",
      formats: ["pdf", "xls"],
      accountRequired: true,
      maxMonths: 12
    },
    {
      type: "journal",
      backend: "journal-v2",
      mode: "direct",
      formats: ["xls"],
      accountRequired: false
    },
    {
      type: "ledger",
      backend: "ledger-v2",
      mode: "direct",
      formats: ["xls"],
      accountRequired: false
    },
    {
      type: "camt052",
      backend: "camt052",
      mode: "direct",
      formats: ["xml"],
      accountRequired: true
    },
    {
      type: "invoicing",
      backend: "invoicing",
      mode: "direct",
      formats: ["xls"],
      accountRequired: false
    },
    {
      type: "all-in-one-pdf",
      backend: "single_pdf",
      mode: "async",
      formats: ["pdf"],
      accountRequired: true,
      maxMonths: 12
    },
    {
      type: "all-in-one-zip",
      backend: "zip_export",
      mode: "async",
      formats: ["zip"],
      accountRequired: false
    }
  ]);
  var auditLimitMin = 1;
  var auditLimitMax = 5000;
  var auditPageSize = 25;
  var maxApiResponseBytes = 2 * 1024 * 1024;
  var maxPaymentResponseBytes = 512 * 1024;
  var commentPageSize = 25;
  var maxCommentPages = 40;
  var maxCommentResults2 = 1000;
  var maxCommentResponseBytes = 1024 * 1024;
  function asString(value) {
    return typeof value === "string" ? value : "";
  }
  async function boundedResponseText(response, maxResponseBytes2) {
    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength)) {
      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength > maxResponseBytes2) {
        throw new Error("Holvi API response exceeded its size limit.");
      }
    }
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maxResponseBytes2) {
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
  function withinDateRange(payment2, from, to) {
    const date = asString(payment2.date);
    return Boolean(date) && (!from || date >= from) && (!to || date <= to);
  }

  class HolviApi {
    staticConfig;
    session;
    fetchRequest;
    constructor(staticConfig, session, fetchRequest = fetch) {
      this.staticConfig = staticConfig;
      this.session = session;
      this.fetchRequest = fetchRequest;
    }
    async request(auth, apiPath, options = {}, maxResponseBytes2 = maxApiResponseBytes) {
      if (!apiPath.startsWith(this.session.apiRoot())) {
        throw new Error("Refused an API path outside the configured Holvi account.");
      }
      const headers = new Headers(options.headers || {});
      headers.set("Accept", "application/json");
      headers.set("Authorization", `Bearer ${auth.token}`);
      if (auth.csrfToken) {
        headers.set("X-CSRFToken", auth.csrfToken);
      }
      const fetchRequest = this.fetchRequest;
      const response = await fetchRequest(`${this.staticConfig.apiOrigin}${apiPath}`, {
        ...options,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error"
      });
      const contentType = response.headers.get("content-type") || "";
      const text = await boundedResponseText(response, maxResponseBytes2);
      let body = text;
      if (contentType.includes("application/json")) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error("Holvi API returned malformed JSON.");
        }
      }
      if (!response.ok) {
        const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
        throw new Error(`Holvi API returned ${response.status}: ${detail}`);
      }
      return body;
    }
    feedPath(cursor = "", missingAttachments = false) {
      const query = new URLSearchParams({
        timeline: "past",
        payment_account: this.session.config.paymentAccountUuid
      });
      if (missingAttachments) {
        query.set("missing_attachments", "true");
      }
      if (cursor) {
        query.set("cursor", cursor);
      }
      return `${this.session.apiRoot()}ux/payments-feed/?${query}`;
    }
    paymentDetailPath(paymentUuid) {
      return `${this.session.apiRoot()}ux/payments-feed/${encodeURIComponent(validateUuid(paymentUuid, "payment"))}/`;
    }
    debtPath(debtUuid) {
      return `${this.session.apiRoot()}debt/${encodeURIComponent(validateUuid(debtUuid, "debt"))}/`;
    }
    paymentDebtCollectionPath() {
      return `${this.session.apiRoot()}debt/`;
    }
    async createPaymentDebt(auth, payload) {
      return this.request(auth, this.paymentDebtCollectionPath(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }, maxPaymentResponseBytes);
    }
    async readPaymentDebt(auth, debtUuid) {
      return this.request(auth, this.debtPath(debtUuid), {}, maxPaymentResponseBytes);
    }
    async verifyPayee(auth, name, iban) {
      const path = `/api/vop/${encodeURIComponent(this.session.config.poolHandle)}/payee-verification/`;
      const expected = `/api/vop/${this.session.config.poolHandle}/payee-verification/`;
      if (path !== expected) {
        throw new Error("Refused an invalid payee-verification path.");
      }
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json"
      });
      if (auth.csrfToken)
        headers.set("X-CSRFToken", auth.csrfToken);
      const fetchRequest = this.fetchRequest;
      const response = await fetchRequest(`${this.staticConfig.apiOrigin}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, iban }),
        credentials: "include",
        cache: "no-store",
        redirect: "error"
      });
      const text = await boundedResponseText(response, 128 * 1024);
      if (!response.ok) {
        throw new Error(`Holvi payee verification returned ${response.status}.`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Holvi payee verification returned malformed JSON.");
      }
    }
    cardPath(cardProfileUuid) {
      return `${this.session.apiRoot()}cardprofile/${encodeURIComponent(validateUuid(cardProfileUuid, "card profile"))}/`;
    }
    commentPath(debtUuid) {
      return `${this.debtPath(debtUuid)}comment/`;
    }
    commentContinuationPath(next, debtUuid) {
      if (next.length > 4096) {
        throw new Error("Holvi comment pagination URL exceeded its limit.");
      }
      let url;
      try {
        url = new URL(next, this.staticConfig.apiOrigin);
      } catch {
        throw new Error("Holvi comment pagination URL is invalid.");
      }
      const expectedPath = this.commentPath(debtUuid);
      if (url.origin !== this.staticConfig.apiOrigin || url.pathname !== expectedPath || url.username || url.password || url.hash) {
        throw new Error("Holvi comment pagination changed the target endpoint.");
      }
      return `${expectedPath}${url.search}`;
    }
    async transactionFeedPage(auth, cursor = "", missingAttachments = false) {
      return projectTransactionFeedPage(await this.request(auth, this.feedPath(cursor, missingAttachments)));
    }
    async listTransactions(auth, params) {
      const results = [];
      const seenCursors = new Set;
      const missingAttachments = params.missingAttachments === true;
      let cursor = "";
      let pages = 0;
      do {
        const page = await this.transactionFeedPage(auth, cursor, missingAttachments);
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
        results
      });
    }
    async paymentForDebt(auth, debtUuid) {
      const seenCursors = new Set;
      let cursor = "";
      let matchedPayment = null;
      let pages = 0;
      let results = 0;
      do {
        const page = await this.transactionFeedPage(auth, cursor);
        pages += 1;
        results += page.results.length;
        if (results > this.staticConfig.maxTransactionResults) {
          throw new Error("The transaction lookup exceeded its result limit.");
        }
        const matches = page.results.filter((item) => typeof item.debtUuid === "string" && item.debtUuid.toLowerCase() === debtUuid.toLowerCase());
        if (matches.length > 1 || matches.length === 1 && matchedPayment !== null) {
          throw new Error("Holvi returned an ambiguous payment match.");
        }
        if (matches.length === 1) {
          matchedPayment = matches[0] ?? null;
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
      return matchedPayment;
    }
    async transactionDetails(auth, debtUuid) {
      const validUuid = validateUuid(debtUuid, "debt");
      const paymentAccountUuid = this.session.config.paymentAccountUuid;
      const debtValue = await this.request(auth, this.debtPath(validUuid));
      const debt = projectTransactionDetailDebt(debtValue, validUuid, paymentAccountUuid);
      const preview = projectDebtPreview(debtValue, validUuid, paymentAccountUuid);
      const [payment2, account, card] = await Promise.all([
        this.paymentForDebt(auth, validUuid),
        this.request(auth, this.session.apiRoot()).then((value) => projectTransactionAccount(value, paymentAccountUuid)),
        debt.cardProfileUuid ? this.request(auth, this.cardPath(debt.cardProfileUuid)).then((value) => projectTransactionCard(value, debt.cardProfileUuid, paymentAccountUuid)) : Promise.resolve(null)
      ]);
      const paymentUuid = asString(payment2?.paymentUuid) || null;
      const paymentMetadata = paymentUuid ? projectTransactionPaymentMetadata(await this.request(auth, this.paymentDetailPath(paymentUuid)), paymentUuid) : null;
      return projectTransactionDetails({
        ...preview,
        paymentUuid,
        debtUuid: debt.debtUuid,
        timestamp: paymentMetadata?.timestamp ?? null,
        valueDate: debt.valueDate ?? paymentMetadata?.valueDate ?? null,
        bookingDate: debt.bookingDate ?? paymentMetadata?.bookingDate ?? null,
        direction: asString(payment2?.direction) || null,
        status: debt.status ?? (asString(payment2?.state) || null),
        counterparty: debt.counterparty ?? paymentMetadata?.counterparty ?? preview.counterparty,
        recipientIban: debt.recipientIban,
        recipientBic: debt.recipientBic,
        reference: debt.reference ?? paymentMetadata?.reference ?? null,
        bankReference: paymentMetadata?.bankReference ?? null,
        message: paymentMetadata?.message ?? null,
        dueDate: debt.dueDate,
        instant: debt.instant,
        type: debt.type,
        subtype: debt.subtype,
        archiveIdentifier: debt.archiveIdentifier,
        card,
        account,
        cardholder: debt.cardholder,
        exchangeRate: debt.exchangeRate,
        merchantAddress: debt.merchantAddress,
        merchantCategory: debt.merchantCategory,
        paymentType: debt.paymentType
      });
    }
    async previewDebt(auth, debtUuid) {
      const validUuid = validateUuid(debtUuid, "debt");
      return projectDebtPreview(await this.request(auth, this.debtPath(validUuid)), validUuid, this.session.config.paymentAccountUuid);
    }
    async listComments(auth, debtUuid) {
      const validUuid = validateUuid(debtUuid, "debt").toLowerCase();
      await this.previewDebt(auth, validUuid);
      const results = [];
      const seenPages = new Set;
      let path = `${this.commentPath(validUuid)}?${new URLSearchParams({
        o: "-create_time",
        page_size: String(commentPageSize)
      })}`;
      let pages = 0;
      while (path) {
        if (seenPages.has(path)) {
          throw new Error("Holvi repeated a comment pagination URL.");
        }
        seenPages.add(path);
        const page = projectCommentPage(await this.request(auth, path, {}, maxCommentResponseBytes));
        results.push(...page.results);
        pages += 1;
        if (results.length > maxCommentResults2) {
          throw new Error("The comment listing exceeded its result limit.");
        }
        if (page.next && pages >= maxCommentPages) {
          throw new Error("The comment listing exceeded its page limit.");
        }
        path = page.next ? this.commentContinuationPath(page.next, validUuid) : "";
      }
      for (let index = 1;index < results.length; index += 1) {
        const previous = results[index - 1];
        const current = results[index];
        if (!previous || !current || Date.parse(String(previous.createTime)) < Date.parse(String(current.createTime))) {
          throw new Error("Holvi comments are not ordered newest first.");
        }
      }
      return projectCommentListing({
        debtUuid: validUuid,
        pages,
        count: results.length,
        order: "newest-first",
        results
      });
    }
    async bookkeepingDebt(auth, debtUuid) {
      const validUuid = validateUuid(debtUuid, "debt");
      return projectBookkeepingDebt(await this.request(auth, this.debtPath(validUuid)), validUuid);
    }
    async bookkeepingCategories(auth) {
      return projectCategories(await this.request(auth, `${this.session.apiRoot()}category/`));
    }
    async bookkeepingSuggestions(auth, debtUuid) {
      const validUuid = validateUuid(debtUuid, "debt");
      return projectSuggestions(await this.request(auth, `${this.debtPath(validUuid)}haip/bookkeeping-suggestions/`), validUuid);
    }
    async downloadResponse(auth, action, params) {
      const fetchRequest = this.fetchRequest;
      if (action === "attachments.download") {
        const debtUuid = validateUuid(asString(params.debtUuid), "debt");
        const preview = await this.previewDebt(auth, debtUuid);
        const matches = preview.attachments.filter((item) => item.attachmentCode === params.attachmentCode);
        if (matches.length !== 1)
          throw new Error("Attachment does not belong uniquely to the requested debt.");
        const code = asString(params.attachmentCode);
        if (!code || Array.from(code).some((character) => character.charCodeAt(0) < 32))
          throw new Error("Attachment code is invalid.");
        const discovery = await fetchRequest(`https://app.holvi.com/attachment/${encodeURIComponent(code)}/`, { credentials: "include", cache: "no-store", redirect: "follow" });
        if (!discovery.ok) {
          await discovery.body?.cancel();
          throw new Error("Holvi attachment download route failed.");
        }
        const signed = this.signedStorageUrl(discovery.url);
        await discovery.body?.cancel();
        const response = await fetchRequest(signed, {
          credentials: "omit",
          cache: "no-store",
          redirect: "error"
        });
        this.validateDownloadResponse(response, ["https://storage.holvi.com"], "/media/");
        const attachment = matches[0];
        const extension = asString(attachment.format).replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
        return {
          response,
          fileName: `holvi-attachment-${debtUuid}.${extension}`,
          metadata: { debtUuid, attachmentCode: code }
        };
      }
      if (action === "reports.export") {
        const spec = reportTypes.find((entry) => entry.type === params.reportType && entry.mode === "direct");
        if (!spec || !spec.formats.includes(asString(params.format)))
          throw new Error("Unsupported direct report type or format.");
        if (spec.accountRequired && !params.paymentAccountUuid)
          throw new Error("This report requires a payment account.");
        const accounts = await this.accounts(auth);
        if (params.paymentAccountUuid && !accounts.results.some((account) => account.paymentAccountUuid === params.paymentAccountUuid))
          throw new Error("Payment account does not belong to the configured pool.");
        const query = new URLSearchParams({
          start_date: asString(params.from),
          end_date: asString(params.to),
          format: asString(params.format)
        });
        if (params.paymentAccountUuid)
          query.set("payment_account_uuid", asString(params.paymentAccountUuid));
        const response = await fetchRequest(`https://app.holvi.com/group/${encodeURIComponent(this.session.config.poolHandle)}/reports/${spec.backend}/?${query}`, { credentials: "include", cache: "no-store", redirect: "error" });
        this.validateDownloadResponse(response, ["https://app.holvi.com"], `/group/${this.session.config.poolHandle}/reports/`);
        const extension = asString(params.format);
        return {
          response,
          fileName: `holvi-${spec.type}-${asString(params.from)}-${asString(params.to)}.${extension}`,
          metadata: { reportType: spec.type }
        };
      }
      if (action === "reports.jobs.download") {
        const reportUuid = validateUuid(asString(params.reportUuid), "report");
        const job = await this.reportJob(auth, reportUuid);
        if (job.status !== "ready")
          throw new Error("Report is not ready for download.");
        const linkValue = await this.reportingRequest(auth, `/api/reporting/reports/${reportUuid}/download/`);
        const link = asString(linkValue?.link);
        const signed = this.signedStorageUrl(link);
        const response = await fetchRequest(signed, {
          credentials: "omit",
          cache: "no-store",
          redirect: "error"
        });
        this.validateDownloadResponse(response, ["https://storage.holvi.com"], "/media/");
        const extension = job.reportType === "zip_export" ? "zip" : "pdf";
        return {
          response,
          fileName: `holvi-${asString(job.fromDate)}-${asString(job.toDate)}.${extension}`,
          metadata: { reportUuid, reportType: job.reportType }
        };
      }
      throw new Error("Unsupported download action.");
    }
    signedStorageUrl(value) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error("Holvi returned an invalid download link.");
      }
      if (url.protocol !== "https:" || url.origin !== "https://storage.holvi.com" || !url.pathname.startsWith("/media/") || url.username || url.password || url.hash)
        throw new Error("Holvi returned an invalid download link.");
      return url;
    }
    validateDownloadResponse(response, origins, pathPrefix) {
      const finalUrl = new URL(response.url);
      if (!response.ok || !origins.includes(finalUrl.origin) || !finalUrl.pathname.startsWith(pathPrefix) || finalUrl.username || finalUrl.password || finalUrl.hash)
        throw new Error("Holvi download response failed validation.");
      const contentLength = response.headers.get("content-length");
      if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumDownloadBytes))
        throw new Error("Download exceeds the maximum size.");
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "";
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
        "image/gif"
      ]);
      if (!allowedMimeTypes.has(contentType))
        throw new Error("Holvi download content type is invalid.");
      const disposition = response.headers.get("content-disposition");
      if (disposition && (disposition.length > 1024 || Array.from(disposition).some((character) => character.charCodeAt(0) < 32 && character !== "\t")))
        throw new Error("Holvi download disposition is invalid.");
    }
    async accounts(auth) {
      return projectAccounts(await this.request(auth, this.session.apiRoot()));
    }
    reportTypeCatalog() {
      return reportTypes;
    }
    async reportingRequest(auth, path, options = {}) {
      const parsed = new URL(path, this.staticConfig.apiOrigin);
      if ((parsed.pathname !== "/api/reporting/reports/" || !["", "?"].includes(path.slice(parsed.pathname.length, parsed.pathname.length + 1))) && !/^\/api\/reporting\/reports\/[0-9a-f-]{36}\/download\/$/i.test(path)) {
        throw new Error("Refused an unsupported reporting API path.");
      }
      const headers = new Headers(options.headers || {});
      headers.set("Accept", "application/json");
      headers.set("Authorization", `Bearer ${auth.token}`);
      if (auth.csrfToken)
        headers.set("X-CSRFToken", auth.csrfToken);
      const fetchRequest = this.fetchRequest;
      const response = await fetchRequest(`${this.staticConfig.apiOrigin}${path}`, {
        ...options,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error"
      });
      const text = await boundedResponseText(response, maxApiResponseBytes);
      if (!response.ok)
        throw new Error(`Holvi reporting API returned ${response.status}.`);
      if (!text)
        return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Holvi reporting API returned malformed JSON.");
      }
    }
    async reportJobs(auth, params) {
      const spec = reportTypes.find((entry) => entry.type === params.reportType && entry.mode === "async");
      if (!spec)
        throw new Error("Unsupported report type.");
      const query = new URLSearchParams({
        report_type: spec.backend,
        o: "-create_time",
        page_size: "50",
        pool: this.session.config.poolHandle
      });
      if (typeof params.status === "string")
        query.set("status", params.status);
      return projectReportJobs(await this.reportingRequest(auth, `/api/reporting/reports/?${query}`));
    }
    async reportJob(auth, reportUuid) {
      validateUuid(reportUuid, "report");
      const matches = [];
      for (const spec of reportTypes.filter((entry) => entry.mode === "async")) {
        const listing = await this.reportJobs(auth, { reportType: spec.type });
        matches.push(...listing.results.filter((job) => String(job.reportUuid).toLowerCase() === reportUuid.toLowerCase()));
      }
      if (matches.length !== 1)
        throw new Error("Report does not belong uniquely to the configured pool.");
      return matches[0];
    }
    async createReportJob(auth, params) {
      if (params.confirmed !== true)
        throw new Error("Report generation requires explicit confirmation.");
      const spec = reportTypes.find((entry) => entry.type === params.reportType && entry.mode === "async");
      if (!spec)
        throw new Error("Unsupported report type.");
      if (spec.accountRequired && !params.paymentAccountUuid)
        throw new Error("This report requires a payment account.");
      const body = {
        from_date: params.from,
        to_date: params.to,
        report_type: spec.backend,
        pool: this.session.config.poolHandle
      };
      if (params.paymentAccountUuid) {
        const accounts = await this.accounts(auth);
        if (!accounts.results.some((account) => account.paymentAccountUuid === params.paymentAccountUuid))
          throw new Error("Payment account does not belong to the configured pool.");
        body.payment_account_uuid = params.paymentAccountUuid;
      }
      await this.reportingRequest(auth, "/api/reporting/reports/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return { accepted: true };
    }
    continuation(next, endpoint, allowed) {
      if (next.length > 4096)
        throw new Error("Holvi pagination URL exceeded its limit.");
      const url = new URL(next, this.staticConfig.apiOrigin);
      if (url.origin !== this.staticConfig.apiOrigin || url.pathname !== endpoint || url.username || url.password || url.hash || [...url.searchParams.keys()].some((key) => !allowed.has(key)))
        throw new Error("Holvi pagination changed the target endpoint.");
      return `${endpoint}${url.search}`;
    }
    async listBookkeeping(auth, params) {
      const endpoint = `${this.session.apiRoot()}debt/`;
      const query = new URLSearchParams({
        booking_date_gte: asString(params.from),
        booking_date_lte: asString(params.to),
        page_size: "100"
      });
      if (params.bookkeepingStatus)
        query.set("bookkeeping_status", asString(params.bookkeepingStatus));
      if (params.paymentAccountUuid) {
        const accounts = await this.accounts(auth);
        if (!accounts.results.some((account) => account.paymentAccountUuid === params.paymentAccountUuid))
          throw new Error("Payment account does not belong to the configured pool.");
        query.set("payment_account_uuid", asString(params.paymentAccountUuid));
      }
      const orOptions = [
        ["uncategorised", "uncategorised"],
        ["noVat", "no_vat"],
        ["noAttachment", "no_attachment"]
      ];
      const ors = orOptions.filter(([key]) => params[key] === true).map(([, value]) => value);
      if (ors.length)
        query.set("or_filters", ors.join(","));
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
        "subtype_csv"
      ]);
      const results = [];
      const seen = new Set;
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
          subtypes: params.externalTransactions === true ? ["external_transaction", "card"] : []
        },
        results
      };
    }
    async auditTypes(auth) {
      return projectAuditTypes(await this.request(auth, `${this.session.apiRoot()}log-feed/type-classes/`));
    }
    async historicalAudit(auth, params) {
      const endpoint = `${this.session.apiRoot()}log-feed/`;
      const query = new URLSearchParams({
        o: "-timestamp",
        page_size: String(auditPageSize),
        timestamp_from: asString(params.from),
        timestamp_to: asString(params.to)
      });
      if (params.typeClass) {
        const types = await this.auditTypes(auth);
        if (!types.results.includes(asString(params.typeClass))) {
          throw new Error("Activity type class is unavailable for the configured pool.");
        }
        query.set("type_class", asString(params.typeClass));
      }
      if (params.query)
        query.set("q", asString(params.query));
      const allowed = new Set([
        "o",
        "page_size",
        "timestamp_from",
        "timestamp_to",
        "type_class",
        "q",
        "page",
        "cursor"
      ]);
      const results = [];
      const seen = new Set;
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
        if (page.next && (pages >= Number(params.maxPages) || results.length >= Number(params.limit))) {
          truncated = true;
          break;
        }
        path = page.next ? this.continuation(page.next, endpoint, allowed) : "";
      }
      const limited = results.slice(0, Number(params.limit));
      for (let index = 1;index < limited.length; index += 1)
        if (Date.parse(String(limited[index - 1]?.timestamp)) < Date.parse(String(limited[index]?.timestamp)))
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
          query: params.query ?? null
        },
        results: limited
      };
    }
    async recentAudit(auth, limit) {
      if (!Number.isSafeInteger(limit) || limit < auditLimitMin || limit > auditLimitMax) {
        throw new Error("Activity limit must be between 1 and 25.");
      }
      return projectAuditPage(await this.request(auth, `${this.session.apiRoot()}log-feed/?o=-timestamp&page_size=${auditPageSize}`), limit);
    }
  }

  // src/extension/comment-workflow.ts
  function validateCommentContent(value) {
    if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > maxCommentContentBytes) {
      throw new Error(`Comment content must contain text and fit within ${maxCommentContentBytes} UTF-8 bytes.`);
    }
    return value;
  }
  function sameCommentWithoutUuid(candidate, expected) {
    return candidate.content === expected.content && candidate.createTime === expected.createTime && candidate.pushNotified === expected.pushNotified && JSON.stringify(candidate.creator) === JSON.stringify(expected.creator);
  }

  class CommentWorkflow {
    session;
    api;
    constructor(session, api) {
      this.session = session;
      this.api = api;
    }
    async createComment(auth, params) {
      this.session.requireCapabilities("transactions.read", "comments.write");
      if (params.confirmed !== true) {
        throw new Error("Comment creation requires explicit confirmation.");
      }
      const debtUuid = validateUuid(typeof params.debtUuid === "string" ? params.debtUuid : "", "debt").toLowerCase();
      const content = validateCommentContent(params.content);
      await this.api.previewDebt(auth, debtUuid);
      const created = projectCommentWriteResponse(await this.api.request(auth, this.api.commentPath(debtUuid), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, notify_push: false })
      }, maxCommentResponseBytes));
      if (created.content !== content || created.pushNotified !== false) {
        throw new Error("Holvi comment creation response did not match the requested content and notification state.");
      }
      const listing = await this.api.listComments(auth, debtUuid);
      const comments = listing.results;
      const createdUuid = created.uuid;
      const matches = typeof createdUuid === "string" ? comments.filter((comment2) => typeof comment2.uuid === "string" && comment2.uuid.toLowerCase() === createdUuid.toLowerCase()) : comments.filter((comment2) => sameCommentWithoutUuid(comment2, created));
      if (matches.length !== 1) {
        throw new Error("Holvi accepted the comment but an authoritative read could not identify exactly one matching record. Inspect the transaction before retrying.");
      }
      const verified = matches[0];
      if (verified.content !== content || verified.pushNotified !== false) {
        throw new Error("Holvi accepted the comment but verification found different content or notification state. Inspect the transaction before retrying.");
      }
      return { debtUuid, comment: verified };
    }
  }

  // src/extension/payment-workflow.ts
  var digestPattern = /^[0-9a-f]{64}$/;
  var paymentPollIntervalMs = 2000;
  var paymentReferenceMaxBytes = 256;
  var paymentBicMaxBytes = 11;
  var confirmableStatuses = new Set(["unverified", "draft"]);
  var confirmedStatuses = new Set(["verified", "paid"]);
  var maxStringBytes = paymentReferenceMaxBytes;
  function record4(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} has an unexpected shape.`);
    }
    return value;
  }
  function exactKeys(value, allowed, label) {
    if (Object.keys(value).some((key) => !allowed.includes(key))) {
      throw new Error(`${label} contains unsupported fields.`);
    }
  }
  function boundedString2(value, label, maxBytes = maxStringBytes) {
    if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > maxBytes) {
      throw new Error(`${label} must be a nonempty bounded string.`);
    }
    return value.trim();
  }
  function mod97(value) {
    let remainder = 0;
    for (const character of value) {
      const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
      for (const digit of digits)
        remainder = (remainder * 10 + Number(digit)) % 97;
    }
    return remainder;
  }
  function normalizeIban(value) {
    const iban = boundedString2(value, "IBAN", 64).replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
      throw new Error("IBAN has an invalid shape.");
    }
    if (mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) !== 1)
      throw new Error("IBAN checksum is invalid.");
    return iban;
  }
  function normalizeAmount(value) {
    const source = typeof value === "number" && Number.isFinite(value) ? String(value) : boundedString2(value, "Payment amount", 32);
    const match = source.match(/^(\d{1,16})(?:\.(\d{1,2}))?$/);
    if (!match)
      throw new Error("Payment amount must be a positive EUR decimal.");
    const whole = (match[1] || "0").replace(/^0+(?=\d)/, "");
    const fraction = (match[2] || "").replace(/0+$/, "");
    const amount = fraction ? `${whole}.${fraction}` : whole;
    if (amount === "0")
      throw new Error("Payment amount must be positive.");
    return amount;
  }
  function paymentReference(value) {
    const source = record4(value, "Payment reference");
    exactKeys(source, ["kind", "value"], "Payment reference");
    if (!["message", "rf", "finnish"].includes(source.kind)) {
      throw new Error("Payment reference kind is unsupported.");
    }
    const kind = source.kind;
    let normalized = boundedString2(source.value, "Payment reference");
    if (kind === "rf") {
      normalized = normalized.replace(/\s/g, "").toUpperCase();
      if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(normalized) || mod97(`${normalized.slice(4)}${normalized.slice(0, 4)}`) !== 1) {
        throw new Error("RF reference checksum is invalid.");
      }
    }
    if (kind === "finnish") {
      normalized = normalized.replace(/\s/g, "");
      if (!/^\d{4,20}$/.test(normalized)) {
        throw new Error("Finnish reference has an invalid shape.");
      }
      const body = normalized.slice(0, -1);
      const check = Number(normalized.slice(-1));
      const weights = [7, 3, 1];
      const sum = body.split("").reverse().reduce((total, digit, index) => total + Number(digit) * (weights[index % weights.length] || 0), 0);
      if ((10 - sum % 10) % 10 !== check) {
        throw new Error("Finnish reference checksum is invalid.");
      }
    }
    return { kind, value: normalized };
  }
  function createParams(value) {
    exactKeys(value, [
      "paymentAccountUuid",
      "recipientName",
      "iban",
      "bic",
      "amount",
      "currency",
      "reference",
      "acceptPayeeWarning",
      "confirmed"
    ], "Payment creation parameters");
    const bic = value.bic === null || value.bic === undefined || value.bic === "" ? null : boundedString2(value.bic, "BIC", paymentBicMaxBytes).toUpperCase();
    if (bic && !/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic)) {
      throw new Error("BIC has an invalid shape.");
    }
    if (value.currency !== "EUR")
      throw new Error("Payment currency must be EUR.");
    if (typeof value.confirmed !== "boolean" || typeof value.acceptPayeeWarning !== "boolean") {
      throw new Error("Payment confirmation flags are invalid.");
    }
    return {
      paymentAccountUuid: validateUuid(boundedString2(value.paymentAccountUuid, "Payment account UUID", 64), "payment account").toLowerCase(),
      recipientName: boundedString2(value.recipientName, "Recipient name"),
      iban: normalizeIban(value.iban),
      bic,
      amount: normalizeAmount(value.amount),
      currency: "EUR",
      reference: paymentReference(value.reference),
      acceptPayeeWarning: value.acceptPayeeWarning,
      confirmed: value.confirmed
    };
  }
  function sendParams(value) {
    exactKeys(value, ["debtUuid", "reviewDigest", "acceptPayeeWarning", "confirmed"], "Payment sending parameters");
    if (typeof value.confirmed !== "boolean" || typeof value.acceptPayeeWarning !== "boolean") {
      throw new Error("Payment confirmation flags are invalid.");
    }
    const reviewDigest = value.reviewDigest === null || value.reviewDigest === undefined ? null : boundedString2(value.reviewDigest, "Review digest", 64);
    if (reviewDigest !== null && !digestPattern.test(reviewDigest)) {
      throw new Error("Review digest must be lowercase SHA-256 hex.");
    }
    if (value.confirmed && reviewDigest === null) {
      throw new Error("Payment confirmation requires the review digest.");
    }
    return {
      debtUuid: validateUuid(boundedString2(value.debtUuid, "Debt UUID", 64), "debt").toLowerCase(),
      reviewDigest,
      acceptPayeeWarning: value.acceptPayeeWarning,
      confirmed: value.confirmed
    };
  }
  function firstItemAmount(source) {
    if (!Array.isArray(source.items) || source.items.length !== 1)
      return;
    const item = record4(source.items[0], "Payment item");
    const price2 = record4(item.detailed_price, "Payment item price");
    return price2.gross;
  }
  function debtReference(source) {
    const candidates = [];
    for (const [field, kind] of [
      ["unstructured_reference", "message"],
      ["rf_reference", "rf"],
      ["fi_reference", "finnish"]
    ]) {
      if (typeof source[field] === "string" && source[field]) {
        candidates.push(paymentReference({ kind, value: source[field] }));
      }
    }
    if (candidates.length !== 1) {
      throw new Error("Holvi payment debt has an ambiguous reference.");
    }
    return candidates[0];
  }
  function projectDebt(value, expectedUuid) {
    const source = record4(value, "Payment debt");
    const debtUuid = validateUuid(boundedString2(source.uuid, "Debt UUID", 64), "debt").toLowerCase();
    if (debtUuid !== expectedUuid.toLowerCase())
      throw new Error("Holvi payment debt UUID does not match.");
    const receiver = record4(source.receiver, "Payment receiver");
    const type = boundedString2(source.type, "Payment type");
    const subtype = boundedString2(source.subtype, "Payment subtype");
    if (type !== "outboundpayment" || subtype !== "outbound") {
      throw new Error("Debt is not a supported outgoing SEPA payment.");
    }
    const statusValue = typeof source.status === "object" ? record4(source.status, "Payment status").value : source.status ?? source.state;
    const status = boundedString2(statusValue, "Payment status", 64).toLowerCase();
    const currency = boundedString2(source.currency, "Payment currency", 3);
    if (currency !== "EUR")
      throw new Error("Payment debt currency is unsupported.");
    return {
      debtUuid,
      paymentAccountUuid: validateUuid(boundedString2(source.payment_account_uuid, "Payment account UUID", 64), "payment account").toLowerCase(),
      recipient: {
        name: boundedString2(receiver.name, "Recipient name"),
        iban: normalizeIban(source.iban)
      },
      bic: source.bic ? boundedString2(source.bic, "BIC", paymentBicMaxBytes).toUpperCase() : null,
      amount: normalizeAmount(source.total_amount_temp ?? source.amount ?? source.total ?? firstItemAmount(source)),
      currency: "EUR",
      reference: debtReference(source),
      dueDate: source.due_date ? boundedString2(source.due_date, "Payment due date", 32) : null,
      instant: source.sctinst_requested === true,
      status,
      type: "outboundpayment",
      subtype: "outbound"
    };
  }
  function projectPayeeVerification(value) {
    const result = record4(value, "Payee verification").match_result;
    if (!["match", "close-match", "no-match", "not-applicable"].includes(String(result))) {
      throw new Error("Holvi payee verification result is unsupported.");
    }
    return result;
  }
  function enforcePayee(result, accepted) {
    if (result === "match")
      return;
    if (result === "no-match" || !accepted) {
      throw new Error(`Payee verification returned ${result}. Review the recipient and explicitly accept a supported warning.`);
    }
  }
  function sameMaterial(left, right) {
    const material = (debt) => JSON.stringify({
      debtUuid: debt.debtUuid,
      paymentAccountUuid: debt.paymentAccountUuid,
      recipient: debt.recipient,
      bic: debt.bic,
      amount: debt.amount,
      currency: debt.currency,
      reference: debt.reference,
      dueDate: debt.dueDate,
      instant: debt.instant,
      type: debt.type,
      subtype: debt.subtype
    });
    return material(left) === material(right);
  }
  async function sha256(value) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function equalDigest(left, right) {
    if (left.length !== right.length)
      return false;
    let difference = 0;
    for (let index = 0;index < left.length; index += 1) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  }

  class PaymentWorkflow {
    session;
    api;
    authProxy;
    clock;
    sleep;
    constructor(session, api, authProxy, clock = Date.now, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) {
      this.session = session;
      this.api = api;
      this.authProxy = authProxy;
      this.clock = clock;
      this.sleep = sleep;
    }
    async create(auth, raw) {
      this.session.requireCapabilities("payments.write");
      const params = createParams(raw);
      const accounts = await this.api.accounts(auth);
      const matches = accounts.results.filter((account) => String(account.paymentAccountUuid).toLowerCase() === params.paymentAccountUuid);
      if (matches.length !== 1)
        throw new Error("Payment account does not belong uniquely to the configured pool.");
      const payeeVerification = projectPayeeVerification(await this.api.verifyPayee(auth, params.recipientName, params.iban));
      const proposal = {
        dryRun: !params.confirmed,
        paymentAccountUuid: params.paymentAccountUuid,
        recipient: { name: params.recipientName, iban: params.iban },
        bic: params.bic,
        amount: params.amount,
        currency: params.currency,
        reference: params.reference,
        instant: false,
        payeeVerification: { result: payeeVerification }
      };
      if (!params.confirmed) {
        return {
          ...proposal,
          next: payeeVerification === "match" ? "Repeat with --yes after checking every value." : "Review the payee warning, then repeat the dry run with --accept-payee-warning before using --yes."
        };
      }
      enforcePayee(payeeVerification, params.acceptPayeeWarning);
      const referenceField = params.reference.kind === "message" ? { unstructured_reference: params.reference.value } : params.reference.kind === "rf" ? { rf_reference: params.reference.value } : { fi_reference: params.reference.value };
      const payload = {
        attachments: [],
        receiver: {
          name: params.recipientName,
          contact: "",
          code: "",
          save_to_contacts: false
        },
        type: "outboundpayment",
        subtype: "outbound",
        currency: "EUR",
        advanced_breakdown: false,
        items: [
          {
            description: "",
            category: "",
            cost_center_uuid: null,
            vat_calculation_rule: "unit_gross",
            detailed_price: {
              currency: "EUR",
              net: params.amount,
              gross: params.amount
            }
          }
        ],
        iban: params.iban,
        bic: params.bic ?? "",
        ...referenceField,
        total_amount_temp: params.amount,
        payment_account_uuid: params.paymentAccountUuid
      };
      let created;
      try {
        created = await this.api.createPaymentDebt(auth, payload);
      } catch {
        throw new Error("Payment draft creation failed or had an ambiguous outcome. Inspect Holvi before retrying.");
      }
      const createdRecord = record4(created, "Created payment debt");
      const debtUuid = validateUuid(boundedString2(createdRecord.uuid, "Created debt UUID", 64), "debt").toLowerCase();
      let debt;
      try {
        debt = projectDebt(await this.api.readPaymentDebt(auth, debtUuid), debtUuid);
      } catch {
        throw new Error("Holvi accepted the payment draft, but its authoritative state could not be verified. Inspect Holvi before retrying.");
      }
      if (debt.paymentAccountUuid !== params.paymentAccountUuid || debt.recipient.name !== params.recipientName || debt.recipient.iban !== params.iban || params.bic !== null && debt.bic !== params.bic || debt.amount !== params.amount || debt.currency !== params.currency || JSON.stringify(debt.reference) !== JSON.stringify(params.reference) || debt.dueDate !== null || debt.instant || !confirmableStatuses.has(debt.status)) {
        throw new Error("Holvi created a payment draft whose authoritative fields differ from the request. Inspect Holvi before retrying.");
      }
      return {
        ...proposal,
        dryRun: false,
        debtUuid,
        status: debt.status,
        verified: true
      };
    }
    async send(auth, raw) {
      this.session.requireCapabilities("payments.send");
      const params = sendParams(raw);
      const review = await this.review(auth, params);
      if (!params.confirmed) {
        return {
          dryRun: true,
          ...review.projection,
          reviewDigest: review.digest,
          next: review.payeeVerification === "match" ? "Repeat with --review-digest and --yes after checking every value." : "Review the payee warning, then repeat the dry run with --accept-payee-warning before using --review-digest and --yes."
        };
      }
      if (!params.reviewDigest || !equalDigest(params.reviewDigest, review.digest)) {
        throw new Error("Payment changed after review. Run the send dry run again.");
      }
      enforcePayee(review.payeeVerification, params.acceptPayeeWarning);
      let confirmation;
      try {
        confirmation = await this.authProxy.initiatePaymentConfirmation(auth, params.debtUuid);
      } catch {
        const debt = await this.readDebtOrNull(auth, params.debtUuid);
        if (debt && confirmedStatuses.has(debt.status) && sameMaterial(review.debt, debt)) {
          return this.confirmedResult(debt);
        }
        throw new Error("Payment confirmation initiation failed or had an ambiguous outcome. Inspect Holvi before retrying.");
      }
      if (!confirmation.hasMobileDevice) {
        await this.authProxy.cancel(confirmation).catch(() => {
          return;
        });
        throw new Error("Payment confirmation requires a Holvi mobile-app device. Use Holvi's UI for another verification method.");
      }
      const deadline = Math.min(this.clock() + 285000, this.clock() + confirmation.expirationSeconds * 1000);
      let approved = false;
      try {
        while (this.clock() < deadline) {
          const status = await this.authProxy.status(confirmation);
          if (status.state === "activated") {
            approved = true;
            break;
          }
          if (status.state === "cancelled")
            throw new Error("Payment confirmation was canceled.");
          if (status.state === "rejected")
            throw new Error("Payment confirmation was rejected.");
          if (status.state === "expired")
            throw new Error("Payment confirmation expired.");
          await this.sleep(paymentPollIntervalMs);
        }
        if (!approved)
          throw new Error("Payment confirmation timed out.");
      } catch (error) {
        if (!approved)
          await this.authProxy.cancel(confirmation).catch(() => {
            return;
          });
        const debt = await this.readDebtOrNull(auth, params.debtUuid);
        if (debt && confirmedStatuses.has(debt.status) && sameMaterial(review.debt, debt)) {
          return this.confirmedResult(debt);
        }
        if (!debt) {
          throw new Error(`${error instanceof Error ? error.message : "Payment confirmation ended."} The resulting payment state is unknown. Inspect Holvi before retrying.`);
        }
        throw error;
      }
      const finalDebt = await this.readDebtOrNull(auth, params.debtUuid);
      if (!finalDebt) {
        throw new Error("Holvi approved 2FA, but the resulting payment state is unknown. Inspect Holvi before retrying.");
      }
      if (!sameMaterial(review.debt, finalDebt) || !confirmedStatuses.has(finalDebt.status)) {
        throw new Error("Holvi approved 2FA, but the resulting payment state could not be verified. Inspect Holvi before retrying.");
      }
      return this.confirmedResult(finalDebt);
    }
    async review(auth, params) {
      const debt = projectDebt(await this.api.readPaymentDebt(auth, params.debtUuid), params.debtUuid);
      if (!confirmableStatuses.has(debt.status) || debt.instant) {
        throw new Error("Payment debt is not in a confirmable one-off SEPA state.");
      }
      const accounts = await this.api.accounts(auth);
      const matches = accounts.results.filter((account) => String(account.paymentAccountUuid).toLowerCase() === debt.paymentAccountUuid);
      if (matches.length !== 1)
        throw new Error("Payment account does not belong uniquely to the configured pool.");
      const payeeVerification = projectPayeeVerification(await this.api.verifyPayee(auth, debt.recipient.name, debt.recipient.iban));
      const projection2 = {
        debtUuid: debt.debtUuid,
        paymentAccountUuid: debt.paymentAccountUuid,
        recipient: debt.recipient,
        bic: debt.bic,
        amount: debt.amount,
        currency: debt.currency,
        reference: debt.reference,
        dueDate: debt.dueDate,
        instant: debt.instant,
        status: debt.status,
        payeeVerification: { result: payeeVerification },
        acceptPayeeWarning: params.acceptPayeeWarning
      };
      return {
        debt,
        projection: projection2,
        digest: await sha256(JSON.stringify(projection2)),
        payeeVerification
      };
    }
    async readDebtOrNull(auth, debtUuid) {
      try {
        return projectDebt(await this.api.readPaymentDebt(auth, debtUuid), debtUuid);
      } catch {
        return null;
      }
    }
    confirmedResult(debt) {
      return {
        debtUuid: debt.debtUuid,
        confirmation: "approved",
        verified: true,
        status: debt.status,
        paymentAccountUuid: debt.paymentAccountUuid
      };
    }
  }

  // src/extension/commands.ts
  function asString2(value) {
    return typeof value === "string" ? value : "";
  }
  function requiredString(value) {
    if (typeof value !== "string") {
      throw new Error("The local helper supplied invalid description data.");
    }
    return value;
  }
  function asBoolean(value) {
    if (typeof value !== "boolean") {
      throw new Error("The local helper supplied invalid confirmation data.");
    }
    return value;
  }

  class CommandService {
    session;
    api;
    requestAuth;
    handlers;
    attachmentDeletion;
    bookkeepingDescriptions;
    comments;
    payments;
    constructor(session, api, requestAuth) {
      this.session = session;
      this.api = api;
      this.requestAuth = requestAuth;
      this.attachmentDeletion = new AttachmentDeletionWorkflow(session, api);
      this.bookkeepingDescriptions = new BookkeepingDescriptionWorkflow(session, api);
      this.comments = new CommentWorkflow(session, api);
      this.payments = new PaymentWorkflow(session, api, new AuthProxyClient("https://holvi.com"));
      this.handlers = {
        doctor: (auth) => this.doctor(auth),
        "transactions.list": (auth, params) => this.api.listTransactions(auth, params),
        "transactions.get": (auth, params) => this.api.transactionDetails(auth, asString2(params.debtUuid)),
        "debts.get": (auth, params) => this.api.previewDebt(auth, asString2(params.debtUuid)),
        "comments.list": (auth, params) => this.api.listComments(auth, asString2(params.debtUuid)),
        "comments.create": (auth, params) => this.comments.createComment(auth, params),
        "attachments.delete": (auth, params) => this.attachmentDeletion.deleteAttachment(auth, params),
        "accounts.list": (auth) => this.api.accounts(auth),
        "reports.types": () => Promise.resolve(this.api.reportTypeCatalog()),
        "reports.jobs.list": (auth, params) => this.api.reportJobs(auth, params),
        "reports.jobs.get": (auth, params) => this.api.reportJob(auth, asString2(params.reportUuid)),
        "reports.jobs.create": (auth, params) => this.api.createReportJob(auth, params),
        "bookkeeping.list": (auth, params) => this.api.listBookkeeping(auth, params),
        "bookkeeping.get": (auth, params) => this.api.bookkeepingDebt(auth, asString2(params.debtUuid)),
        "bookkeeping.categories": (auth) => this.api.bookkeepingCategories(auth),
        "bookkeeping.suggestions": (auth, params) => this.api.bookkeepingSuggestions(auth, asString2(params.debtUuid)),
        "bookkeeping.set-description": (auth, params) => this.bookkeepingDescriptions.change(auth, {
          debtUuid: asString2(params.debtUuid),
          itemUuid: asString2(params.itemUuid),
          description: requiredString(params.description),
          confirmed: asBoolean(params.confirmed)
        }),
        "audit.types": (auth) => this.api.auditTypes(auth),
        "audit.list": (auth, params) => this.api.historicalAudit(auth, params),
        "payments.create": (auth, params) => this.payments.create(auth, params),
        "payments.send": (auth, params) => this.payments.send(auth, params)
      };
    }
    async handle(message) {
      const action = message.action || "";
      if (!isBridgeAction(action)) {
        throw new Error("The local helper requested an unsupported action.");
      }
      const requirements = requiredCapabilities(action);
      if (!requirements) {
        throw new Error("The local helper requested an unsupported action.");
      }
      this.session.requireCapabilities(...requirements);
      if (action === "attachments.upload" || action === "attachments.download" || action === "reports.export" || action === "reports.jobs.download") {
        throw new Error("This action requires transfer messages.");
      }
      const auth = await this.requestAuth();
      return this.handlers[action](auth, message.params || {});
    }
    async doctor(auth) {
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
        extensionVersion: this.session.extensionVersion
      };
      if (config?.capabilities.includes("transactions.read")) {
        this.session.requireCapabilities("transactions.read");
        const page = await this.api.transactionFeedPage(auth);
        return {
          ...base,
          probeAction: "transactions.list",
          firstPageResults: page.results.length
        };
      }
      if (config?.capabilities.includes("bookkeeping.read")) {
        this.session.requireCapabilities("bookkeeping.read");
        const categories = await this.api.bookkeepingCategories(auth);
        return {
          ...base,
          probeAction: "bookkeeping.categories",
          categoryCount: categories.length
        };
      }
      if (config?.capabilities.includes("audit.read")) {
        this.session.requireCapabilities("audit.read");
        const audit = await this.api.recentAudit(auth, 1);
        return {
          ...base,
          probeAction: "audit.list",
          recentActivityCount: audit.returnedCount
        };
      }
      return { ...base, probeAction: null };
    }
  }

  // src/extension/upload-transfer.ts
  var uploadMimeTypes = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif"
  ]);
  var uuidPattern3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var sha256Pattern = /^[a-f0-9]{64}$/;
  var base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  var fileChunkBytes = 480 * 1024;
  var uploadTransferExpiryMs = 30000;
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
  async function verifyUploadTransfer(upload) {
    const bytes = base64ToBytes(upload.chunks.join(""));
    if (bytes.byteLength !== upload.size) {
      throw new Error("Receipt byte count changed during native messaging transfer.");
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (bytesToHex(new Uint8Array(digest)) !== upload.sha256) {
      throw new Error("Receipt checksum changed during native messaging transfer.");
    }
    return bytes;
  }

  class UploadTransferError extends Error {
    transferId;
    constructor(message, transferId) {
      super(message);
      this.transferId = transferId;
    }
  }
  function validFileName(value) {
    return typeof value === "string" && value.length >= 1 && value.length <= 255 && !value.includes("/") && !value.includes("\\") && !value.includes("\x00");
  }

  class UploadTransferLifecycle {
    active;
    start(message, maxFileBytes, now) {
      if (this.active) {
        throw new UploadTransferError("Another receipt upload is active.", message.id);
      }
      if (typeof message.debtUuid !== "string" || !uuidPattern3.test(message.debtUuid)) {
        throw new UploadTransferError("A valid Holvi debt UUID is required.", message.id);
      }
      if (!Number.isSafeInteger(message.size) || message.size < minimumFileBytes || message.size > maxFileBytes) {
        throw new UploadTransferError("Receipt size is outside the configured limit.", message.id);
      }
      const expectedChunks = Math.ceil(message.size / fileChunkBytes);
      if (message.chunkCount !== expectedChunks) {
        throw new UploadTransferError("Receipt chunk count does not match its size.", message.id);
      }
      if (typeof message.sha256 !== "string" || !sha256Pattern.test(message.sha256)) {
        throw new UploadTransferError("Receipt checksum is invalid.", message.id);
      }
      if (!validFileName(message.fileName) || typeof message.mimeType !== "string" || !uploadMimeTypes.has(message.mimeType)) {
        throw new UploadTransferError("Receipt filename or media type is invalid.", message.id);
      }
      this.active = {
        transfer: {
          id: message.id,
          debtUuid: message.debtUuid,
          fileName: message.fileName,
          mimeType: message.mimeType,
          size: message.size,
          sha256: message.sha256,
          chunkCount: message.chunkCount,
          chunks: []
        },
        state: "receiving",
        expiresAt: now + uploadTransferExpiryMs
      };
    }
    append(id, index, data, now) {
      const active = this.receiving(id, now);
      if (active.transfer.chunks.length === active.transfer.chunkCount || index !== active.transfer.chunks.length || typeof data !== "string" || data.length < 1 || data.length > 700000 || !base64Pattern.test(data)) {
        this.active = undefined;
        throw new UploadTransferError("Receipt chunks arrived out of order or exceeded their limit.", id);
      }
      active.transfer.chunks.push(data);
    }
    complete(id, now) {
      const active = this.receiving(id, now);
      if (active.transfer.chunks.length !== active.transfer.chunkCount) {
        this.active = undefined;
        throw new UploadTransferError("Receipt transfer ended before every chunk arrived.", id);
      }
      active.state = "committing";
      return active.transfer;
    }
    finish(id) {
      if (this.active?.transfer.id === id) {
        this.active = undefined;
      }
    }
    cancel() {
      const id = this.active?.transfer.id || null;
      this.active = undefined;
      return id;
    }
    expire(now) {
      if (!this.active || this.active.state !== "receiving" || now < this.active.expiresAt) {
        return null;
      }
      const id = this.active.transfer.id;
      this.active = undefined;
      return id;
    }
    hasActiveTransfer() {
      return this.active !== undefined;
    }
    receiving(id, now) {
      const expiredId = this.expire(now);
      if (expiredId) {
        throw new UploadTransferError("Receipt transfer expired.", expiredId);
      }
      if (!this.active || this.active.transfer.id !== id || this.active.state !== "receiving") {
        throw new UploadTransferError("Upload completion did not match an active transfer.", id);
      }
      return this.active;
    }
  }

  // src/extension/native-bridge.ts
  var requestIdPattern = /^[0-9a-f-]{16,64}$/i;
  var nativeReconnectDelayMs = 1000;
  var nativeMessageType = Object.freeze({
    hostReady: "host_ready",
    hostRestart: "host_restart",
    command: "command",
    uploadStart: "upload_start",
    uploadChunk: "upload_chunk",
    uploadEnd: "upload_end",
    tabReady: "tab_ready",
    tabUnavailable: "tab_unavailable",
    hostRejected: "host_rejected",
    downloadStart: "download_start",
    downloadChunk: "download_chunk",
    downloadEnd: "download_end",
    result: "result"
  });
  var nativeMessageTypes = Object.freeze({
    hostToExtension: [
      nativeMessageType.hostReady,
      nativeMessageType.hostRestart,
      nativeMessageType.command,
      nativeMessageType.uploadStart,
      nativeMessageType.uploadChunk,
      nativeMessageType.uploadEnd
    ],
    extensionToHost: [
      nativeMessageType.tabReady,
      nativeMessageType.tabUnavailable,
      nativeMessageType.hostRejected,
      nativeMessageType.downloadStart,
      nativeMessageType.downloadChunk,
      nativeMessageType.downloadEnd,
      nativeMessageType.result
    ]
  });

  class NativeBridge {
    staticConfig;
    session;
    tabs;
    commands;
    uploads;
    api;
    nativePort = null;
    reconnectTimer = null;
    uploadExpiryTimer = null;
    uploadTransfers = new UploadTransferLifecycle;
    constructor(staticConfig, session, tabs, commands, uploads, api) {
      this.staticConfig = staticConfig;
      this.session = session;
      this.tabs = tabs;
      this.commands = commands;
      this.uploads = uploads;
      this.api = api;
    }
    connect() {
      if (this.nativePort || this.tabs.size === 0) {
        return;
      }
      const port = chrome.runtime.connectNative(this.staticConfig.nativeHostName);
      this.nativePort = port;
      port.onMessage.addListener((message) => this.handleMessage(message));
      port.onDisconnect.addListener(() => this.disconnect(port));
    }
    reportTabState() {
      if (!this.nativePort || !this.session.optionalConfig) {
        return;
      }
      const tab = this.tabs.configuredTab();
      this.nativePort.postMessage(tab ? { type: nativeMessageType.tabReady, tabId: tab[0] } : { type: nativeMessageType.tabUnavailable });
    }
    disconnect(port) {
      if (this.nativePort !== port) {
        return;
      }
      this.nativePort = null;
      this.session.clear();
      this.uploadTransfers.cancel();
      this.clearUploadExpiry();
      if (this.tabs.size > 0 && this.reconnectTimer === null) {
        this.reconnectTimer = self.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, nativeReconnectDelayMs);
      }
    }
    postNative(message) {
      if (!this.nativePort) {
        throw new Error("The local Holvi helper is disconnected.");
      }
      this.nativePort.postMessage(message);
    }
    postResult(id, ok, value) {
      try {
        this.postNative(ok ? { type: nativeMessageType.result, id, ok, data: value } : {
          type: nativeMessageType.result,
          id,
          ok,
          error: value instanceof Error ? value.message : String(value)
        });
      } catch {}
    }
    clearUploadExpiry() {
      if (this.uploadExpiryTimer !== null) {
        clearTimeout(this.uploadExpiryTimer);
        this.uploadExpiryTimer = null;
      }
    }
    scheduleUploadExpiry() {
      this.clearUploadExpiry();
      this.uploadExpiryTimer = self.setTimeout(() => {
        this.uploadExpiryTimer = null;
        const expiredId = this.uploadTransfers.expire(Date.now());
        if (expiredId) {
          this.postResult(expiredId, false, new Error("Receipt transfer expired."));
        }
      }, uploadTransferExpiryMs);
    }
    finishUpload(upload) {
      return this.tabs.requestAuth().then((auth) => this.uploads.uploadReceipt(auth, upload));
    }
    async streamDownload(id, message) {
      if (!this.api)
        throw new Error("Download service is unavailable.");
      const action = message.action || "";
      const requirements = requiredCapabilities(action);
      if (!requirements)
        throw new Error("The local helper requested an unsupported action.");
      this.session.requireCapabilities(...requirements);
      const auth = await this.tabs.requestAuth();
      const { response, fileName, metadata } = await this.api.downloadResponse(auth, action, message.params || {});
      if (!response.body)
        throw new Error("Holvi download returned no body.");
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
      const declared = response.headers.get("content-length");
      const expectedSize = declared && /^\d+$/.test(declared) ? Number(declared) : undefined;
      this.postNative({
        type: nativeMessageType.downloadStart,
        id,
        fileName,
        mimeType,
        expectedSize,
        chunkSize: 491520
      });
      const reader = response.body.getReader();
      let pending = new Uint8Array(0);
      let index = 0;
      let size = 0;
      const send = (bytes) => {
        let binary = "";
        for (let offset = 0;offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        this.postNative({
          type: nativeMessageType.downloadChunk,
          id,
          index,
          data: btoa(binary)
        });
        index += 1;
        size += bytes.length;
        if (size > maximumDownloadBytes)
          throw new Error("Download exceeds the maximum size.");
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending);
        joined.set(value, pending.length);
        let offset = 0;
        while (joined.length - offset >= 491520) {
          send(joined.subarray(offset, offset + 491520));
          offset += 491520;
        }
        pending = joined.slice(offset);
      }
      if (pending.length)
        send(pending);
      if (expectedSize !== undefined && expectedSize !== size)
        throw new Error("Download size differs from its Content-Length.");
      this.postNative({
        type: nativeMessageType.downloadEnd,
        id,
        chunkCount: index,
        size
      });
      this.postResult(id, true, metadata);
    }
    handleMessage(value) {
      const message = value;
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === nativeMessageType.hostRestart) {
        const port = this.nativePort;
        if (port) {
          this.disconnect(port);
          port.disconnect();
        }
        return;
      }
      if (message.type === nativeMessageType.hostReady) {
        try {
          this.session.configure(message.config, message.protocolVersion, message.hostVersion);
          this.reportTabState();
        } catch (error) {
          this.session.clear();
          this.nativePort?.postMessage({
            type: nativeMessageType.hostRejected,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }
      if (!requestIdPattern.test(message.id || "")) {
        return;
      }
      const id = message.id;
      if (message.type === nativeMessageType.command) {
        if ([
          "attachments.download",
          "reports.export",
          "reports.jobs.download"
        ].includes(message.action || "")) {
          this.streamDownload(id, message).catch((error) => this.postResult(id, false, error));
          return;
        }
        this.commands.handle(message).then((data) => this.postResult(id, true, data)).catch((error) => this.postResult(id, false, error));
        return;
      }
      if (message.type === nativeMessageType.uploadStart) {
        try {
          this.uploadTransfers.start({
            id,
            debtUuid: message.debtUuid,
            fileName: message.fileName,
            mimeType: message.mimeType,
            size: message.size,
            sha256: message.sha256,
            chunkCount: message.chunkCount
          }, this.session.optionalConfig?.maxFileBytes || 0, Date.now());
          this.scheduleUploadExpiry();
        } catch (error) {
          this.postResult(id, false, error);
        }
        return;
      }
      if (message.type === nativeMessageType.uploadChunk) {
        try {
          this.uploadTransfers.append(id, message.index, message.data, Date.now());
        } catch (error) {
          if (!this.uploadTransfers.hasActiveTransfer()) {
            this.clearUploadExpiry();
          }
          this.postResult(id, false, error);
        }
        return;
      }
      if (message.type === nativeMessageType.uploadEnd) {
        let upload;
        try {
          upload = this.uploadTransfers.complete(id, Date.now());
          this.clearUploadExpiry();
        } catch (error) {
          if (!this.uploadTransfers.hasActiveTransfer()) {
            this.clearUploadExpiry();
          }
          this.postResult(id, false, error);
          return;
        }
        this.finishUpload(upload).then((data) => this.postResult(id, true, data)).catch((error) => this.postResult(id, false, error)).finally(() => this.uploadTransfers.finish(id));
      }
    }
  }

  // src/extension/tab-registry.ts
  class TabRegistry {
    staticConfig;
    session;
    events;
    connections = new Map;
    authRequests = new Map;
    constructor(staticConfig, session, events) {
      this.staticConfig = staticConfig;
      this.session = session;
      this.events = events;
    }
    get size() {
      return this.connections.size;
    }
    register(port) {
      const tabId = port.sender?.tab?.id;
      const href = port.sender?.tab?.url || "";
      const groupPathSegment = groupPathSegmentFromUrl(href, this.staticConfig.accountOrigin);
      if (port.name !== "holvi-tab" || !Number.isInteger(tabId) || !groupPathSegment) {
        port.disconnect();
        return;
      }
      const validTabId = tabId;
      const stalePort = this.connections.get(validTabId)?.port;
      if (stalePort) {
        this.removeConnection(validTabId, stalePort);
        stalePort.disconnect();
      }
      this.connections.set(validTabId, { port, href, groupPathSegment });
      port.onMessage.addListener((message) => this.handleContentMessage(validTabId, message));
      port.onDisconnect.addListener(() => this.disconnect(validTabId, port));
      this.events.connectionAvailable();
    }
    configuredTab() {
      const config = this.session.optionalConfig;
      if (!config) {
        return null;
      }
      for (const entry of this.connections) {
        if (entry[1].groupPathSegment === config.groupPathSegment) {
          return entry;
        }
      }
      return null;
    }
    requestAuth() {
      const tab = this.configuredTab();
      if (!tab) {
        return Promise.reject(new Error("Open the configured signed-in Holvi group tab in Chrome."));
      }
      const [tabId, connection] = tab;
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timeout = self.setTimeout(() => {
          this.authRequests.delete(requestId);
          reject(new Error("The Holvi tab did not provide session authentication."));
        }, 5000);
        this.authRequests.set(requestId, { resolve, reject, timeout, tabId });
        connection.port.postMessage({ type: "auth_request", requestId });
      });
    }
    handleContentMessage(tabId, value) {
      const message = value;
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === "tab_hello") {
        const groupPathSegment = groupPathSegmentFromUrl(message.href || "", this.staticConfig.accountOrigin);
        const connection = this.connections.get(tabId);
        if (!connection || !groupPathSegment) {
          if (connection) {
            this.disconnect(tabId, connection.port);
            connection.port.disconnect();
          }
          return;
        }
        connection.href = message.href || "";
        connection.groupPathSegment = groupPathSegment;
        this.events.connectionAvailable();
        this.events.stateChanged();
        return;
      }
      if (message.type !== "auth_response" || !message.requestId) {
        return;
      }
      const pending = this.authRequests.get(message.requestId);
      if (!pending || pending.tabId !== tabId) {
        return;
      }
      this.authRequests.delete(message.requestId);
      clearTimeout(pending.timeout);
      const config = this.session.optionalConfig;
      if (!config || message.origin !== this.staticConfig.accountOrigin || groupPathSegmentFromUrl(message.href || "", this.staticConfig.accountOrigin) !== config.groupPathSegment) {
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
    removeConnection(tabId, port) {
      if (this.connections.get(tabId)?.port !== port) {
        return false;
      }
      this.connections.delete(tabId);
      for (const [requestId, pending] of this.authRequests) {
        if (pending.tabId === tabId) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("The Holvi tab disconnected."));
          this.authRequests.delete(requestId);
        }
      }
      return true;
    }
    disconnect(tabId, port) {
      if (this.removeConnection(tabId, port)) {
        this.events.stateChanged();
      }
    }
  }

  // src/extension/upload-workflow.ts
  function projectedAttachments(debt) {
    if (!Array.isArray(debt.attachments)) {
      throw new Error("Projected upload debt has an invalid attachment list.");
    }
    return debt.attachments.map((attachment) => attachment);
  }
  function attachmentCode2(attachment) {
    if (typeof attachment.attachmentCode !== "string" || !attachment.attachmentCode) {
      throw new Error("Projected upload attachment has an invalid code.");
    }
    return attachment.attachmentCode;
  }
  function verifyAdditiveUpload(before, after) {
    const expectedCount = before.length + 1;
    if (after.length !== expectedCount) {
      throw new Error(`Holvi accepted the upload but verification expected ${expectedCount} attachment(s) and found ${after.length}. Inspect the transaction before retrying.`);
    }
    const existing = new Map(before.map((attachment) => [attachmentCode2(attachment), attachment]));
    for (const [code, expected] of existing) {
      const actual = after.find((attachment) => attachmentCode2(attachment) === code);
      if (!actual) {
        throw new Error("Holvi accepted the upload but verification found a missing existing attachment. Inspect the transaction before retrying.");
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("Holvi accepted the upload but verification found a changed existing attachment. Inspect the transaction before retrying.");
      }
    }
    const added = after.filter((attachment) => !existing.has(attachmentCode2(attachment)));
    if (added.length !== 1) {
      throw new Error(`Holvi accepted the upload but verification found ${added.length} new attachment(s). Inspect the transaction before retrying.`);
    }
    return added[0];
  }

  class UploadWorkflow {
    session;
    api;
    sleep;
    constructor(session, api, sleep = (delay) => new Promise((resolve) => self.setTimeout(resolve, delay))) {
      this.session = session;
      this.api = api;
      this.sleep = sleep;
    }
    async uploadReceipt(auth, upload) {
      this.session.requireCapabilities("transactions.read", "attachments.write");
      const debtUuid = validateUuid(upload.debtUuid, "debt");
      const before = projectUploadDebtRead(await this.api.request(auth, this.api.debtPath(debtUuid)), debtUuid, this.session.config.paymentAccountUuid);
      const beforeAttachments = projectedAttachments(before);
      const beforeCount = beforeAttachments.length;
      if (beforeCount >= maxDebtAttachments) {
        throw new Error(`Upload refused because the transaction has reached the ${maxDebtAttachments}-attachment verification limit.`);
      }
      if (typeof before.code !== "string" || !before.code) {
        throw new Error("Holvi did not return the object code required for upload.");
      }
      const bytes = await verifyUploadTransfer(upload);
      const form = new FormData;
      form.append("content_type", "debt");
      form.append("object_code", before.code);
      form.append("attachment_file", new File([bytes], upload.fileName, { type: upload.mimeType }));
      await this.api.request(auth, `${this.session.apiRoot()}attachment/formpost/`, {
        method: "POST",
        body: form
      });
      let afterAttachments = beforeAttachments;
      for (const delay of [0, 250, 500, 1000, 2000]) {
        if (delay) {
          await this.sleep(delay);
        }
        const after = projectUploadDebtRead(await this.api.request(auth, this.api.debtPath(debtUuid)), debtUuid, this.session.config.paymentAccountUuid);
        afterAttachments = projectedAttachments(after);
        if (afterAttachments.length > beforeCount) {
          break;
        }
      }
      const attachment = verifyAdditiveUpload(beforeAttachments, afterAttachments);
      return {
        debtUuid,
        fileName: upload.fileName,
        sha256: upload.sha256,
        attachmentCountBefore: beforeCount,
        attachmentCountAfter: afterAttachments.length,
        attachment
      };
    }
  }

  // src/extension/background.ts
  importScripts("config.js");
  var staticConfig = _HOLVI_AGENT_BRIDGE_STATIC_CONFIG;
  var session = new BridgeSession(staticConfig);
  var api = new HolviApi(staticConfig, session);
  var nativeBridge;
  var tabs;
  tabs = new TabRegistry(staticConfig, session, {
    connectionAvailable: () => nativeBridge.connect(),
    stateChanged: () => nativeBridge.reportTabState()
  });
  var commands = new CommandService(session, api, () => tabs.requestAuth());
  var uploads = new UploadWorkflow(session, api);
  nativeBridge = new NativeBridge(staticConfig, session, tabs, commands, uploads, api);
  chrome.runtime.onConnect.addListener((port) => tabs.register(port));
})();
