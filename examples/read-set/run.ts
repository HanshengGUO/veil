import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  loadAdapterFile,
  openReadSetSnapshotStore,
  type ReadSetSnapshot,
  TemporalGuard,
} from "../../packages/veil-engine/src/index.ts";

interface ReplaySummary {
  readonly format: string;
  readonly rows: number;
  readonly resultHash: string;
  readonly arrowHash: string;
  readonly manifestHash: string;
}

function summarize(snapshot: ReadSetSnapshot): ReplaySummary {
  return {
    format: snapshot.manifest.format,
    rows: snapshot.manifest.result.rowCount,
    resultHash: snapshot.manifest.result.resultHash,
    arrowHash: snapshot.manifest.result.arrowHash,
    manifestHash: snapshot.manifest.manifestHash,
  };
}

async function coldReplay(root: string, id: string): Promise<void> {
  const store = await openReadSetSnapshotStore({ root });
  console.log(JSON.stringify(summarize(await store.read(id))));
}

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

function executeColdReplay(root: string, id: string): Promise<ReplaySummary> {
  const entrypoint = fileURLToPath(import.meta.url);
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import=tsx", entrypoint, "--cold-replay", root, id],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: coldEnvironment(),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`cold snapshot replay failed: ${stderr.trim()}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as ReplaySummary);
        } catch {
          reject(new Error("cold snapshot replay returned invalid JSON"));
        }
      },
    );
  });
}

async function produceAndReplay(): Promise<void> {
  const sourceRoot = fileURLToPath(new URL("../csv-pit/", import.meta.url));
  const declaration = await loadAdapterFile(new URL("adapter.yaml", import.meta.url));
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  const result = await new TemporalGuard(registry).read(
    declaration,
    { asOf: "2026-08-12", columns: ["ticker", "value"] },
    createSourceBinding({
      id: "read-set-example",
      backend: DUCKDB_FILE_BACKEND_ID,
      options: { root: sourceRoot },
    }),
  );

  const snapshotRoot = await mkdtemp(join(tmpdir(), "veil-read-set-"));
  try {
    const store = await openReadSetSnapshotStore({ root: snapshotRoot });
    const write = await store.put(result.readSet, result.arrowIpc);
    const expected = summarize(
      await store.read(write.snapshot.id, {
        declaration,
        sourceFingerprint: result.sourceFingerprint,
      }),
    );
    const replayed = await executeColdReplay(snapshotRoot, write.snapshot.id);
    if (JSON.stringify(replayed) !== JSON.stringify(expected)) {
      throw new Error("cold snapshot replay did not reproduce the expected identity");
    }

    console.log(
      JSON.stringify({
        ok: true,
        coldReplay: true,
        created: write.created,
        ...replayed,
      }),
    );
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

const [mode, root, id] = process.argv.slice(2);
if (mode === "--cold-replay") {
  if (root === undefined || id === undefined) {
    throw new Error("cold replay requires a snapshot root and content id");
  }
  await coldReplay(root, id);
} else if (mode === undefined) {
  await produceAndReplay();
} else {
  throw new Error(`unknown read-set example mode: ${mode}`);
}
