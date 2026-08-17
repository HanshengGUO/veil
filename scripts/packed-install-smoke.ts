import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packagesDirectory = resolve(option("--packages-dir") ?? ".release");
const tarballs = await readdir(packagesDirectory);
const contract = requiredTarball(tarballs, "veilquant-contract-");
const engine = requiredTarball(tarballs, "veilquant-engine-");
const agent = requiredTarball(tarballs, "veil-quant-");
const temporaryRoot = await mkdtemp(join(tmpdir(), "veil-packed-install-"));

try {
  const packageJson = {
    name: "veil-packed-install-smoke",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {
      "@earendil-works/pi-coding-agent": "0.84.1",
      "@veilquant/contract": fileDependency(join(packagesDirectory, contract)),
      "@veilquant/engine": fileDependency(join(packagesDirectory, engine)),
      typebox: "1.3.7",
      tsx: "4.23.9",
      "veil-quant": fileDependency(join(packagesDirectory, agent)),
    },
  };
  await writeFile(join(temporaryRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const npm = npmInvocation(["install", "--no-audit", "--no-fund"]);
  await execFileAsync(npm.executable, npm.arguments, {
    cwd: temporaryRoot,
    windowsHide: true,
  });
  const expectedLicense = await readFile(resolve("LICENSE"), "utf8");
  for (const packagePath of [
    ["@veilquant", "contract"],
    ["@veilquant", "engine"],
    ["veil-quant"],
  ]) {
    const installedLicense = await readFile(
      join(temporaryRoot, "node_modules", ...packagePath, "LICENSE"),
      "utf8",
    );
    if (installedLicense !== expectedLicense) {
      throw new Error(`packed ${packagePath.join("/")} license is missing or changed`);
    }
  }
  await writeFile(
    join(temporaryRoot, "smoke.mjs"),
    `import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createVeilExtension, VEIL_BACKTEST_TOOL, VEIL_DATA_TOOL, VEIL_MEMORY_TOOL } from "veil-quant";
if (typeof createVeilExtension() !== "function") throw new Error("extension factory missing");
if ([VEIL_DATA_TOOL, VEIL_BACKTEST_TOOL, VEIL_MEMORY_TOOL].join(",") !== "veil-data,veil-backtest,veil-memory") {
  throw new Error("tool surface mismatch");
}
const packageRoot = join(process.cwd(), "node_modules", "veil-quant");
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const agentDir = join(process.cwd(), ".pi-agent");
await mkdir(agentDir, { recursive: true });
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
  additionalExtensionPaths: manifest.pi.extensions.map((path) => join(packageRoot, path)),
  additionalSkillPaths: manifest.pi.skills.map((path) => join(packageRoot, path)),
  additionalPromptTemplatePaths: manifest.pi.prompts.map((path) => join(packageRoot, path)),
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length !== 0 || loaded.extensions.length !== 1) {
  throw new Error("packed extension did not load cleanly");
}
const extension = loaded.extensions[0];
const tools = [...extension.tools.keys()].sort();
const commands = [...extension.commands.keys()].sort();
if (tools.join(",") !== "veil-backtest,veil-data,veil-memory") throw new Error("registered tools mismatch");
if (commands.join(",") !== "veil-brief,veil-family,veil-hypothesis,veil-promote,veil-reproduce") {
  throw new Error("registered commands mismatch");
}
if (!loader.getSkills().skills.some((skill) => skill.name === "veil-research-loop")) {
  throw new Error("packed skill missing");
}
const prompts = loader.getPrompts().prompts.map((prompt) => prompt.name).sort();
if (prompts.join(",") !== "veil-research-log,veil-research-plan") throw new Error("packed prompts mismatch");
process.stdout.write(JSON.stringify({ ok: true, tools, commands, prompts }) + "\\n");
`,
  );
  const installedAgent = JSON.parse(
    await readFile(join(temporaryRoot, "node_modules", "veil-quant", "package.json"), "utf8"),
  ) as { readonly pi?: unknown };
  if (installedAgent.pi === undefined) throw new Error("packed Pi manifest is missing");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", join(temporaryRoot, "smoke.mjs")],
    { cwd: temporaryRoot, windowsHide: true },
  );
  process.stdout.write(stdout);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function requiredTarball(files: readonly string[], prefix: string): string {
  const matches = files.filter((file) => file.startsWith(prefix) && file.endsWith(".tgz"));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${prefix} tarball, found ${matches.length}`);
  }
  const match = matches[0];
  if (match === undefined || basename(match) !== match) throw new Error("tarball name is invalid");
  return match;
}

function npmInvocation(arguments_: readonly string[]): {
  readonly executable: string;
  readonly arguments: readonly string[];
} {
  const npmCli = process.env.npm_execpath;
  if (npmCli !== undefined && npmCli.length > 0) {
    return { executable: process.execPath, arguments: [npmCli, ...arguments_] };
  }
  if (process.platform === "win32") {
    throw new Error("npm_execpath is required to run the packed install smoke on Windows");
  }
  return { executable: "npm", arguments: arguments_ };
}

function fileDependency(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
