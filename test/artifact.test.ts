import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const expectedExtensionId = "oeedcemphbobfehfmcllmjhhhjgahgeb";

function extensionId(publicKey: string): string {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest();
  return Array.from(digest.subarray(0, 16), (byte) =>
    `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`,
  ).join("");
}

test("manifest key produces the native host allowlisted extension ID", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../dist/extension/manifest.json", import.meta.url), "utf8"),
  ) as { key: string; content_scripts: Array<{ matches: string[] }> };

  assert.equal(extensionId(manifest.key), expectedExtensionId);
  assert.deepEqual(manifest.content_scripts[0]?.matches, [
    "https://account.app.holvi.com/group/*",
  ]);
});
