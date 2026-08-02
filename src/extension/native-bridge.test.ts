import { describe, expect, test } from "bun:test";
import type { StaticBridgeConfig } from "./background-types.js";
import type { CommandService } from "./commands.js";
import { NativeBridge } from "./native-bridge.js";
import { BridgeSession } from "./session.js";
import type { TabRegistry } from "./tab-registry.js";
import type { UploadWorkflow } from "./upload-workflow.js";

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

interface FakeNativePort {
  port: chrome.runtime.Port;
  messages: unknown[];
  emit: (message: unknown) => void;
  disconnect: () => void;
}

function fakeNativePort(): FakeNativePort {
  const messages: unknown[] = [];
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    port: {
      postMessage: (message: unknown) => messages.push(message),
      disconnect: () => {
        for (const listener of disconnectListeners) listener();
      },
      onMessage: {
        addListener: (listener: (message: unknown) => void) =>
          messageListeners.push(listener),
      },
      onDisconnect: {
        addListener: (listener: () => void) =>
          disconnectListeners.push(listener),
      },
    } as unknown as chrome.runtime.Port,
    messages,
    emit: (message) => {
      for (const listener of messageListeners) listener(message);
    },
    disconnect: () => {
      for (const listener of disconnectListeners) listener();
    },
  };
}

function uploadStart(id: string) {
  return {
    type: "upload_start",
    id,
    debtUuid: "11111111-1111-4111-8111-111111111111",
    fileName: "receipt.pdf",
    mimeType: "application/pdf",
    size: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    chunkCount: 1,
  };
}

describe("native bridge controller", () => {
  test("releases an interrupted upload when the native transport closes", () => {
    const session = new BridgeSession(staticConfig);
    const ports = [fakeNativePort(), fakeNativePort()];
    let tabCount = 1;
    let connection = 0;
    const originalChrome = globalThis.chrome;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          connectNative: () => ports[connection++]!.port,
        },
      },
    });

    try {
      const tabs = {
        get size() {
          return tabCount;
        },
        configuredTab: () => [7, {}],
      } as unknown as TabRegistry;
      const bridge = new NativeBridge(
        staticConfig,
        session,
        tabs,
        {} as CommandService,
        {} as UploadWorkflow,
      );

      bridge.connect();
      ports[0]!.emit({ type: "host_ready", config: runtimeConfig });
      ports[0]!.emit(uploadStart("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));

      tabCount = 0;
      ports[0]!.disconnect();
      expect(session.optionalConfig).toBeNull();

      tabCount = 1;
      bridge.connect();
      ports[1]!.emit({ type: "host_ready", config: runtimeConfig });
      ports[1]!.emit(uploadStart("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
      ports[1]!.emit({
        type: "upload_chunk",
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        index: 1,
        data: "YWJj",
      });

      expect(ports[1]!.messages).toContainEqual({
        type: "result",
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ok: false,
        error: "Receipt chunks arrived out of order or exceeded their limit.",
      });
      tabCount = 0;
      ports[1]!.disconnect();
    } finally {
      Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: originalChrome,
      });
    }
  });
});
