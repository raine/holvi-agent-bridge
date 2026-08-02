import type { Auth } from "./background-types.js";
import type { HolviApi } from "./holvi-api.js";
import { BridgeSession, validateUuid } from "./session.js";

export const bookkeepingDescriptionMaxBytes = 4096;
const maxBookkeepingItems = 500;
const maxDiagnosticPaths = 32;
const maxDiagnosticDepth = 8;
const maxDiagnosticFieldBytes = 128;
const criticalDebtFields = [
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
  "attachments",
] as const;

type JsonRecord = Record<string, unknown>;

interface DebtSnapshot {
  debt: JsonRecord;
  items: JsonRecord[];
  targetIndex: number;
  currentDescription: string;
}

export interface BookkeepingDescriptionChange {
  debtUuid: string;
  itemUuid: string;
  description: string;
  confirmed: boolean;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an unexpected shape.`);
  }
  return value as JsonRecord;
}

function boundedDescription(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > bookkeepingDescriptionMaxBytes
  ) {
    throw new Error(`${label} must be at most 4096 bytes.`);
  }
  return value;
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function responseUuid(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a UUID.`);
  }
  return validateUuid(value, label);
}

function canonicalJson(value: unknown): string {
  function normalize(entry: unknown): unknown {
    if (Array.isArray(entry)) {
      return entry.map(normalize);
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as JsonRecord)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return entry;
  }
  return JSON.stringify(normalize(value));
}

function parseSnapshot(
  value: unknown,
  debtUuid: string,
  itemUuid: string,
  paymentAccountUuid: string,
): DebtSnapshot {
  const debt = record(value, "Bookkeeping debt");
  const responseDebtUuid = responseUuid(debt.uuid, "bookkeeping debt");
  if (!sameUuid(responseDebtUuid, debtUuid)) {
    throw new Error("Holvi bookkeeping debt UUID does not match the request.");
  }
  const responsePaymentAccountUuid = responseUuid(
    debt.payment_account_uuid,
    "bookkeeping debt payment account",
  );
  if (!sameUuid(responsePaymentAccountUuid, paymentAccountUuid)) {
    throw new Error(
      "Holvi bookkeeping debt payment account does not match the configured payment account.",
    );
  }
  if (!Array.isArray(debt.items)) {
    throw new Error("Holvi bookkeeping debt has an invalid item list.");
  }
  if (debt.items.length > maxBookkeepingItems) {
    throw new Error("Holvi bookkeeping debt exceeded its item limit.");
  }

  const matchingItems: JsonRecord[] = [];
  const items: JsonRecord[] = [];
  for (const [index, value] of debt.items.entries()) {
    const item = record(value, `Bookkeeping item ${index + 1}`);
    const responseItemUuid = responseUuid(
      item.uuid,
      `bookkeeping item ${index + 1}`,
    );
    if (typeof item.type !== "string" || typeof item.active !== "boolean") {
      throw new Error(`Bookkeeping item ${index + 1} has an unexpected shape.`);
    }
    if (sameUuid(responseItemUuid, itemUuid)) {
      matchingItems.push(item);
    }
    if (item.type === "line_item" && item.active) {
      boundedDescription(
        item.description,
        `Bookkeeping item ${index + 1} description`,
      );
      items.push(item);
    }
  }
  if (matchingItems.length !== 1) {
    throw new Error(
      "Holvi bookkeeping debt must contain exactly one matching item UUID.",
    );
  }
  const targetIndex = items.indexOf(matchingItems[0]!);
  if (targetIndex < 0) {
    throw new Error(
      "The matching bookkeeping item is not an active line item.",
    );
  }
  const currentDescription = boundedDescription(
    items[targetIndex]!.description,
    "Current bookkeeping description",
  );
  return { debt, items, targetIndex, currentDescription };
}

function verifyCriticalDebtFields(before: JsonRecord, after: JsonRecord): void {
  for (const field of criticalDebtFields) {
    if (canonicalJson(before[field]) !== canonicalJson(after[field])) {
      throw new Error(
        `Bookkeeping verification found a changed debt field: ${field}.`,
      );
    }
  }
}

function withoutDescription(item: JsonRecord): JsonRecord {
  const copy = { ...item };
  delete copy.description;
  return copy;
}

function diagnosticPath(parent: string, field: string): string {
  const boundedField =
    new TextEncoder().encode(field).byteLength <= maxDiagnosticFieldBytes
      ? field
      : "<oversized-field-name>";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(boundedField)
    ? parent
      ? `${parent}.${boundedField}`
      : boundedField
    : `${parent}[${JSON.stringify(boundedField)}]`;
}

function changedFieldPaths(
  expected: JsonRecord,
  actual: JsonRecord,
): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let truncated = false;

  function visit(
    left: unknown,
    right: unknown,
    path: string,
    depth: number,
  ): void {
    if (canonicalJson(left) === canonicalJson(right)) {
      return;
    }
    if (paths.length >= maxDiagnosticPaths) {
      truncated = true;
      return;
    }
    if (
      depth < maxDiagnosticDepth &&
      left &&
      right &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const leftRecord = left as JsonRecord;
      const rightRecord = right as JsonRecord;
      const fields = Array.from(
        new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]),
      ).sort();
      for (const field of fields) {
        const fieldPath = diagnosticPath(path, field);
        if (
          !Object.hasOwn(leftRecord, field) ||
          !Object.hasOwn(rightRecord, field)
        ) {
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

function verifyItems(
  expected: JsonRecord[],
  after: DebtSnapshot,
  itemUuid: string,
  description: string,
): void {
  if (after.items.length !== expected.length) {
    throw new Error(
      "Bookkeeping verification found a changed line-item count.",
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedItem = expected[index]!;
    const actualItem = after.items[index]!;
    const expectedUuid = responseUuid(
      expectedItem.uuid,
      "expected bookkeeping item",
    );
    const actualUuid = responseUuid(
      actualItem.uuid,
      "verified bookkeeping item",
    );
    if (!sameUuid(expectedUuid, actualUuid)) {
      throw new Error(
        "Bookkeeping verification found changed sibling item identity.",
      );
    }
    if (sameUuid(expectedUuid, itemUuid)) {
      if (actualItem.description !== description) {
        throw new Error(
          "Bookkeeping verification found an unexpected description.",
        );
      }
      const expectedFields = withoutDescription(expectedItem);
      const actualFields = withoutDescription(actualItem);
      if (canonicalJson(expectedFields) !== canonicalJson(actualFields)) {
        const changes = changedFieldPaths(expectedFields, actualFields);
        const omitted = changes.truncated
          ? " Additional fields were omitted."
          : "";
        throw new Error(
          `Bookkeeping verification found changed target item fields: ${JSON.stringify(changes.paths)}.${omitted}`,
        );
      }
    } else if (canonicalJson(expectedItem) !== canonicalJson(actualItem)) {
      throw new Error("Bookkeeping verification found a changed sibling item.");
    }
  }
}

export class BookkeepingDescriptionWorkflow {
  constructor(
    private readonly session: BridgeSession,
    private readonly api: HolviApi,
  ) {}

  async change(
    auth: Auth,
    change: BookkeepingDescriptionChange,
  ): Promise<Record<string, unknown>> {
    this.session.requireCapabilities("bookkeeping.write");
    const debtUuid = validateUuid(change.debtUuid, "debt");
    const itemUuid = validateUuid(change.itemUuid, "item");
    const description = boundedDescription(
      change.description,
      "Bookkeeping description",
    );
    if (typeof change.confirmed !== "boolean") {
      throw new Error("Bookkeeping confirmation has an unexpected shape.");
    }

    const path = this.api.debtPath(debtUuid);
    const before = parseSnapshot(
      await this.api.request(auth, path),
      debtUuid,
      itemUuid,
      this.session.config.paymentAccountUuid,
    );
    const report = {
      debtUuid,
      itemUuid,
      currentDescription: before.currentDescription,
      proposedDescription: description,
    };
    if (!change.confirmed) {
      return {
        ...report,
        dryRun: true,
        writePerformed: false,
        next: "Repeat the command with --yes after checking these descriptions.",
      };
    }

    const items = before.items.map((item, index) =>
      index === before.targetIndex ? { ...item, description } : item,
    );
    try {
      await this.api.request(auth, path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(
        `Bookkeeping description write failed or had an ambiguous outcome.${detail} Inspect the debt before retrying.`,
      );
    }

    try {
      const after = parseSnapshot(
        await this.api.request(auth, path),
        debtUuid,
        itemUuid,
        this.session.config.paymentAccountUuid,
      );
      verifyCriticalDebtFields(before.debt, after.debt);
      verifyItems(items, after, itemUuid, description);
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(
        `Holvi accepted the write but post-write verification failed.${detail} Inspect the debt before retrying.`,
      );
    }

    return {
      ...report,
      dryRun: false,
      writePerformed: true,
      verified: true,
    };
  }
}
