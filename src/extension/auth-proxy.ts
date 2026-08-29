import type { Auth } from "./background-types.js";
import { validateUuid } from "./session.js";

const basePath = "/api/auth-proxy/2fa/v1/token/";
const maxResponseBytes = 128 * 1024;
const tokenIdPattern = /^[A-Za-z0-9_-]{1,256}$/;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an unexpected shape.`);
  }
  return value as JsonRecord;
}

function boundedSecret(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384) {
    throw new Error(`${label} has an unexpected shape.`);
  }
  return value;
}

function tokenId(value: unknown): string {
  const id = boundedSecret(value, "Holvi 2FA token ID");
  if (!tokenIdPattern.test(id)) {
    throw new Error("Holvi 2FA token ID has an unexpected shape.");
  }
  return id;
}

async function responseJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)
  ) {
    throw new Error("Holvi 2FA response exceeded its size limit.");
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxResponseBytes) {
    throw new Error("Holvi 2FA response exceeded its size limit.");
  }
  if (!response.ok) {
    throw new Error(`Holvi 2FA request returned ${response.status}.`);
  }
  if (!buffer.byteLength) return {};
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new Error("Holvi 2FA response was malformed.");
  }
}

export interface PaymentConfirmationSession {
  authorization: string;
  tokenId: string;
  expirationSeconds: number;
  hasMobileDevice: boolean;
}

export interface PaymentConfirmationStatus {
  state: "activated" | "expired" | "cancelled" | "rejected" | "pending";
  expirationSeconds: number;
}

export class AuthProxyClient {
  constructor(
    private readonly origin = "https://holvi.com",
    private readonly fetchRequest: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {
    const url = new URL(origin);
    if (
      url.href !== "https://holvi.com/" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      throw new Error("Holvi 2FA origin is invalid.");
    }
  }

  async initiatePaymentConfirmation(
    auth: Auth,
    debtUuid: string,
  ): Promise<PaymentConfirmationSession> {
    const uuid = validateUuid(debtUuid, "debt");
    const body = await this.request(
      `${basePath}initiate/`,
      "POST",
      `Bearer ${auth.token}`,
      auth.csrfToken,
      {
        action_name: "payment_confirm",
        action_data: { debt_uuid: uuid },
      },
    );
    const source = record(body, "Holvi 2FA initiation response");
    const meta = record(source.token_meta, "Holvi 2FA token metadata");
    const authorization = `${boundedSecret(source.token_type, "Holvi 2FA token type")} ${boundedSecret(source.id_token, "Holvi 2FA authorization token")}`;
    const devices = meta.totp_devices;
    if (!Array.isArray(devices) || devices.length > 20) {
      throw new Error("Holvi 2FA device list has an unexpected shape.");
    }
    const hasMobileDevice = devices.some((value) => {
      const device = record(value, "Holvi 2FA device");
      boundedSecret(device.id, "Holvi 2FA device ID");
      return device.device_type === "user_device";
    });
    const expirationSeconds = Number(
      source.expiration_delta ?? source.expires_in ?? 300,
    );
    if (
      !Number.isSafeInteger(expirationSeconds) ||
      expirationSeconds < 0 ||
      expirationSeconds > 3600
    ) {
      throw new Error("Holvi 2FA expiration has an unexpected shape.");
    }
    return {
      authorization,
      tokenId: tokenId(meta.twofactor_token_id),
      expirationSeconds,
      hasMobileDevice,
    };
  }

  async status(
    session: PaymentConfirmationSession,
  ): Promise<PaymentConfirmationStatus> {
    const body = await this.request(
      `${basePath}${tokenId(session.tokenId)}/`,
      "GET",
      session.authorization,
    );
    const source = record(body, "Holvi 2FA status response");
    const rawState = source.state;
    const expirationSeconds = Number(source.expiration_delta ?? 0);
    if (
      !Number.isSafeInteger(expirationSeconds) ||
      expirationSeconds < 0 ||
      expirationSeconds > 3600
    ) {
      throw new Error("Holvi 2FA status expiration has an unexpected shape.");
    }
    if (
      rawState === "activated" ||
      rawState === "expired" ||
      rawState === "cancelled" ||
      rawState === "rejected"
    ) {
      return { state: rawState, expirationSeconds };
    }
    if (expirationSeconds > 0) {
      return { state: "pending", expirationSeconds };
    }
    return { state: "expired", expirationSeconds: 0 };
  }

  async cancel(session: PaymentConfirmationSession): Promise<void> {
    await this.request(
      `${basePath}${tokenId(session.tokenId)}/`,
      "DELETE",
      session.authorization,
    );
  }

  private async request(
    path: string,
    method: "GET" | "POST" | "DELETE",
    authorization: string,
    csrfToken = "",
    body?: unknown,
  ): Promise<unknown> {
    const allowed =
      (method === "POST" && path === `${basePath}initiate/`) ||
      ((method === "GET" || method === "DELETE") &&
        new RegExp(`^${basePath}[A-Za-z0-9_-]{1,256}/$`).test(path));
    if (!allowed) throw new Error("Refused an unsupported Holvi 2FA path.");
    const headers = new Headers({
      Accept: "application/json",
      Authorization: authorization,
    });
    if (csrfToken) headers.set("X-CSRFToken", csrfToken);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const fetchRequest = this.fetchRequest;
    const response = await fetchRequest(`${this.origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    return responseJson(response);
  }
}
