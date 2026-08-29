import type { Auth } from "./background-types.js";
import { AuthProxyClient } from "./auth-proxy.js";
import { HolviApi } from "./holvi-api.js";
import { BridgeSession, validateUuid } from "./session.js";

const digestPattern = /^[0-9a-f]{64}$/;
export const paymentPollIntervalMs = 2000;
export const paymentRecipientNameMaxBytes = 256;
export const paymentReferenceMaxBytes = 256;
export const paymentBicMaxBytes = 11;
const confirmableStatuses = new Set(["unverified", "draft"]);
const confirmedStatuses = new Set(["verified", "paid"]);
const maxStringBytes = paymentReferenceMaxBytes;

type JsonRecord = Record<string, unknown>;
type ReferenceKind = "message" | "rf" | "finnish";

interface PaymentReference {
  kind: ReferenceKind;
  value: string;
}

interface CreateParams {
  paymentAccountUuid: string;
  recipientName: string;
  iban: string;
  bic: string | null;
  amount: string;
  currency: "EUR";
  reference: PaymentReference;
  acceptPayeeWarning: boolean;
  confirmed: boolean;
}

interface SendParams {
  debtUuid: string;
  reviewDigest: string | null;
  acceptPayeeWarning: boolean;
  confirmed: boolean;
}

interface PaymentDebt {
  debtUuid: string;
  paymentAccountUuid: string;
  recipient: { name: string; iban: string };
  bic: string | null;
  amount: string;
  currency: "EUR";
  reference: PaymentReference;
  dueDate: string | null;
  instant: boolean;
  status: string;
  type: "outboundpayment";
  subtype: "outbound";
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an unexpected shape.`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  maxBytes = maxStringBytes,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new Error(`${label} must be a nonempty bounded string.`);
  }
  return value.trim();
}

function mod97(value: string): number {
  let remainder = 0;
  for (const character of value) {
    const digits = /[A-Z]/.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits)
      remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

function normalizeIban(value: unknown): string {
  const iban = boundedString(value, "IBAN", 64)
    .replace(/\s/g, "")
    .toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
    throw new Error("IBAN has an invalid shape.");
  }
  if (mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) !== 1)
    throw new Error("IBAN checksum is invalid.");
  return iban;
}

function normalizeAmount(value: unknown): string {
  const source =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : boundedString(value, "Payment amount", 32);
  const match = source.match(/^(\d{1,16})(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Payment amount must be a positive EUR decimal.");
  const whole = (match[1] || "0").replace(/^0+(?=\d)/, "");
  const fraction = (match[2] || "").replace(/0+$/, "");
  const amount = fraction ? `${whole}.${fraction}` : whole;
  if (amount === "0") throw new Error("Payment amount must be positive.");
  return amount;
}

function paymentReference(value: unknown): PaymentReference {
  const source = record(value, "Payment reference");
  exactKeys(source, ["kind", "value"], "Payment reference");
  if (!(["message", "rf", "finnish"] as unknown[]).includes(source.kind)) {
    throw new Error("Payment reference kind is unsupported.");
  }
  const kind = source.kind as ReferenceKind;
  let normalized = boundedString(source.value, "Payment reference");
  if (kind === "rf") {
    normalized = normalized.replace(/\s/g, "").toUpperCase();
    if (
      !/^RF\d{2}[A-Z0-9]{1,21}$/.test(normalized) ||
      mod97(`${normalized.slice(4)}${normalized.slice(0, 4)}`) !== 1
    ) {
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
    const sum = body
      .split("")
      .reverse()
      .reduce(
        (total, digit, index) =>
          total + Number(digit) * (weights[index % weights.length] || 0),
        0,
      );
    if ((10 - (sum % 10)) % 10 !== check) {
      throw new Error("Finnish reference checksum is invalid.");
    }
  }
  return { kind, value: normalized };
}

function createParams(value: Record<string, unknown>): CreateParams {
  exactKeys(
    value,
    [
      "paymentAccountUuid",
      "recipientName",
      "iban",
      "bic",
      "amount",
      "currency",
      "reference",
      "acceptPayeeWarning",
      "confirmed",
    ],
    "Payment creation parameters",
  );
  const bic =
    value.bic === null || value.bic === undefined || value.bic === ""
      ? null
      : boundedString(value.bic, "BIC", paymentBicMaxBytes).toUpperCase();
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic)) {
    throw new Error("BIC has an invalid shape.");
  }
  if (value.currency !== "EUR")
    throw new Error("Payment currency must be EUR.");
  if (
    typeof value.confirmed !== "boolean" ||
    typeof value.acceptPayeeWarning !== "boolean"
  ) {
    throw new Error("Payment confirmation flags are invalid.");
  }
  return {
    paymentAccountUuid: validateUuid(
      boundedString(value.paymentAccountUuid, "Payment account UUID", 64),
      "payment account",
    ).toLowerCase(),
    recipientName: boundedString(value.recipientName, "Recipient name"),
    iban: normalizeIban(value.iban),
    bic,
    amount: normalizeAmount(value.amount),
    currency: "EUR",
    reference: paymentReference(value.reference),
    acceptPayeeWarning: value.acceptPayeeWarning,
    confirmed: value.confirmed,
  };
}

function sendParams(value: Record<string, unknown>): SendParams {
  exactKeys(
    value,
    ["debtUuid", "reviewDigest", "acceptPayeeWarning", "confirmed"],
    "Payment sending parameters",
  );
  if (
    typeof value.confirmed !== "boolean" ||
    typeof value.acceptPayeeWarning !== "boolean"
  ) {
    throw new Error("Payment confirmation flags are invalid.");
  }
  const reviewDigest =
    value.reviewDigest === null || value.reviewDigest === undefined
      ? null
      : boundedString(value.reviewDigest, "Review digest", 64);
  if (reviewDigest !== null && !digestPattern.test(reviewDigest)) {
    throw new Error("Review digest must be lowercase SHA-256 hex.");
  }
  if (value.confirmed && reviewDigest === null) {
    throw new Error("Payment confirmation requires the review digest.");
  }
  return {
    debtUuid: validateUuid(
      boundedString(value.debtUuid, "Debt UUID", 64),
      "debt",
    ).toLowerCase(),
    reviewDigest,
    acceptPayeeWarning: value.acceptPayeeWarning,
    confirmed: value.confirmed,
  };
}

function firstItemAmount(source: JsonRecord): unknown {
  if (!Array.isArray(source.items) || source.items.length !== 1)
    return undefined;
  const item = record(source.items[0], "Payment item");
  const price = record(item.detailed_price, "Payment item price");
  return price.gross;
}

function debtReference(source: JsonRecord): PaymentReference {
  const candidates: PaymentReference[] = [];
  for (const [field, kind] of [
    ["unstructured_reference", "message"],
    ["rf_reference", "rf"],
    ["fi_reference", "finnish"],
  ] as const) {
    if (typeof source[field] === "string" && source[field]) {
      candidates.push(paymentReference({ kind, value: source[field] }));
    }
  }
  if (candidates.length !== 1) {
    throw new Error("Holvi payment debt has an ambiguous reference.");
  }
  return candidates[0]!;
}

function projectDebt(value: unknown, expectedUuid: string): PaymentDebt {
  const source = record(value, "Payment debt");
  const debtUuid = validateUuid(
    boundedString(source.uuid, "Debt UUID", 64),
    "debt",
  ).toLowerCase();
  if (debtUuid !== expectedUuid.toLowerCase())
    throw new Error("Holvi payment debt UUID does not match.");
  const receiver = record(source.receiver, "Payment receiver");
  const type = boundedString(source.type, "Payment type");
  const subtype = boundedString(source.subtype, "Payment subtype");
  if (type !== "outboundpayment" || subtype !== "outbound") {
    throw new Error("Debt is not a supported outgoing SEPA payment.");
  }
  const statusValue =
    typeof source.status === "object"
      ? record(source.status, "Payment status").value
      : (source.status ?? source.state);
  const status = boundedString(statusValue, "Payment status", 64).toLowerCase();
  const currency = boundedString(source.currency, "Payment currency", 3);
  if (currency !== "EUR")
    throw new Error("Payment debt currency is unsupported.");
  return {
    debtUuid,
    paymentAccountUuid: validateUuid(
      boundedString(source.payment_account_uuid, "Payment account UUID", 64),
      "payment account",
    ).toLowerCase(),
    recipient: {
      name: boundedString(receiver.name, "Recipient name"),
      iban: normalizeIban(source.iban),
    },
    bic: source.bic
      ? boundedString(source.bic, "BIC", paymentBicMaxBytes).toUpperCase()
      : null,
    amount: normalizeAmount(
      source.total_amount_temp ??
        source.amount ??
        source.total ??
        firstItemAmount(source),
    ),
    currency: "EUR",
    reference: debtReference(source),
    dueDate: source.due_date
      ? boundedString(source.due_date, "Payment due date", 32)
      : null,
    instant: source.sctinst_requested === true,
    status,
    type: "outboundpayment",
    subtype: "outbound",
  };
}

function projectPayeeVerification(
  value: unknown,
): "match" | "close-match" | "no-match" | "not-applicable" {
  const result = record(value, "Payee verification").match_result;
  if (
    !["match", "close-match", "no-match", "not-applicable"].includes(
      String(result),
    )
  ) {
    throw new Error("Holvi payee verification result is unsupported.");
  }
  return result as "match" | "close-match" | "no-match" | "not-applicable";
}

function enforcePayee(result: string, accepted: boolean): void {
  if (result === "match") return;
  if (result === "no-match" || !accepted) {
    throw new Error(
      `Payee verification returned ${result}. Review the recipient and explicitly accept a supported warning.`,
    );
  }
}

function sameMaterial(left: PaymentDebt, right: PaymentDebt): boolean {
  const material = (debt: PaymentDebt) =>
    JSON.stringify({
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
      subtype: debt.subtype,
    });
  return material(left) === material(right);
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function equalDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export class PaymentWorkflow {
  constructor(
    private readonly session: BridgeSession,
    private readonly api: HolviApi,
    private readonly authProxy: AuthProxyClient,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async create(auth: Auth, raw: Record<string, unknown>): Promise<JsonRecord> {
    this.session.requireCapabilities("payments.write");
    const params = createParams(raw);
    const accounts = await this.api.accounts(auth);
    const matches = (accounts.results as JsonRecord[]).filter(
      (account) =>
        String(account.paymentAccountUuid).toLowerCase() ===
        params.paymentAccountUuid,
    );
    if (matches.length !== 1)
      throw new Error(
        "Payment account does not belong uniquely to the configured pool.",
      );
    const payeeVerification = projectPayeeVerification(
      await this.api.verifyPayee(auth, params.recipientName, params.iban),
    );
    const proposal = {
      dryRun: !params.confirmed,
      paymentAccountUuid: params.paymentAccountUuid,
      recipient: { name: params.recipientName, iban: params.iban },
      bic: params.bic,
      amount: params.amount,
      currency: params.currency,
      reference: params.reference,
      instant: false,
      payeeVerification: { result: payeeVerification },
    };
    if (!params.confirmed) {
      return {
        ...proposal,
        next:
          payeeVerification === "match"
            ? "Repeat with --yes after checking every value."
            : "Review the payee warning, then repeat the dry run with --accept-payee-warning before using --yes.",
      };
    }
    enforcePayee(payeeVerification, params.acceptPayeeWarning);
    const referenceField =
      params.reference.kind === "message"
        ? { unstructured_reference: params.reference.value }
        : params.reference.kind === "rf"
          ? { rf_reference: params.reference.value }
          : { fi_reference: params.reference.value };
    const payload = {
      attachments: [],
      receiver: {
        name: params.recipientName,
        contact: "",
        code: "",
        save_to_contacts: false,
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
            gross: params.amount,
          },
        },
      ],
      iban: params.iban,
      bic: params.bic ?? "",
      ...referenceField,
      total_amount_temp: params.amount,
      payment_account_uuid: params.paymentAccountUuid,
    };
    let created: unknown;
    try {
      created = await this.api.createPaymentDebt(auth, payload);
    } catch {
      throw new Error(
        "Payment draft creation failed or had an ambiguous outcome. Inspect Holvi before retrying.",
      );
    }
    const createdRecord = record(created, "Created payment debt");
    const debtUuid = validateUuid(
      boundedString(createdRecord.uuid, "Created debt UUID", 64),
      "debt",
    ).toLowerCase();
    let debt: PaymentDebt;
    try {
      debt = projectDebt(
        await this.api.readPaymentDebt(auth, debtUuid),
        debtUuid,
      );
    } catch {
      throw new Error(
        "Holvi accepted the payment draft, but its authoritative state could not be verified. Inspect Holvi before retrying.",
      );
    }
    if (
      debt.paymentAccountUuid !== params.paymentAccountUuid ||
      debt.recipient.name !== params.recipientName ||
      debt.recipient.iban !== params.iban ||
      (params.bic !== null && debt.bic !== params.bic) ||
      debt.amount !== params.amount ||
      debt.currency !== params.currency ||
      JSON.stringify(debt.reference) !== JSON.stringify(params.reference) ||
      debt.dueDate !== null ||
      debt.instant ||
      !confirmableStatuses.has(debt.status)
    ) {
      throw new Error(
        "Holvi created a payment draft whose authoritative fields differ from the request. Inspect Holvi before retrying.",
      );
    }
    return {
      ...proposal,
      dryRun: false,
      debtUuid,
      status: debt.status,
      verified: true,
    };
  }

  async send(auth: Auth, raw: Record<string, unknown>): Promise<JsonRecord> {
    this.session.requireCapabilities("payments.send");
    const params = sendParams(raw);
    const review = await this.review(auth, params);
    if (!params.confirmed) {
      return {
        dryRun: true,
        ...review.projection,
        reviewDigest: review.digest,
        next:
          review.payeeVerification === "match"
            ? "Repeat with --review-digest and --yes after checking every value."
            : "Review the payee warning, then repeat the dry run with --accept-payee-warning before using --review-digest and --yes.",
      };
    }
    if (
      !params.reviewDigest ||
      !equalDigest(params.reviewDigest, review.digest)
    ) {
      throw new Error(
        "Payment changed after review. Run the send dry run again.",
      );
    }
    enforcePayee(review.payeeVerification, params.acceptPayeeWarning);
    let confirmation: Awaited<
      ReturnType<AuthProxyClient["initiatePaymentConfirmation"]>
    >;
    try {
      confirmation = await this.authProxy.initiatePaymentConfirmation(
        auth,
        params.debtUuid,
      );
    } catch {
      const debt = await this.readDebtOrNull(auth, params.debtUuid);
      if (
        debt &&
        confirmedStatuses.has(debt.status) &&
        sameMaterial(review.debt, debt)
      ) {
        return this.confirmedResult(debt);
      }
      throw new Error(
        "Payment confirmation initiation failed or had an ambiguous outcome. Inspect Holvi before retrying.",
      );
    }
    if (!confirmation.hasMobileDevice) {
      await this.authProxy.cancel(confirmation).catch(() => undefined);
      throw new Error(
        "Payment confirmation requires a Holvi mobile-app device. Use Holvi's UI for another verification method.",
      );
    }
    const deadline = Math.min(
      this.clock() + 285_000,
      this.clock() + confirmation.expirationSeconds * 1000,
    );
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
      if (!approved) throw new Error("Payment confirmation timed out.");
    } catch (error) {
      if (!approved)
        await this.authProxy.cancel(confirmation).catch(() => undefined);
      const debt = await this.readDebtOrNull(auth, params.debtUuid);
      if (
        debt &&
        confirmedStatuses.has(debt.status) &&
        sameMaterial(review.debt, debt)
      ) {
        return this.confirmedResult(debt);
      }
      if (!debt) {
        throw new Error(
          `${error instanceof Error ? error.message : "Payment confirmation ended."} The resulting payment state is unknown. Inspect Holvi before retrying.`,
        );
      }
      throw error;
    }
    const finalDebt = await this.readDebtOrNull(auth, params.debtUuid);
    if (!finalDebt) {
      throw new Error(
        "Holvi approved 2FA, but the resulting payment state is unknown. Inspect Holvi before retrying.",
      );
    }
    if (
      !sameMaterial(review.debt, finalDebt) ||
      !confirmedStatuses.has(finalDebt.status)
    ) {
      throw new Error(
        "Holvi approved 2FA, but the resulting payment state could not be verified. Inspect Holvi before retrying.",
      );
    }
    return this.confirmedResult(finalDebt);
  }

  private async review(
    auth: Auth,
    params: SendParams,
  ): Promise<{
    debt: PaymentDebt;
    projection: JsonRecord;
    digest: string;
    payeeVerification: string;
  }> {
    const debt = projectDebt(
      await this.api.readPaymentDebt(auth, params.debtUuid),
      params.debtUuid,
    );
    if (!confirmableStatuses.has(debt.status) || debt.instant) {
      throw new Error(
        "Payment debt is not in a confirmable one-off SEPA state.",
      );
    }
    const accounts = await this.api.accounts(auth);
    const matches = (accounts.results as JsonRecord[]).filter(
      (account) =>
        String(account.paymentAccountUuid).toLowerCase() ===
        debt.paymentAccountUuid,
    );
    if (matches.length !== 1)
      throw new Error(
        "Payment account does not belong uniquely to the configured pool.",
      );
    const payeeVerification = projectPayeeVerification(
      await this.api.verifyPayee(
        auth,
        debt.recipient.name,
        debt.recipient.iban,
      ),
    );
    const projection = {
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
      acceptPayeeWarning: params.acceptPayeeWarning,
    };
    return {
      debt,
      projection,
      digest: await sha256(JSON.stringify(projection)),
      payeeVerification,
    };
  }

  private async readDebtOrNull(
    auth: Auth,
    debtUuid: string,
  ): Promise<PaymentDebt | null> {
    try {
      return projectDebt(
        await this.api.readPaymentDebt(auth, debtUuid),
        debtUuid,
      );
    } catch {
      return null;
    }
  }

  private confirmedResult(debt: PaymentDebt): JsonRecord {
    return {
      debtUuid: debt.debtUuid,
      confirmation: "approved",
      verified: true,
      status: debt.status,
      paymentAccountUuid: debt.paymentAccountUuid,
    };
  }
}

export const paymentTestHelpers = {
  normalizeIban,
  normalizeAmount,
  projectDebt,
};
