#!/usr/bin/env node

import crypto from "node:crypto";
import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import net from "node:net";
import { requiredCapabilities } from "./capabilities.js";
import {
  EXTENSION_ORIGIN,
  type BridgeConfig,
  loadConfig,
  publicConfig,
  resolveReceiptFile,
  socketPath,
  validateUuid,
} from "./config.js";
import {
  type BridgeRequest,
  encodeNativeMessage,
  MAX_SOCKET_REQUEST_BYTES,
  NativeMessageDecoder,
  verifyRequest,
} from "./protocol.js";

const FILE_CHUNK_BYTES = 480 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const seenNonces = new Map<string, number>();
const pending = new Map<
  string,
  { socket: net.Socket; timeout: NodeJS.Timeout }
>();
const decoder = new NativeMessageDecoder();
let tabReady = false;
let activeRequestId: string | null = null;
let writeChain: Promise<void> = Promise.resolve();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  process.stderr.write(`[holvi-agent-bridge] ${message}\n`);
}

function writeNative(message: unknown): Promise<void> {
  const frame = encodeNativeMessage(message);
  writeChain = writeChain.then(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(frame, (error) =>
          error ? reject(error) : resolve(),
        );
      }),
  );
  return writeChain;
}

function sendSocket(socket: net.Socket, response: unknown): void {
  if (!socket.destroyed) {
    socket.end(`${JSON.stringify(response)}\n`);
  }
}

function finishRequest(id: string, response: unknown): void {
  const item = pending.get(id);
  if (!item) {
    return;
  }
  clearTimeout(item.timeout);
  pending.delete(id);
  if (activeRequestId === id) {
    activeRequestId = null;
  }
  sendSocket(item.socket, response);
}

interface NativeResult {
  type?: string;
  id?: string;
  ok?: boolean;
  data?: unknown;
  error?: unknown;
}

function handleNativeMessage(value: unknown): void {
  const message = value as NativeResult;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "tab_ready") {
    tabReady = true;
    return;
  }
  if (message.type === "tab_unavailable") {
    tabReady = false;
    return;
  }
  if (message.type === "result" && message.id && pending.has(message.id)) {
    finishRequest(
      message.id,
      message.ok
        ? { ok: true, data: message.data }
        : {
            ok: false,
            error: errorMessage(
              message.error ?? "Holvi Agent Bridge request failed.",
            ),
          },
    );
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  try {
    for (const message of decoder.push(chunk)) {
      handleNativeMessage(message);
    }
  } catch (error) {
    log(errorMessage(error));
    process.exitCode = 1;
    process.stdin.destroy();
  }
});

async function socketIsActive(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(target);
    const done = (active: boolean) => {
      client.destroy();
      resolve(active);
    };
    client.setTimeout(300, () => done(false));
    client.once("connect", () => done(true));
    client.once("error", () => done(false));
  });
}

async function prepareSocket(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isSocket()) {
      throw new Error(`Refused to replace a non-socket path: ${target}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(
        `Refused to replace a socket owned by another user: ${target}`,
      );
    }
    if (await socketIsActive(target)) {
      throw new Error("Another Holvi Agent Bridge native host is active.");
    }
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function sendUpload(
  request: BridgeRequest,
  config: BridgeConfig,
): Promise<void> {
  const filePath =
    typeof request.params.filePath === "string" ? request.params.filePath : "";
  const debtUuid = validateUuid(
    typeof request.params.debtUuid === "string" ? request.params.debtUuid : "",
    "Debt",
  );
  const receipt = await resolveReceiptFile(config, filePath);
  const bytes = await readFile(receipt.path);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const chunkCount = Math.ceil(bytes.length / FILE_CHUNK_BYTES);

  await writeNative({
    type: "upload_start",
    id: request.id,
    debtUuid,
    fileName: receipt.fileName,
    mimeType: receipt.mimeType,
    size: bytes.length,
    sha256,
    chunkCount,
  });

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * FILE_CHUNK_BYTES;
    const data = bytes
      .subarray(start, start + FILE_CHUNK_BYTES)
      .toString("base64");
    await writeNative({ type: "upload_chunk", id: request.id, index, data });
  }
  await writeNative({ type: "upload_end", id: request.id });
}

async function dispatchRequest(
  request: BridgeRequest,
  config: BridgeConfig,
  socket: net.Socket,
): Promise<void> {
  const requirements = requiredCapabilities(request.action);
  if (!requirements) {
    throw new Error("Unsupported local bridge action.");
  }
  const missingCapabilities = requirements.filter(
    (capability) => !config.capabilities.includes(capability),
  );
  if (missingCapabilities.length > 0) {
    throw new Error(
      `Action requires disabled capabilities: ${missingCapabilities.join(", ")}.`,
    );
  }
  if (!tabReady) {
    throw new Error(
      "Open or reload the configured signed-in Holvi group tab in Chrome.",
    );
  }
  if (activeRequestId) {
    throw new Error("Another Holvi Agent Bridge request is active.");
  }
  if (request.action === "upload" && request.params.confirmed !== true) {
    throw new Error("Receipt upload requires explicit confirmation.");
  }

  activeRequestId = request.id;
  const timeout = setTimeout(() => {
    finishRequest(request.id, {
      ok: false,
      error:
        "Holvi Agent Bridge timed out. Inspect the transaction before retrying an upload.",
    });
  }, REQUEST_TIMEOUT_MS);
  pending.set(request.id, { socket, timeout });

  try {
    if (request.action === "upload") {
      await sendUpload(request, config);
    } else {
      await writeNative({
        type: "command",
        id: request.id,
        action: request.action,
        params: request.params,
      });
    }
  } catch (error) {
    finishRequest(request.id, { ok: false, error: errorMessage(error) });
  }
}

function handleSocket(socket: net.Socket, config: BridgeConfig): void {
  socket.setEncoding("utf8");
  let input = "";
  let handled = false;

  socket.on("data", (chunk: string) => {
    if (handled) {
      return;
    }
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_SOCKET_REQUEST_BYTES) {
      handled = true;
      sendSocket(socket, {
        ok: false,
        error: "Local bridge request is too large.",
      });
      return;
    }
    const newline = input.indexOf("\n");
    if (newline === -1) {
      return;
    }

    handled = true;
    socket.pause();
    try {
      const signed: unknown = JSON.parse(input.slice(0, newline));
      const request = verifyRequest(config.hmacSecret, signed, seenNonces);
      dispatchRequest(request, config, socket).catch((error) => {
        if (pending.has(request.id)) {
          finishRequest(request.id, { ok: false, error: errorMessage(error) });
        } else {
          sendSocket(socket, { ok: false, error: errorMessage(error) });
        }
      });
    } catch (error) {
      sendSocket(socket, { ok: false, error: errorMessage(error) });
    }
  });
}

async function main(): Promise<void> {
  const callerOrigin = process.argv[2] || "";
  if (callerOrigin !== EXTENSION_ORIGIN) {
    throw new Error(
      "Native host caller origin is not the configured extension.",
    );
  }

  const { config } = await loadConfig();
  const target = socketPath();
  await prepareSocket(target);

  const server = net.createServer((socket) => handleSocket(socket, config));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, resolve);
  });
  await chmod(target, 0o600);

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        for (const id of pending.keys()) {
          finishRequest(id, {
            ok: false,
            error: "The Chrome connection to Holvi Agent Bridge closed.",
          });
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          const stat = await lstat(target);
          if (
            stat.isSocket() &&
            (typeof process.getuid !== "function" ||
              stat.uid === process.getuid())
          ) {
            await unlink(target);
          }
        } catch {
          // Socket cleanup is best effort during process shutdown.
        }
      })();
    }
    return cleanupPromise;
  };
  const exitAfterCleanup = (): void => {
    void cleanup().then(
      () => process.exit(0),
      (error) => {
        log(errorMessage(error));
        process.exit(1);
      },
    );
  };
  process.stdin.once("end", exitAfterCleanup);
  process.once("SIGTERM", exitAfterCleanup);
  process.once("SIGINT", exitAfterCleanup);

  process.stdout.once("error", (error) => {
    log(error.message);
    process.exitCode = 1;
    process.stdin.destroy();
  });

  await writeNative({ type: "host_ready", config: publicConfig(config) });
}

main().catch((error) => {
  log(errorMessage(error));
  process.exit(1);
});
