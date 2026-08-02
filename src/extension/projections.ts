const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimalPattern = /^-?\d+(?:\.\d+)?$/;
const maxStringLength = 4096;
const maxBookkeepingItems = 500;
const maxCategoryResults = 1000;
const maxSuggestionResults = 100;
const maxAuditResults = 25;
const maxAuditEnvelopeResults = 200;
const maxFeedPageResults = 10_000;
const maxPaymentMatches = 1000;
const maxPaymentAccounts = 100;
export const maxDebtAttachments = 1000;
const maxCommentPageResults = 25;
const maxCommentResults = 1000;
export const maxCommentContentBytes = 16 * 1024;
const maxProjectionBytes = 512 * 1024;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an unexpected shape.`);
  }
  return value as JsonRecord;
}

function boundedString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxStringLength
  ) {
    throw new Error(`${label} must be a nonempty bounded string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return boundedString(value, label);
}

function uuid(value: unknown, label: string): string {
  const text = boundedString(value, label);
  if (!uuidPattern.test(text)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return text;
}

function optionalUuid(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return uuid(value, label);
}

function decimal(value: unknown, label: string): string | number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.length <= 128 &&
    decimalPattern.test(value)
  ) {
    return value;
  }
  throw new Error(`${label} has an invalid decimal value.`);
}

function requiredDecimal(value: unknown, label: string): string | number {
  const result = decimal(value, label);
  if (result === null) {
    throw new Error(`${label} is required.`);
  }
  return result;
}

function price(
  value: unknown,
  label: string,
  includeVatRate: boolean,
): JsonRecord | null {
  if (value === null || value === undefined) {
    return null;
  }
  const source = record(value, label);
  return {
    currency: optionalString(source.currency, `${label} currency`),
    gross: decimal(source.gross, `${label} gross`),
    net: decimal(source.net, `${label} net`),
    ...(includeVatRate
      ? { vatRate: decimal(source.vat_rate, `${label} VAT rate`) }
      : {}),
  };
}

function projection<T>(value: T): T {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    maxProjectionBytes
  ) {
    throw new Error("Holvi projection exceeded its output limit.");
  }
  return value;
}

function stringOrEmpty(value: unknown, label: string): string {
  return optionalString(value, label) ?? "";
}

function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const count =
    typeof value === "string" && /^\d{1,16}$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new Error(`${label} must be a nonnegative integer.`);
  }
  return count as number;
}

function optionalRecord(value: unknown, label: string): JsonRecord {
  if (value === null || value === undefined) {
    return {};
  }
  return record(value, label);
}

function boundedArray(
  value: unknown,
  label: string,
  limit: number,
  optional = false,
): unknown[] {
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

function directDebtUuid(value: unknown): string | null {
  const matches = boundedArray(
    value,
    "Payment matches",
    maxPaymentMatches,
    true,
  );
  let direct: JsonRecord | null = null;
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

function payment(value: unknown): JsonRecord {
  const source = record(value, "Payment");
  const counterparty = optionalRecord(
    source.counterparty,
    "Payment counterparty",
  );
  const fx = optionalRecord(
    source.fx_meta,
    "Payment foreign exchange metadata",
  );
  const paymentTimestamp = timestamp(source.ux_timestamp, "Payment timestamp");
  const rawAttachmentCount = source.attachment_count ?? 0;
  return {
    paymentUuid: uuid(source.uuid, "Payment UUID"),
    debtUuid: directDebtUuid(source.matches),
    date: paymentTimestamp.slice(0, 10),
    timestamp: paymentTimestamp,
    counterparty:
      optionalString(counterparty.display_name, "Payment counterparty name") ??
      optionalString(source.counterparty_name, "Payment counterparty name") ??
      stringOrEmpty(source.description, "Payment description"),
    description: stringOrEmpty(source.description, "Payment description"),
    direction: stringOrEmpty(source.direction, "Payment direction"),
    amount: decimal(source.amount ?? source.value, "Payment amount"),
    currency: optionalString(source.currency, "Payment currency") ?? "EUR",
    originalAmount: decimal(
      fx.counterparty_amount ?? fx.counterparty_value,
      "Payment original amount",
    ),
    originalCurrency: optionalString(
      fx.counterparty_currency,
      "Payment original currency",
    ),
    state: stringOrEmpty(source.state, "Payment state"),
    attachmentCount: nonnegativeInteger(
      rawAttachmentCount,
      "Payment attachment count",
    ),
  };
}

export function projectTransactionFeedPage(value: unknown): {
  results: JsonRecord[];
  hasMore: boolean;
  nextCursor: string;
} {
  const page = record(value, "Payments feed page");
  const results = boundedArray(
    page.results,
    "Payments feed results",
    maxFeedPageResults,
  ).map(payment);
  const pagination = record(page.pagination, "Payments feed pagination");
  if (typeof pagination.has_more !== "boolean") {
    throw new Error("Payments feed pagination has an unexpected shape.");
  }
  const nextCursor = stringOrEmpty(
    pagination.next_cursor,
    "Payments feed cursor",
  );
  if (pagination.has_more && !nextCursor) {
    throw new Error("Holvi pagination omitted its next cursor.");
  }
  return projection({
    results,
    hasMore: pagination.has_more,
    nextCursor: pagination.has_more ? nextCursor : "",
  });
}

export function projectTransactionListing<T>(value: T): T {
  return projection(value);
}

export interface TransactionDetailDebt {
  debtUuid: string;
  paymentAccountUuid: string;
  cardProfileUuid: string | null;
  cardholder: string | null;
  exchangeRate: JsonRecord | null;
  merchantAddress: JsonRecord | null;
  merchantCategory: string | null;
  paymentType: string | null;
}

export function projectTransactionDetailDebt(
  value: unknown,
  debtUuid: string,
  paymentAccountUuid: string,
): TransactionDetailDebt {
  const debt = record(value, "Transaction detail debt");
  const requestedUuid = uuid(debtUuid, "Debt UUID");
  const responseUuid = uuid(debt.uuid, "Transaction detail debt UUID");
  if (responseUuid.toLowerCase() !== requestedUuid.toLowerCase()) {
    throw new Error(
      "Holvi transaction detail debt UUID does not match the request.",
    );
  }
  const configuredAccount = uuid(
    paymentAccountUuid,
    "Configured payment account UUID",
  );
  const responseAccount = uuid(
    debt.payment_account_uuid,
    "Transaction detail payment account UUID",
  );
  if (responseAccount.toLowerCase() !== configuredAccount.toLowerCase()) {
    throw new Error(
      "Holvi transaction detail debt is outside the configured payment account.",
    );
  }

  const links = optionalRecord(debt.links, "Transaction detail links");
  const receiver = optionalRecord(debt.receiver, "Transaction detail receiver");
  const merchant = optionalRecord(
    receiver.merchant_info,
    "Transaction detail merchant",
  );
  const address = optionalRecord(
    merchant.address,
    "Transaction detail merchant address",
  );
  const merchantAddress = {
    street: optionalString(address.street, "Merchant address street"),
    postcode: optionalString(address.postcode, "Merchant address postcode"),
    city: optionalString(address.city, "Merchant address city"),
    country: optionalString(address.country, "Merchant address country"),
  };
  const conversion = optionalRecord(
    debt.currency_conversion,
    "Transaction detail currency conversion",
  );
  const exchangeRate = Object.keys(conversion).length
    ? {
        baseCurrency: boundedString(debt.currency, "Payment currency"),
        counterpartyCurrency: boundedString(
          conversion.counterparty_currency,
          "Exchange counterparty currency",
        ),
        counterpartyAmount: requiredDecimal(
          conversion.counterparty_amount,
          "Exchange counterparty amount",
        ),
        rate: requiredDecimal(conversion.rate, "Exchange rate"),
      }
    : null;
  const creator = optionalRecord(debt.creator, "Transaction detail creator");
  const cardProfileUuid = optionalUuid(
    links.card_profile,
    "Transaction detail card profile UUID",
  );

  return projection({
    debtUuid: requestedUuid,
    paymentAccountUuid: responseAccount,
    cardProfileUuid,
    cardholder: cardProfileUuid
      ? optionalString(creator.displayname, "Transaction detail cardholder")
      : null,
    exchangeRate,
    merchantAddress: Object.values(merchantAddress).some(Boolean)
      ? merchantAddress
      : null,
    merchantCategory: optionalString(
      merchant.category,
      "Transaction detail merchant category",
    ),
    paymentType: optionalString(
      merchant.payment_type,
      "Transaction detail payment type",
    ),
  });
}

export function projectTransactionAccount(
  value: unknown,
  paymentAccountUuid: string,
): JsonRecord {
  const pool = record(value, "Pool account response");
  const requestedUuid = uuid(
    paymentAccountUuid,
    "Configured payment account UUID",
  );
  const accounts = boundedArray(
    pool.paymentaccounts,
    "Pool payment accounts",
    maxPaymentAccounts,
  );
  const matches = accounts.filter((entry) => {
    const account = record(entry, "Pool payment account");
    return (
      uuid(account.uuid, "Pool payment account UUID").toLowerCase() ===
      requestedUuid.toLowerCase()
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      "Holvi pool response did not contain one configured payment account.",
    );
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
    currency: boundedString(account.currency, "Payment account currency"),
  });
}

export function projectTransactionCard(
  value: unknown,
  cardProfileUuid: string,
  paymentAccountUuid: string,
): JsonRecord {
  const card = record(value, "Transaction card profile");
  const requestedCard = uuid(cardProfileUuid, "Card profile UUID");
  const responseCard = uuid(card.uuid, "Transaction card profile UUID");
  if (responseCard.toLowerCase() !== requestedCard.toLowerCase()) {
    throw new Error("Holvi card profile UUID does not match the debt link.");
  }
  const requestedAccount = uuid(
    paymentAccountUuid,
    "Configured payment account UUID",
  );
  const responseAccount = uuid(
    card.payment_account_uuid,
    "Card payment account UUID",
  );
  if (responseAccount.toLowerCase() !== requestedAccount.toLowerCase()) {
    throw new Error(
      "Holvi card profile is outside the configured payment account.",
    );
  }
  const maskedPan = boundedString(card.masked_pan, "Card masked PAN");
  const lastFour =
    maskedPan.length <= 64 ? maskedPan.match(/(\d{4})$/)?.[1] : undefined;
  if (!lastFour) {
    throw new Error("Holvi card profile has an invalid masked PAN.");
  }
  return projection({
    cardProfileUuid: requestedCard,
    lastFour,
  });
}

export function projectTransactionDetails(value: unknown): JsonRecord {
  return projection(record(value, "Transaction details"));
}

function attachmentCode(value: unknown): string {
  const code = boundedString(value, "Attachment code");
  if (
    code.length > 256 ||
    Array.from({ length: code.length }, (_, index) =>
      code.charCodeAt(index),
    ).some((value) => value < 32 || value === 127)
  ) {
    throw new Error("Attachment code must be a nonempty bounded string.");
  }
  return code;
}

function debtAttachments(value: unknown, label: string): JsonRecord[] {
  const codes = new Set<string>();
  return boundedArray(
    value,
    `${label} attachments`,
    maxDebtAttachments,
    true,
  ).map((entry) => {
    const source = record(entry, `${label} attachment`);
    const code = attachmentCode(source.code);
    if (codes.has(code)) {
      throw new Error(`${label} contains an ambiguous attachment code.`);
    }
    codes.add(code);
    return {
      attachmentCode: code,
      title: boundedString(source.title, `${label} attachment title`),
      format: optionalString(source.format, `${label} attachment format`),
    };
  });
}

function debtRecord(
  value: unknown,
  debtUuid: string,
  paymentAccountUuid: string,
  label: string,
): JsonRecord {
  const debt = record(value, label);
  const requestedUuid = uuid(debtUuid, "Debt UUID");
  const responseUuid = uuid(debt.uuid, `${label} UUID`);
  if (responseUuid.toLowerCase() !== requestedUuid.toLowerCase()) {
    throw new Error(
      `Holvi ${label.toLowerCase()} UUID does not match the request.`,
    );
  }
  const configuredPaymentAccountUuid = uuid(
    paymentAccountUuid,
    "Configured payment account",
  );
  const responsePaymentAccountUuid = uuid(
    debt.payment_account_uuid,
    `${label} payment account`,
  );
  if (
    responsePaymentAccountUuid.toLowerCase() !==
    configuredPaymentAccountUuid.toLowerCase()
  ) {
    throw new Error(
      `Holvi ${label.toLowerCase()} payment account does not match the configured payment account.`,
    );
  }
  const attachments = debtAttachments(debt.attachments, label);
  const merchant = optionalRecord(debt.merchant, `${label} merchant`);
  return projection({
    debtUuid: requestedUuid,
    code: stringOrEmpty(debt.code, `${label} code`),
    counterparty:
      optionalString(debt.counterparty_name, `${label} counterparty`) ??
      stringOrEmpty(merchant.name, `${label} merchant name`),
    amount: decimal(debt.amount ?? debt.value ?? debt.total, `${label} amount`),
    currency: optionalString(debt.currency, `${label} currency`) ?? "EUR",
    attachmentCount: attachments.length,
    attachments,
    bookkeepingStatus:
      optionalString(debt.bookkeeping_status, `${label} bookkeeping status`) ??
      stringOrEmpty(debt.bookkeeping_state, `${label} bookkeeping state`),
  });
}

export function projectDebtPreview(
  value: unknown,
  debtUuid: string,
  paymentAccountUuid: string,
): JsonRecord {
  return debtRecord(value, debtUuid, paymentAccountUuid, "Debt");
}

function commentContent(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > maxCommentContentBytes
  ) {
    throw new Error(`${label} must be a nonempty bounded string.`);
  }
  return value;
}

function commentCreator(value: unknown): JsonRecord {
  if (value === null || value === undefined) {
    return { uuid: null, name: "Holvi", isHolvi: true };
  }
  const source = record(value, "Comment creator");
  const creatorUuid = optionalUuid(source.uuid, "Comment creator UUID");
  const firstName =
    optionalString(source.first_name, "Comment creator first name") ??
    optionalString(source.firstname, "Comment creator first name");
  const lastName =
    optionalString(source.last_name, "Comment creator last name") ??
    optionalString(source.lastname, "Comment creator last name");
  const name =
    optionalString(source.name, "Comment creator name") ??
    optionalString(source.display_name, "Comment creator display name") ??
    [firstName, lastName].filter(Boolean).join(" ");
  if (!name) {
    throw new Error("Comment creator has no bounded display name.");
  }
  return { uuid: creatorUuid, name, isHolvi: false };
}

function comment(value: unknown): JsonRecord {
  const source = record(value, "Comment");
  if (typeof source.push_notified !== "boolean") {
    throw new Error("Comment notification state has an unexpected shape.");
  }
  return {
    uuid: optionalUuid(source.uuid, "Comment UUID"),
    content: commentContent(source.content, "Comment content"),
    creator: commentCreator(source.creator),
    createTime: timestamp(source.create_time, "Comment creation time"),
    pushNotified: source.push_notified,
  };
}

export function projectCommentPage(value: unknown): {
  results: JsonRecord[];
  next: string;
} {
  if (Array.isArray(value)) {
    return projection({
      results: boundedArray(value, "Comment results", maxCommentResults).map(
        comment,
      ),
      next: "",
    });
  }
  const page = record(value, "Comment page");
  const results = boundedArray(
    page.results,
    "Comment page results",
    maxCommentPageResults,
  ).map(comment);
  const next = optionalString(page.next, "Comment next page") ?? "";
  return projection({ results, next });
}

export function projectCommentListing<T>(value: T): T {
  return projection(value);
}

export function projectCommentWriteResponse(value: unknown): JsonRecord {
  return projection(comment(value));
}

export function projectUploadDebtRead(
  value: unknown,
  debtUuid: string,
  paymentAccountUuid: string,
): JsonRecord {
  return debtRecord(value, debtUuid, paymentAccountUuid, "Upload debt");
}

export function projectAttachmentDeletionDebt(
  value: unknown,
  debtUuid: string,
  paymentAccountUuid: string,
): JsonRecord {
  const debt = record(value, "Attachment deletion debt");
  const expectedAccount = uuid(
    paymentAccountUuid,
    "Configured payment account UUID",
  );
  const actualAccount = uuid(
    debt.payment_account_uuid,
    "Attachment deletion payment account UUID",
  );
  if (actualAccount.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error(
      "Holvi attachment deletion debt is outside the configured payment account.",
    );
  }
  return projection({
    ...debtRecord(
      debt,
      debtUuid,
      paymentAccountUuid,
      "Attachment deletion debt",
    ),
    paymentAccountUuid: actualAccount,
  });
}

function bookkeepingItem(value: unknown): JsonRecord {
  const item = record(value, "Bookkeeping item");
  return {
    itemUuid: uuid(item.uuid, "Bookkeeping item UUID"),
    description: optionalString(item.description, "Bookkeeping description"),
    categoryCode: optionalString(item.category, "Bookkeeping category"),
    costCenterUuid: optionalUuid(
      item.cost_center_uuid,
      "Bookkeeping cost center",
    ),
    vatCalculationRule: optionalString(
      item.vat_calculation_rule,
      "Bookkeeping VAT calculation rule",
    ),
    vatStatus: optionalString(item.vat_status, "Bookkeeping VAT status"),
    quantity: decimal(item.quantity, "Bookkeeping quantity"),
    unit: optionalString(item.unit, "Bookkeeping unit"),
    unitPrice: price(item.detailed_price, "Bookkeeping unit price", true),
    lineTotal: price(
      item.detailed_total_price,
      "Bookkeeping line total",
      false,
    ),
  };
}

export function projectBookkeepingDebt(
  value: unknown,
  debtUuid: string,
): JsonRecord {
  const debt = record(value, "Bookkeeping debt");
  const items =
    debt.items === null || debt.items === undefined ? [] : debt.items;
  if (!Array.isArray(items)) {
    throw new Error("Holvi bookkeeping debt has an invalid item list.");
  }
  if (items.length > maxBookkeepingItems) {
    throw new Error("Holvi bookkeeping debt exceeded its item limit.");
  }
  const attachments = boundedArray(
    debt.attachments,
    "Bookkeeping debt attachments",
    maxDebtAttachments,
    true,
  );
  const responseUuid = uuid(debt.uuid, "Bookkeeping debt UUID");
  const requestedUuid = uuid(debtUuid, "Debt UUID");
  if (responseUuid.toLowerCase() !== requestedUuid.toLowerCase()) {
    throw new Error("Holvi bookkeeping debt UUID does not match the request.");
  }

  const retained = items.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const candidate = item as JsonRecord;
    return candidate.type === "line_item" && candidate.active === true;
  });
  const merchant =
    debt.merchant && typeof debt.merchant === "object"
      ? (debt.merchant as JsonRecord)
      : {};

  return projection({
    debtUuid: requestedUuid,
    code: optionalString(debt.code, "Bookkeeping debt code"),
    bookingDate: optionalString(debt.booking_date, "Bookkeeping date"),
    counterparty:
      optionalString(debt.counterparty_name, "Bookkeeping counterparty") ??
      optionalString(merchant.name, "Bookkeeping merchant"),
    amount: decimal(
      debt.amount ?? debt.value ?? debt.total,
      "Bookkeeping amount",
    ),
    currency: optionalString(debt.currency, "Bookkeeping currency"),
    bookkeepingStatus:
      optionalString(debt.bookkeeping_status, "Bookkeeping status") ??
      optionalString(debt.bookkeeping_state, "Bookkeeping state"),
    exportStatus: optionalString(
      debt.export_status,
      "Bookkeeping export status",
    ),
    type: optionalString(debt.type, "Bookkeeping type"),
    subtype: optionalString(debt.subtype, "Bookkeeping subtype"),
    paymentAccountUuid: optionalUuid(
      debt.payment_account_uuid,
      "Bookkeeping payment account",
    ),
    connectionUuid: optionalUuid(
      debt.connection_uuid,
      "Bookkeeping connection",
    ),
    attachmentCount: attachments.length,
    droppedItemCount: items.length - retained.length,
    items: retained.map(bookkeepingItem),
  });
}

export function projectCategories(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Holvi returned an unexpected category list shape.");
  }
  if (value.length > maxCategoryResults) {
    throw new Error("Holvi category listing exceeded its result limit.");
  }
  return projection(
    value.map((entry) => {
      const category = record(entry, "Bookkeeping category");
      return {
        code: boundedString(category.code, "Bookkeeping category code"),
        handle: optionalString(category.handle, "Bookkeeping category handle"),
        label: optionalString(category.label, "Bookkeeping category label"),
      };
    }),
  );
}

export function projectSuggestions(
  value: unknown,
  debtUuid: string,
): JsonRecord {
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
    return boundedString(
      record(entry, "Suggested category").code,
      "Suggested category code",
    );
  });
  return projection({
    debtUuid: uuid(debtUuid, "Debt UUID"),
    categoryCodes,
  });
}

function creator(value: unknown): { name: string; isHolvi: boolean } {
  if (value === null || value === undefined) {
    return { name: "Holvi", isHolvi: true };
  }
  const source = record(value, "Activity creator");
  const name =
    optionalString(source.name, "Activity creator name") ??
    [
      optionalString(source.firstname, "Activity creator first name"),
      optionalString(source.lastname, "Activity creator last name"),
    ]
      .filter(Boolean)
      .join(" ");
  return { name: name || "Unknown", isHolvi: false };
}

function auditEntry(value: unknown): JsonRecord {
  const entry = record(value, "Activity entry");
  const timestamp = boundedString(entry.timestamp, "Activity timestamp");
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("Activity timestamp is invalid.");
  }
  const data =
    entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
      ? (entry.data as JsonRecord)
      : {};
  return {
    code: boundedString(entry.code, "Activity code"),
    timestamp,
    category: optionalString(entry.category, "Activity category"),
    creator: creator(entry.creator),
    action: optionalString(entry.action, "Activity action"),
    title: optionalString(entry.title, "Activity title"),
    content:
      typeof entry.content === "string"
        ? optionalString(entry.content, "Activity content")
        : null,
    status: optionalString(data.status, "Activity status"),
  };
}

export function projectAuditPage(value: unknown, limit: number): JsonRecord {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxAuditResults) {
    throw new Error("Activity limit is outside the configured range.");
  }
  const page = record(value, "Activity page");
  if (
    !Array.isArray(page.results) ||
    page.results.length > maxAuditEnvelopeResults
  ) {
    throw new Error("Holvi returned an unexpected activity feed shape.");
  }
  if (
    page.next !== null &&
    page.next !== undefined &&
    typeof page.next !== "string"
  ) {
    throw new Error("Holvi activity pagination has an unexpected shape.");
  }
  const entries = page.results.map(auditEntry);
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (
      !previous ||
      !current ||
      Date.parse(String(previous.timestamp)) <
        Date.parse(String(current.timestamp))
    ) {
      throw new Error("Holvi activity feed is not ordered newest first.");
    }
  }
  const results = entries.slice(0, limit);
  return projection({
    returnedCount: results.length,
    hasMore: typeof page.next === "string" || entries.length > results.length,
    order: "newest-first",
    results,
  });
}
