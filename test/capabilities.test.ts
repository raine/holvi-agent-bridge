import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enabledActions,
  requiredCapabilities,
} from "../dist/native/capabilities.js";

test("unknown actions have no capability mapping", () => {
  assert.equal(requiredCapabilities("fetch"), null);
});

test("read-only scope disables attachment writes", () => {
  assert.deepEqual(enabledActions(["transactions.read"]), {
    doctor: true,
    scan: true,
    preview: true,
    upload: false,
  });
});

test("attachment upload requires both enabled capabilities", () => {
  assert.equal(
    enabledActions(["transactions.read", "attachments.write"]).upload,
    true,
  );
});
