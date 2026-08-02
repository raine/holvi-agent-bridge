import { describe, expect, test } from "bun:test";
import type { StaticBridgeConfig } from "./background-types.js";
import { HolviApi } from "./holvi-api.js";
import { BridgeSession } from "./session.js";
import type { UploadTransfer } from "./upload-transfer.js";
import { UploadWorkflow } from "./upload-workflow.js";

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
const upload: UploadTransfer = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  debtUuid,
  fileName: "receipt.pdf",
  mimeType: "application/pdf",
  size: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  chunkCount: 1,
  chunks: ["YWJj"],
};

function configuredSession(): BridgeSession {
  const session = new BridgeSession(staticConfig);
  session.configure({
    groupPathSegment: "example+11111111-1111-4111-8111-111111111111",
    poolHandle: "example",
    paymentAccountUuid,
    capabilities: ["transactions.read", "attachments.write"],
    maxFileBytes: 1024,
  });
  return session;
}

function debt(attachmentCount: number, accountUuid = paymentAccountUuid) {
  return {
    uuid: debtUuid,
    code: "DEBT-1",
    payment_account_uuid: accountUuid,
    attachments: Array.from({ length: attachmentCount }, () => ({})),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("receipt upload workflow", () => {
  test("reads before one write and verifies with subsequent reads", async () => {
    const session = configuredSession();
    const methods: string[] = [];
    const responses = [debt(0), {}, debt(0), debt(1)];
    const fetchRequest = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      methods.push(init?.method || "GET");
      return jsonResponse(responses.shift());
    };
    const delays: number[] = [];
    const api = new HolviApi(staticConfig, session, fetchRequest);
    const workflow = new UploadWorkflow(session, api, async (delay) => {
      delays.push(delay);
    });

    await expect(workflow.uploadReceipt(auth, upload)).resolves.toMatchObject({
      debtUuid,
      attachmentCountBefore: 0,
      attachmentCountAfter: 1,
    });
    expect(methods).toEqual(["GET", "POST", "GET", "GET"]);
    expect(delays).toEqual([250]);
  });

  test("rejects a debt from another payment account before upload", async () => {
    const session = configuredSession();
    const methods: string[] = [];
    const fetchRequest = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      methods.push(init?.method || "GET");
      return jsonResponse(debt(0, "99999999-9999-4999-8999-999999999999"));
    };
    const api = new HolviApi(staticConfig, session, fetchRequest);
    const workflow = new UploadWorkflow(session, api);

    await expect(workflow.uploadReceipt(auth, upload)).rejects.toThrow(
      "payment account does not match the configured payment account",
    );
    expect(methods).toEqual(["GET"]);
  });

  test("does not retry a failed write", async () => {
    const session = configuredSession();
    const methods: string[] = [];
    const fetchRequest = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      methods.push(method);
      return method === "POST"
        ? jsonResponse({ detail: "failed" }, 500)
        : jsonResponse(debt(0));
    };
    const api = new HolviApi(staticConfig, session, fetchRequest);
    const workflow = new UploadWorkflow(session, api);

    await expect(workflow.uploadReceipt(auth, upload)).rejects.toThrow(
      "Holvi API returned 500",
    );
    expect(methods).toEqual(["GET", "POST"]);
  });
});
