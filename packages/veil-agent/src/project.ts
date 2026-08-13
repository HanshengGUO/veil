import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterDeclaration } from "@veilquant/contract";
import {
  ArtifactRuntimeRegistry,
  BackendRegistry,
  createArtifactRuntimeProvider,
  createSourceBinding,
  DuckDbFileBackend,
  loadAdapterFile,
  type SourceBinding,
} from "@veilquant/engine";
import { parseDocument } from "yaml";
import { VEIL_PROJECT_FORMAT, VEIL_PROJECT_REFERENCE } from "./constants.ts";
import { VeilAgentError } from "./errors.ts";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_NODE_RUNTIME_ID = "veil-node";
const DEFAULT_NODE_RUNTIME_CONSTRAINT = ">=20.10.0,<30";
const NODE_RUNNER = fileURLToPath(new URL("../runtime/node-runner.mjs", import.meta.url));
const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));

export interface VeilProjectDataset {
  readonly dataset: string;
  readonly declaration: AdapterDeclaration;
  readonly binding: SourceBinding;
}

export interface VeilProjectRuntime {
  readonly root: string;
  readonly projectReference: typeof VEIL_PROJECT_REFERENCE;
  readonly datasets: ReadonlyMap<string, VeilProjectDataset>;
  readonly backends: BackendRegistry;
  readonly runtimes: ArtifactRuntimeRegistry;
  readonly promotionConcurrency: number;
}

export type VeilProjectLoader = (cwd: string) => Promise<VeilProjectRuntime>;

interface ProjectDatasetConfig {
  readonly dataset: string;
  readonly adapter: string;
  readonly root: string | null;
  readonly rootEnvironment: string | null;
}

interface ProjectRuntimeConfig {
  readonly id: string;
  readonly constraints: readonly string[];
}

interface ProjectConfig {
  readonly format: typeof VEIL_PROJECT_FORMAT;
  readonly datasets: readonly ProjectDatasetConfig[];
  readonly runtimes: readonly ProjectRuntimeConfig[];
  readonly promotionConcurrency: number;
}

/** Loads the conservative CSV/Parquet project profile shipped with the v0.1 Pi package. */
export async function loadVeilProject(cwdInput: string): Promise<VeilProjectRuntime> {
  const root = await existingDirectory(cwdInput, "project working directory");
  if (root === parse(root).root) {
    throw invalidProject("project working directory cannot be a filesystem root");
  }
  const configPath = await existingProjectPath(root, VEIL_PROJECT_REFERENCE, "file");
  const config = await loadProjectConfig(configPath);
  const backend = new DuckDbFileBackend();
  const backends = new BackendRegistry();
  backends.register(backend);
  const datasets = new Map<string, VeilProjectDataset>();

  for (const datasetConfig of config.datasets) {
    const adapterPath = await existingProjectPath(root, datasetConfig.adapter, "file");
    const declaration = await loadAdapterFile(adapterPath);
    if (declaration.dataset !== datasetConfig.dataset) {
      throw invalidProject("project dataset id does not match its adapter declaration");
    }
    if (declaration.source.type !== "csv" && declaration.source.type !== "parquet") {
      throw invalidProject(
        "the default agent project loader accepts only CSV or Parquet declarations",
        "Use a CSV/Parquet declaration or inject a custom VeilProjectLoader for another backend.",
      );
    }
    const dataRoot = await resolveDatasetRoot(root, datasetConfig);
    const binding = createSourceBinding({
      id: `agent-${createPortableSuffix(datasetConfig.dataset)}`,
      backend: backend.id,
      options: { root: dataRoot },
    });
    datasets.set(
      declaration.dataset,
      Object.freeze({ dataset: declaration.dataset, declaration, binding }),
    );
  }

  const runtimes = new ArtifactRuntimeRegistry();
  for (const runtime of config.runtimes) {
    runtimes.register(
      createArtifactRuntimeProvider({
        id: runtime.id,
        implementation: { name: "node", version: process.versions.node },
        supports: (constraint) => runtime.constraints.includes(constraint),
        launch: () => ({
          executable: process.execPath,
          arguments: ["--import", TSX_LOADER, NODE_RUNNER],
        }),
      }),
    );
  }

  return Object.freeze({
    root,
    projectReference: VEIL_PROJECT_REFERENCE,
    datasets,
    backends,
    runtimes,
    promotionConcurrency: config.promotionConcurrency,
  });
}

export async function existingProjectPath(
  rootInput: string,
  referenceInput: string,
  kind: "file" | "directory",
): Promise<string> {
  const root = await existingDirectory(rootInput, "project root");
  const reference = projectReference(referenceInput);
  const requested = resolve(root, ...reference.split("/"));
  let canonical: string;
  try {
    canonical = await realpath(requested);
    const status = await lstat(canonical);
    if ((kind === "file" && !status.isFile()) || (kind === "directory" && !status.isDirectory())) {
      throw new Error("wrong project path kind");
    }
  } catch {
    throw invalidProject(
      `project ${kind} reference could not be resolved`,
      `Create the referenced ${kind} beneath the project root and retry.`,
    );
  }
  if (!isWithin(root, canonical)) {
    throw invalidProject(
      `project ${kind} reference escapes the project root`,
      "Use a project-relative path that resolves beneath the working directory.",
    );
  }
  return canonical;
}

export function projectOutputPath(rootInput: string, referenceInput: string): string {
  if (!isAbsolute(rootInput)) throw invalidProject("project output root must be absolute");
  const reference = projectReference(referenceInput);
  const output = resolve(rootInput, ...reference.split("/"));
  if (!isWithin(resolve(rootInput), output)) {
    throw invalidProject("project output reference escapes the project root");
  }
  return output;
}

export function projectReference(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1024 ||
    input.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(input) ||
    input.includes("\\") ||
    input.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw invalidProject(
      "project reference must be a normalized relative path",
      "Use forward slashes and keep the reference beneath the project working directory.",
    );
  }
  return input;
}

async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw invalidProject("project configuration could not be read");
  }
  let input: unknown;
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error("invalid project YAML");
    }
    input = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw invalidProject(
      "project configuration is not valid strict YAML",
      `Fix syntax, duplicate keys, aliases, or unsupported tags in ${VEIL_PROJECT_REFERENCE}.`,
    );
  }
  const root = exactRecord(
    input,
    ["format", "datasets", "runtimes", "promotion_concurrency"],
    "project configuration",
  );
  if (root.format !== VEIL_PROJECT_FORMAT) {
    throw invalidProject("project configuration uses an unsupported format");
  }
  if (!Array.isArray(root.datasets) || root.datasets.length === 0) {
    throw invalidProject("project configuration requires at least one dataset");
  }
  if (!Array.isArray(root.runtimes) || root.runtimes.length === 0) {
    throw invalidProject("project configuration requires at least one artifact runtime");
  }
  const datasets = root.datasets.map(normalizeDatasetConfig);
  requireUnique(
    datasets.map((dataset) => dataset.dataset),
    "dataset ids",
  );
  const runtimes = root.runtimes.map(normalizeRuntimeConfig);
  requireUnique(
    runtimes.map((runtime) => runtime.id),
    "runtime ids",
  );
  const promotionConcurrency = positiveInteger(
    root.promotion_concurrency,
    "promotion_concurrency",
    16,
  );
  return Object.freeze({
    format: VEIL_PROJECT_FORMAT,
    datasets: Object.freeze(datasets),
    runtimes: Object.freeze(runtimes),
    promotionConcurrency,
  });
}

function normalizeDatasetConfig(input: unknown): ProjectDatasetConfig {
  const root = exactRecord(input, ["dataset", "adapter", "root", "root_env"], "project dataset");
  const dataset = portableId(root.dataset, "project dataset id");
  const adapter = projectReference(root.adapter);
  const localRoot = root.root === null ? null : datasetRootReference(root.root);
  const rootEnvironment = root.root_env === null ? null : environmentName(root.root_env);
  if ((localRoot === null) === (rootEnvironment === null)) {
    throw invalidProject("project dataset must select exactly one of root or root_env");
  }
  return Object.freeze({ dataset, adapter, root: localRoot, rootEnvironment });
}

function normalizeRuntimeConfig(input: unknown): ProjectRuntimeConfig {
  const root = exactRecord(input, ["id", "constraints"], "project runtime");
  if (!Array.isArray(root.constraints) || root.constraints.length === 0) {
    throw invalidProject("project runtime requires at least one exact supported constraint");
  }
  const id = portableId(root.id, "project runtime id");
  const constraints = root.constraints.map((value) =>
    boundedText(value, "runtime constraint", 128),
  );
  requireUnique(constraints, "runtime constraints");
  if (
    id !== DEFAULT_NODE_RUNTIME_ID ||
    constraints.length !== 1 ||
    constraints[0] !== DEFAULT_NODE_RUNTIME_CONSTRAINT
  ) {
    throw invalidProject(
      `the default loader supports only ${DEFAULT_NODE_RUNTIME_ID} ${DEFAULT_NODE_RUNTIME_CONSTRAINT}`,
      "Use the published Node runtime declaration or inject a custom VeilProjectLoader.",
    );
  }
  return Object.freeze({
    id,
    constraints: Object.freeze(constraints),
  });
}

async function resolveDatasetRoot(
  projectRoot: string,
  config: ProjectDatasetConfig,
): Promise<string> {
  if (config.root === ".") return projectRoot;
  if (config.root !== null) return existingProjectPath(projectRoot, config.root, "directory");
  const environmentNameInput = config.rootEnvironment;
  if (environmentNameInput === null) throw invalidProject("project dataset root is missing");
  const environmentValue = process.env[environmentNameInput];
  if (environmentValue === undefined || environmentValue.length === 0) {
    throw invalidProject(
      "project dataset root environment variable is not set",
      `Set ${environmentNameInput} to the private data directory before starting Pi.`,
    );
  }
  return existingDirectory(
    isAbsolute(environmentValue) ? environmentValue : resolve(projectRoot, environmentValue),
    "dataset root",
  );
}

function datasetRootReference(input: unknown): string {
  if (input === ".") return ".";
  return projectReference(input);
}

async function existingDirectory(input: unknown, label: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0) {
    throw invalidProject(`${label} is missing`);
  }
  try {
    const canonical = await realpath(resolve(input));
    if (!(await lstat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw invalidProject(`${label} does not resolve to a readable directory`);
  }
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidProject(`${label} must be an object`);
  }
  const root = input as Record<string, unknown>;
  const actual = Object.keys(root).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidProject(`${label} has missing or unknown fields`);
  }
  return root;
}

function portableId(input: unknown, label: string): string {
  if (typeof input !== "string" || !PORTABLE_ID.test(input)) {
    throw invalidProject(`${label} must use letters, digits, dots, underscores, or hyphens`);
  }
  return input;
}

function environmentName(input: unknown): string {
  if (typeof input !== "string" || !ENVIRONMENT_NAME.test(input)) {
    throw invalidProject("root_env must be an environment variable name, not a path or value");
  }
  return input;
}

function boundedText(input: unknown, label: string, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum ||
    input.trim() !== input ||
    input.includes("\0")
  ) {
    throw invalidProject(`${label} must be bounded portable text`);
  }
  return input;
}

function positiveInteger(input: unknown, label: string, maximum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > maximum) {
    throw invalidProject(`${label} must be an integer from 1 through ${maximum}`);
  }
  return input;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw invalidProject(`${label} must be unique`);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function createPortableSuffix(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
}

function invalidProject(
  message: string,
  remedy = `Create a strict ${VEIL_PROJECT_REFERENCE} from the published template and retry.`,
): VeilAgentError {
  return new VeilAgentError("INVALID_PROJECT", message, remedy);
}
