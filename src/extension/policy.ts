export const minimumFileBytes = 1;
export const maximumDownloadBytes = 1024 * 1024 * 1024;

export const actionCapabilities = {
  doctor: [],
  "transactions.list": ["transactions.read"],
  "transactions.get": ["transactions.read"],
  "debts.get": ["transactions.read"],
  "comments.list": ["transactions.read"],
  "comments.create": ["transactions.read", "comments.write"],
  "attachments.upload": ["transactions.read", "attachments.write"],
  "attachments.delete": ["transactions.read", "attachments.delete"],
  "attachments.download": ["bookkeeping.read", "attachments.read"],
  "accounts.list": ["accounts.read"],
  "reports.types": ["reports.read"],
  "reports.export": ["reports.read"],
  "reports.jobs.list": ["reports.read"],
  "reports.jobs.get": ["reports.read"],
  "reports.jobs.create": ["reports.generate"],
  "reports.jobs.download": ["reports.read"],
  "bookkeeping.list": ["bookkeeping.read"],
  "bookkeeping.get": ["bookkeeping.read"],
  "bookkeeping.categories": ["bookkeeping.read"],
  "bookkeeping.suggestions": ["bookkeeping.read"],
  "bookkeeping.set-description": ["bookkeeping.write"],
  "audit.types": ["audit.read"],
  "audit.list": ["audit.read"],
  "payments.create": ["payments.write"],
  "payments.send": ["payments.send"],
} as const satisfies Record<string, readonly string[]>;

export type BridgeAction = keyof typeof actionCapabilities;
export type CommandAction = Exclude<
  BridgeAction,
  | "attachments.upload"
  | "attachments.download"
  | "reports.export"
  | "reports.jobs.download"
>;

export const commandActions = {
  doctor: true,
  "transactions.list": true,
  "transactions.get": true,
  "debts.get": true,
  "comments.list": true,
  "comments.create": true,
  "attachments.delete": true,
  "accounts.list": true,
  "reports.types": true,
  "reports.jobs.list": true,
  "reports.jobs.get": true,
  "reports.jobs.create": true,
  "bookkeeping.list": true,
  "bookkeeping.get": true,
  "bookkeeping.categories": true,
  "bookkeeping.suggestions": true,
  "bookkeeping.set-description": true,
  "audit.types": true,
  "audit.list": true,
  "payments.create": true,
  "payments.send": true,
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
