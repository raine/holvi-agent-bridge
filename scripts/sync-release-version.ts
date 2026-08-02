const version = Bun.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("Release version must contain three numeric components.");
}

function replaceVersion(
  source: string,
  pattern: RegExp,
  label: string,
): string {
  if ([...source.matchAll(pattern)].length !== 1) {
    throw new Error(`${label} must define its release version once.`);
  }
  return source.replace(
    pattern,
    (_match: string, prefix: string, suffix: string) =>
      `${prefix}${version}${suffix}`,
  );
}

const contractPath = "bridge-contract.json";
let contract = await Bun.file(contractPath).text();
contract = replaceVersion(
  contract,
  /(\"host\":\s*\")[^\"]+(\")/g,
  "bridge contract host",
);
contract = replaceVersion(
  contract,
  /(\"extension\":\s*\")[^\"]+(\")/g,
  "bridge contract extension",
);
JSON.parse(contract);
await Bun.write(contractPath, contract);

const manifestPath = "src/extension/manifest.json";
let manifest = await Bun.file(manifestPath).text();
manifest = replaceVersion(
  manifest,
  /(\"version\":\s*\")[^\"]+(\")/g,
  "extension manifest",
);
JSON.parse(manifest);
await Bun.write(manifestPath, manifest);

const configPath = "src/extension/config.ts";
let config = await Bun.file(configPath).text();
config = replaceVersion(
  config,
  /(\bextensionVersion:\s*\")[^\"]+(\",)/g,
  "extension config",
);
await Bun.write(configPath, config);
