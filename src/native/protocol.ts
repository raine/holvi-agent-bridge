import crypto from "node:crypto";

export const MAX_NATIVE_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SOCKET_REQUEST_BYTES = 128 * 1024;
export const REQUEST_MAX_AGE_MS = 30_000;

export interface BridgeRequest {
  version: 1;
  id: string;
  issuedAt: number;
  nonce: string;
  action: string;
  params: Record<string, unknown>;
}

export interface SignedBridgeRequest extends BridgeRequest {
  mac: string;
}

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_OUTPUT_BYTES) {
    throw new Error("Native message exceeds Chrome's 1 MiB host output limit.");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > MAX_NATIVE_INPUT_BYTES) {
        throw new Error("Chrome native message exceeds the input limit.");
      }
      if (this.buffer.length < size + 4) {
        break;
      }
      const body = this.buffer.subarray(4, size + 4).toString("utf8");
      this.buffer = this.buffer.subarray(size + 4);
      messages.push(JSON.parse(body));
    }

    return messages;
  }
}

function requestPayload(request: SignedBridgeRequest | BridgeRequest): BridgeRequest {
  return {
    version: request.version,
    id: request.id,
    issuedAt: request.issuedAt,
    nonce: request.nonce,
    action: request.action,
    params: request.params,
  };
}

function requestMac(
  secret: string,
  request: SignedBridgeRequest | BridgeRequest,
): string {
  return crypto
    .createHmac("sha256", Buffer.from(secret, "hex"))
    .update(JSON.stringify(requestPayload(request)))
    .digest("hex");
}

export function signRequest(
  secret: string,
  action: string,
  params: Record<string, unknown> = {},
): SignedBridgeRequest {
  const request: BridgeRequest = {
    version: 1,
    id: crypto.randomUUID(),
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
    action,
    params,
  };
  return { ...request, mac: requestMac(secret, request) };
}

export function verifyRequest(
  secret: string,
  value: unknown,
  seenNonces: Map<string, number>,
  clock = Date.now(),
): BridgeRequest {
  const request = value as Partial<SignedBridgeRequest>;
  if (
    !request ||
    request.version !== 1 ||
    !/^[0-9a-f-]{16,64}$/i.test(request.id || "") ||
    !Number.isSafeInteger(request.issuedAt) ||
    Math.abs(clock - (request.issuedAt || 0)) > REQUEST_MAX_AGE_MS ||
    !/^[a-f0-9]{32}$/.test(request.nonce || "") ||
    typeof request.action !== "string" ||
    typeof request.params !== "object" ||
    request.params === null ||
    Array.isArray(request.params) ||
    !/^[a-f0-9]{64}$/.test(request.mac || "")
  ) {
    throw new Error("Local bridge request is invalid or expired.");
  }
  const nonce = request.nonce || "";
  if (seenNonces.has(nonce)) {
    throw new Error("Local bridge request nonce was already used.");
  }

  const signed = request as SignedBridgeRequest;
  const expected = Buffer.from(requestMac(secret, signed), "hex");
  const supplied = Buffer.from(signed.mac, "hex");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw new Error("Local bridge request authentication failed.");
  }

  seenNonces.set(signed.nonce, signed.issuedAt);
  for (const [nonce, issuedAt] of seenNonces) {
    if (clock - issuedAt > REQUEST_MAX_AGE_MS) {
      seenNonces.delete(nonce);
    }
  }
  return requestPayload(signed);
}
