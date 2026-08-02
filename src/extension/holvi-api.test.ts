import { describe, expect, test } from "bun:test";
import type { Auth, StaticBridgeConfig } from "./background-types.js";
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

const runtimeConfig = {
  groupPathSegment: "example+11111111-1111-4111-8111-111111111111",
  poolHandle: "example",
  paymentAccountUuid: "22222222-2222-4222-8222-222222222222",
  capabilities: ["transactions.read", "attachments.write"],
  maxFileBytes: 1024,
};

const auth: Auth = {
  token: "header.payload.signature",
  csrfToken: "csrf-token",
};

function payment(uuid: string, timestamp: string) {
  return {
    uuid,
    ux_timestamp: timestamp,
    description: "Card purchase",
    counterparty: { display_name: "Example merchant" },
    direction: "out",
    amount: "24.80",
    currency: "EUR",
    state: "settled",
    fx_meta: null,
    attachment_count: 0,
    matches: [],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe("Holvi API boundary", () => {
  test("contains requests within the configured pool and supplies auth", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchRequest = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ input: requestUrl(input), init });
      return jsonResponse({ ok: true });
    };
    const api = new HolviApi(staticConfig, session, fetchRequest);

    await expect(
      api.request(auth, "/api/pool/another/category/"),
    ).rejects.toThrow("outside the configured Holvi account");
    expect(requests).toHaveLength(0);

    await api.request(auth, `${session.apiRoot()}category/`);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.input).toBe(
      "https://holvi.com/api/pool/example/category/",
    );
    const headers = requests[0]!.init?.headers as Headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${auth.token}`);
    expect(headers.get("X-CSRFToken")).toBe(auth.csrfToken);
    expect(requests[0]!.init).toMatchObject({
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
  });

  test("paginates with scoped account parameters and filters dates", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const urls: string[] = [];
    const pages = [
      {
        results: [
          payment(
            "33333333-3333-4333-8333-333333333333",
            "2026-07-31T12:00:00Z",
          ),
          payment(
            "44444444-4444-4444-8444-444444444444",
            "2026-08-01T12:00:00Z",
          ),
        ],
        pagination: { has_more: true, next_cursor: "cursor-2" },
      },
      {
        results: [
          payment(
            "55555555-5555-4555-8555-555555555555",
            "2026-08-02T12:00:00Z",
          ),
        ],
        pagination: { has_more: false },
      },
    ];
    const fetchRequest = async (input: string | URL | Request) => {
      urls.push(requestUrl(input));
      return jsonResponse(pages.shift());
    };
    const api = new HolviApi(staticConfig, session, fetchRequest);

    const result = await api.listTransactions(auth, {
      from: "2026-08-01",
      to: "2026-08-01",
      missingAttachments: true,
    });

    expect(result).toMatchObject({ pages: 2, count: 1 });
    expect(result.results).toEqual([
      expect.objectContaining({
        paymentUuid: "44444444-4444-4444-8444-444444444444",
        date: "2026-08-01",
      }),
    ]);
    expect(urls[0]).toContain(
      `payment_account=${runtimeConfig.paymentAccountUuid}`,
    );
    expect(urls[0]).toContain("missing_attachments=true");
    expect(urls[1]).toContain("cursor=cursor-2");
  });

  test("rejects repeated pagination cursors", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const fetchRequest = async () =>
      jsonResponse({
        results: [],
        pagination: { has_more: true, next_cursor: "same-cursor" },
      });
    const api = new HolviApi(staticConfig, session, fetchRequest);

    await expect(api.listTransactions(auth, {})).rejects.toThrow(
      "repeated a pagination cursor",
    );
  });
});
