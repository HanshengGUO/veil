import { fileURLToPath } from "node:url";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import {
  ArtifactRuntimeRegistry,
  BackendRegistry,
  captureArtifactCode,
  createArtifactManifest,
  createArtifactRuntimeProvider,
  createSourceBinding,
  executeWalkForwardWindows,
  type TemporalBackend,
  TemporalGuard,
  verifyWalkForwardRunRecord,
} from "../../packages/veil-engine/src/index.ts";

const codeRoot = fileURLToPath(new URL(".", import.meta.url));
const runner = fileURLToPath(new URL("runner.ts", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const backendId = "walk-forward-memory";
const declaration = normalizeAdapterDeclaration({
  dataset: "walk-forward-example",
  version: "2026-08-12",
  entity_key: "ticker",
  event_time: "event_time",
  available_time: "available_time",
  availability_basis: "observed",
  guarantees: { point_in_time: true },
  payload_schema: { value: "float64" },
  source: { type: "custom", locator: "logical/example" },
});
const eventTimes = Array.from({ length: 4 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);
const table = tableFromArrays({
  ticker: eventTimes.map(() => "AAA"),
  event_time: eventTimes,
  available_time: eventTimes,
  value: eventTimes.map((_, index) => index + 1),
});
const backend: TemporalBackend = {
  id: backendId,
  capabilities: {
    projectionPushdown: false,
    temporalPredicatePushdown: false,
    sourceFingerprint: "content-hash",
    readOnly: true,
  },
  accepts: (source) => source.type === "custom",
  read: async () => ({
    arrowIpc: tableToIPC(table, "stream"),
    sourceFingerprint: {
      algorithm: "sha256",
      value: "c".repeat(64),
      scope: "source-version",
    },
    runtime: { name: "memory", version: "example-v1" },
    pushdown: { projectionApplied: false, temporalPredicateApplied: false },
  }),
};
const backends = new BackendRegistry();
backends.register(backend);
const guard = new TemporalGuard(backends);
const binding = createSourceBinding({
  id: "walk-forward-example",
  backend: backendId,
  secrets: { credential: "never-crosses-the-guard" },
});
const development = await guard.read(
  declaration,
  { asOf: "2025-12-31", columns: ["ticker", "value"] },
  binding,
);
const artifact = createArtifactManifest({
  factor: {
    runtime: { id: "node-example", constraint: ">=20,<30" },
    entry: { file: "factor.mjs", callable: "compute" },
    code: await captureArtifactCode({ root: codeRoot, files: ["factor.mjs"] }),
  },
  paramsLocked: { lookbackDays: 20 },
  declaredLiterals: { selectedThreshold: 1.5 },
  trialsDeclared: 3,
  dataSemantics: {
    datasets: [{ declaration, developmentReadSets: [development.readSet.manifestHash] }],
  },
  hypothesisRef: "example.walk-forward-v1",
  protocol: {
    mode: "rolling",
    folds: 2,
    trainDays: 3,
    oosDays: 1,
    purgeDays: 1,
    embargoDays: 1,
    holdDays: 1,
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
const decisionSchedule = Array.from({ length: 7 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);
const result = await executeWalkForwardWindows({
  artifact,
  codeRoot,
  decisionSchedule,
  declaration,
  guard,
  binding,
  runtimes,
  columns: ["ticker", "value"],
});
verifyWalkForwardRunRecord(result.record, {
  artifact,
  plan: result.plan,
  expectedHash: result.record.runHash,
});
const rowCounts = result.windows.map((window) => window.window.manifest.result.rowCount);
if (JSON.stringify(rowCounts) !== JSON.stringify([3, 3])) {
  throw new Error("rolling training windows did not use the declared session boundaries");
}
const serialized = JSON.stringify(result.record);
if (
  serialized.includes(backendId) ||
  serialized.includes(codeRoot) ||
  serialized.includes("never-crosses-the-guard") ||
  serialized.includes('"verified"')
) {
  throw new Error("run record exposed private state or claimed an OOS verdict");
}

console.log(
  JSON.stringify({
    ok: true,
    status: result.record.status,
    artifactHash: result.record.artifactHash,
    planHash: result.record.planHash,
    runHash: result.record.runHash,
    rowCounts,
    executionHashes: result.record.windows.map((window) => window.executionHash),
  }),
);
