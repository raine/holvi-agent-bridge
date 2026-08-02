import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NativeMessageDecoder,
  REQUEST_MAX_AGE_MS,
  encodeNativeMessage,
  signRequest,
  verifyRequest,
} from "../dist/native/protocol.js";

const secret = "a".repeat(64);

test("native message decoder accepts fragmented frames", () => {
  const frame = encodeNativeMessage({ type: "result", ok: true });
  const decoder = new NativeMessageDecoder();

  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(frame.subarray(7)), [
    { type: "result", ok: true },
  ]);
});

test("signed local requests authenticate once", () => {
  const request = signRequest(secret, "scan", { from: "2026-07-01" });
  const seen = new Map<string, number>();

  assert.deepEqual(verifyRequest(secret, request, seen), {
    version: 1,
    id: request.id,
    issuedAt: request.issuedAt,
    nonce: request.nonce,
    action: "scan",
    params: { from: "2026-07-01" },
  });
  assert.throws(
    () => verifyRequest(secret, request, seen),
    /nonce was already used/,
  );
});

test("signed local requests reject tampering and expiration", () => {
  const request = signRequest(secret, "preview", { debtUuid: "one" });

  assert.throws(
    () =>
      verifyRequest(
        secret,
        { ...request, params: { debtUuid: "two" } },
        new Map(),
      ),
    /authentication failed/,
  );
  assert.throws(
    () =>
      verifyRequest(
        secret,
        request,
        new Map(),
        request.issuedAt + REQUEST_MAX_AGE_MS + 1,
      ),
    /invalid or expired/,
  );
});
