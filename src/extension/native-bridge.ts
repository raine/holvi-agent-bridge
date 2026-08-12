import type { NativeMessage, StaticBridgeConfig } from "./background-types.js";
import { CommandService } from "./commands.js";
import { HolviApi } from "./holvi-api.js";
import { requiredCapabilities } from "./policy.js";
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
  hostRestart: "host_restart",
  command: "command",
  uploadStart: "upload_start",
  uploadChunk: "upload_chunk",
  uploadEnd: "upload_end",
  tabReady: "tab_ready",
  tabUnavailable: "tab_unavailable",
  hostRejected: "host_rejected",
  downloadStart: "download_start",
  downloadChunk: "download_chunk",
  downloadEnd: "download_end",
  result: "result",
});
export const nativeMessageTypes = Object.freeze({
  hostToExtension: [
    nativeMessageType.hostReady,
    nativeMessageType.hostRestart,
    nativeMessageType.command,
    nativeMessageType.uploadStart,
    nativeMessageType.uploadChunk,
    nativeMessageType.uploadEnd,
  ],
  extensionToHost: [
    nativeMessageType.tabReady,
    nativeMessageType.tabUnavailable,
    nativeMessageType.hostRejected,
    nativeMessageType.downloadStart,
    nativeMessageType.downloadChunk,
    nativeMessageType.downloadEnd,
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
    private readonly api?: HolviApi,
  ) {}

  connect(): void {
    if (this.nativePort || this.tabs.size === 0) {
      return;
    }

    const port = chrome.runtime.connectNative(this.staticConfig.nativeHostName);
    this.nativePort = port;
    port.onMessage.addListener((message) => this.handleMessage(message));
    port.onDisconnect.addListener(() => this.disconnect(port));
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

  private disconnect(port: chrome.runtime.Port): void {
    if (this.nativePort !== port) {
      return;
    }
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

  private async streamDownload(
    id: string,
    message: NativeMessage,
  ): Promise<void> {
    if (!this.api) throw new Error("Download service is unavailable.");
    const action = message.action || "";
    const requirements = requiredCapabilities(action);
    if (!requirements)
      throw new Error("The local helper requested an unsupported action.");
    this.session.requireCapabilities(...requirements);
    const auth = await this.tabs.requestAuth();
    const { response, fileName, metadata } = await this.api.downloadResponse(
      auth,
      action,
      message.params || {},
    );
    if (!response.body) throw new Error("Holvi download returned no body.");
    const mimeType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
      "application/octet-stream";
    const declared = response.headers.get("content-length");
    const expectedSize =
      declared && /^\d+$/.test(declared) ? Number(declared) : undefined;
    this.postNative({
      type: nativeMessageType.downloadStart,
      id,
      fileName,
      mimeType,
      expectedSize,
      chunkSize: 491520,
    });
    const reader = response.body.getReader();
    let pending = new Uint8Array(0);
    let index = 0;
    let size = 0;
    const send = (bytes: Uint8Array) => {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      this.postNative({
        type: nativeMessageType.downloadChunk,
        id,
        index,
        data: btoa(binary),
      });
      index += 1;
      size += bytes.length;
      if (size > (this.session.config.maxDownloadBytes ?? 1073741824))
        throw new Error("Download exceeds the configured size limit.");
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(pending.length + value.length);
      joined.set(pending);
      joined.set(value, pending.length);
      let offset = 0;
      while (joined.length - offset >= 491520) {
        send(joined.subarray(offset, offset + 491520));
        offset += 491520;
      }
      pending = joined.slice(offset);
    }
    if (pending.length) send(pending);
    if (expectedSize !== undefined && expectedSize !== size)
      throw new Error("Download size differs from its Content-Length.");
    this.postNative({
      type: nativeMessageType.downloadEnd,
      id,
      chunkCount: index,
      size,
    });
    this.postResult(id, true, metadata);
  }

  private handleMessage(value: unknown): void {
    const message = value as NativeMessage;
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === nativeMessageType.hostRestart) {
      const port = this.nativePort;
      if (port) {
        this.disconnect(port);
        port.disconnect();
      }
      return;
    }

    if (message.type === nativeMessageType.hostReady) {
      try {
        this.session.configure(
          message.config,
          message.protocolVersion,
          message.hostVersion,
        );
        this.reportTabState();
      } catch (error) {
        this.session.clear();
        this.nativePort?.postMessage({
          type: nativeMessageType.hostRejected,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (!requestIdPattern.test(message.id || "")) {
      return;
    }
    const id = message.id as string;

    if (message.type === nativeMessageType.command) {
      if (
        [
          "attachments.download",
          "reports.export",
          "reports.jobs.download",
        ].includes(message.action || "")
      ) {
        this.streamDownload(id, message).catch((error) =>
          this.postResult(id, false, error),
        );
        return;
      }
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
