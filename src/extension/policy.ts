export const minimumFileBytes = 1;

export const actionCapabilities = {
  doctor: [],
  "transactions.list": ["transactions.read"],
  "debts.get": ["transactions.read"],
  "comments.list": ["transactions.read"],
  "comments.create": ["transactions.read", "comments.write"],
  "attachments.upload": ["transactions.read", "attachments.write"],
  "attachments.delete": ["transactions.read", "attachments.delete"],
  "bookkeeping.get": ["bookkeeping.read"],
  "bookkeeping.categories": ["bookkeeping.read"],
  "bookkeeping.suggestions": ["bookkeeping.read"],
  "bookkeeping.set-description": ["bookkeeping.write"],
  "audit.list": ["audit.read"],
} as const satisfies Record<string, readonly string[]>;

export type BridgeAction = keyof typeof actionCapabilities;
export type CommandAction = Exclude<BridgeAction, "attachments.upload">;

export const commandActions = {
  doctor: true,
  "transactions.list": true,
  "debts.get": true,
  "comments.list": true,
  "comments.create": true,
  "attachments.delete": true,
  "bookkeeping.get": true,
  "bookkeeping.categories": true,
  "bookkeeping.suggestions": true,
  "bookkeeping.set-description": true,
  "audit.list": true,
} as const satisfies Record<CommandAction, true>;

export const supportedCapabilities: ReadonlySet<string> = new Set(
  Object.values(actionCapabilities).flat(),
);

export function isBridgeAction(action: string): action is BridgeAction {
  return Object.hasOwn(actionCapabilities, action);
}

export function requiredCapabilities(action: string): readonly string[] | null {
  return isBridgeAction(action) ? actionCapabilities[action] : null;
}
