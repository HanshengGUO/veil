import { fileURLToPath } from "node:url";
import { tableFromIPC } from "apache-arrow";
import {
  ArtifactRuntimeRegistry,
  BackendRegistry,
  captureArtifactCode,
  createArtifactManifest,
  createArtifactRuntimeProvider,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  executeArtifact,
  loadAdapterFile,
  TemporalGuard,
} from "../../packages/veil-engine/src/index.ts";

const codeRoot = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../csv-pit/", import.meta.url));
const runner = fileURLToPath(new URL("runner.ts", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const declaration = await loadAdapterFile(new URL("../csv-pit/adapter.yaml", import.meta.url));

const backends = new BackendRegistry();
backends.register(new DuckDbFileBackend());
const guard = new TemporalGuard(backends);
const binding = createSourceBinding({
  id: "artifact-execution-example",
  backend: DUCKDB_FILE_BACKEND_ID,
  options: { root: sourceRoot },
});
const [development, verification] = await Promise.all([
  guard.read(declaration, { asOf: "2026-08-11", columns: ["ticker", "value"] }, binding),
  guard.read(declaration, { asOf: "2026-08-12", columns: ["ticker", "value"] }, binding),
]);

const code = await captureArtifactCode({ root: codeRoot, files: ["factor.mjs"] });
const artifact = createArtifactManifest({
  factor: {
    runtime: { id: "node-example", constraint: ">=20,<30" },
    entry: { file: "factor.mjs", callable: "compute" },
    code,
  },
  paramsLocked: { lookbackDays: 20 },
  declaredLiterals: { selectedThreshold: 1.5 },
  trialsDeclared: 3,
  dataSemantics: {
    datasets: [
      {
        declaration,
        developmentReadSets: [development.readSet.manifestHash],
      },
    ],
  },
  hypothesisRef: "example.framed-momentum-v1",
  protocol: {
    mode: "expanding",
    folds: 3,
    trainDays: 252,
    oosDays: 21,
    purgeDays: 5,
    embargoDays: 2,
    holdDays: 5,
    executionLagDays: 1,
  },
  costModel: "example-bps-v1",
});

const runtimes = new ArtifactRuntimeRegistry();
runtimes.register(
  createArtifactRuntimeProvider({
    id: "node-example",
    implementation: { name: "node", version: process.versions.node },
    supports: (constraint) => constraint === ">=20,<30",
    launch: () => ({
      executable: process.execPath,
      arguments: ["--import", tsxLoader, runner],
    }),
  }),
);

const result = await executeArtifact({
  artifact,
  codeRoot,
  readSet: verification.readSet,
  arrowIpc: verification.arrowIpc,
  runtimes,
});
const table = tableFromIPC(result.arrowIpc);
const tickers = [...(table.getChild("ticker")?.toArray() ?? [])];
if (JSON.stringify(tickers) !== JSON.stringify(["PAST", "BOUNDARY"])) {
  throw new Error("artifact child did not receive the exact guarded verification window");
}

console.log(
  JSON.stringify({
    ok: true,
    framed: true,
    materializedCode: true,
    artifactHash: result.artifactHash,
    readSetId: result.readSetId,
    requestHash: result.requestHash,
    outputArrowHash: result.outputArrowHash,
    runtime: result.runtime,
    tickers,
  }),
);
