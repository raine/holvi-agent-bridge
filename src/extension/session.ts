import { supportedCapabilities } from "./policy.js";
import type {
  RuntimeBridgeConfig,
  StaticBridgeConfig,
} from "./background-types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function groupPathSegmentFromUrl(
  value: string,
  accountOrigin: string,
): string {
  try {
    const url = new URL(value);
    if (url.origin !== accountOrigin) {
      return "";
    }
    const match = url.pathname.match(/^\/group\/([^/]+)(?:\/|$)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

export function validateRuntimeConfig(
  value: unknown,
  staticConfig: StaticBridgeConfig,
): RuntimeBridgeConfig {
  const config = value as Partial<RuntimeBridgeConfig>;
  const groupParts = (config.groupPathSegment || "").match(
    /^([^/+]+)\+([^/]+)$/,
  );
  const groupPoolHandle = groupParts?.[1] || "";
  if (
    !groupParts ||
    groupPoolHandle !== config.poolHandle ||
    !uuidPattern.test(config.paymentAccountUuid || "") ||
    !Array.isArray(config.capabilities) ||
    config.capabilities.length < 1 ||
    config.capabilities.some(
      (capability) => !supportedCapabilities.has(capability),
    ) ||
    new Set(config.capabilities).size !== config.capabilities.length ||
    !Number.isSafeInteger(config.maxFileBytes) ||
    (config.maxFileBytes || 0) < 1 ||
    (config.maxFileBytes || 0) > staticConfig.maxFileBytes
  ) {
    throw new Error(
      "The native host supplied an invalid Holvi account boundary.",
    );
  }
  return config as RuntimeBridgeConfig;
}

export function validateUuid(value: string, resource: string): string {
  if (!uuidPattern.test(value || "")) {
    throw new Error(`A valid Holvi ${resource} UUID is required.`);
  }
  return value;
}

export class BridgeSession {
  private runtimeConfig: RuntimeBridgeConfig | null = null;

  constructor(private readonly staticConfig: StaticBridgeConfig) {}

  configure(value: unknown): RuntimeBridgeConfig {
    const config = validateRuntimeConfig(value, this.staticConfig);
    this.runtimeConfig = config;
    return config;
  }

  clear(): void {
    this.runtimeConfig = null;
  }

  get optionalConfig(): RuntimeBridgeConfig | null {
    return this.runtimeConfig;
  }

  get config(): RuntimeBridgeConfig {
    if (!this.runtimeConfig) {
      throw new Error("The local bridge has no configured Holvi account.");
    }
    return this.runtimeConfig;
  }

  requireCapabilities(...capabilities: string[]): void {
    if (
      !this.runtimeConfig ||
      capabilities.some(
        (capability) => !this.runtimeConfig?.capabilities.includes(capability),
      )
    ) {
      throw new Error(
        `Action requires capabilities: ${capabilities.join(", ")}.`,
      );
    }
  }

  apiRoot(): string {
    return `/api/pool/${encodeURIComponent(this.config.poolHandle)}/`;
  }
}
