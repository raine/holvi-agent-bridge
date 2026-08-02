#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FORMAT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
]);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const repositoryRoot = git("rev-parse", "--show-toplevel");
process.chdir(repositoryRoot);

const stagedOutput = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
  { encoding: "utf8" },
);
const stagedPaths = stagedOutput.split("\0").filter(Boolean);
const targets = stagedPaths.filter((path) => {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && FORMAT_EXTENSIONS.has(path.slice(dot));
});

if (targets.length === 0) process.exit(0);

const temporaryRoot = mkdtempSync(join(tmpdir(), "format-staged-"));
process.on("exit", () =>
  rmSync(temporaryRoot, { recursive: true, force: true }),
);

const temporaryTree = join(temporaryRoot, "tree");
const temporaryIndex = join(temporaryRoot, "index");
mkdirSync(temporaryTree, { recursive: true });
copyFileSync(git("rev-parse", "--git-path", "index"), temporaryIndex);

const originals = new Map();
const indexEntries = execFileSync("git", ["ls-files", "-s", "--", ...targets], {
  encoding: "utf8",
});
for (const line of indexEntries.split("\n").filter(Boolean)) {
  const tab = line.indexOf("\t");
  const [mode, sha] = line.slice(0, tab).split(" ");
  const path = line.slice(tab + 1);
  if (mode && sha) originals.set(path, { mode, sha });
}

const checkout = spawnSync("git", ["checkout-index", "-z", "--stdin", "-f"], {
  input: `${targets.join("\0")}\0`,
  env: {
    ...process.env,
    GIT_INDEX_FILE: temporaryIndex,
    GIT_WORK_TREE: temporaryTree,
  },
  stdio: ["pipe", "inherit", "inherit"],
});
if (checkout.status !== 0) {
  console.error("[format-staged] git checkout-index failed");
  process.exit(1);
}

for (const name of [".gitignore", ".oxfmtrc.json", ".oxfmtrc.jsonc"]) {
  const source = join(repositoryRoot, name);
  if (existsSync(source)) copyFileSync(source, join(temporaryTree, name));
}

const formatter = join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "oxfmt.cmd" : "oxfmt",
);
const temporaryPaths = targets.map((path) => join(temporaryTree, path));
const format = spawnSync(formatter, ["--write", ...temporaryPaths], {
  cwd: temporaryTree,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "1" },
});
if (format.status !== 0) {
  process.stdout.write(format.stdout);
  process.stderr.write(format.stderr);
  console.error("[format-staged] oxfmt failed");
  process.exit(1);
}

let changed = 0;
let synchronized = 0;
for (const path of targets) {
  const original = originals.get(path);
  if (!original) continue;

  const temporaryPath = join(temporaryTree, path);
  const newSha = execFileSync(
    "git",
    ["hash-object", "-w", "--path", path, temporaryPath],
    { encoding: "utf8" },
  ).trim();
  if (newSha === original.sha) continue;

  execFileSync("git", [
    "update-index",
    "--cacheinfo",
    `${original.mode},${newSha},${path}`,
  ]);
  changed++;

  let worktreeSha;
  try {
    worktreeSha = execFileSync("git", ["hash-object", "--", path], {
      encoding: "utf8",
    }).trim();
  } catch {
    continue;
  }
  if (worktreeSha !== original.sha) continue;

  const worktreePath = join(repositoryRoot, path);
  mkdirSync(dirname(worktreePath), { recursive: true });
  copyFileSync(temporaryPath, worktreePath);
  synchronized++;
}

if (changed > 0) {
  const detail =
    synchronized === changed
      ? ""
      : ` (${changed - synchronized} kept due to unstaged edits)`;
  console.log(`[format-staged] formatted ${changed} staged file(s)${detail}`);
}
