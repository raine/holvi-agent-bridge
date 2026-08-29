import { describe, expect, test } from "bun:test";
import { AuthProxyClient } from "./auth-proxy.js";
import type { StaticBridgeConfig } from "./background-types.js";
import { HolviApi } from "./holvi-api.js";
import { PaymentWorkflow, paymentTestHelpers } from "./payment-workflow.js";
import { BridgeSession } from "./session.js";

const staticConfig: StaticBridgeConfig = {
  accountOrigin: "https://account.app.holvi.com",
  apiOrigin: "https://holvi.com",
  groupPathPrefix: "/group/",
  nativeHostName: "app.holvi_agent_bridge",
  nativeProtocolVersion: 2,
  extensionVersion: "0.1.4",
  maxFileBytes: 25 * 1024 * 1024,
  maxTransactionPages: 200,
  maxTransactionResults: 10_000,
};
const accountUuid = "11111111-1111-4111-8111-111111111111";
const debtUuid = "22222222-2222-4222-8222-222222222222";
const iban = "FI2112345600000785";
const auth = { token: "session-token", csrfToken: "csrf" };

function session(capabilities: string[]): BridgeSession {
  const result = new BridgeSession(staticConfig);
  result.configure({
    groupPathSegment: "example+company",
    poolHandle: "example",
    paymentAccountUuid: accountUuid,
    capabilities,
    maxFileBytes: 1024,
  });
  return result;
}

function accountResponse() {
  return {
    paymentaccounts: [
      {
        uuid: accountUuid,
        name: "Main",
        iban,
        currency: "EUR",
        balance: "1000.00",
      },
    ],
  };
}

function debt(status = "unverified") {
  return {
    uuid: debtUuid,
    payment_account_uuid: accountUuid,
    receiver: { name: "Example Recipient" },
    iban,
    bic: "DABAFIHH",
    total_amount_temp: "123.45",
    currency: "EUR",
    unstructured_reference: "Invoice 123",
    type: "outboundpayment",
    subtype: "outbound",
    status,
    due_date: null,
    sctinst_requested: false,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function url(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

const create = {
  paymentAccountUuid: accountUuid,
  recipientName: "Example Recipient",
  iban,
  bic: null,
  amount: "123.45",
  currency: "EUR",
  reference: { kind: "message", value: "Invoice 123" },
  acceptPayeeWarning: false,
};

function apiFor(
  bridgeSession: BridgeSession,
  responder: (
    requestUrl: string,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): HolviApi {
  return new HolviApi(staticConfig, bridgeSession, async (input, init) =>
    responder(url(input), init),
  );
}

describe("payment workflow", () => {
  test("normalizes exact monetary and IBAN values", () => {
    expect(paymentTestHelpers.normalizeAmount("00123.40")).toBe("123.4");
    expect(paymentTestHelpers.normalizeAmount(27.16)).toBe("27.16");
    expect(paymentTestHelpers.normalizeIban("fi21 1234 5600 0007 85")).toBe(
      iban,
    );
    expect(() => paymentTestHelpers.normalizeAmount("0.00")).toThrow(
      "positive",
    );
    expect(() =>
      paymentTestHelpers.normalizeIban("FI2112345600000786"),
    ).toThrow("checksum");
  });

  test("previews creation without a debt mutation", async () => {
    const bridgeSession = session(["payments.write"]);
    const requests: Array<{ url: string; method: string }> = [];
    const api = apiFor(bridgeSession, (requestUrl, init) => {
      requests.push({ url: requestUrl, method: init?.method || "GET" });
      return json(
        requestUrl.includes("/api/vop/")
          ? { match_result: "match" }
          : accountResponse(),
      );
    });
    const workflow = new PaymentWorkflow(
      bridgeSession,
      api,
      new AuthProxyClient(),
    );

    await expect(
      workflow.create(auth, { ...create, confirmed: false }),
    ).resolves.toMatchObject({
      dryRun: true,
      amount: "123.45",
      recipient: { name: "Example Recipient", iban },
      payeeVerification: { result: "match" },
    });
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(
      requests.some((request) => request.url.endsWith("/debt/")),
    ).toBeFalse();
  });

  test("surfaces payee warnings in dry runs and requires explicit acceptance", async () => {
    const bridgeSession = session(["payments.write"]);
    const methods: string[] = [];
    const api = apiFor(bridgeSession, (requestUrl, init) => {
      methods.push(init?.method || "GET");
      return json(
        requestUrl.includes("/api/vop/")
          ? { match_result: "close-match" }
          : accountResponse(),
      );
    });
    const workflow = new PaymentWorkflow(
      bridgeSession,
      api,
      new AuthProxyClient(),
    );

    await expect(
      workflow.create(auth, { ...create, confirmed: false }),
    ).resolves.toMatchObject({
      dryRun: true,
      payeeVerification: { result: "close-match" },
    });
    await expect(
      workflow.create(auth, { ...create, confirmed: true }),
    ).rejects.toThrow("explicitly accept");
    expect(methods.filter((method) => method === "POST")).toEqual([
      "POST",
      "POST",
    ]);
  });

  test("creates one fixed draft and verifies its authoritative fields", async () => {
    const bridgeSession = session(["payments.write"]);
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const api = apiFor(bridgeSession, (requestUrl, init) => {
      const method = init?.method || "GET";
      requests.push({
        url: requestUrl,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (requestUrl.includes("/api/vop/"))
        return json({ match_result: "match" });
      if (method === "POST") return json({ uuid: debtUuid });
      if (requestUrl.endsWith(`/debt/${debtUuid}/`)) return json(debt());
      return json(accountResponse());
    });
    const workflow = new PaymentWorkflow(
      bridgeSession,
      api,
      new AuthProxyClient(),
    );

    await expect(
      workflow.create(auth, { ...create, confirmed: true }),
    ).resolves.toMatchObject({
      dryRun: false,
      debtUuid,
      verified: true,
      status: "unverified",
    });
    const debtPosts = requests.filter(
      (request) => request.method === "POST" && request.url.endsWith("/debt/"),
    );
    expect(debtPosts).toHaveLength(1);
    expect(debtPosts[0]?.body).toEqual({
      attachments: [],
      receiver: {
        name: "Example Recipient",
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
          detailed_price: { currency: "EUR", net: "123.45", gross: "123.45" },
        },
      ],
      iban,
      bic: "",
      unstructured_reference: "Invoice 123",
      total_amount_temp: "123.45",
      payment_account_uuid: accountUuid,
    });
  });

  test("binds sending to the review digest and mobile approval", async () => {
    const bridgeSession = session(["payments.send"]);
    let final = false;
    const api = apiFor(bridgeSession, (requestUrl) => {
      if (requestUrl.includes("/api/vop/"))
        return json({ match_result: "match" });
      if (requestUrl.endsWith(`/debt/${debtUuid}/`))
        return json(
          final
            ? {
                ...debt("paid"),
                total_amount_temp: null,
                amount: 123.45,
              }
            : debt(),
        );
      return json(accountResponse());
    });
    const authRequests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const authProxy = new AuthProxyClient(
      "https://holvi.com",
      async (input, init) => {
        authRequests.push({
          url: url(input),
          method: init?.method || "GET",
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        if ((init?.method || "GET") === "POST") {
          return json({
            token_type: "Bearer",
            id_token: "transient-token",
            expires_in: 300,
            token_meta: {
              twofactor_token_id: "token_123",
              totp_devices: [
                { id: "device-secret", device_type: "user_device" },
              ],
            },
          });
        }
        final = true;
        return json({ state: "activated", expiration_delta: 250 });
      },
    );
    const workflow = new PaymentWorkflow(
      bridgeSession,
      api,
      authProxy,
      () => 1000,
      async () => undefined,
    );
    const preview = await workflow.send(auth, {
      debtUuid,
      reviewDigest: null,
      acceptPayeeWarning: false,
      confirmed: false,
    });
    expect(preview.reviewDigest).toMatch(/^[0-9a-f]{64}$/);

    const confirmed = await workflow.send(auth, {
      debtUuid,
      reviewDigest: preview.reviewDigest,
      acceptPayeeWarning: false,
      confirmed: true,
    });
    expect(confirmed).toEqual({
      debtUuid,
      confirmation: "approved",
      verified: true,
      status: "paid",
      paymentAccountUuid: accountUuid,
    });
    expect(authRequests).toEqual([
      {
        url: "https://holvi.com/api/auth-proxy/2fa/v1/token/initiate/",
        method: "POST",
        authorization: "Bearer session-token",
        body: {
          action_name: "payment_confirm",
          action_data: { debt_uuid: debtUuid },
        },
      },
      {
        url: "https://holvi.com/api/auth-proxy/2fa/v1/token/token_123/",
        method: "GET",
        authorization: "Bearer transient-token",
        body: null,
      },
    ]);
    expect(JSON.stringify(confirmed)).not.toContain("transient-token");
  });

  test("rejects stale review and payee warnings before 2FA", async () => {
    const bridgeSession = session(["payments.send"]);
    let amount = "123.45";
    const api = apiFor(bridgeSession, (requestUrl) => {
      if (requestUrl.includes("/api/vop/"))
        return json({ match_result: "match" });
      if (requestUrl.endsWith(`/debt/${debtUuid}/`))
        return json({ ...debt(), total_amount_temp: amount });
      return json(accountResponse());
    });
    let initiated = false;
    const proxy = new AuthProxyClient("https://holvi.com", async () => {
      initiated = true;
      return json({});
    });
    const workflow = new PaymentWorkflow(bridgeSession, api, proxy);
    const preview = await workflow.send(auth, {
      debtUuid,
      reviewDigest: null,
      acceptPayeeWarning: false,
      confirmed: false,
    });
    amount = "124.45";
    await expect(
      workflow.send(auth, {
        debtUuid,
        reviewDigest: preview.reviewDigest,
        acceptPayeeWarning: false,
        confirmed: true,
      }),
    ).rejects.toThrow("changed after review");
    expect(initiated).toBeFalse();
  });

  test("cancels a TOTP-only confirmation without exposing token data", async () => {
    const bridgeSession = session(["payments.send"]);
    const api = apiFor(bridgeSession, (requestUrl) => {
      if (requestUrl.includes("/api/vop/"))
        return json({ match_result: "match" });
      if (requestUrl.endsWith(`/debt/${debtUuid}/`)) return json(debt());
      return json(accountResponse());
    });
    const methods: string[] = [];
    const proxy = new AuthProxyClient(
      "https://holvi.com",
      async (_input, init) => {
        methods.push(init?.method || "GET");
        if (init?.method === "DELETE") return json({});
        return json({
          token_type: "Bearer",
          id_token: "secret-token",
          expires_in: 300,
          token_meta: {
            twofactor_token_id: "secret_id",
            totp_devices: [{ id: "secret_device", device_type: "totp_app" }],
          },
        });
      },
    );
    const workflow = new PaymentWorkflow(bridgeSession, api, proxy);
    const preview = await workflow.send(auth, {
      debtUuid,
      reviewDigest: null,
      acceptPayeeWarning: false,
      confirmed: false,
    });
    let message = "";
    try {
      await workflow.send(auth, {
        debtUuid,
        reviewDigest: preview.reviewDigest,
        acceptPayeeWarning: false,
        confirmed: true,
      });
    } catch (error) {
      message = String(error);
    }
    expect(methods).toEqual(["POST", "DELETE"]);
    expect(message).toContain("mobile-app device");
    expect(message).not.toContain("secret");
  });
});
