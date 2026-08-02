import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const EXTENSION_ID = "oeedcemphbobfehfmcllmjhhhjgahgeb";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const HOST_NAME = "app.holvi_agent_bridge";
export const ACCOUNT_ORIGIN = "https://account.app.holvi.com";
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_CAPABILITIES = [
  "transactions.read",
  "attachments.write",
] as const;

export type Capability = (typeof SUPPORTED_CAPABILITIES)[number];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const poolHandlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const groupSegmentPattern = /^([^/+]+)\+([^/]+)$/;

export interface BridgeConfig {
  version: 2;
  groupPathSegment: string;
  poolHandle: string;
  paymentAccountUuid: string;
  capabilities: Capability[];
  receiptRoots: string[];
  maxFileBytes: number;
  hmacSecret: string;
}

export interface PublicBridgeConfig {
  groupPathSegment: string;
  poolHandle: string;
  paymentAccountUuid: string;
  capabilities: Capability[];
  maxFileBytes: number;
}

export interface ReceiptFile {
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export function defaultConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Holvi Agent Bridge",
      "config.json",
    );
  }
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configRoot, "holvi-agent-bridge", "config.json");
}

export function socketPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `holvi-agent-bridge-${uid}.sock`);
}

export function validateUuid(value: string, label = "UUID"): string {
  if (!uuidPattern.test(value || "")) {
    throw new Error(`${label} must be a UUID.`);
  }
  return value;
}

export function parseGroupUrl(value: string): {
  groupPathSegment: string;
  poolHandle: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--group-url must be a valid URL.");
  }
  if (url.origin !== ACCOUNT_ORIGIN) {
    throw new Error(`--group-url must use ${ACCOUNT_ORIGIN}.`);
  }
  const match = url.pathname.match(/^\/group\/([^/]+)(?:\/|$)/);
  if (!match) {
    throw new Error("--group-url must identify a Holvi group page.");
  }
  const encodedGroupPathSegment = match[1];
  if (!encodedGroupPathSegment) {
    throw new Error("--group-url must identify a Holvi group page.");
  }
  const groupPathSegment = decodeURIComponent(encodedGroupPathSegment);
  const groupMatch = groupPathSegment.match(groupSegmentPattern);
  const poolHandle = groupMatch?.[1] || "";
  if (!groupMatch || !poolHandlePattern.test(poolHandle)) {
    throw new Error("--group-url contains an unsupported Holvi group path.");
  }
  return { groupPathSegment, poolHandle };
}

export function validateConfig(value: unknown): BridgeConfig {
  const config = value as Partial<BridgeConfig>;
  if (!config || config.version !== 2) {
    throw new Error("Holvi Agent Bridge config version is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(config.hmacSecret || "")) {
    throw new Error("Holvi Agent Bridge config has no valid request secret.");
  }
  if (
    !config.groupPathSegment ||
    parseGroupUrl(`${ACCOUNT_ORIGIN}/group/${encodeURIComponent(config.groupPathSegment)}/`)
      .poolHandle !== config.poolHandle
  ) {
    throw new Error("Holvi Agent Bridge config has an invalid group target.");
  }
  validateUuid(config.paymentAccountUuid || "", "Payment account");
  if (
    !Array.isArray(config.capabilities) ||
    config.capabilities.length < 1 ||
    config.capabilities.some(
      (capability) =>
        !SUPPORTED_CAPABILITIES.includes(capability as Capability),
    ) ||
    new Set(config.capabilities).size !== config.capabilities.length
  ) {
    throw new Error("Holvi Agent Bridge config has invalid capabilities.");
  }
  if (
    !Array.isArray(config.receiptRoots) ||
    config.receiptRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))
  ) {
    throw new Error("Holvi Agent Bridge config has an invalid attachment folder.");
  }
  if (
    config.capabilities.includes("attachments.write") &&
    config.receiptRoots.length < 1
  ) {
    throw new Error("attachments.write requires an approved attachment folder.");
  }
  if (
    !Number.isSafeInteger(config.maxFileBytes) ||
    (config.maxFileBytes || 0) < 1 ||
    (config.maxFileBytes || 0) > DEFAULT_MAX_FILE_BYTES
  ) {
    throw new Error("Holvi Agent Bridge config has an invalid file-size limit.");
  }
  return config as BridgeConfig;
}

export function publicConfig(config: BridgeConfig): PublicBridgeConfig {
  return {
    groupPathSegment: config.groupPathSegment,
    poolHandle: config.poolHandle,
    paymentAccountUuid: config.paymentAccountUuid,
    capabilities: [...config.capabilities],
    maxFileBytes: config.maxFileBytes,
  };
}

export async function loadConfig(): Promise<{
  config: BridgeConfig;
  configPath: string;
}> {
  const configPath = process.env.HOLVI_AGENT_BRIDGE_CONFIG || defaultConfigPath();
  const stat = await lstat(configPath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Config must be a regular file with 0600 permissions: ${configPath}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Config must be owned by the current user: ${configPath}`);
  }
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  return { config, configPath };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const mimeByExtension = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
]);

export async function resolveReceiptRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root || "")) {
    throw new Error("Receipt roots must be absolute paths.");
  }
  const resolved = await realpath(root);
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Receipt root must be a directory: ${root}`);
  }
  await access(resolved, fsConstants.R_OK);
  return resolved;
}

export async function resolveReceiptFile(
  config: BridgeConfig,
  filePath: string,
): Promise<ReceiptFile> {
  if (!path.isAbsolute(filePath || "")) {
    throw new Error("Receipt path must be absolute.");
  }

  const candidate = await realpath(filePath);
  const roots = await Promise.all(config.receiptRoots.map(resolveReceiptRoot));
  if (!roots.some((root) => isInside(root, candidate))) {
    throw new Error("Receipt path is outside the approved receipt folders.");
  }

  const stat = await lstat(candidate);
  if (!stat.isFile()) {
    throw new Error("Receipt path must identify a regular file.");
  }
  if (stat.size < 1 || stat.size > config.maxFileBytes) {
    throw new Error(`Receipt size must be between 1 and ${config.maxFileBytes} bytes.`);
  }
  await access(candidate, fsConstants.R_OK);

  const extension = path.extname(candidate).toLowerCase();
  const mimeType = mimeByExtension.get(extension);
  if (!mimeType) {
    throw new Error("Receipt type must be PDF, PNG, JPEG, or GIF.");
  }

  return {
    path: candidate,
    fileName: path.basename(candidate),
    mimeType,
    size: stat.size,
  };
}

export const internal = { isInside, validateConfig };
