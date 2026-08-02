interface HolviBridgeStaticConfig {
  accountOrigin: string;
  apiOrigin: string;
  groupPathPrefix: string;
  nativeHostName: string;
  maxFileBytes: number;
  maxTransactionPages: number;
  maxTransactionResults: number;
}

var _HOLVI_AGENT_BRIDGE_STATIC_CONFIG: HolviBridgeStaticConfig;

_HOLVI_AGENT_BRIDGE_STATIC_CONFIG = Object.freeze({
  accountOrigin: "https://account.app.holvi.com",
  apiOrigin: "https://holvi.com",
  groupPathPrefix: "/group/",
  nativeHostName: "app.holvi_agent_bridge",
  maxFileBytes: 25 * 1024 * 1024,
  maxTransactionPages: 200,
  maxTransactionResults: 10_000,
});
