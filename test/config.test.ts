import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  internal,
  parseGroupUrl,
  resolveReceiptFile,
  type BridgeConfig,
} from "../dist/native/config.js";

function config(receiptRoots: string[]): BridgeConfig {
  return {
    version: 2,
    groupPathSegment: "AbC123+example-company",
    poolHandle: "AbC123",
    paymentAccountUuid: "11111111-1111-4111-8111-111111111111",
    capabilities: ["transactions.read", "attachments.write"],
    receiptRoots,
    maxFileBytes: 1024 * 1024,
    hmacSecret: "b".repeat(64),
  };
}

test("group URL parsing separates the API handle from the browser segment", () => {
  assert.deepEqual(
    parseGroupUrl(
      "https://account.app.holvi.com/group/AbC123+example-company/payments-feed/",
    ),
    {
      groupPathSegment: "AbC123+example-company",
      poolHandle: "AbC123",
    },
  );
  assert.throws(
    () => parseGroupUrl("https://example.com/group/AbC123+example-company/"),
    /must use/,
  );
});

test("config rejects a group segment that does not match its API handle", () => {
  assert.throws(
    () => internal.validateConfig({ ...config(["/tmp"]), poolHandle: "Other" }),
    /invalid group target/,
  );
});

test("config rejects unknown capabilities", () => {
  assert.throws(
    () =>
      internal.validateConfig({
        ...config(["/tmp"]),
        capabilities: ["http.anything"],
      }),
    /invalid capabilities/,
  );
});

test("read-only config needs no attachment roots", () => {
  assert.doesNotThrow(() =>
    internal.validateConfig({
      ...config([]),
      capabilities: ["transactions.read"],
    }),
  );
});

test("attachment writes require an approved root", () => {
  assert.throws(
    () => internal.validateConfig(config([])),
    /requires an approved attachment folder/,
  );
});

test("receipt resolution accepts approved files and blocks symlink escapes", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "holvi-agent-bridge-test-"),
  );
  const approved = path.join(temporary, "approved");
  const outside = path.join(temporary, "outside");
  await mkdir(approved);
  await mkdir(outside);
  const receipt = path.join(approved, "receipt.pdf");
  const escaped = path.join(approved, "escaped.pdf");
  const outsideReceipt = path.join(outside, "outside.pdf");
  await writeFile(receipt, "%PDF-1.7\nreceipt\n");
  await writeFile(outsideReceipt, "%PDF-1.7\noutside\n");
  await symlink(outsideReceipt, escaped);

  const resolved = await resolveReceiptFile(config([approved]), receipt);
  assert.equal(resolved.path, await realpath(receipt));
  assert.equal(resolved.mimeType, "application/pdf");
  await assert.rejects(
    () => resolveReceiptFile(config([approved]), escaped),
    /outside the approved receipt folders/,
  );
});
