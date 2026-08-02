import { describe, expect, test } from "bun:test";
import type { StaticBridgeConfig } from "./background-types.js";
import { CommentWorkflow } from "./comment-workflow.js";
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
const paymentAccountUuid = "22222222-2222-4222-8222-222222222222";
const commentUuid = "33333333-3333-4333-8333-333333333333";
const auth = { token: "header.payload.signature", csrfToken: "csrf-token" };
const content = "Exact internal note\nwith a second line";

function configuredSession(
  capabilities = ["transactions.read", "comments.write"],
): BridgeSession {
  const session = new BridgeSession(staticConfig);
  session.configure({
    groupPathSegment: "example+11111111-1111-4111-8111-111111111111",
    poolHandle: "example",
    paymentAccountUuid,
    capabilities,
    maxFileBytes: 1024,
  });
  return session;
}

function debt(accountUuid = paymentAccountUuid) {
  return {
    uuid: debtUuid,
    code: "DEBT-1",
    payment_account_uuid: accountUuid,
    attachments: [],
  };
}

function comment(uuid: string | null = commentUuid) {
  return {
    ...(uuid ? { uuid } : {}),
    content,
    creator: { name: "Example User" },
    create_time: "2026-08-02T12:00:00Z",
    push_notified: false,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("comment creation workflow", () => {
  test("validates the account, performs one exact POST, and verifies by UUID", async () => {
    const session = configuredSession();
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const responses = [
      debt(),
      comment(),
      debt(),
      { results: [comment()], next: null },
    ];
    const api = new HolviApi(staticConfig, session, async (input, init) => {
      requests.push({
        url: requestUrl(input),
        method: init?.method || "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return jsonResponse(responses.shift());
    });
    const workflow = new CommentWorkflow(session, api);

    await expect(
      workflow.createComment(auth, { debtUuid, content, confirmed: true }),
    ).resolves.toEqual({
      debtUuid,
      comment: {
        uuid: commentUuid,
        content,
        creator: { uuid: null, name: "Example User", isHolvi: false },
        createTime: "2026-08-02T12:00:00Z",
        pushNotified: false,
      },
    });
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
    ]);
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toEqual([
      {
        url: `https://holvi.com/api/pool/example/debt/${debtUuid}/comment/`,
        method: "POST",
        body: { content, notify_push: false },
      },
    ]);
  });

  test("uses one exact full-record match when Holvi supplies no UUID", async () => {
    const session = configuredSession();
    const responses = [
      debt(),
      comment(null),
      debt(),
      { results: [comment(null)], next: null },
    ];
    const api = new HolviApi(staticConfig, session, async () =>
      jsonResponse(responses.shift()),
    );
    const workflow = new CommentWorkflow(session, api);

    await expect(
      workflow.createComment(auth, { debtUuid, content, confirmed: true }),
    ).resolves.toMatchObject({ debtUuid });
  });

  test("rejects account mismatch and missing confirmation before POST", async () => {
    const session = configuredSession();
    const methods: string[] = [];
    const api = new HolviApi(staticConfig, session, async (_input, init) => {
      methods.push(init?.method || "GET");
      return jsonResponse(debt("99999999-9999-4999-8999-999999999999"));
    });
    const workflow = new CommentWorkflow(session, api);

    await expect(
      workflow.createComment(auth, { debtUuid, content, confirmed: true }),
    ).rejects.toThrow("payment account does not match");
    expect(methods).toEqual(["GET"]);
    await expect(
      workflow.createComment(auth, { debtUuid, content, confirmed: false }),
    ).rejects.toThrow("explicit confirmation");
    expect(methods).toEqual(["GET"]);
  });

  test("requires both capabilities and bounded non-whitespace content", async () => {
    for (const capabilities of [["transactions.read"], ["comments.write"]]) {
      const session = configuredSession(capabilities);
      const api = new HolviApi(staticConfig, session, async () =>
        jsonResponse(debt()),
      );
      await expect(
        new CommentWorkflow(session, api).createComment(auth, {
          debtUuid,
          content,
          confirmed: true,
        }),
      ).rejects.toThrow("transactions.read, comments.write");
    }

    const session = configuredSession();
    const api = new HolviApi(staticConfig, session, async () =>
      jsonResponse(debt()),
    );
    await expect(
      new CommentWorkflow(session, api).createComment(auth, {
        debtUuid,
        content: " \n ",
        confirmed: true,
      }),
    ).rejects.toThrow("must contain text");
  });

  test("does not retry a failed POST or continue to verification", async () => {
    const session = configuredSession();
    const methods: string[] = [];
    const api = new HolviApi(staticConfig, session, async (_input, init) => {
      const method = init?.method || "GET";
      methods.push(method);
      return method === "POST"
        ? jsonResponse({ detail: "failed" }, 500)
        : jsonResponse(debt());
    });
    const workflow = new CommentWorkflow(session, api);

    await expect(
      workflow.createComment(auth, { debtUuid, content, confirmed: true }),
    ).rejects.toThrow("Holvi API returned 500");
    expect(methods).toEqual(["GET", "POST"]);
  });

  test("fails closed when post-write verification is absent or ambiguous", async () => {
    for (const results of [[], [comment(null), comment(null)]]) {
      const session = configuredSession();
      const responses = [
        debt(),
        comment(null),
        debt(),
        { results, next: null },
      ];
      const api = new HolviApi(staticConfig, session, async () =>
        jsonResponse(responses.shift()),
      );
      const workflow = new CommentWorkflow(session, api);
      await expect(
        workflow.createComment(auth, { debtUuid, content, confirmed: true }),
      ).rejects.toThrow("could not identify exactly one matching record");
    }
  });

  test("rejects changed response content or notification state", async () => {
    for (const created of [
      { ...comment(), content: "changed" },
      { ...comment(), push_notified: true },
    ]) {
      const session = configuredSession();
      const methods: string[] = [];
      const responses = [debt(), created];
      const api = new HolviApi(staticConfig, session, async (_input, init) => {
        methods.push(init?.method || "GET");
        return jsonResponse(responses.shift());
      });
      const workflow = new CommentWorkflow(session, api);
      await expect(
        workflow.createComment(auth, { debtUuid, content, confirmed: true }),
      ).rejects.toThrow("did not match the requested content");
      expect(methods).toEqual(["GET", "POST"]);
    }
  });
});
