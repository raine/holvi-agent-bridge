import { describe, expect, test } from "bun:test";
import type { StaticBridgeConfig } from "./background-types.js";
import { BridgeSession } from "./session.js";
import { TabRegistry } from "./tab-registry.js";

const staticConfig: StaticBridgeConfig = {
  accountOrigin: "https://account.app.holvi.com",
  apiOrigin: "https://holvi.com",
  groupPathPrefix: "/group/",
  nativeHostName: "app.holvi_agent_bridge",
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

interface FakePort {
  port: chrome.runtime.Port;
  messages: unknown[];
  contentListeners: Array<(message: unknown) => void>;
  disconnectListeners: Array<() => void>;
}

function fakePort(
  tabId = 7,
  url = `https://account.app.holvi.com/group/${runtimeConfig.groupPathSegment}/feed`,
): FakePort {
  const messages: unknown[] = [];
  const contentListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port = {
    name: "holvi-tab",
    sender: { tab: { id: tabId, url } },
    postMessage: (message: unknown) => messages.push(message),
    disconnect: () => {
      for (const listener of disconnectListeners) {
        listener();
      }
    },
    onMessage: {
      addListener: (listener: (message: unknown) => void) =>
        contentListeners.push(listener),
    },
    onDisconnect: {
      addListener: (listener: () => void) => disconnectListeners.push(listener),
    },
  } as unknown as chrome.runtime.Port;
  return { port, messages, contentListeners, disconnectListeners };
}

function authResponse(
  requestId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "auth_response",
    requestId,
    href: `https://account.app.holvi.com/group/${runtimeConfig.groupPathSegment}/feed`,
    origin: staticConfig.accountOrigin,
    token: `${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
    csrfToken: "csrf-token",
    ...overrides,
  };
}

describe("tab authentication", () => {
  test("requests credentials only from the configured group tab", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const connection = fakePort();
    const tabs = new TabRegistry(staticConfig, session, {
      connectionAvailable: () => {},
      stateChanged: () => {},
    });
    tabs.register(connection.port);

    const authPromise = tabs.requestAuth();
    const request = connection.messages[0] as {
      type: string;
      requestId: string;
    };
    expect(request.type).toBe("auth_request");

    connection.contentListeners[0]!(authResponse(request.requestId));
    await expect(authPromise).resolves.toEqual({
      token: `${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
      csrfToken: "csrf-token",
    });
  });

  test("rejects credentials reported outside the configured origin", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const connection = fakePort();
    const tabs = new TabRegistry(staticConfig, session, {
      connectionAvailable: () => {},
      stateChanged: () => {},
    });
    tabs.register(connection.port);

    const authPromise = tabs.requestAuth();
    const request = connection.messages[0] as { requestId: string };
    connection.contentListeners[0]!(
      authResponse(request.requestId, {
        href: `https://example.test/group/${runtimeConfig.groupPathSegment}/feed`,
        origin: "https://example.test",
      }),
    );

    await expect(authPromise).rejects.toThrow(
      "outside the configured Holvi group",
    );
  });

  test("rejects pending authentication when its tab disconnects", async () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);
    const connection = fakePort();
    let stateChanges = 0;
    const tabs = new TabRegistry(staticConfig, session, {
      connectionAvailable: () => {},
      stateChanged: () => {
        stateChanges += 1;
      },
    });
    tabs.register(connection.port);

    const authPromise = tabs.requestAuth();
    connection.port.disconnect();

    await expect(authPromise).rejects.toThrow("Holvi tab disconnected");
    expect(stateChanges).toBe(1);
    expect(tabs.size).toBe(0);
  });
});
