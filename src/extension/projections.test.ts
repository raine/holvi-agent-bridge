import { describe, expect, test } from "bun:test";
import policyFixture from "../../capability-policy.json";
import {
  actionCapabilities,
  commandActions,
  requiredCapabilities,
  supportedCapabilities,
} from "./policy.js";
import {
  projectAuditPage,
  projectBookkeepingDebt,
  projectCategories,
  projectDebtPreview,
  projectSuggestions,
  projectTransactionFeedPage,
  projectUploadDebtRead,
} from "./projections.js";

const debtUuid = "11111111-1111-4111-8111-111111111111";
const itemUuid = "22222222-2222-4222-8222-222222222222";

function debt() {
  return {
    uuid: debtUuid,
    code: "DEBT-1",
    booking_date: "2026-08-01",
    counterparty_name: "Example merchant",
    amount: "24.80",
    currency: "EUR",
    bookkeeping_status: "complete",
    export_status: "pending",
    type: "purchase",
    subtype: "card_purchase",
    payment_account_uuid: "33333333-3333-4333-8333-333333333333",
    connection_uuid: null,
    attachments: [{}],
    items: [
      {
        uuid: itemUuid,
        type: "line_item",
        active: true,
        description: "Office supplies",
        category: "office",
        cost_center_uuid: null,
        vat_calculation_rule: "gross",
        vat_status: "included",
        quantity: "2",
        unit: "piece",
        detailed_price: {
          currency: "EUR",
          gross: "12.40",
          net: "10.00",
          vat_rate: "24",
        },
        detailed_total_price: {
          currency: "EUR",
          gross: "24.80",
          net: "20.00",
        },
      },
      { uuid: "ignored", type: "metadata", active: true },
    ],
  };
}

function payment() {
  return {
    uuid: "44444444-4444-4444-8444-444444444444",
    ux_timestamp: "2026-08-02T10:15:00Z",
    description: "Card purchase",
    counterparty: { display_name: "Example merchant" },
    direction: "out",
    amount: "24.80",
    currency: "EUR",
    state: "settled",
    fx_meta: null,
    attachment_count: 1,
    matches: [{ match_type: "direct", uuid: debtUuid }],
  };
}

describe("capability policy", () => {
  test("matches the cross-language policy fixture", () => {
    expect(JSON.stringify(actionCapabilities)).toBe(
      JSON.stringify(policyFixture),
    );
  });

  test("keeps ordinary command handlers exhaustive with policy", () => {
    expect(Object.keys(commandActions)).toEqual(
      Object.keys(actionCapabilities).filter((action) => action !== "upload"),
    );
  });

  test("rejects unknown actions and keeps capability areas separate", () => {
    expect(requiredCapabilities("fetch")).toBeNull();
    expect(requiredCapabilities("bookkeeping.get")).toEqual([
      "bookkeeping.read",
    ]);
    expect(requiredCapabilities("audit.list")).toEqual(["audit.read"]);
    expect(supportedCapabilities).toEqual(
      new Set([
        "transactions.read",
        "attachments.write",
        "bookkeeping.read",
        "audit.read",
      ]),
    );
  });
});

describe("transaction projections", () => {
  test("projects the evidenced feed envelope and scalar fields", () => {
    expect(
      projectTransactionFeedPage({
        results: [payment()],
        pagination: { has_more: true, next_cursor: "cursor-2" },
      }),
    ).toEqual({
      results: [
        {
          paymentUuid: "44444444-4444-4444-8444-444444444444",
          debtUuid,
          date: "2026-08-02",
          timestamp: "2026-08-02T10:15:00Z",
          counterparty: "Example merchant",
          description: "Card purchase",
          direction: "out",
          amount: "24.80",
          currency: "EUR",
          originalAmount: null,
          originalCurrency: null,
          state: "settled",
          attachmentCount: 1,
        },
      ],
      hasMore: true,
      nextCursor: "cursor-2",
    });
  });

  test("rejects malformed money, timestamps, counts, and pagination", () => {
    const malformed = payment();
    malformed.amount = "twenty";
    expect(() =>
      projectTransactionFeedPage({
        results: [malformed],
        pagination: { has_more: false },
      }),
    ).toThrow("invalid decimal value");

    malformed.amount = "24.80";
    malformed.ux_timestamp = "yesterdayish";
    expect(() =>
      projectTransactionFeedPage({
        results: [malformed],
        pagination: { has_more: false },
      }),
    ).toThrow("timestamp is invalid");

    malformed.ux_timestamp = "2026-08-02T10:15:00Z";
    malformed.attachment_count = -1;
    expect(() =>
      projectTransactionFeedPage({
        results: [malformed],
        pagination: { has_more: false },
      }),
    ).toThrow("nonnegative integer");

    expect(() =>
      projectTransactionFeedPage({
        results: [],
        pagination: { has_more: true },
      }),
    ).toThrow("omitted its next cursor");
  });

  test("bounds collections and serialized output", () => {
    const large = Array.from({ length: 130 }, (_, index) => ({
      ...payment(),
      uuid: `${index.toString(16).padStart(8, "0")}-4444-4444-8444-444444444444`,
      description: "x".repeat(4096),
    }));
    expect(() =>
      projectTransactionFeedPage({
        results: large,
        pagination: { has_more: false },
      }),
    ).toThrow("output limit");

    expect(() =>
      projectTransactionFeedPage({
        results: Array.from({ length: 10_001 }),
        pagination: { has_more: false },
      }),
    ).toThrow("result limit");
  });
});

describe("debt read projections", () => {
  test("preserves preview fields and validates upload reads", () => {
    const value = debt();
    expect(projectDebtPreview(value, debtUuid)).toEqual({
      debtUuid,
      code: "DEBT-1",
      counterparty: "Example merchant",
      amount: "24.80",
      currency: "EUR",
      attachmentCount: 1,
      bookkeepingStatus: "complete",
    });
    expect(projectUploadDebtRead(value, debtUuid)).toMatchObject({
      debtUuid,
      code: "DEBT-1",
      attachmentCount: 1,
    });
  });

  test("rejects malformed shapes and debt identity mismatches", () => {
    expect(() =>
      projectDebtPreview({ ...debt(), attachments: "one" }, debtUuid),
    ).toThrow("unexpected shape");

    const otherUuid = "99999999-9999-4999-8999-999999999999";
    expect(() =>
      projectDebtPreview({ ...debt(), uuid: otherUuid }, debtUuid),
    ).toThrow("does not match the request");
    expect(() =>
      projectUploadDebtRead({ ...debt(), uuid: otherUuid }, debtUuid),
    ).toThrow("does not match the request");
  });
});

describe("bookkeeping projections", () => {
  test("separates unit prices from line totals", () => {
    const result = projectBookkeepingDebt(debt(), debtUuid);
    expect(result).toMatchObject({
      debtUuid,
      code: "DEBT-1",
      attachmentCount: 1,
      droppedItemCount: 1,
      items: [
        {
          itemUuid,
          quantity: "2",
          unitPrice: { gross: "12.40", net: "10.00", vatRate: "24" },
          lineTotal: { gross: "24.80", net: "20.00" },
        },
      ],
    });
  });

  test("accepts omitted empty collections and verifies debt identity", () => {
    const value = debt();
    value.items = [];
    delete (value as { attachments?: unknown }).attachments;
    expect(projectBookkeepingDebt(value, debtUuid)).toMatchObject({
      attachmentCount: 0,
      items: [],
    });

    value.uuid = "99999999-9999-4999-8999-999999999999";
    expect(() => projectBookkeepingDebt(value, debtUuid)).toThrow(
      "does not match the request",
    );
  });

  test("rejects malformed money instead of coercing it", () => {
    const value = debt();
    value.items[0]!.detailed_price!.gross = "twelve";
    expect(() => projectBookkeepingDebt(value, debtUuid)).toThrow(
      "invalid decimal value",
    );
  });

  test("projects only evidenced category fields", () => {
    expect(
      projectCategories([
        {
          code: "office",
          handle: "office_supplies",
          label: "Office supplies",
          private_field: "hidden",
        },
      ]),
    ).toEqual([
      {
        code: "office",
        handle: "office_supplies",
        label: "Office supplies",
      },
    ]);
  });

  test("normalizes both evidenced suggestion forms", () => {
    expect(
      projectSuggestions(
        { categories: ["office", { code: "software", score: 0.9 }] },
        debtUuid,
      ),
    ).toEqual({ debtUuid, categoryCodes: ["office", "software"] });
  });
});

describe("audit projection", () => {
  test("returns a bounded newest-first scalar page", () => {
    const result = projectAuditPage(
      {
        next: "https://holvi.com/api/pool/example/log-feed/?page=2",
        results: [
          {
            code: "LOG-2",
            timestamp: "2026-08-02T12:00:00Z",
            category: "invoice",
            creator: null,
            action: "updated",
            title: "Invoice updated",
            content: { private: true },
            data: { status: "sent", private: "hidden" },
          },
          {
            code: "LOG-1",
            timestamp: "2026-08-01T12:00:00Z",
            creator: { firstname: "Ada", lastname: "Lovelace" },
          },
        ],
      },
      1,
    );
    expect(result).toEqual({
      returnedCount: 1,
      hasMore: true,
      order: "newest-first",
      results: [
        {
          code: "LOG-2",
          timestamp: "2026-08-02T12:00:00Z",
          category: "invoice",
          creator: { name: "Holvi", isHolvi: true },
          action: "updated",
          title: "Invoice updated",
          content: null,
          status: "sent",
        },
      ],
    });
  });

  test("rejects activity pages whose labeled order is false", () => {
    expect(() =>
      projectAuditPage(
        {
          next: null,
          results: [
            { code: "old", timestamp: "2026-08-01T12:00:00Z" },
            { code: "new", timestamp: "2026-08-02T12:00:00Z" },
          ],
        },
        2,
      ),
    ).toThrow("not ordered newest first");
  });
});
