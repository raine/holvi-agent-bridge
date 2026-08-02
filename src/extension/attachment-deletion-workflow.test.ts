import { describe, expect, test } from "bun:test";
import { AttachmentDeletionWorkflow } from "./attachment-deletion-workflow.js";
import type { StaticBridgeConfig } from "./background-types.js";
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
const auth = { token: "header.payload.signature", csrfToken: "csrf-token" };

function configuredSession(
  capabilities = ["transactions.read", "attachments.delete"],
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

function attachment(code: string, title: string) {
  return { code, title, format: "pdf", backend_private: "hidden" };
}

function debt(attachments: Record<string, unknown>[]) {
  return {
    uuid: debtUuid,
    code: "DEBT-1",
    payment_account_uuid: paymentAccountUuid,
    counterparty_name: "Example merchant",
    amount: "24.80",
    currency: "EUR",
    bookkeeping_status: "complete",
    attachments,
    backend_private: "hidden",
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("attachment deletion workflow", () => {
  test("returns a bounded target preview without deleting", async () => {
    const session = configuredSession();
    const methods: string[] = [];
    const api = new HolviApi(staticConfig, session, async (_input, init) => {
      methods.push(init?.method || "GET");
      return jsonResponse(
        debt([
          attachment("ATTACHMENT-1", "receipt.pdf"),
          attachment("ATTACHMENT-2", "invoice.pdf"),
        ]),
      );
    });
    const workflow = new AttachmentDeletionWorkflow(session, api);

    const result = await workflow.deleteAttachment(auth, {
      debtUuid,
      attachmentCode: "ATTACHMENT-2",
      confirmed: false,
    });

    expect(methods).toEqual(["GET"]);
    expect(result).toMatchObject({
      dryRun: true,
      debt: {
        debtUuid,
        paymentAccountUuid,
        attachmentCount: 2,
        attachments: [
          {
            attachmentCode: "ATTACHMENT-1",
            title: "receipt.pdf",
            format: "pdf",
          },
          {
            attachmentCode: "ATTACHMENT-2",
            title: "invoice.pdf",
            format: "pdf",
          },
        ],
      },
      attachment: {
        attachmentCode: "ATTACHMENT-2",
        title: "invoice.pdf",
      },
    });
    expect(JSON.stringify(result)).not.toContain("backend_private");
  });

  test("deletes once and verifies the exact remaining attachment state", async () => {
    const session = configuredSession();
    const first = attachment("ATTACHMENT-1", "receipt.pdf");
    const target = attachment("ATTACHMENT / 2", "invoice.pdf");
    const responses = [
      debt([first, target]),
      {},
      debt([first, target]),
      debt([first]),
    ];
    const requests: { url: string; method: string }[] = [];
    const api = new HolviApi(staticConfig, session, async (input, init) => {
      requests.push({
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        method: init?.method || "GET",
      });
      return jsonResponse(responses.shift());
    });
    const delays: number[] = [];
    const workflow = new AttachmentDeletionWorkflow(
      session,
      api,
      async (delay) => {
        delays.push(delay);
      },
    );

    await expect(
      workflow.deleteAttachment(auth, {
        debtUuid,
        attachmentCode: "ATTACHMENT / 2",
        confirmed: true,
      }),
    ).resolves.toEqual({
      dryRun: false,
      debtUuid,
      attachment: {
        attachmentCode: "ATTACHMENT / 2",
        title: "invoice.pdf",
        format: "pdf",
      },
      attachmentCountBefore: 2,
      attachmentCountAfter: 1,
      verified: true,
    });
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "DELETE",
      "GET",
      "GET",
    ]);
    expect(requests[1]?.url).toBe(
      "https://holvi.com/api/pool/example/attachment/ATTACHMENT%20%2F%202/",
    );
    expect(delays).toEqual([250]);
  });

  test("fails closed before deletion for missing targets and debt scope mismatch", async () => {
    const session = configuredSession();
    let writes = 0;
    const api = new HolviApi(staticConfig, session, async (_input, init) => {
      if (init?.method === "DELETE") {
        writes += 1;
      }
      return jsonResponse(debt([attachment("ATTACHMENT-1", "receipt.pdf")]));
    });
    const workflow = new AttachmentDeletionWorkflow(session, api);

    await expect(
      workflow.deleteAttachment(auth, {
        debtUuid,
        attachmentCode: "MISSING",
        confirmed: true,
      }),
    ).rejects.toThrow("does not exist");

    const outside = {
      ...debt([attachment("ATTACHMENT-1", "receipt.pdf")]),
      payment_account_uuid: "99999999-9999-4999-8999-999999999999",
    };
    const outsideApi = new HolviApi(staticConfig, session, async () =>
      jsonResponse(outside),
    );
    await expect(
      new AttachmentDeletionWorkflow(session, outsideApi).deleteAttachment(
        auth,
        {
          debtUuid,
          attachmentCode: "ATTACHMENT-1",
          confirmed: true,
        },
      ),
    ).rejects.toThrow("outside the configured payment account");
    expect(writes).toBe(0);
  });

  test("does not retry API errors or report unverifiable deletion as success", async () => {
    const session = configuredSession();
    const present = debt([attachment("ATTACHMENT-1", "receipt.pdf")]);
    let apiCalls = 0;
    const failedApi = new HolviApi(
      staticConfig,
      session,
      async (_input, init) => {
        apiCalls += 1;
        return init?.method === "DELETE"
          ? jsonResponse({ detail: "failed" }, 500)
          : jsonResponse(present);
      },
    );
    await expect(
      new AttachmentDeletionWorkflow(session, failedApi).deleteAttachment(
        auth,
        {
          debtUuid,
          attachmentCode: "ATTACHMENT-1",
          confirmed: true,
        },
      ),
    ).rejects.toThrow("Holvi API returned 500");
    expect(apiCalls).toBe(2);

    const staleResponses = [
      present,
      {},
      present,
      present,
      present,
      present,
      present,
    ];
    const staleApi = new HolviApi(staticConfig, session, async () =>
      jsonResponse(staleResponses.shift()),
    );
    await expect(
      new AttachmentDeletionWorkflow(
        session,
        staleApi,
        async () => {},
      ).deleteAttachment(auth, {
        debtUuid,
        attachmentCode: "ATTACHMENT-1",
        confirmed: true,
      }),
    ).rejects.toThrow("could not be verified");
  });
});
