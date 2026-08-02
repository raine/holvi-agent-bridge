import { describe, expect, test } from "bun:test";
import type { Auth, StaticBridgeConfig } from "./background-types.js";
import {
  HolviApi,
  maxApiResponseBytes,
  maxCommentResponseBytes,
} from "./holvi-api.js";
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
const debtUuid = "11111111-1111-4111-8111-111111111111";

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

function debt(accountUuid = runtimeConfig.paymentAccountUuid) {
  return {
    uuid: debtUuid,
    payment_account_uuid: accountUuid,
    attachments: [],
  };
}

function comment(uuid: string) {
  return {
    uuid,
    content: "Internal note",
    creator: { name: "Example User" },
    create_time: "2026-08-02T12:00:00Z",
    push_notified: false,
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

  test("invokes fetch without an object receiver", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const fetchRequest = async function (
      this: unknown,
      _input: string | URL | Request,
      _init?: RequestInit,
    ) {
      expect(this).toBeUndefined();
      return jsonResponse({ ok: true });
    };
    const api = new HolviApi(staticConfig, session, fetchRequest);

    await api.request(auth, `${session.apiRoot()}category/`);
  });

  test("reads purpose-built transaction details within the configured account", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const cardProfileUuid = "55555555-5555-4555-8555-555555555555";
    const paymentUuid = "33333333-3333-4333-8333-333333333333";
    const urls: string[] = [];
    let feedPages = 0;
    const api = new HolviApi(staticConfig, session, async (input) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.endsWith(`/debt/${debtUuid}/`)) {
        return jsonResponse({
          ...debt(),
          currency: "EUR",
          links: { card_profile: cardProfileUuid },
          creator: { displayname: "Example Cardholder" },
          currency_conversion: {
            counterparty_amount: "27.20",
            counterparty_currency: "USD",
            rate: "1.09677",
          },
          receiver: {
            merchant_info: {
              category: "Office Supplies",
              payment_type: "POS",
              address: { city: "Helsinki", country: "FI" },
            },
          },
        });
      }
      if (url.includes("/ux/payments-feed/")) {
        feedPages += 1;
        return jsonResponse(
          feedPages === 1
            ? {
                results: [
                  {
                    ...payment(paymentUuid, "2026-08-02T10:15:00Z"),
                    matches: [{ match_type: "direct", uuid: debtUuid }],
                  },
                ],
                pagination: { has_more: true, next_cursor: "cursor-2" },
              }
            : { results: [], pagination: { has_more: false } },
        );
      }
      if (url.endsWith(`/cardprofile/${cardProfileUuid}/`)) {
        return jsonResponse({
          uuid: cardProfileUuid,
          payment_account_uuid: runtimeConfig.paymentAccountUuid,
          name: "Team card",
          masked_pan: "**** **** **** 1533",
        });
      }
      if (url.endsWith("/api/pool/example/")) {
        return jsonResponse({
          paymentaccounts: [
            {
              uuid: runtimeConfig.paymentAccountUuid,
              name: "Main account",
              iban: "FI0012345600000785",
              currency: "EUR",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    await expect(api.transactionDetails(auth, debtUuid)).resolves.toMatchObject(
      {
        paymentUuid,
        debtUuid,
        card: {
          cardProfileUuid,
          lastFour: "1533",
        },
        account: {
          paymentAccountUuid: runtimeConfig.paymentAccountUuid,
          name: "Main account",
          iban: "FI00 •••• 0785",
          currency: "EUR",
        },
        cardholder: "Example Cardholder",
        exchangeRate: {
          baseCurrency: "EUR",
          counterpartyCurrency: "USD",
          counterpartyAmount: "27.20",
          rate: "1.09677",
        },
        merchantAddress: {
          street: null,
          postcode: null,
          city: "Helsinki",
          country: "FI",
        },
        merchantCategory: "Office Supplies",
        paymentType: "POS",
      },
    );
    expect(urls).toEqual(
      expect.arrayContaining([
        `https://holvi.com/api/pool/example/debt/${debtUuid}/`,
        `https://holvi.com/api/pool/example/cardprofile/${cardProfileUuid}/`,
        "https://holvi.com/api/pool/example/",
      ]),
    );
    const feedUrls = urls.filter((url) => url.includes("payments-feed"));
    expect(feedUrls).toHaveLength(2);
    expect(feedUrls[0]).toContain(
      `payment_account=${runtimeConfig.paymentAccountUuid}`,
    );
    expect(feedUrls[1]).toContain("cursor=cursor-2");
  });

  test("rejects matching payments split across feed pages", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    let feedPage = 0;
    const api = new HolviApi(staticConfig, session, async (input) => {
      const url = requestUrl(input);
      if (url.endsWith(`/debt/${debtUuid}/`)) {
        return jsonResponse(debt());
      }
      if (url.endsWith("/api/pool/example/")) {
        return jsonResponse({
          paymentaccounts: [
            {
              uuid: runtimeConfig.paymentAccountUuid,
              name: "Main account",
              iban: "FI0012345600000785",
              currency: "EUR",
            },
          ],
        });
      }
      if (url.includes("/ux/payments-feed/")) {
        feedPage += 1;
        return jsonResponse({
          results: [
            {
              ...payment(
                feedPage === 1
                  ? "33333333-3333-4333-8333-333333333333"
                  : "44444444-4444-4444-8444-444444444444",
                "2026-08-02T10:15:00Z",
              ),
              matches: [{ match_type: "direct", uuid: debtUuid }],
            },
          ],
          pagination:
            feedPage === 1
              ? { has_more: true, next_cursor: "cursor-2" }
              : { has_more: false },
        });
      }
      return jsonResponse({}, 404);
    });

    await expect(api.transactionDetails(auth, debtUuid)).rejects.toThrow(
      "ambiguous payment match",
    );
    expect(feedPage).toBe(2);
  });

  test("rejects transaction preview from another payment account", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const fetchRequest = async () =>
      jsonResponse({
        uuid: debtUuid,
        payment_account_uuid: "99999999-9999-4999-8999-999999999999",
        attachments: [],
      });
    const api = new HolviApi(staticConfig, session, fetchRequest);

    await expect(api.previewDebt(auth, debtUuid)).rejects.toThrow(
      "payment account does not match the configured payment account",
    );
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

  test("lists bounded comment pages without accepting a changed target", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const urls: string[] = [];
    const responses = [
      debt(),
      {
        results: [comment("33333333-3333-4333-8333-333333333333")],
        next: `https://holvi.com/api/pool/example/debt/${debtUuid}/comment/?page=2`,
      },
      {
        results: [comment("44444444-4444-4444-8444-444444444444")],
        next: null,
      },
    ];
    const api = new HolviApi(staticConfig, session, async (input) => {
      urls.push(requestUrl(input));
      return jsonResponse(responses.shift());
    });

    await expect(api.listComments(auth, debtUuid)).resolves.toMatchObject({
      debtUuid,
      pages: 2,
      count: 2,
      order: "newest-first",
    });
    expect(urls[1]).toContain(
      `/debt/${debtUuid}/comment/?o=-create_time&page_size=25`,
    );
    expect(urls[2]).toContain(`/debt/${debtUuid}/comment/?page=2`);

    const changedTarget = new HolviApi(staticConfig, session, async (input) => {
      return requestUrl(input).endsWith(`/debt/${debtUuid}/`)
        ? jsonResponse(debt())
        : jsonResponse({
            results: [],
            next: "https://holvi.com/api/pool/example/category/?page=2",
          });
    });
    await expect(changedTarget.listComments(auth, debtUuid)).rejects.toThrow(
      "changed the target endpoint",
    );
  });

  test("rejects malformed comments, account mismatch, and page overflow", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const malformed = new HolviApi(staticConfig, session, async (input) => {
      return requestUrl(input).endsWith(`/debt/${debtUuid}/`)
        ? jsonResponse(debt())
        : jsonResponse({
            results: [
              {
                ...comment("33333333-3333-4333-8333-333333333333"),
                creator: { uuid: "not-a-uuid" },
              },
            ],
            next: null,
          });
    });
    await expect(malformed.listComments(auth, debtUuid)).rejects.toThrow(
      "Comment creator UUID must be a UUID",
    );

    const methods: string[] = [];
    const wrongAccount = new HolviApi(
      staticConfig,
      session,
      async (_input, init) => {
        methods.push(init?.method || "GET");
        return jsonResponse(debt("99999999-9999-4999-8999-999999999999"));
      },
    );
    await expect(wrongAccount.listComments(auth, debtUuid)).rejects.toThrow(
      "payment account does not match",
    );
    expect(methods).toEqual(["GET"]);

    let requests = 0;
    const overflowing = new HolviApi(staticConfig, session, async () => {
      requests += 1;
      if (requests === 1) return jsonResponse(debt());
      return jsonResponse({
        results: [],
        next: `https://holvi.com/api/pool/example/debt/${debtUuid}/comment/?page=${requests}`,
      });
    });
    await expect(overflowing.listComments(auth, debtUuid)).rejects.toThrow(
      "exceeded its page limit",
    );
    expect(requests).toBe(41);
  });

  test("bounds API response bytes before projection", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const api = new HolviApi(staticConfig, session, async () =>
      jsonResponse({ data: "x".repeat(1024 * 1024) }),
    );
    await expect(
      api.request(
        auth,
        `${session.apiRoot()}category/`,
        {},
        maxCommentResponseBytes,
      ),
    ).rejects.toThrow("response exceeded its size limit");
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

  test("bounds and validates API response bodies", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const path = `${session.apiRoot()}category/`;

    const declaredOversize = new HolviApi(staticConfig, session, async () =>
      jsonResponse([], 200, {
        "content-length": String(maxApiResponseBytes + 1),
      }),
    );
    await expect(declaredOversize.request(auth, path)).rejects.toThrow(
      "response exceeded its size limit",
    );

    const streamedOversize = new HolviApi(
      staticConfig,
      session,
      async () =>
        new Response("x".repeat(maxApiResponseBytes + 1), {
          headers: { "content-type": "text/plain" },
        }),
    );
    await expect(streamedOversize.request(auth, path)).rejects.toThrow(
      "response exceeded its size limit",
    );

    const malformed = new HolviApi(
      staticConfig,
      session,
      async () =>
        new Response("{", {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(malformed.request(auth, path)).rejects.toThrow(
      "malformed JSON",
    );
  });
});
