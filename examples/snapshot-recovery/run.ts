import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  loadAdapterFile,
  openReadSetSnapshotRecovery,
  openReadSetSnapshotStore,
  TemporalGuard,
} from "../../packages/veil-engine/src/index.ts";

interface ColdSummary {
  readonly snapshotId: string;
  readonly resultHash: string;
  readonly operationId: string;
  readonly auditHash: string;
}

function snapshotDirectory(root: string, id: string): string {
  const hex = id.slice("sha256:".length);
  return join(root, "read-set-snapshots-v0", hex.slice(0, 2), hex);
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

async function coldVerify(root: string, snapshotId: string, operationId: string): Promise<void> {
  const store = await openReadSetSnapshotStore({ root });
  const recovery = await openReadSetSnapshotRecovery({ root });
  const [snapshot, audit] = await Promise.all([store.read(snapshotId), recovery.read(operationId)]);
  const summary: ColdSummary = {
    snapshotId: snapshot.snapshot.id,
    resultHash: snapshot.snapshot.resultHash,
    operationId: audit.operationId,
    auditHash: audit.auditHash,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function executeColdVerify(
  root: string,
  snapshotId: string,
  operationId: string,
): Promise<ColdSummary> {
  const entrypoint = fileURLToPath(import.meta.url);
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      ["--import=tsx", entrypoint, "--cold-verify", root, snapshotId, operationId],
      { cwd: repositoryRoot, encoding: "utf8", env: coldEnvironment() },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error("cold snapshot recovery verification failed"));
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout) as ColdSummary);
        } catch {
          rejectPromise(new Error("cold snapshot recovery verification returned invalid JSON"));
        }
      },
    );
  });
}

async function verifyRecovery(): Promise<void> {
  const sourceRoot = fileURLToPath(new URL("../csv-pit/", import.meta.url));
  const declaration = await loadAdapterFile(new URL("../csv-pit/adapter.yaml", import.meta.url));
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  const guarded = await new TemporalGuard(registry).read(
    declaration,
    { asOf: "2026-08-12", columns: ["ticker", "value"] },
    createSourceBinding({
      id: "snapshot-recovery-example",
      backend: DUCKDB_FILE_BACKEND_ID,
      options: { root: sourceRoot },
    }),
  );

  const root = await mkdtemp(join(tmpdir(), "veil-snapshot-recovery-"));
  try {
    const store = await openReadSetSnapshotStore({ root });
    const original = await store.put(guarded.readSet, guarded.arrowIpc);
    await writeFile(
      join(snapshotDirectory(root, original.snapshot.id), "data.arrow"),
      Uint8Array.of(1, 2, 3),
    );
    if ((await store.inspect(original.snapshot.id)).status !== "invalid") {
      throw new Error("simulated corruption was not detected");
    }

    const recovery = await openReadSetSnapshotRecovery({ root });
    const audit = await recovery.quarantine({
      snapshotId: original.snapshot.id,
      actor: "example.operator",
      reason: "The example deliberately truncated the temporary Arrow payload.",
    });
    if ((await store.inspect(original.snapshot.id)).status !== "missing") {
      throw new Error("quarantined evidence remained in the readable namespace");
    }

    const republished = await store.put(guarded.readSet, guarded.arrowIpc);
    if (!republished.created || republished.snapshot.id !== original.snapshot.id) {
      throw new Error("explicit snapshot republication did not restore the original identity");
    }
    const cold = await executeColdVerify(root, original.snapshot.id, audit.operationId);
    if (
      cold.snapshotId !== original.snapshot.id ||
      cold.resultHash !== original.snapshot.resultHash ||
      cold.operationId !== audit.operationId ||
      cold.auditHash !== audit.auditHash
    ) {
      throw new Error("cold recovery verification did not reproduce snapshot and audit identities");
    }

    console.log(
      JSON.stringify({
        ok: true,
        corruptionDetected: true,
        quarantined: true,
        explicitlyRepublished: true,
        coldVerified: true,
        snapshotId: cold.snapshotId,
        operationId: cold.operationId,
        auditHash: cold.auditHash,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const [mode, root, snapshotId, operationId] = process.argv.slice(2);
if (mode === "--cold-verify") {
  if (root === undefined || snapshotId === undefined || operationId === undefined) {
    throw new Error("cold recovery verification requires root, snapshot id, and operation id");
  }
  await coldVerify(root, snapshotId, operationId);
} else if (mode === undefined) {
  await verifyRecovery();
} else {
  throw new Error("unknown snapshot recovery example mode");
}
