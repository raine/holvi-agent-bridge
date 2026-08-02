import { readFile, readdir } from "node:fs/promises";

const builtDirectory = new URL("../dist/extension/", import.meta.url);
const embeddedDirectory = new URL("../assets/extension/", import.meta.url);
const [builtFiles, embeddedFiles] = await Promise.all([
  readdir(builtDirectory),
  readdir(embeddedDirectory),
]);
builtFiles.sort();
embeddedFiles.sort();

if (JSON.stringify(builtFiles) !== JSON.stringify(embeddedFiles)) {
  throw new Error(
    `Embedded extension inventory differs from its TypeScript build. Built: ${builtFiles.join(", ")}. Embedded: ${embeddedFiles.join(", ")}. Run bun run sync:artifacts.`,
  );
}

for (const file of builtFiles) {
  const [built, embedded] = await Promise.all([
    readFile(new URL(file, builtDirectory)),
    readFile(new URL(file, embeddedDirectory)),
  ]);
  if (!built.equals(embedded)) {
    throw new Error(
      `Embedded extension artifact ${file} differs from its TypeScript build. Run bun run sync:artifacts.`,
    );
  }
}
