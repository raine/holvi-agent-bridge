interface HolviBridgeStaticConfig {
  accountOrigin: string;
  apiOrigin: string;
  groupPathPrefix: string;
  nativeHostName: string;
  maxFileBytes: number;
  maxScanPages: number;
  maxScanResults: number;
}

var HOLVI_AGENT_BRIDGE_STATIC_CONFIG: HolviBridgeStaticConfig;

HOLVI_AGENT_BRIDGE_STATIC_CONFIG = Object.freeze({
  accountOrigin: "https://account.app.holvi.com",
  apiOrigin: "https://holvi.com",
  groupPathPrefix: "/group/",
  nativeHostName: "app.holvi_agent_bridge",
  maxFileBytes: 25 * 1024 * 1024,
  maxScanPages: 200,
  maxScanResults: 10_000,
});
