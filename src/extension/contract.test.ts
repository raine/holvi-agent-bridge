import { describe, expect, test } from "bun:test";
import contract from "../../bridge-contract.json";
import { bookkeepingDescriptionMaxBytes } from "./bookkeeping-description-workflow.js";
import {
  auditLimitMax,
  auditLimitMin,
  auditPageSize,
  maxApiResponseBytes,
} from "./holvi-api.js";
import { nativeMessageTypes, nativeReconnectDelayMs } from "./native-bridge.js";
import {
  actionCapabilities,
  minimumFileBytes,
  supportedCapabilities,
} from "./policy.js";
import {
  fileChunkBytes,
  uploadMimeTypes,
  uploadTransferExpiryMs,
} from "./upload-transfer.js";

interface SharedStaticConfig {
  accountOrigin: string;
  apiOrigin: string;
  nativeHostName: string;
  nativeProtocolVersion: number;
  extensionVersion: string;
  maxFileBytes: number;
}

function sourceConfigValue(source: string, name: string): string {
  const value = source.match(
    new RegExp(`^\\s*${name}: (?:"([^"]+)"|(\\d+)),?$`, "m"),
  );
  const match = value?.[1] || value?.[2];
  if (!match) {
    throw new Error(`Static extension config has no literal ${name}.`);
  }
  return match;
}

async function staticConfig(): Promise<SharedStaticConfig> {
  const source = await Bun.file(new URL("./config.ts", import.meta.url)).text();
  return {
    accountOrigin: sourceConfigValue(source, "accountOrigin"),
    apiOrigin: sourceConfigValue(source, "apiOrigin"),
    nativeHostName: sourceConfigValue(source, "nativeHostName"),
    nativeProtocolVersion: Number(
      sourceConfigValue(source, "nativeProtocolVersion"),
    ),
    extensionVersion: sourceConfigValue(source, "extensionVersion"),
    maxFileBytes: Number(sourceConfigValue(source, "maxFileBytes")),
  };
}

async function manifest(): Promise<Record<string, unknown>> {
  return Bun.file(
    new URL("../../assets/extension/manifest.json", import.meta.url),
  ).json();
}

async function extensionId(key: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(key), (value) => value.charCodeAt(0));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", keyBytes),
  );
  return Array.from(digest.slice(0, 16), (byte) =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)),
  ).join("");
}

describe("cross-language bridge contract", () => {
  test("matches action and capability policy", () => {
    expect(JSON.stringify(actionCapabilities)).toBe(
      JSON.stringify(contract.actions),
    );
    expect([...supportedCapabilities].sort()).toEqual(
      [...new Set(Object.values(contract.actions).flat())].sort(),
    );
  });

  test("matches static identity, origins, and file bounds", async () => {
    const config = await staticConfig();
    const extensionManifest = await manifest();

    expect(config.accountOrigin).toBe(contract.origins.account);
    expect(config.apiOrigin).toBe(contract.origins.api);
    expect(config.nativeHostName).toBe(contract.identity.nativeHostName);
    expect(config.nativeProtocolVersion).toBe(contract.versions.nativeProtocol);
    expect(config.extensionVersion).toBe(contract.versions.extension);
    expect(extensionManifest.version).toBe(contract.versions.extension);
    expect(config.maxFileBytes).toBe(contract.fileBytes.max);
    expect(extensionManifest.manifest_version).toBe(
      contract.versions.extensionManifest,
    );
    expect(await extensionId(extensionManifest.key as string)).toBe(
      contract.identity.extensionId,
    );
  });

  test("matches upload, audit, and timeout policies", () => {
    expect(minimumFileBytes).toBe(contract.fileBytes.min);
    expect(fileChunkBytes).toBe(contract.fileBytes.uploadChunk);
    expect([...uploadMimeTypes]).toEqual(contract.uploadMimeTypes);
    expect(uploadTransferExpiryMs).toBe(contract.timeoutsMs.uploadTransfer);
    expect(nativeReconnectDelayMs).toBe(contract.timeoutsMs.nativeReconnect);
    expect({
      min: auditLimitMin,
      max: auditLimitMax,
      pageSize: auditPageSize,
    }).toEqual(contract.auditLimit);
    expect(maxApiResponseBytes).toBe(contract.apiResponseBytes.max);
    expect(bookkeepingDescriptionMaxBytes).toBe(
      contract.bookkeepingDescriptionBytes.max,
    );
  });

  test("matches Native Messaging variants", () => {
    expect(JSON.stringify(nativeMessageTypes)).toBe(
      JSON.stringify(contract.nativeMessaging),
    );
  });
});
