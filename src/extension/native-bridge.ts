import type { NativeMessage, StaticBridgeConfig } from "./background-types.js";
import { CommandService } from "./commands.js";
import { BridgeSession } from "./session.js";
import { TabRegistry } from "./tab-registry.js";
import {
  UploadTransferLifecycle,
  type UploadTransfer,
  uploadTransferExpiryMs,
} from "./upload-transfer.js";
import { UploadWorkflow } from "./upload-workflow.js";

const requestIdPattern = /^[0-9a-f-]{16,64}$/i;

export const nativeReconnectDelayMs = 1000;
const nativeMessageType = Object.freeze({
  hostReady: "host_ready",
  command: "command",
  uploadStart: "upload_start",
  uploadChunk: "upload_chunk",
  uploadEnd: "upload_end",
  tabReady: "tab_ready",
  tabUnavailable: "tab_unavailable",
  result: "result",
});
export const nativeMessageTypes = Object.freeze({
  hostToExtension: [
    nativeMessageType.hostReady,
    nativeMessageType.command,
    nativeMessageType.uploadStart,
    nativeMessageType.uploadChunk,
    nativeMessageType.uploadEnd,
  ],
  extensionToHost: [
    nativeMessageType.tabReady,
    nativeMessageType.tabUnavailable,
    nativeMessageType.result,
  ],
});

export class NativeBridge {
  private nativePort: chrome.runtime.Port | null = null;
  private reconnectTimer: number | null = null;
  private uploadExpiryTimer: number | null = null;
  private readonly uploadTransfers = new UploadTransferLifecycle();

  constructor(
    private readonly staticConfig: StaticBridgeConfig,
    private readonly session: BridgeSession,
    private readonly tabs: TabRegistry,
    private readonly commands: CommandService,
    private readonly uploads: UploadWorkflow,
  ) {}

  connect(): void {
    if (this.nativePort || this.tabs.size === 0) {
      return;
    }

    this.nativePort = chrome.runtime.connectNative(
      this.staticConfig.nativeHostName,
    );
    this.nativePort.onMessage.addListener((message) =>
      this.handleMessage(message),
    );
    this.nativePort.onDisconnect.addListener(() => {
      this.nativePort = null;
      this.session.clear();
      this.uploadTransfers.cancel();
      this.clearUploadExpiry();
      if (this.tabs.size > 0 && this.reconnectTimer === null) {
        this.reconnectTimer = self.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, nativeReconnectDelayMs);
      }
    });
  }

  reportTabState(): void {
    if (!this.nativePort || !this.session.optionalConfig) {
      return;
    }
    const tab = this.tabs.configuredTab();
    this.nativePort.postMessage(
      tab
        ? { type: nativeMessageType.tabReady, tabId: tab[0] }
        : { type: nativeMessageType.tabUnavailable },
    );
  }

  private postNative(message: unknown): void {
    if (!this.nativePort) {
      throw new Error("The local Holvi helper is disconnected.");
    }
    this.nativePort.postMessage(message);
  }

  private postResult(id: string, ok: boolean, value: unknown): void {
    try {
      this.postNative(
        ok
          ? { type: nativeMessageType.result, id, ok, data: value }
          : {
              type: nativeMessageType.result,
              id,
              ok,
              error: value instanceof Error ? value.message : String(value),
            },
      );
    } catch {
      // A disconnected native port has no response destination.
    }
  }

  private clearUploadExpiry(): void {
    if (this.uploadExpiryTimer !== null) {
      clearTimeout(this.uploadExpiryTimer);
      this.uploadExpiryTimer = null;
    }
  }

  private scheduleUploadExpiry(): void {
    this.clearUploadExpiry();
    this.uploadExpiryTimer = self.setTimeout(() => {
      this.uploadExpiryTimer = null;
      const expiredId = this.uploadTransfers.expire(Date.now());
      if (expiredId) {
        this.postResult(
          expiredId,
          false,
          new Error("Receipt transfer expired."),
        );
      }
    }, uploadTransferExpiryMs);
  }

  private finishUpload(upload: UploadTransfer): Promise<unknown> {
    return this.tabs
      .requestAuth()
      .then((auth) => this.uploads.uploadReceipt(auth, upload));
  }

  private handleMessage(value: unknown): void {
    const message = value as NativeMessage;
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === nativeMessageType.hostReady) {
      try {
        this.session.configure(message.config);
        this.reportTabState();
      } catch (_error) {
        this.nativePort?.disconnect();
      }
      return;
    }

    if (!requestIdPattern.test(message.id || "")) {
      return;
    }
    const id = message.id as string;

    if (message.type === nativeMessageType.command) {
      this.commands
        .handle(message)
        .then((data) => this.postResult(id, true, data))
        .catch((error) => this.postResult(id, false, error));
      return;
    }

    if (message.type === nativeMessageType.uploadStart) {
      try {
        this.uploadTransfers.start(
          {
            id,
            debtUuid: message.debtUuid,
            fileName: message.fileName,
            mimeType: message.mimeType,
            size: message.size,
            sha256: message.sha256,
            chunkCount: message.chunkCount,
          },
          this.session.optionalConfig?.maxFileBytes || 0,
          Date.now(),
        );
        this.scheduleUploadExpiry();
      } catch (error) {
        this.postResult(id, false, error);
      }
      return;
    }

    if (message.type === nativeMessageType.uploadChunk) {
      try {
        this.uploadTransfers.append(
          id,
          message.index,
          message.data,
          Date.now(),
        );
      } catch (error) {
        if (!this.uploadTransfers.hasActiveTransfer()) {
          this.clearUploadExpiry();
        }
        this.postResult(id, false, error);
      }
      return;
    }

    if (message.type === nativeMessageType.uploadEnd) {
      let upload: UploadTransfer;
      try {
        upload = this.uploadTransfers.complete(id, Date.now());
        this.clearUploadExpiry();
      } catch (error) {
        if (!this.uploadTransfers.hasActiveTransfer()) {
          this.clearUploadExpiry();
        }
        this.postResult(id, false, error);
        return;
      }
      this.finishUpload(upload)
        .then((data) => this.postResult(id, true, data))
        .catch((error) => this.postResult(id, false, error))
        .finally(() => this.uploadTransfers.finish(id));
    }
  }
}
