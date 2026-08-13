import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackendRegistry,
  captureArtifactCode,
  createArtifactManifest,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  loadAdapterFile,
  TemporalGuard,
  verifyArtifactCode,
  verifyArtifactManifest,
} from "../../packages/veil-engine/src/index.ts";

interface ColdSummary {
  readonly artifactHash: string;
  readonly codeTreeHash: string;
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

async function coldVerify(codeRoot: string, manifestPath: string): Promise<void> {
  const manifest = verifyArtifactManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  await verifyArtifactCode(codeRoot, manifest.factor.code);
  const summary: ColdSummary = {
    artifactHash: manifest.artifactHash,
    codeTreeHash: manifest.factor.code.treeHash,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function executeColdVerify(codeRoot: string, manifestPath: string): Promise<ColdSummary> {
  const entrypoint = fileURLToPath(import.meta.url);
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      ["--import=tsx", entrypoint, "--cold-verify", codeRoot, manifestPath],
      { cwd: repositoryRoot, encoding: "utf8", env: coldEnvironment() },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error("cold artifact verification failed"));
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout) as ColdSummary);
        } catch {
          rejectPromise(new Error("cold artifact verification returned invalid JSON"));
        }
      },
    );
  });
}

async function verifyIdentity(): Promise<void> {
  const codeRoot = fileURLToPath(new URL("./", import.meta.url));
  const sourceRoot = fileURLToPath(new URL("../csv-pit/", import.meta.url));
  const declaration = await loadAdapterFile(new URL("../csv-pit/adapter.yaml", import.meta.url));
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  const guarded = await new TemporalGuard(registry).read(
    declaration,
    { asOf: "2026-08-12", columns: ["ticker", "value"] },
    createSourceBinding({
      id: "artifact-identity-example",
      backend: DUCKDB_FILE_BACKEND_ID,
      options: { root: sourceRoot },
    }),
  );

  const temporary = await mkdtemp(join(tmpdir(), "veil-artifact-identity-"));
  try {
    await copyFile(join(codeRoot, "requirements.lock"), join(temporary, "requirements.lock"));
    await copyFile(join(codeRoot, "factor.py"), join(temporary, "factor.py"));
    const differentTime = new Date("2000-01-01T00:00:00Z");
    await Promise.all([
      utimes(join(temporary, "factor.py"), differentTime, differentTime),
      utimes(join(temporary, "requirements.lock"), differentTime, differentTime),
    ]);

    const [originalCode, copiedCode] = await Promise.all([
      captureArtifactCode({ root: codeRoot, files: ["factor.py", "requirements.lock"] }),
      captureArtifactCode({ root: temporary, files: ["requirements.lock", "factor.py"] }),
    ]);
    const common = {
      paramsLocked: { lookbackDays: 20 },
      declaredLiterals: { selectedThreshold: 1.5 },
      trialsDeclared: 3,
      dataSemantics: {
        datasets: [
          {
            declaration,
            developmentReadSets: [guarded.readSet.manifestHash],
          },
        ],
      },
      hypothesisRef: "example.momentum-v1",
      protocol: {
        mode: "expanding" as const,
        folds: 3,
        trainDays: 252,
        oosDays: 21,
        purgeDays: 5,
        embargoDays: 2,
        holdDays: 5,
        executionLagDays: 1,
      },
      costModel: "example-bps-v1",
    };
    const original = createArtifactManifest({
      ...common,
      factor: {
        runtime: { id: "python", constraint: ">=3.11,<4" },
        entry: { file: "factor.py", callable: "compute" },
        code: originalCode,
      },
    });
    const copied = createArtifactManifest({
      ...common,
      factor: {
        runtime: { id: "python", constraint: ">=3.11,<4" },
        entry: { file: "factor.py", callable: "compute" },
        code: copiedCode,
      },
    });
    if (original.artifactHash !== copied.artifactHash) {
      throw new Error("artifact identity changed across code roots");
    }

    const manifestPath = join(temporary, "artifact.json");
    await writeFile(manifestPath, `${JSON.stringify(copied, null, 2)}\n`);
    const cold = await executeColdVerify(temporary, manifestPath);
    if (
      cold.artifactHash !== original.artifactHash ||
      cold.codeTreeHash !== original.factor.code.treeHash
    ) {
      throw new Error("cold process did not reproduce artifact identity");
    }
    const developmentReadSet = original.dataSemantics.datasets[0]?.developmentReadSets[0];
    if (developmentReadSet === undefined) {
      throw new Error("artifact omitted its development read-set identity");
    }
    console.log(
      JSON.stringify({
        ok: true,
        pathIndependent: true,
        coldVerified: true,
        artifactHash: cold.artifactHash,
        codeTreeHash: cold.codeTreeHash,
        developmentReadSet,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const [mode, codeRoot, manifestPath] = process.argv.slice(2);
if (mode === "--cold-verify") {
  if (codeRoot === undefined || manifestPath === undefined) {
    throw new Error("cold artifact verification requires code root and manifest path");
  }
  await coldVerify(codeRoot, manifestPath);
} else if (mode === undefined) {
  await verifyIdentity();
} else {
  throw new Error("unknown artifact identity example mode");
}
