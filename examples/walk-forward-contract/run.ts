import { fileURLToPath } from "node:url";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import {
  ArtifactRuntimeRegistry,
  BackendRegistry,
  captureArtifactCode,
  createArtifactManifest,
  createArtifactRuntimeProvider,
  createHypothesisRegistration,
  createPromotionCandidate,
  createSourceBinding,
  executeWalkForwardContract,
  type TemporalBackend,
  TemporalGuard,
  verifyPromotionCandidate,
  verifyWalkForwardContractRecord,
} from "../../packages/veil-engine/src/index.ts";

const codeRoot = fileURLToPath(new URL(".", import.meta.url));
const runner = fileURLToPath(new URL("runner.ts", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const backendId = "contract-example-memory";
const schedule = Array.from({ length: 7 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);
const declaration = normalizeAdapterDeclaration({
  dataset: "walk-forward-contract-example",
  version: "2026-08-12",
  entity_key: "ticker",
  event_time: "event_time",
  available_time: "available_time",
  availability_basis: "observed",
  guarantees: { point_in_time: true, tradability_mask: "tradable" },
  payload_schema: { value: "float64" },
  source: { type: "custom", locator: "logical/contract-example" },
});
const eventTimes = schedule.flatMap((time) => [time, time]);
const table = tableFromArrays({
  ticker: schedule.flatMap(() => ["AAA", "BBB"]),
  event_time: eventTimes,
  available_time: eventTimes,
  tradable: schedule.flatMap((_, index) => [true, index !== 5]),
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
      value: "d".repeat(64),
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
  id: "walk-forward-contract-example",
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
  hypothesisRef: "example.walk-forward-contract-v1",
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
const result = await executeWalkForwardContract({
  artifact,
  codeRoot,
  decisionSchedule: schedule,
  declaration,
  guard,
  binding,
  runtimes,
  columns: ["ticker", "value"],
});
verifyWalkForwardContractRecord(result.record, {
  artifact,
  plan: result.plan,
  declaration,
  expectedHash: result.record.contractHash,
});
const registration = createHypothesisRegistration({
  hypothesisRef: artifact.hypothesisRef,
  statement: "Tradable short-horizon winners outperform after costs.",
  ideaAvailableAt: "2025-01-01T00:00:00.000Z",
  registeredAt: "2025-12-01T00:00:00.000Z",
  source: { kind: "brief", reference: "example-session-entry-001" },
});
const candidate = createPromotionCandidate({
  artifact,
  plan: result.plan,
  declaration,
  contractRecord: result.record,
  verification: {
    startedAt: "2026-08-12T12:00:00.000Z",
    sourceReference: "example-verification-run-001",
  },
  registration,
});
verifyPromotionCandidate(candidate, {
  artifact,
  plan: result.plan,
  declaration,
  contractRecord: result.record,
  registration,
  verification: candidate.verification,
  expectedCandidateHash: candidate.candidateHash,
});
const admittedRows = result.executions.map((execution) => execution.admitted.result.rowCount);
if (JSON.stringify(admittedRows) !== JSON.stringify([6, 1, 6, 2])) {
  throw new Error("contract execution did not admit the expected train and OOS rows");
}
const oosTimes = result.executions
  .filter((execution) => execution.record.role === "out-of-sample")
  .map((execution) => tableFromIPC(execution.admitted.arrowIpc).getChild("event_time")?.toArray());
if (JSON.stringify(oosTimes) !== JSON.stringify([[schedule[5]], [schedule[6], schedule[6]]])) {
  throw new Error("historical child output was admitted as a current OOS signal");
}
const serialized = JSON.stringify(result.record);
const serializedCandidate = JSON.stringify(candidate);
if (
  serialized.includes(backendId) ||
  serialized.includes(codeRoot) ||
  serialized.includes("never-crosses-the-guard") ||
  ["metrics", "prices", "returns", "gates", "verdict"].some((key) =>
    serialized.includes(`"${key}"`),
  ) ||
  serializedCandidate.includes(backendId) ||
  serializedCandidate.includes(codeRoot) ||
  ["metric", "return", "sharpe", "verdict", "experimentId"].some((key) =>
    serializedCandidate.toLowerCase().includes(`"${key.toLowerCase()}"`),
  )
) {
  throw new Error("contract record exposed private state or claimed an experiment outcome");
}

console.log(
  JSON.stringify({
    ok: true,
    status: result.record.status,
    artifactHash: result.record.artifactHash,
    planHash: result.record.planHash,
    parameterLockHash: result.record.parameterLockHash,
    contractHash: result.record.contractHash,
    candidateStatus: candidate.status,
    claimStatus: candidate.claimStatus,
    registrationStatus: candidate.hypothesis.registrationStatus,
    candidateHash: candidate.candidateHash,
    admittedRows,
    oosTimes,
  }),
);
