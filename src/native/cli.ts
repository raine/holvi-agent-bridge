#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { enabledActions } from "./capabilities.js";
import {
  loadConfig,
  resolveReceiptFile,
  socketPath,
  validateUuid,
} from "./config.js";
import { installBridge } from "./install.js";
import { signRequest } from "./protocol.js";

type OptionValue = string | boolean | string[];
type Options = Record<string, OptionValue>;

interface ParsedArguments {
  command: string;
  options: Options;
}

interface ScanRow {
  date?: string;
  counterparty?: string;
  description?: string;
  amount?: string | number | null;
  currency?: string;
  transactionUuid?: string;
}

interface ScanResult {
  count: number;
  pages: number;
  results: ScanRow[];
}

const helpText = `Holvi Agent Bridge

Usage:
  holvi-agent-bridge install --group-url URL --account UUID \\
    --capability transactions.read [--capability attachments.write] \\
    [--receipt-root /absolute/path] --yes
  holvi-agent-bridge capabilities
  holvi-agent-bridge doctor
  holvi-agent-bridge scan [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
  holvi-agent-bridge preview --transaction UUID
  holvi-agent-bridge upload --transaction UUID --file /absolute/path/to/receipt.pdf
  holvi-agent-bridge upload --transaction UUID --file /absolute/path/to/receipt.pdf --yes

Every command requires its configured capability. Upload is a dry check unless
--yes is present. The configured signed-in Holvi group tab must remain open in
Chrome. Attachment paths are restricted by the private local config.
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command = "help", ...rest] = argv;
  const options: Options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument) {
      throw new Error("Argument parsing reached an empty value.");
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    if (name === "yes" || name === "json") {
      options[name] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option --${name} requires a value.`);
    }
    if (name === "receipt-root" || name === "capability") {
      const roots = options[name];
      options[name] = Array.isArray(roots) ? [...roots, value] : [value];
    } else {
      if (options[name] !== undefined) {
        throw new Error(`Option --${name} may be provided only once.`);
      }
      options[name] = value;
    }
    index += 1;
  }
  return { command, options };
}

function assertOptions(options: Options, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(options)) {
    if (!allowedSet.has(name)) {
      throw new Error(`Unsupported option: --${name}`);
    }
  }
}

function stringOption(options: Options, name: string): string {
  const value = options[name];
  return typeof value === "string" ? value : "";
}

function stringListOption(options: Options, name: string): string[] {
  const value = options[name];
  return Array.isArray(value) ? value : [];
}

function validateDate(value: string, name: string): string {
  if (!value) {
    return "";
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`--${name} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`--${name} must be a calendar date.`);
  }
  return value;
}

async function requestHost<T>(
  secret: string,
  action: string,
  params: Record<string, unknown>,
): Promise<T> {
  const request = signRequest(secret, action, params);
  const target = socketPath();
  try {
    const stat = await lstat(target);
    if (
      !stat.isSocket() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("The local bridge socket failed its ownership checks.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Open or reload the configured signed-in Holvi tab in Chrome.");
    }
    throw error;
  }

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(target);
    let input = "";
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      callback();
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("Holvi Agent Bridge request timed out.")));
    }, 125_000);

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        const response = JSON.parse(input.slice(0, newline)) as {
          ok?: boolean;
          data?: T;
          error?: string;
        };
        if (!response.ok) {
          settle(() =>
            reject(new Error(response.error || "Holvi Agent Bridge request failed.")),
          );
          return;
        }
        settle(() => resolve(response.data as T));
      } catch (error) {
        settle(() => reject(error));
      }
    });
    socket.once("error", (error) => {
      settle(() => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          reject(new Error("Open or reload the configured signed-in Holvi tab in Chrome."));
        } else {
          reject(error);
        }
      });
    });
  });
}

function formatCell(value: unknown, width: number): string {
  const valueText = value === null || value === undefined ? "" : String(value);
  return valueText.length > width
    ? `${valueText.slice(0, Math.max(0, width - 1))}…`
    : valueText.padEnd(width);
}

function printScan(scan: ScanResult): void {
  const rows = scan.results || [];
  const widths = { date: 10, counterparty: 28, amount: 12, currency: 8, uuid: 36 };
  const header = [
    formatCell("Date", widths.date),
    formatCell("Counterparty", widths.counterparty),
    formatCell("Amount", widths.amount),
    formatCell("Currency", widths.currency),
    formatCell("Transaction UUID", widths.uuid),
  ].join("  ");
  process.stdout.write(`${header}\n`);
  for (const row of rows) {
    process.stdout.write(
      `${[
        formatCell(row.date, widths.date),
        formatCell(row.counterparty || row.description, widths.counterparty),
        formatCell(row.amount, widths.amount),
        formatCell(row.currency, widths.currency),
        formatCell(row.transactionUuid, widths.uuid),
      ].join("  ")}\n`,
    );
  }
  process.stdout.write(
    `\n${scan.count} missing receipt transaction(s), ${scan.pages} API page(s).\n`,
  );
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    assertOptions(options, []);
    process.stdout.write(helpText);
    return;
  }
  if (command === "install") {
    assertOptions(options, [
      "group-url",
      "account",
      "capability",
      "receipt-root",
      "yes",
    ]);
    const result = await installBridge({
      confirmed: options.yes === true,
      groupUrl: stringOption(options, "group-url"),
      paymentAccountUuid: stringOption(options, "account"),
      capabilities: stringListOption(options, "capability"),
      receiptRoots: stringListOption(options, "receipt-root"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const { config } = await loadConfig();

  if (command === "capabilities") {
    assertOptions(options, []);
    process.stdout.write(
      `${JSON.stringify(
        {
          capabilities: config.capabilities,
          operations: enabledActions(config.capabilities),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === "doctor") {
    assertOptions(options, []);
    const result = await requestHost(config.hmacSecret, "doctor", {});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "scan") {
    assertOptions(options, ["from", "to", "json"]);
    const from = validateDate(stringOption(options, "from"), "from");
    const to = validateDate(stringOption(options, "to"), "to");
    if (from && to && from > to) {
      throw new Error("--from must be on or before --to.");
    }
    const result = await requestHost<ScanResult>(config.hmacSecret, "scan", {
      from,
      to,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printScan(result);
    }
    return;
  }

  if (command === "preview") {
    assertOptions(options, ["transaction"]);
    const transactionUuid = validateUuid(
      stringOption(options, "transaction"),
      "Transaction",
    );
    const result = await requestHost(config.hmacSecret, "preview", {
      transactionUuid,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "upload") {
    assertOptions(options, ["transaction", "file", "yes"]);
    const transactionUuid = validateUuid(
      stringOption(options, "transaction"),
      "Transaction",
    );
    const receipt = await resolveReceiptFile(config, stringOption(options, "file"));
    if (options.yes !== true) {
      const preview = await requestHost(config.hmacSecret, "preview", {
        transactionUuid,
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            dryRun: true,
            transaction: preview,
            receipt,
            next: "Repeat the upload command with --yes after checking these values.",
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    const result = await requestHost(config.hmacSecret, "upload", {
      transactionUuid,
      filePath: receipt.path,
      confirmed: true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${helpText}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

export const internal = {
  parseArguments,
  validateDate,
};
