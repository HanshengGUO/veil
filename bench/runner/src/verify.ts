import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadAdapterFile } from "@veilquant/engine";
import { type BenchSuite, selectSuiteTasks } from "./suite.ts";
import { discoverTasks } from "./tasks.ts";
import { prepareTaskWorkspace } from "./workspace.ts";

export interface TaskVerification {
  taskId: string;
  kind: "trap" | "honest";
  seed: number;
  dataFiles: number;
  dataBytes: number;
}

export interface CatalogVerification {
  suite: BenchSuite;
  variant: string;
  taskCount: number;
  trapCount: number;
  honestCount: number;
  tasks: TaskVerification[];
}

export interface VerifyCatalogOptions {
  tasksDirectory: string;
  suite?: BenchSuite;
  variant?: string;
}

function workspacePath(workspace: string, declaredPath: string): string {
  const target = resolve(workspace, declaredPath);
  const fromWorkspace = relative(resolve(workspace), target);
  if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    throw new Error(`generated path escapes the workspace: ${declaredPath}`);
  }
  return target;
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function adapterLocator(adapterPath: string): Promise<string> {
  return (await loadAdapterFile(adapterPath)).source.locator;
}

async function verifyWorkspace(
  workspace: string,
  universeSource: string,
  adapterPaths: readonly string[],
): Promise<Pick<TaskVerification, "dataFiles" | "dataBytes">> {
  for (const privateName of ["generate.ts", "trap.yaml", "golden.yaml"]) {
    if (existsSync(join(workspace, privateName))) {
      throw new Error(`runner-only file leaked into the agent workspace: ${privateName}`);
    }
  }

  const declaredSources = [
    universeSource,
    ...(await Promise.all(
      adapterPaths.map((path) => adapterLocator(workspacePath(workspace, path))),
    )),
  ];
  for (const declaredSource of declaredSources) {
    const source = workspacePath(workspace, declaredSource);
    if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) {
      throw new Error(`generated data source is missing or empty: ${declaredSource}`);
    }
  }

  const dataDirectory = join(workspace, "data");
  const dataFiles = listFiles(dataDirectory);
  if (dataFiles.length === 0) throw new Error("generator produced no data files");
  const sentinelPath = join(dataDirectory, "sentinel.csv");
  if (
    !existsSync(sentinelPath) ||
    !readFileSync(sentinelPath, "utf8").includes("VEIL_FUTURE_SENTINEL")
  ) {
    throw new Error("generated snapshot is missing its future-availability sentinel");
  }
  return {
    dataFiles: dataFiles.length,
    dataBytes: dataFiles.reduce((total, path) => total + statSync(path).size, 0),
  };
}

/** Generate and validate task snapshots without starting a model session. */
export async function verifyCatalog(options: VerifyCatalogOptions): Promise<CatalogVerification> {
  const suite = options.suite ?? "full";
  const variant = options.variant ?? `${suite}-v1`;
  const tasks = selectSuiteTasks(discoverTasks(options.tasksDirectory), suite);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "veil-bench-verify-"));
  const verified: TaskVerification[] = [];

  try {
    for (const task of tasks) {
      const prepared = prepareTaskWorkspace({
        taskDirectory: task.directory,
        workspaceDirectory: join(temporaryRoot, task.manifest.taskId),
        variant,
      });
      verified.push({
        taskId: task.manifest.taskId,
        kind: task.kind,
        seed: prepared.seed,
        ...(await verifyWorkspace(
          prepared.workspaceDirectory,
          task.manifest.universe.source,
          task.manifest.datasets.map((dataset) => dataset.adapter),
        )),
      });
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  return {
    suite,
    variant,
    taskCount: verified.length,
    trapCount: verified.filter((task) => task.kind === "trap").length,
    honestCount: verified.filter((task) => task.kind === "honest").length,
    tasks: verified,
  };
}
