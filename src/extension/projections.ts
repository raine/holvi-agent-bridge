const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimalPattern = /^-?\d+(?:\.\d+)?$/;
const maxStringLength = 4096;
const maxBookkeepingItems = 500;
const maxCategoryResults = 1000;
const maxSuggestionResults = 100;
const maxAuditResults = 25;
const maxAuditEnvelopeResults = 200;
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
  const attachments =
    debt.attachments === null || debt.attachments === undefined
      ? []
      : debt.attachments;
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
