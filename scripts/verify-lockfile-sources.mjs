import { readFile } from "node:fs/promises";

const reference = "package-lock.json";
const lock = JSON.parse(await readFile(new URL(`../${reference}`, import.meta.url), "utf8"));
const packages = lock.packages;

if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
  throw new Error(`${reference}: packages must be an object`);
}

const invalid = [];
for (const [packageReference, entry] of Object.entries(packages)) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
  const resolved = entry.resolved;
  if (typeof resolved !== "string") continue;
  if (Object.hasOwn(packages, resolved)) continue;

  let source;
  try {
    source = new URL(resolved);
  } catch {
    invalid.push(`${packageReference || "<root>"}: invalid source ${resolved}`);
    continue;
  }
  if (source.protocol !== "https:" || source.hostname !== "registry.npmjs.org") {
    invalid.push(`${packageReference || "<root>"}: disallowed source ${source.origin}`);
  }
}

if (invalid.length > 0) {
  throw new Error(
    `${reference}: dependency tarballs must use https://registry.npmjs.org\n${invalid.join("\n")}`,
  );
}

process.stdout.write(`${reference}: verified ${Object.keys(packages).length} package entries\n`);
