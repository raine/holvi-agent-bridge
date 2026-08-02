import type { Auth, StaticBridgeConfig } from "./background-types.js";
import { BridgeSession, groupPathSegmentFromUrl } from "./session.js";

interface TabConnection {
  port: chrome.runtime.Port;
  href: string;
  groupPathSegment: string;
}

interface PendingAuth {
  resolve: (auth: Auth) => void;
  reject: (error: Error) => void;
  timeout: number;
  tabId: number;
}

interface ContentMessage {
  type?: string;
  requestId?: string;
  href?: string;
  origin?: string;
  pathname?: string;
  token?: string;
  csrfToken?: string;
}

interface TabRegistryEvents {
  connectionAvailable: () => void;
  stateChanged: () => void;
}

export class TabRegistry {
  private readonly connections = new Map<number, TabConnection>();
  private readonly authRequests = new Map<string, PendingAuth>();

  constructor(
    private readonly staticConfig: StaticBridgeConfig,
    private readonly session: BridgeSession,
    private readonly events: TabRegistryEvents,
  ) {}

  get size(): number {
    return this.connections.size;
  }

  register(port: chrome.runtime.Port): void {
    const tabId = port.sender?.tab?.id;
    const href = port.sender?.tab?.url || "";
    const groupPathSegment = groupPathSegmentFromUrl(
      href,
      this.staticConfig.accountOrigin,
    );
    if (
      port.name !== "holvi-tab" ||
      !Number.isInteger(tabId) ||
      !groupPathSegment
    ) {
      port.disconnect();
      return;
    }

    const validTabId = tabId as number;
    this.connections.get(validTabId)?.port.disconnect();
    this.connections.set(validTabId, { port, href, groupPathSegment });
    port.onMessage.addListener((message) =>
      this.handleContentMessage(validTabId, message),
    );
    port.onDisconnect.addListener(() => this.disconnect(validTabId, port));
    this.events.connectionAvailable();
  }

  configuredTab(): [number, TabConnection] | null {
    const config = this.session.optionalConfig;
    if (!config) {
      return null;
    }
    for (const entry of this.connections) {
      if (entry[1].groupPathSegment === config.groupPathSegment) {
        return entry;
      }
    }
    return null;
  }

  requestAuth(): Promise<Auth> {
    const tab = this.configuredTab();
    if (!tab) {
      return Promise.reject(
        new Error("Open the configured signed-in Holvi group tab in Chrome."),
      );
    }

    const [tabId, connection] = tab;
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = self.setTimeout(() => {
        this.authRequests.delete(requestId);
        reject(
          new Error("The Holvi tab did not provide session authentication."),
        );
      }, 5000);

      this.authRequests.set(requestId, { resolve, reject, timeout, tabId });
      connection.port.postMessage({ type: "auth_request", requestId });
    });
  }

  private handleContentMessage(tabId: number, value: unknown): void {
    const message = value as ContentMessage;
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "tab_hello") {
      const groupPathSegment = groupPathSegmentFromUrl(
        message.href || "",
        this.staticConfig.accountOrigin,
      );
      const connection = this.connections.get(tabId);
      if (!connection || !groupPathSegment) {
        connection?.port.disconnect();
        return;
      }
      connection.href = message.href || "";
      connection.groupPathSegment = groupPathSegment;
      this.events.connectionAvailable();
      this.events.stateChanged();
      return;
    }

    if (message.type !== "auth_response" || !message.requestId) {
      return;
    }

    const pending = this.authRequests.get(message.requestId);
    if (!pending || pending.tabId !== tabId) {
      return;
    }

    this.authRequests.delete(message.requestId);
    clearTimeout(pending.timeout);

    const config = this.session.optionalConfig;
    if (
      !config ||
      message.origin !== this.staticConfig.accountOrigin ||
      groupPathSegmentFromUrl(
        message.href || "",
        this.staticConfig.accountOrigin,
      ) !== config.groupPathSegment
    ) {
      pending.reject(
        new Error("The bridge tab is outside the configured Holvi group."),
      );
      return;
    }

    const token = typeof message.token === "string" ? message.token : "";
    if (
      token.length < 32 ||
      token.length > 8192 ||
      token.split(".").length !== 3
    ) {
      pending.reject(
        new Error("Sign in to Holvi or reload the configured group tab."),
      );
      return;
    }

    pending.resolve({
      token,
      csrfToken: typeof message.csrfToken === "string" ? message.csrfToken : "",
    });
  }

  private disconnect(tabId: number, port: chrome.runtime.Port): void {
    if (this.connections.get(tabId)?.port !== port) {
      return;
    }
    this.connections.delete(tabId);
    for (const [requestId, pending] of this.authRequests) {
      if (pending.tabId === tabId) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("The Holvi tab disconnected."));
        this.authRequests.delete(requestId);
      }
    }
    this.events.stateChanged();
  }
}
