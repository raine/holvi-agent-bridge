import { describe, expect, test } from "bun:test";
import {
  fileChunkBytes,
  UploadTransferLifecycle,
  uploadTransferExpiryMs,
  verifyUploadTransfer,
} from "./upload-transfer.js";

const transferId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherTransferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const debtUuid = "11111111-1111-4111-8111-111111111111";
const maxFileBytes = 25 * 1024 * 1024;

function start(
  lifecycle: UploadTransferLifecycle,
  overrides: Record<string, unknown> = {},
  now = 1000,
): void {
  lifecycle.start(
    {
      id: transferId,
      debtUuid,
      fileName: "receipt.pdf",
      mimeType: "application/pdf",
      size: 3,
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      chunkCount: 1,
      ...overrides,
    },
    maxFileBytes,
    now,
  );
}

describe("upload transfer lifecycle", () => {
  test("cancels an interrupted transfer and releases its slot", () => {
    const lifecycle = new UploadTransferLifecycle();
    start(lifecycle);

    expect(lifecycle.cancel()).toBe(transferId);
    expect(lifecycle.hasActiveTransfer()).toBeFalse();
    start(lifecycle, { id: otherTransferId });
    expect(lifecycle.hasActiveTransfer()).toBeTrue();
  });

  test("expires an interrupted transfer deterministically", () => {
    const lifecycle = new UploadTransferLifecycle();
    start(lifecycle, {}, 1000);

    expect(lifecycle.expire(1000 + uploadTransferExpiryMs - 1)).toBeNull();
    expect(lifecycle.expire(1000 + uploadTransferExpiryMs)).toBe(transferId);
    expect(lifecycle.hasActiveTransfer()).toBeFalse();
    start(lifecycle, { id: otherTransferId }, 1000 + uploadTransferExpiryMs);
  });

  test("rejects malformed starts and chunks", () => {
    const lifecycle = new UploadTransferLifecycle();
    expect(() => start(lifecycle, { size: 0, chunkCount: 0 })).toThrow(
      "outside the configured limit",
    );
    expect(lifecycle.hasActiveTransfer()).toBeFalse();

    start(lifecycle);
    expect(() => lifecycle.append(transferId, 0, "%%%", 1001)).toThrow(
      "out of order or exceeded",
    );
    expect(lifecycle.hasActiveTransfer()).toBeFalse();
  });

  test("rejects out-of-order and incomplete transfers", () => {
    const lifecycle = new UploadTransferLifecycle();
    start(lifecycle, {
      size: fileChunkBytes + 1,
      chunkCount: 2,
    });
    expect(() => lifecycle.append(transferId, 1, "YWJj", 1001)).toThrow(
      "out of order",
    );
    expect(lifecycle.hasActiveTransfer()).toBeFalse();

    start(lifecycle, {
      size: fileChunkBytes + 1,
      chunkCount: 2,
    });
    lifecycle.append(transferId, 0, "YWJj", 1001);
    expect(() => lifecycle.complete(transferId, 1002)).toThrow(
      "before every chunk arrived",
    );
    expect(lifecycle.hasActiveTransfer()).toBeFalse();
  });

  test("rejects chunks beyond the declared chunk count", () => {
    const lifecycle = new UploadTransferLifecycle();
    start(lifecycle);
    lifecycle.append(transferId, 0, "YWJj", 1001);

    expect(() => lifecycle.append(transferId, 1, "ZA==", 1002)).toThrow(
      "out of order or exceeded",
    );
    expect(lifecycle.hasActiveTransfer()).toBeFalse();
  });

  test("completes exact ordered chunks and holds the slot through commit", async () => {
    const lifecycle = new UploadTransferLifecycle();
    start(lifecycle);
    lifecycle.append(transferId, 0, "YWJj", 1001);

    const transfer = lifecycle.complete(transferId, 1002);
    expect(transfer).toMatchObject({
      id: transferId,
      debtUuid,
      size: 3,
      chunkCount: 1,
      chunks: ["YWJj"],
    });
    expect(Array.from(await verifyUploadTransfer(transfer))).toEqual([
      97, 98, 99,
    ]);
    expect(() => start(lifecycle, { id: otherTransferId }, 1003)).toThrow(
      "Another receipt upload is active",
    );

    lifecycle.finish(transferId);
    expect(lifecycle.hasActiveTransfer()).toBeFalse();
  });

  test("verifies completed transfer size and checksum", async () => {
    const lifecycle = new UploadTransferLifecycle();
    start(lifecycle);
    lifecycle.append(transferId, 0, "YWJj", 1001);
    const transfer = lifecycle.complete(transferId, 1002);

    await expect(
      verifyUploadTransfer({ ...transfer, size: 4 }),
    ).rejects.toThrow("byte count changed");
    await expect(
      verifyUploadTransfer({ ...transfer, sha256: "0".repeat(64) }),
    ).rejects.toThrow("checksum changed");
  });

  test("preserves an active transfer when another start is rejected", () => {
    const lifecycle = new UploadTransferLifecycle();
    start(lifecycle);
    expect(() => start(lifecycle, { id: otherTransferId })).toThrow(
      "Another receipt upload is active",
    );
    expect(lifecycle.hasActiveTransfer()).toBeTrue();
  });
});
