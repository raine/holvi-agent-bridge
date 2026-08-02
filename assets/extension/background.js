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
  var maxFeedPageResults = 1e4;
  var maxPaymentMatches = 1000;
  var maxPaymentAccounts = 100;
  var maxDebtAttachments = 1000;
  var maxCommentPageResults = 25;
  var maxCommentResults = 1000;
  var maxCommentContentBytes = 16 * 1024;
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
    return record(value, label);
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
      const match = record(entry, "Payment match");
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
    const source = record(value, "Payment");
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
    const page = record(value, "Payments feed page");
    const results = boundedArray(page.results, "Payments feed results", maxFeedPageResults).map(payment);
    const pagination = record(page.pagination, "Payments feed pagination");
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
    const debt = record(value, "Transaction detail debt");
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
    return projection({
      debtUuid: requestedUuid,
      paymentAccountUuid: responseAccount,
      cardProfileUuid,
      cardholder: cardProfileUuid ? optionalString(creator.displayname, "Transaction detail cardholder") : null,
      exchangeRate,
      merchantAddress: Object.values(merchantAddress).some(Boolean) ? merchantAddress : null,
      merchantCategory: optionalString(merchant.category, "Transaction detail merchant category"),
      paymentType: optionalString(merchant.payment_type, "Transaction detail payment type")
    });
  }
  function projectTransactionAccount(value, paymentAccountUuid) {
    const pool = record(value, "Pool account response");
    const requestedUuid = uuid(paymentAccountUuid, "Configured payment account UUID");
    const accounts = boundedArray(pool.paymentaccounts, "Pool payment accounts", maxPaymentAccounts);
    const matches = accounts.filter((entry) => {
      const account2 = record(entry, "Pool payment account");
      return uuid(account2.uuid, "Pool payment account UUID").toLowerCase() === requestedUuid.toLowerCase();
    });
    if (matches.length !== 1) {
      throw new Error("Holvi pool response did not contain one configured payment account.");
    }
    const account = record(matches[0], "Configured payment account");
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
    const card = record(value, "Transaction card profile");
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
  function projectTransactionDetails(value) {
    return projection(record(value, "Transaction details"));
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
      const source = record(entry, `${label} attachment`);
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
    const debt = record(value, label);
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
    const source = record(value, "Comment creator");
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
    const source = record(value, "Comment");
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
    const page = record(value, "Comment page");
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
    const debt = record(value, "Attachment deletion debt");
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
    const attachments = boundedArray(debt.attachments, "Bookkeeping debt attachments", maxDebtAttachments, true);
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
  var minimumFileBytes = 1;
  var actionCapabilities = {
    doctor: [],
    "transactions.list": ["transactions.read"],
    "transactions.get": ["transactions.read"],
    "debts.get": ["transactions.read"],
    "comments.list": ["transactions.read"],
    "comments.create": ["transactions.read", "comments.write"],
    "attachments.upload": ["transactions.read", "attachments.write"],
    "attachments.delete": ["transactions.read", "attachments.delete"],
    "bookkeeping.get": ["bookkeeping.read"],
    "bookkeeping.categories": ["bookkeeping.read"],
    "bookkeeping.suggestions": ["bookkeeping.read"],
    "bookkeeping.set-description": ["bookkeeping.write"],
    "audit.list": ["audit.read"]
  };
  var supportedCapabilities = new Set(Object.values(actionCapabilities).flat());
  function isBridgeAction(action) {
    return Object.hasOwn(actionCapabilities, action);
  }
  function requiredCapabilities(action) {
    return isBridgeAction(action) ? actionCapabilities[action] : null;
  }

  // src/extension/session.ts
  var uuidPattern2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    if (!groupParts || !poolHandlePattern.test(config.poolHandle || "") || groupPoolHandle !== config.poolHandle || !uuidPattern2.test(config.paymentAccountUuid || "") || !Array.isArray(config.capabilities) || config.capabilities.length < 1 || config.capabilities.some((capability) => !supportedCapabilities.has(capability)) || new Set(config.capabilities).size !== config.capabilities.length || !Number.isSafeInteger(config.maxFileBytes) || (config.maxFileBytes || 0) < minimumFileBytes || (config.maxFileBytes || 0) > staticConfig.maxFileBytes) {
      throw new Error("The native host supplied an invalid Holvi account boundary.");
    }
    return config;
  }
  function validateUuid(value, resource) {
    if (!uuidPattern2.test(value || "")) {
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
  function record2(value, label) {
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
    const debt = record2(value, "Bookkeeping debt");
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
      const item = record2(value2, `Bookkeeping item ${index + 1}`);
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
  var auditLimitMin = 1;
  var auditLimitMax = 25;
  var auditPageSize = 25;
  var maxApiResponseBytes = 2 * 1024 * 1024;
  var commentPageSize = 25;
  var maxCommentPages = 40;
  var maxCommentResults2 = 1000;
  var maxCommentResponseBytes = 1024 * 1024;
  function asString(value) {
    return typeof value === "string" ? value : "";
  }
  async function boundedResponseText(response, maxResponseBytes) {
    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength)) {
      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength > maxResponseBytes) {
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
    async request(auth, apiPath, options = {}, maxResponseBytes = maxApiResponseBytes) {
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
      const text = await boundedResponseText(response, maxResponseBytes);
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
    debtPath(debtUuid) {
      return `${this.session.apiRoot()}debt/${encodeURIComponent(validateUuid(debtUuid, "debt"))}/`;
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
    async paymentUuidForDebt(auth, debtUuid) {
      const seenCursors = new Set;
      let cursor = "";
      let paymentUuid = null;
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
        if (matches.length > 1 || matches.length === 1 && paymentUuid !== null) {
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
    async transactionDetails(auth, debtUuid) {
      const validUuid = validateUuid(debtUuid, "debt");
      const paymentAccountUuid = this.session.config.paymentAccountUuid;
      const debtValue = await this.request(auth, this.debtPath(validUuid));
      const debt = projectTransactionDetailDebt(debtValue, validUuid, paymentAccountUuid);
      const preview = projectDebtPreview(debtValue, validUuid, paymentAccountUuid);
      const [paymentUuid, account, card] = await Promise.all([
        this.paymentUuidForDebt(auth, validUuid),
        this.request(auth, this.session.apiRoot()).then((value) => projectTransactionAccount(value, paymentAccountUuid)),
        debt.cardProfileUuid ? this.request(auth, this.cardPath(debt.cardProfileUuid)).then((value) => projectTransactionCard(value, debt.cardProfileUuid, paymentAccountUuid)) : Promise.resolve(null)
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
    constructor(session, api, requestAuth) {
      this.session = session;
      this.api = api;
      this.requestAuth = requestAuth;
      this.attachmentDeletion = new AttachmentDeletionWorkflow(session, api);
      this.bookkeepingDescriptions = new BookkeepingDescriptionWorkflow(session, api);
      this.comments = new CommentWorkflow(session, api);
      this.handlers = {
        doctor: (auth) => this.doctor(auth),
        "transactions.list": (auth, params) => this.api.listTransactions(auth, params),
        "transactions.get": (auth, params) => this.api.transactionDetails(auth, asString2(params.debtUuid)),
        "debts.get": (auth, params) => this.api.previewDebt(auth, asString2(params.debtUuid)),
        "comments.list": (auth, params) => this.api.listComments(auth, asString2(params.debtUuid)),
        "comments.create": (auth, params) => this.comments.createComment(auth, params),
        "attachments.delete": (auth, params) => this.attachmentDeletion.deleteAttachment(auth, params),
        "bookkeeping.get": (auth, params) => this.api.bookkeepingDebt(auth, asString2(params.debtUuid)),
        "bookkeeping.categories": (auth) => this.api.bookkeepingCategories(auth),
        "bookkeeping.suggestions": (auth, params) => this.api.bookkeepingSuggestions(auth, asString2(params.debtUuid)),
        "bookkeeping.set-description": (auth, params) => this.bookkeepingDescriptions.change(auth, {
          debtUuid: asString2(params.debtUuid),
          itemUuid: asString2(params.itemUuid),
          description: requiredString(params.description),
          confirmed: asBoolean(params.confirmed)
        }),
        "audit.list": (auth, params) => this.api.recentAudit(auth, params.limit)
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
      if (action === "attachments.upload") {
        throw new Error("Receipt uploads require transfer messages.");
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
      nativeMessageType.result
    ]
  });

  class NativeBridge {
    staticConfig;
    session;
    tabs;
    commands;
    uploads;
    nativePort = null;
    reconnectTimer = null;
    uploadExpiryTimer = null;
    uploadTransfers = new UploadTransferLifecycle;
    constructor(staticConfig, session, tabs, commands, uploads) {
      this.staticConfig = staticConfig;
      this.session = session;
      this.tabs = tabs;
      this.commands = commands;
      this.uploads = uploads;
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
  nativeBridge = new NativeBridge(staticConfig, session, tabs, commands, uploads);
  chrome.runtime.onConnect.addListener((port) => tabs.register(port));
})();
