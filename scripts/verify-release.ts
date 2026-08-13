import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly private?: unknown;
  readonly engines?: unknown;
  readonly files?: unknown;
  readonly dependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly publishConfig?: unknown;
  readonly pi?: unknown;
}

const expectedVersion = option("--version") ?? process.env.VEIL_RELEASE_VERSION ?? "0.1.0";
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
  throw new Error("release version must be a semantic version without a v prefix");
}

const packages = await Promise.all([
  loadPackage("packages/veil-contract/package.json"),
  loadPackage("packages/veil-engine/package.json"),
  loadPackage("packages/veil-agent/package.json"),
]);
const expectedNames = ["@veilquant/contract", "@veilquant/engine", "veil-quant"] as const;
const rootLicense = await readFile(resolve("LICENSE"), "utf8");
for (const [index, item] of packages.entries()) {
  if (item.json.name !== expectedNames[index]) {
    throw new Error(`${item.reference}: publish name differs from the release package set`);
  }
  if (item.json.version !== expectedVersion) {
    throw new Error(`${item.reference}: version does not match ${expectedVersion}`);
  }
  if (item.json.private === true)
    throw new Error(`${item.reference}: publishable package is private`);
  const engines = record(item.json.engines, `${item.reference} engines`);
  if (engines.node !== ">=20.10.0 <30") {
    throw new Error(`${item.reference}: Node support range differs from the v0.1 runtime boundary`);
  }
  const publishConfig = record(item.json.publishConfig, `${item.reference} publishConfig`);
  if (publishConfig.access !== "public") {
    throw new Error(`${item.reference}: publishConfig.access must be public`);
  }
  if (!Array.isArray(item.json.files) || !item.json.files.includes("LICENSE")) {
    throw new Error(`${item.reference}: published files must include LICENSE`);
  }
  if ((await readFile(resolve(dirname(item.reference), "LICENSE"), "utf8")) !== rootLicense) {
    throw new Error(`${item.reference}: package LICENSE differs from the repository license`);
  }
}

const engine = packages[1];
const agent = packages[2];
if (engine === undefined || agent === undefined)
  throw new Error("release package set is incomplete");
requireDependency(engine, "@veilquant/contract", expectedVersion);
requireDependency(agent, "@veilquant/contract", expectedVersion);
requireDependency(agent, "@veilquant/engine", expectedVersion);

const pi = record(agent.json.pi, "veil-quant pi manifest");
requireStringArray(pi.extensions, ["./src/extension.ts"], "pi.extensions");
requireStringArray(pi.skills, ["./skills"], "pi.skills");
requireStringArray(pi.prompts, ["./prompts"], "pi.prompts");
const peers = record(agent.json.peerDependencies, "veil-quant peerDependencies");
for (const name of ["@earendil-works/pi-coding-agent", "typebox"]) {
  if (peers[name] !== "*") throw new Error(`veil-quant peer ${name} must use Pi's * range`);
}
requireStringArray(
  agent.json.files,
  ["src", "runtime", "skills", "prompts", "LICENSE", "README.md"],
  "veil-quant files",
);
for (const reference of [
  "packages/veil-agent/src/extension.ts",
  "packages/veil-agent/runtime/node-runner.mjs",
  "packages/veil-agent/skills/research-loop/SKILL.md",
  "packages/veil-agent/skills/research-loop/assets/factor.mjs",
  "packages/veil-agent/skills/research-loop/assets/promotion-request.yaml",
  "packages/veil-agent/prompts/veil-research-plan.md",
  "packages/veil-agent/prompts/veil-research-log.md",
]) {
  await readFile(resolve(reference));
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    version: expectedVersion,
    packages: packages.map((item) => item.json.name),
    piResources: { extensions: 1, skillRoots: 1, promptRoots: 1 },
  })}\n`,
);

async function loadPackage(reference: string): Promise<{
  readonly reference: string;
  readonly json: PackageJson;
}> {
  const input: unknown = JSON.parse(await readFile(resolve(reference), "utf8"));
  return { reference, json: record(input, reference) as PackageJson };
}

function requireDependency(
  item: { readonly reference: string; readonly json: PackageJson },
  name: string,
  version: string,
): void {
  const dependencies = record(item.json.dependencies, `${item.reference} dependencies`);
  if (dependencies[name] !== version) {
    throw new Error(`${item.reference}: ${name} must match release version ${version}`);
  }
}

function requireStringArray(input: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(input) || JSON.stringify(input) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the frozen release manifest`);
  }
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
