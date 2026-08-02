import { readFile } from "node:fs/promises";

const files = ["background.js", "config.js", "content.js", "manifest.json"];

for (const file of files) {
  const [built, embedded] = await Promise.all([
    readFile(new URL(`../dist/extension/${file}`, import.meta.url)),
    readFile(new URL(`../assets/extension/${file}`, import.meta.url)),
  ]);
  if (!built.equals(embedded)) {
    throw new Error(
      `Embedded extension artifact ${file} differs from its TypeScript build. Run bun run sync:artifacts.`,
    );
  }
}
