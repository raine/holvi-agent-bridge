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
        }, 1000);
      }
    });
  }

  reportTabState(): void {
    if (!this.nativePort || !this.session.optionalConfig) {
      return;
    }
    const tab = this.tabs.configuredTab();
    this.nativePort.postMessage(
      tab ? { type: "tab_ready", tabId: tab[0] } : { type: "tab_unavailable" },
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
          ? { type: "result", id, ok, data: value }
          : {
              type: "result",
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

    if (message.type === "host_ready") {
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

    if (message.type === "command") {
      this.commands
        .handle(message)
        .then((data) => this.postResult(id, true, data))
        .catch((error) => this.postResult(id, false, error));
      return;
    }

    if (message.type === "upload_start") {
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

    if (message.type === "upload_chunk") {
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

    if (message.type === "upload_end") {
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
