import { describe, expect, test } from "bun:test";
import type { StaticBridgeConfig } from "./background-types.js";
import {
  BridgeSession,
  groupPathSegmentFromUrl,
  validateHostIdentity,
  validateRuntimeConfig,
} from "./session.js";

const staticConfig: StaticBridgeConfig = {
  accountOrigin: "https://account.app.holvi.com",
  apiOrigin: "https://holvi.com",
  groupPathPrefix: "/group/",
  nativeHostName: "app.holvi_agent_bridge",
  nativeProtocolVersion: 1,
  extensionVersion: "0.1.0",
  maxFileBytes: 25 * 1024 * 1024,
  maxTransactionPages: 200,
  maxTransactionResults: 10_000,
};

const runtimeConfig = {
  groupPathSegment: "example+11111111-1111-4111-8111-111111111111",
  poolHandle: "example",
  paymentAccountUuid: "22222222-2222-4222-8222-222222222222",
  capabilities: ["transactions.read", "attachments.write"],
  maxFileBytes: 1024,
};

describe("bridge session", () => {
  test("derives group identity only from the configured Chrome origin", () => {
    expect(
      groupPathSegmentFromUrl(
        `https://account.app.holvi.com/group/${runtimeConfig.groupPathSegment}/feed`,
        staticConfig.accountOrigin,
      ),
    ).toBe(runtimeConfig.groupPathSegment);
    expect(
      groupPathSegmentFromUrl(
        `https://example.test/group/${runtimeConfig.groupPathSegment}/feed`,
        staticConfig.accountOrigin,
      ),
    ).toBe("");
    expect(
      groupPathSegmentFromUrl("not a URL", staticConfig.accountOrigin),
    ).toBe("");
  });

  test("validates the native account and capability boundary", () => {
    expect(validateRuntimeConfig(runtimeConfig, staticConfig)).toEqual(
      runtimeConfig,
    );
    expect(() =>
      validateRuntimeConfig(
        { ...runtimeConfig, poolHandle: "another-pool" },
        staticConfig,
      ),
    ).toThrow("invalid Holvi account boundary");
    expect(() =>
      validateRuntimeConfig(
        {
          ...runtimeConfig,
          capabilities: ["transactions.read", "unknown.read"],
        },
        staticConfig,
      ),
    ).toThrow("invalid Holvi account boundary");
    expect(() =>
      validateRuntimeConfig(
        { ...runtimeConfig, maxFileBytes: staticConfig.maxFileBytes + 1 },
        staticConfig,
      ),
    ).toThrow("invalid Holvi account boundary");
  });

  test("mirrors the native pool-handle grammar", () => {
    for (const poolHandle of ["A", "A_b-C9", `A${"b".repeat(127)}`]) {
      expect(() =>
        validateRuntimeConfig(
          {
            ...runtimeConfig,
            groupPathSegment: `${poolHandle}+example`,
            poolHandle,
          },
          staticConfig,
        ),
      ).not.toThrow();
    }

    for (const poolHandle of [
      "_example",
      "-example",
      "example.pool",
      "exämple",
      `A${"b".repeat(128)}`,
    ]) {
      expect(() =>
        validateRuntimeConfig(
          {
            ...runtimeConfig,
            groupPathSegment: `${poolHandle}+example`,
            poolHandle,
          },
          staticConfig,
        ),
      ).toThrow("invalid Holvi account boundary");
    }
  });

  test("rejects incompatible native host identities with recovery guidance", () => {
    expect(validateHostIdentity(1, "0.1.0", staticConfig)).toEqual({
      protocolVersion: 1,
      hostVersion: "0.1.0",
    });
    expect(() => validateHostIdentity(2, "0.1.0", staticConfig)).toThrow(
      "Native host protocol 2 is incompatible with extension protocol 1",
    );
    expect(validateHostIdentity(1, "0.2.0", staticConfig)).toEqual({
      protocolVersion: 1,
      hostVersion: "0.2.0",
    });
    expect(() => validateHostIdentity(1, "", staticConfig)).toThrow(
      "invalid build version",
    );
  });

  test("checks every required capability independently", () => {
    const session = new BridgeSession(staticConfig);
    session.configure(runtimeConfig);

    expect(() =>
      session.requireCapabilities("transactions.read", "attachments.write"),
    ).not.toThrow();
    expect(() =>
      session.requireCapabilities("transactions.read", "bookkeeping.read"),
    ).toThrow("transactions.read, bookkeeping.read");

    session.clear();
    expect(() => session.requireCapabilities()).toThrow("Action requires");
  });
});
