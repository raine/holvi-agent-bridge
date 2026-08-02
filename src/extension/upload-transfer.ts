const uploadMimeTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/;
const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const fileChunkBytes = 480 * 1024;
export const uploadTransferExpiryMs = 30_000;

export interface UploadTransfer {
  id: string;
  debtUuid: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkCount: number;
  chunks: string[];
}

export interface UploadStart {
  id: string;
  debtUuid: unknown;
  fileName: unknown;
  mimeType: unknown;
  size: unknown;
  sha256: unknown;
  chunkCount: unknown;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function verifyUploadTransfer(
  upload: UploadTransfer,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = base64ToBytes(upload.chunks.join(""));
  if (bytes.byteLength !== upload.size) {
    throw new Error(
      "Receipt byte count changed during native messaging transfer.",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  if (bytesToHex(new Uint8Array(digest)) !== upload.sha256) {
    throw new Error(
      "Receipt checksum changed during native messaging transfer.",
    );
  }
  return bytes;
}

export class UploadTransferError extends Error {
  constructor(
    message: string,
    readonly transferId: string,
  ) {
    super(message);
  }
}

function validFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

export class UploadTransferLifecycle {
  private active:
    | {
        transfer: UploadTransfer;
        state: "receiving" | "committing";
        expiresAt: number;
      }
    | undefined;

  start(message: UploadStart, maxFileBytes: number, now: number): void {
    if (this.active) {
      throw new UploadTransferError(
        "Another receipt upload is active.",
        message.id,
      );
    }
    if (
      typeof message.debtUuid !== "string" ||
      !uuidPattern.test(message.debtUuid)
    ) {
      throw new UploadTransferError(
        "A valid Holvi debt UUID is required.",
        message.id,
      );
    }
    if (
      !Number.isSafeInteger(message.size) ||
      (message.size as number) < 1 ||
      (message.size as number) > maxFileBytes
    ) {
      throw new UploadTransferError(
        "Receipt size is outside the configured limit.",
        message.id,
      );
    }
    const expectedChunks = Math.ceil((message.size as number) / fileChunkBytes);
    if (message.chunkCount !== expectedChunks) {
      throw new UploadTransferError(
        "Receipt chunk count does not match its size.",
        message.id,
      );
    }
    if (
      typeof message.sha256 !== "string" ||
      !sha256Pattern.test(message.sha256)
    ) {
      throw new UploadTransferError("Receipt checksum is invalid.", message.id);
    }
    if (
      !validFileName(message.fileName) ||
      typeof message.mimeType !== "string" ||
      !uploadMimeTypes.has(message.mimeType)
    ) {
      throw new UploadTransferError(
        "Receipt filename or media type is invalid.",
        message.id,
      );
    }

    this.active = {
      transfer: {
        id: message.id,
        debtUuid: message.debtUuid as string,
        fileName: message.fileName,
        mimeType: message.mimeType as string,
        size: message.size as number,
        sha256: message.sha256 as string,
        chunkCount: message.chunkCount as number,
        chunks: [],
      },
      state: "receiving",
      expiresAt: now + uploadTransferExpiryMs,
    };
  }

  append(id: string, index: unknown, data: unknown, now: number): void {
    const active = this.receiving(id, now);
    if (
      index !== active.transfer.chunks.length ||
      typeof data !== "string" ||
      data.length < 1 ||
      data.length > 700_000 ||
      !base64Pattern.test(data)
    ) {
      this.active = undefined;
      throw new UploadTransferError(
        "Receipt chunks arrived out of order or exceeded their limit.",
        id,
      );
    }
    active.transfer.chunks.push(data);
  }

  complete(id: string, now: number): UploadTransfer {
    const active = this.receiving(id, now);
    if (active.transfer.chunks.length !== active.transfer.chunkCount) {
      this.active = undefined;
      throw new UploadTransferError(
        "Receipt transfer ended before every chunk arrived.",
        id,
      );
    }
    active.state = "committing";
    return active.transfer;
  }

  finish(id: string): void {
    if (this.active?.transfer.id === id) {
      this.active = undefined;
    }
  }

  cancel(): string | null {
    const id = this.active?.transfer.id || null;
    this.active = undefined;
    return id;
  }

  expire(now: number): string | null {
    if (
      !this.active ||
      this.active.state !== "receiving" ||
      now < this.active.expiresAt
    ) {
      return null;
    }
    const id = this.active.transfer.id;
    this.active = undefined;
    return id;
  }

  hasActiveTransfer(): boolean {
    return this.active !== undefined;
  }

  private receiving(
    id: string,
    now: number,
  ): NonNullable<UploadTransferLifecycle["active"]> {
    const expiredId = this.expire(now);
    if (expiredId) {
      throw new UploadTransferError("Receipt transfer expired.", expiredId);
    }
    if (
      !this.active ||
      this.active.transfer.id !== id ||
      this.active.state !== "receiving"
    ) {
      throw new UploadTransferError(
        "Upload completion did not match an active transfer.",
        id,
      );
    }
    return this.active;
  }
}
