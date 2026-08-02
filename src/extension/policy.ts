export const actionCapabilities = {
  doctor: [],
  transactions: ["transactions.read"],
  preview: ["transactions.read"],
  upload: ["transactions.read", "attachments.write"],
  "bookkeeping.get": ["bookkeeping.read"],
  "bookkeeping.categories": ["bookkeeping.read"],
  "bookkeeping.suggestions": ["bookkeeping.read"],
  "audit.list": ["audit.read"],
} as const satisfies Record<string, readonly string[]>;

export type BridgeAction = keyof typeof actionCapabilities;

export const supportedCapabilities: ReadonlySet<string> = new Set(
  Object.values(actionCapabilities).flat(),
);

export function requiredCapabilities(action: string): readonly string[] | null {
  return Object.hasOwn(actionCapabilities, action)
    ? actionCapabilities[action as BridgeAction]
    : null;
}
