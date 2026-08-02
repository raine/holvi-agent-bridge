#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const JOBS = [
  {
    label: "types-native",
    color: "\x1b[38;5;81m",
    cmd: "bunx",
    args: ["tsgo", "-p", "tsconfig.native.json", "--noEmit"],
  },
  {
    label: "types-extension",
    color: "\x1b[38;5;147m",
    cmd: "bunx",
    args: ["tsgo", "-p", "tsconfig.extension.json", "--noEmit"],
  },
  {
    label: "test",
    color: "\x1b[38;5;114m",
    cmd: "bun",
    args: ["run", "test"],
  },
  {
    label: "lint",
    color: "\x1b[38;5;213m",
    cmd: "bunx",
    args: ["oxlint", "--type-aware", "--deny-warnings"],
  },
  {
    label: "format",
    color: "\x1b[38;5;215m",
    cmd: "bunx",
    args: ["oxfmt", "--check", "."],
  },
];

function parseMode(argv) {
  const args = argv.slice(2);
  const arg = args.shift() ?? "";
  if (args.length > 0) {
    throw new Error("usage: check.mjs [--verbose|--quiet]");
  }
  if (arg === "" || arg === "--quiet") return "quiet";
  if (arg === "-v" || arg === "--verbose") return "verbose";
  throw new Error("usage: check.mjs [--verbose|--quiet]");
}

const isTTY = process.stdout.isTTY ?? false;
const ansi = (code) => (isTTY ? code : "");
const RESET = ansi("\x1b[0m");
const BOLD = ansi("\x1b[1m");
const DIM = ansi("\x1b[2m");
const GREEN = ansi("\x1b[32m");
const RED = ansi("\x1b[31m");

function prefix(job) {
  return `${ansi(job.color)}${BOLD}${job.label}${RESET}${DIM} |${RESET} `;
}

const live = new Set();
let shutdownReason = null;

function killTree(child, signal = "SIGTERM") {
  if (child.proc.pid === undefined) return;
  try {
    process.kill(-child.proc.pid, signal);
  } catch {}
}

function shutdown(reason, signal = "SIGTERM") {
  if (shutdownReason !== null) return;
  shutdownReason = reason;
  for (const child of live) killTree(child, signal);
}

process.on("SIGINT", () => shutdown("user-signal", "SIGINT"));
process.on("SIGTERM", () => shutdown("user-signal", "SIGTERM"));

function capture(stream, onLine) {
  const lines = createInterface({ input: stream, terminal: false });
  lines.on("line", onLine);
}

function spawnJob(job, mode) {
  const proc = spawn(job.cmd, job.args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(isTTY ? { FORCE_COLOR: "1" } : {}) },
  });

  const output = [];
  const onLine = (line) => {
    if (mode === "verbose") process.stdout.write(`${prefix(job)}${line}\n`);
    else output.push(line);
  };

  if (proc.stdout === null || proc.stderr === null) {
    throw new Error(`spawn for ${job.label} produced null stdio pipes`);
  }
  capture(proc.stdout, onLine);
  capture(proc.stderr, onLine);

  const done = new Promise((resolve) => {
    proc.once("close", (code, signal) => {
      resolve({
        label: job.label,
        code: code ?? (signal === null ? 1 : 143),
        killed: signal !== null,
      });
    });
    proc.once("error", (error) => {
      output.push(`spawn error: ${error.message}`);
      resolve({ label: job.label, code: 127, killed: false });
    });
  });

  return { job, proc, output, done };
}

function reportOutcome(child, outcome, mode) {
  if (outcome.code === 0) {
    process.stdout.write(`${GREEN}${BOLD}PASS${RESET} ${outcome.label}\n`);
    return true;
  }

  process.stdout.write(
    `${RED}${BOLD}FAIL${RESET} ${outcome.label} ${DIM}(exit ${outcome.code})${RESET}\n`,
  );

  if (mode === "quiet") {
    const linePrefix = prefix(child.job);
    for (const line of child.output) {
      process.stdout.write(`${linePrefix}${line}\n`);
    }
  }

  return false;
}

async function main() {
  const mode = parseMode(process.argv);
  for (const job of JOBS) live.add(spawnJob(job, mode));
  const pending = new Set(live);
  let failed = false;

  while (pending.size > 0) {
    const { child, outcome } = await Promise.race(
      [...pending].map(async (candidate) => ({
        child: candidate,
        outcome: await candidate.done,
      })),
    );
    pending.delete(child);
    live.delete(child);

    if (outcome.killed && shutdownReason !== null) continue;
    if (reportOutcome(child, outcome, mode)) continue;

    failed = true;
    shutdown("fail-fast");
  }

  return shutdownReason === "user-signal" ? 130 : failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    shutdown("fail-fast");
    console.error(error);
    process.exitCode = 1;
  },
);
