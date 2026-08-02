import type { Capability } from "./config.js";

export const ACTION_CAPABILITIES = {
  doctor: ["transactions.read"],
  scan: ["transactions.read"],
  preview: ["transactions.read"],
  upload: ["transactions.read", "attachments.write"],
} as const satisfies Record<string, readonly Capability[]>;

export type BridgeAction = keyof typeof ACTION_CAPABILITIES;

export function requiredCapabilities(
  action: string,
): readonly Capability[] | null {
  if (!Object.hasOwn(ACTION_CAPABILITIES, action)) {
    return null;
  }
  return ACTION_CAPABILITIES[action as BridgeAction];
}

export function enabledActions(
  capabilities: readonly Capability[],
): Record<BridgeAction, boolean> {
  return Object.fromEntries(
    Object.entries(ACTION_CAPABILITIES).map(([action, required]) => [
      action,
      required.every((capability) => capabilities.includes(capability)),
    ]),
  ) as Record<BridgeAction, boolean>;
}
