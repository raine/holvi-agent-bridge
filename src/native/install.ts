#!/usr/bin/env node

import crypto from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_FILE_BYTES,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  HOST_NAME,
  SUPPORTED_CAPABILITIES,
  type BridgeConfig,
  type Capability,
  defaultConfigPath,
  parseGroupUrl,
  resolveReceiptRoot,
  validateUuid,
} from "./config.js";

export interface InstallOptions {
  confirmed: boolean;
  groupUrl: string;
  paymentAccountUuid: string;
  capabilities: string[];
  receiptRoots: string[];
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function writePrivateJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

function chromeManifestDirectory(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
    );
  }
  if (process.platform === "linux") {
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(configRoot, "google-chrome", "NativeMessagingHosts");
  }
  throw new Error("The installer supports Google Chrome on macOS and Linux.");
}

async function reusableSecret(configPath: string): Promise<string> {
  try {
    const stat = await lstat(configPath);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      return "";
    }
    const existing = JSON.parse(await readFile(configPath, "utf8")) as {
      hmacSecret?: string;
    };
    return /^[a-f0-9]{64}$/.test(existing.hmacSecret || "")
      ? existing.hmacSecret || ""
      : "";
  } catch {
    return "";
  }
}

export async function installBridge(options: InstallOptions): Promise<{
  configPath: string;
  extensionId: string;
  extensionPath: string;
  nativeHostManifest: string;
}> {
  if (!options.confirmed) {
    throw new Error("Installation requires --yes because it registers a Chrome native host.");
  }
  if (!Array.isArray(options.capabilities) || options.capabilities.length < 1) {
    throw new Error("Installation requires at least one --capability.");
  }
  const capabilities = [...new Set(options.capabilities)];
  if (
    capabilities.some(
      (capability) =>
        !SUPPORTED_CAPABILITIES.includes(capability as Capability),
    )
  ) {
    throw new Error(
      `Supported capabilities: ${SUPPORTED_CAPABILITIES.join(", ")}.`,
    );
  }
  if (
    capabilities.includes("attachments.write") &&
    (!Array.isArray(options.receiptRoots) || options.receiptRoots.length < 1)
  ) {
    throw new Error("attachments.write requires at least one --receipt-root.");
  }

  const { groupPathSegment, poolHandle } = parseGroupUrl(options.groupUrl);
  const paymentAccountUuid = validateUuid(
    options.paymentAccountUuid,
    "Payment account",
  );
  const receiptRoots = [
    ...new Set(await Promise.all((options.receiptRoots || []).map(resolveReceiptRoot))),
  ];

  const projectRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const extensionPath = path.join(projectRoot, "dist", "extension");
  const hostScript = path.join(projectRoot, "dist", "native", "host.js");
  const configPath = defaultConfigPath();
  const supportDirectory = path.dirname(configPath);
  const wrapperPath = path.join(supportDirectory, "native-host");
  const manifestDirectory = chromeManifestDirectory();
  const nativeHostManifest = path.join(manifestDirectory, `${HOST_NAME}.json`);

  await mkdir(supportDirectory, { recursive: true, mode: 0o700 });
  await chmod(supportDirectory, 0o700);
  await mkdir(manifestDirectory, { recursive: true });

  const hmacSecret =
    (await reusableSecret(configPath)) || crypto.randomBytes(32).toString("hex");
  const config: BridgeConfig = {
    version: 2,
    groupPathSegment,
    poolHandle,
    paymentAccountUuid,
    capabilities: capabilities as Capability[],
    receiptRoots,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    hmacSecret,
  };
  await writePrivateJson(configPath, config);

  const wrapper = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hostScript)} "$@"\n`;
  await writeFile(wrapperPath, wrapper, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);

  await writePrivateJson(nativeHostManifest, {
    name: HOST_NAME,
    description: "Holvi Agent Bridge native host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  });

  return {
    configPath,
    extensionId: EXTENSION_ID,
    extensionPath,
    nativeHostManifest,
  };
}
