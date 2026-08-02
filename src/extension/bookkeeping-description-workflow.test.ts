import { describe, expect, test } from "bun:test";
import type { Auth, StaticBridgeConfig } from "./background-types.js";
import { BookkeepingDescriptionWorkflow } from "./bookkeeping-description-workflow.js";
import { CommandService } from "./commands.js";
import { HolviApi } from "./holvi-api.js";
import { BridgeSession } from "./session.js";

const staticConfig: StaticBridgeConfig = {
  accountOrigin: "https://account.app.holvi.com",
  apiOrigin: "https://holvi.com",
  groupPathPrefix: "/group/",
  nativeHostName: "app.holvi_agent_bridge",
  nativeProtocolVersion: 1,
  extensionVersion: "0.1.0",
  maxFileBytes: 25 * 1024 * 1024,
  maxTransactionPages: 200,
  maxTransactionResults: 10_000,
};

const debtUuid = "11111111-1111-4111-8111-111111111111";
const accountUuid = "22222222-2222-4222-8222-222222222222";
const targetUuid = "33333333-3333-4333-8333-333333333333";
const siblingUuid = "44444444-4444-4444-8444-444444444444";
const inactiveUuid = "55555555-5555-4555-8555-555555555555";
const auth: Auth = { token: "header.payload.signature", csrfToken: "csrf" };

function runtimeConfig(capabilities = ["bookkeeping.write"]) {
  return {
    groupPathSegment: "example+company",
    poolHandle: "example",
    paymentAccountUuid: accountUuid,
    capabilities,
    maxFileBytes: 1024,
  };
}

function lineItem(uuid: string, description: string) {
  return {
    uuid,
    type: "line_item",
    active: true,
    description,
    timestamp: "2026-08-02T10:00:00Z",
    category: "4000",
    cost_center_uuid: null,
    vat_calculation_rule: "gross",
    vat_status: "",
    quantity: "1",
    unit: "pcs",
    detailed_price: {
      currency: "EUR",
      gross: "24.80",
      net: "20.00",
      vat_rate: "24",
    },
    detailed_total_price: {
      currency: "EUR",
      gross: "24.80",
      net: "20.00",
    },
  };
}

function debt(description = "Original") {
  return {
    uuid: debtUuid,
    payment_account_uuid: accountUuid,
    code: "DEBT-1",
    booking_date: "2026-08-02",
    amount: "49.60",
    currency: "EUR",
    bookkeeping_status: "incomplete",
    type: "purchase",
    subtype: "card",
    connection_uuid: null,
    attachments: [{ code: "attachment-1" }],
    update_timestamp: "2026-08-02T10:00:00Z",
    items: [
      lineItem(targetUuid, description),
      { ...lineItem(siblingUuid, "Sibling"), custom_server_field: "keep" },
      { ...lineItem(inactiveUuid, "Inactive"), active: false },
      {
        uuid: "66666666-6666-4666-8666-666666666666",
        type: "summary",
        active: true,
        server_field: "not-in-editor",
      },
    ],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function setup(
  fetchRequest: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  capabilities?: string[],
) {
  const session = new BridgeSession(staticConfig);
  session.configure(runtimeConfig(capabilities));
  const api = new HolviApi(staticConfig, session, fetchRequest);
  return new BookkeepingDescriptionWorkflow(session, api);
}

function change(confirmed: boolean, description = "Replacement") {
  return { debtUuid, itemUuid: targetUuid, description, confirmed };
}

describe("bookkeeping description workflow", () => {
  test("dry run reads authoritative data and reports exact descriptions", async () => {
    const calls: RequestInit[] = [];
    const workflow = setup(async (_input, init = {}) => {
      calls.push(init);
      return jsonResponse(debt("  Original description  "));
    });

    await expect(
      workflow.change(auth, change(false, "  Proposed description  ")),
    ).resolves.toEqual({
      debtUuid,
      itemUuid: targetUuid,
      currentDescription: "  Original description  ",
      proposedDescription: "  Proposed description  ",
      dryRun: true,
      writePerformed: false,
      next: "Repeat the command with --yes after checking these descriptions.",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBeUndefined();
  });

  test("confirmation sends the exact frontend payload once and verifies it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      jsonResponse(debt()),
      jsonResponse({
        uuid: "99999999-9999-4999-8999-999999999999",
        items: [{ description: "untrusted write response" }],
      }),
      jsonResponse({
        ...debt("Replacement"),
        update_timestamp: "2026-08-02T10:01:00Z",
      }),
    ];
    const workflow = setup(async (input, init = {}) => {
      calls.push({ url: requestUrl(input), init });
      return responses.shift()!;
    });

    await expect(workflow.change(auth, change(true))).resolves.toEqual({
      debtUuid,
      itemUuid: targetUuid,
      currentDescription: "Original",
      proposedDescription: "Replacement",
      dryRun: false,
      writePerformed: true,
      verified: true,
    });

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual([
      `https://holvi.com/api/pool/example/debt/${debtUuid}/`,
      `https://holvi.com/api/pool/example/debt/${debtUuid}/`,
      `https://holvi.com/api/pool/example/debt/${debtUuid}/`,
    ]);
    const writes = calls.filter((call) => call.init.method === "PATCH");
    expect(writes).toHaveLength(1);
    const headers = writes[0]!.init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = writes[0]!.init.body;
    expect(typeof body).toBe("string");
    const payload = JSON.parse(body as string);
    const before = debt();
    expect(payload).toEqual({
      items: [
        { ...(before.items[0] as object), description: "Replacement" },
        before.items[1],
      ],
    });
  });

  test("allows Holvi to update the target item timestamp", async () => {
    const before = debt();
    const after = debt("Replacement");
    after.items[0] = {
      ...lineItem(targetUuid, "Replacement"),
      timestamp: "2026-08-02T10:01:00Z",
    };
    const responses = [
      jsonResponse(before),
      jsonResponse({}),
      jsonResponse(after),
    ];
    const workflow = setup(async () => responses.shift()!);

    await expect(workflow.change(auth, change(true))).resolves.toMatchObject({
      proposedDescription: "Replacement",
      writePerformed: true,
      verified: true,
    });
  });

  test("reports changed target field paths without their values", async () => {
    const target = {
      ...lineItem(targetUuid, "Replacement"),
      category: "changed-category-value",
      detailed_price: {
        ...lineItem(targetUuid, "Replacement").detailed_price,
        gross: "changed-price-value",
      },
      server_timestamp: "sensitive-server-value",
    };
    const responses = [
      jsonResponse(debt()),
      jsonResponse({}),
      jsonResponse({
        ...debt("Replacement"),
        items: [target, lineItem(siblingUuid, "Sibling")],
      }),
    ];
    const workflow = setup(async () => responses.shift()!);

    let message = "";
    try {
      await workflow.change(auth, change(true));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(
      'changed target item fields: ["category","detailed_price.gross","server_timestamp"]',
    );
    expect(message).not.toContain("changed-category-value");
    expect(message).not.toContain("changed-price-value");
    expect(message).not.toContain("sensitive-server-value");
  });

  test("requires bookkeeping.write independently of bookkeeping.read", async () => {
    let fetchCount = 0;
    const workflow = setup(async () => {
      fetchCount += 1;
      return jsonResponse(debt());
    }, ["bookkeeping.read"]);

    await expect(workflow.change(auth, change(false))).rejects.toThrow(
      "Action requires capabilities: bookkeeping.write.",
    );
    expect(fetchCount).toBe(0);
  });

  test("rejects account and item scope mismatches before writing", async () => {
    for (const fixture of [
      {
        ...debt(),
        payment_account_uuid: "99999999-9999-4999-8999-999999999999",
      },
      { ...debt(), items: [lineItem(siblingUuid, "Sibling")] },
      {
        ...debt(),
        items: [lineItem(targetUuid, "One"), lineItem(targetUuid, "Two")],
      },
    ]) {
      const methods: Array<string | undefined> = [];
      const workflow = setup(async (_input, init = {}) => {
        methods.push(init.method);
        return jsonResponse(fixture);
      });

      await expect(workflow.change(auth, change(true))).rejects.toThrow();
      expect(methods).toEqual([undefined]);
    }
  });

  test("does not retry a failed or ambiguous write", async () => {
    const methods: Array<string | undefined> = [];
    const workflow = setup(async (_input, init = {}) => {
      methods.push(init.method);
      return init.method === "PATCH"
        ? jsonResponse({ detail: "failure" }, 500)
        : jsonResponse(debt());
    });

    await expect(workflow.change(auth, change(true))).rejects.toThrow(
      "Inspect the debt before retrying",
    );
    expect(methods).toEqual([undefined, "PATCH"]);
  });

  test("fails verification for description, sibling identity, and sibling field changes", async () => {
    const changedFixtures = [
      debt("Wrong description"),
      {
        ...debt("Replacement"),
        items: [
          lineItem(targetUuid, "Replacement"),
          lineItem("77777777-7777-4777-8777-777777777777", "Sibling"),
        ],
      },
      {
        ...debt("Replacement"),
        items: [
          lineItem(targetUuid, "Replacement"),
          { ...lineItem(siblingUuid, "Sibling"), category: "changed" },
        ],
      },
    ];

    for (const after of changedFixtures) {
      const responses = [
        jsonResponse(debt()),
        jsonResponse({}),
        jsonResponse(after),
      ];
      const methods: Array<string | undefined> = [];
      const workflow = setup(async (_input, init = {}) => {
        methods.push(init.method);
        return responses.shift()!;
      });

      await expect(workflow.change(auth, change(true))).rejects.toThrow(
        "post-write verification failed",
      );
      expect(methods).toEqual([undefined, "PATCH", undefined]);
    }
  });

  test("rejects malformed authoritative and verification responses", async () => {
    const malformed = [
      null,
      { ...debt(), items: "invalid" },
      { ...debt(), items: [{ uuid: targetUuid, type: "line_item" }] },
      { ...debt(), uuid: siblingUuid },
    ];
    for (const fixture of malformed) {
      let fetchCount = 0;
      const workflow = setup(async () => {
        fetchCount += 1;
        return jsonResponse(fixture);
      });
      await expect(workflow.change(auth, change(true))).rejects.toThrow();
      expect(fetchCount).toBe(1);
    }

    const responses = [
      jsonResponse(debt()),
      jsonResponse({}),
      jsonResponse(null),
    ];
    const workflow = setup(async () => responses.shift()!);
    await expect(workflow.change(auth, change(true))).rejects.toThrow();
  });
});

describe("bookkeeping description command handling", () => {
  test("rejects malformed parameters without converting them into a write", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig());
    let fetchCount = 0;
    const api = new HolviApi(staticConfig, session, async () => {
      fetchCount += 1;
      return jsonResponse(debt());
    });
    const commands = new CommandService(session, api, async () => auth);

    await expect(
      commands.handle({
        action: "bookkeeping.set-description",
        params: {
          debtUuid,
          itemUuid: targetUuid,
          description: 123,
          confirmed: true,
        },
      }),
    ).rejects.toThrow("invalid description data");
    await expect(
      commands.handle({
        action: "bookkeeping.set-description",
        params: {
          debtUuid,
          itemUuid: targetUuid,
          description: "Replacement",
          confirmed: "yes",
        },
      }),
    ).rejects.toThrow("invalid confirmation data");
    expect(fetchCount).toBe(0);
  });
});
