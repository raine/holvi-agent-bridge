import assert from "node:assert/strict";
import { test } from "node:test";
import { internal } from "../dist/native/cli.js";

test("install parsing preserves repeated receipt roots", () => {
  assert.deepEqual(
    internal.parseArguments([
      "install",
      "--group-url",
      "https://account.app.holvi.com/group/AbC123+example/",
      "--account",
      "11111111-1111-4111-8111-111111111111",
      "--capability",
      "transactions.read",
      "--capability",
      "attachments.write",
      "--receipt-root",
      "/receipts/one",
      "--receipt-root",
      "/receipts/two",
      "--yes",
    ]),
    {
      command: "install",
      options: {
        "group-url": "https://account.app.holvi.com/group/AbC123+example/",
        account: "11111111-1111-4111-8111-111111111111",
        capability: ["transactions.read", "attachments.write"],
        "receipt-root": ["/receipts/one", "/receipts/two"],
        yes: true,
      },
    },
  );
});

test("transactions parsing accepts the missing attachments filter", () => {
  assert.deepEqual(
    internal.parseArguments([
      "transactions",
      "--from",
      "2026-07-01",
      "--to",
      "2026-07-31",
      "--missing-attachments",
      "--json",
    ]),
    {
      command: "transactions",
      options: {
        from: "2026-07-01",
        to: "2026-07-31",
        "missing-attachments": true,
        json: true,
      },
    },
  );
});

test("date validation rejects normalized overflow dates", () => {
  assert.equal(internal.validateDate("2026-02-28", "from"), "2026-02-28");
  assert.throws(
    () => internal.validateDate("2026-02-31", "from"),
    /calendar date/,
  );
});
