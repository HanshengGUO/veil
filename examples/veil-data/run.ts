import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableFromIPC } from "apache-arrow";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  loadAdapterFile,
  openReadSetSnapshotStore,
  runVeilDataCli,
  type VeilDataCliSnapshotResult,
} from "../../packages/veil-engine/src/index.ts";

const CHILD_ARROW = "--child-arrow";
const CHILD_SNAPSHOT = "--child-snapshot";

function coldEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TMP",
    "TEMP",
    "TMPDIR",
  ]) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

async function childContext(snapshotRoot?: string) {
  const sourceRoot = fileURLToPath(new URL("../csv-pit/", import.meta.url));
  const declaration = await loadAdapterFile(new URL("../csv-pit/adapter.yaml", import.meta.url));
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  const binding = createSourceBinding({
    id: "veil-data-cold-example",
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root: sourceRoot },
  });
  return {
    registry,
    declaration,
    binding,
    ...(snapshotRoot === undefined
      ? {}
      : { snapshotStore: await openReadSetSnapshotStore({ root: snapshotRoot }) }),
  };
}

async function runChild(mode: string, argumentsInput: readonly string[]): Promise<void> {
  if (mode === CHILD_ARROW) {
    const result = await runVeilDataCli(argumentsInput, await childContext());
    if (result.output !== "arrow") {
      throw new Error("cold Arrow command returned the wrong output kind");
    }
    process.stdout.write(result.arrowIpc);
    return;
  }
  const [snapshotRoot, ...cliArguments] = argumentsInput;
  if (mode !== CHILD_SNAPSHOT || snapshotRoot === undefined) {
    throw new Error("invalid cold veil-data child invocation");
  }
  const result = await runVeilDataCli(cliArguments, await childContext(snapshotRoot));
  if (result.output !== "snapshot") {
    throw new Error("cold snapshot command returned the wrong output kind");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function executeChild(mode: string, argumentsInput: readonly string[]): Promise<Buffer> {
  const entrypoint = fileURLToPath(import.meta.url);
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import=tsx", entrypoint, mode, ...argumentsInput], {
      cwd: repositoryRoot,
      env: coldEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once("error", () => rejectPromise(new Error("cold veil-data process could not start")));
    child.once("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error("cold veil-data process failed"));
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
  });
}

function values(table: ReturnType<typeof tableFromIPC>, column: string): unknown[] {
  if (table instanceof Promise) {
    throw new Error("unexpected asynchronous Arrow table");
  }
  return [...(table.getChild(column)?.toArray() ?? [])];
}

async function verifyColdSurface(): Promise<void> {
  const pointBytes = await executeChild(CHILD_ARROW, [
    "point",
    "--as-of",
    "2026-08-12",
    "--columns",
    "ticker,value",
    "--output",
    "arrow",
  ]);
  const point = tableFromIPC(pointBytes);
  if (point instanceof Promise) {
    throw new Error("unexpected asynchronous point table");
  }
  const pointTickers = values(point, "ticker");
  if (JSON.stringify(pointTickers) !== JSON.stringify(["PAST", "BOUNDARY"])) {
    throw new Error("future sentinel crossed the cold point guard");
  }

  const snapshotRoot = await mkdtemp(join(tmpdir(), "veil-data-cold-"));
  try {
    const snapshotBytes = await executeChild(CHILD_SNAPSHOT, [
      snapshotRoot,
      "panel",
      "--as-of",
      "2026-08-12",
      "--columns",
      "value",
      "--output",
      "snapshot",
    ]);
    const written = JSON.parse(snapshotBytes.toString("utf8")) as VeilDataCliSnapshotResult;
    if (
      written.output !== "snapshot" ||
      written.view.mode !== "panel" ||
      written.view.grade !== "exploration-grade" ||
      written.snapshot.id !== written.view.readSetId
    ) {
      throw new Error("cold panel did not return an exploration-grade snapshot reference");
    }

    const store = await openReadSetSnapshotStore({ root: snapshotRoot });
    const panel = tableFromIPC((await store.read(written.snapshot.id)).arrowIpc);
    if (panel instanceof Promise) {
      throw new Error("unexpected asynchronous panel table");
    }
    const panelColumns = panel.schema.fields.map((field) => field.name);
    const panelTickers = values(panel, "ticker");
    if (
      JSON.stringify(panelColumns) !==
        JSON.stringify(["ticker", "event_time", "available_time", "value"]) ||
      JSON.stringify(panelTickers) !== JSON.stringify(["PAST", "BOUNDARY"])
    ) {
      throw new Error("cold panel snapshot is not the guarded bitemporal export");
    }

    console.log(
      JSON.stringify({
        ok: true,
        coldProcess: true,
        pointRows: point.numRows,
        panelRows: panel.numRows,
        panelGrade: written.view.grade,
        futureRowsVisible: panelTickers.includes("FUTURE"),
        snapshotId: written.snapshot.id,
      }),
    );
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

const [mode, ...argumentsInput] = process.argv.slice(2);
if (mode === CHILD_ARROW || mode === CHILD_SNAPSHOT) {
  await runChild(mode, argumentsInput);
} else if (mode === undefined) {
  await verifyColdSurface();
} else {
  throw new Error("unknown veil-data example mode");
}
