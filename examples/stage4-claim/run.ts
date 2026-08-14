import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import {
  loadProjectExperiment,
  persistProjectExperiment,
  recordProjectReadSetRetentionDeletion,
  reproduceProjectExperiment,
  VEIL_EXPERIMENT_ENTRY,
} from "../../packages/veil-agent/src/index.ts";
import {
  ArtifactRuntimeRegistry,
  BackendRegistry,
  CostModelRegistry,
  captureArtifactCode,
  createArtifactManifest,
  createArtifactRuntimeProvider,
  createCenteredBlockBootstrapNullGenerator,
  createHypothesisRegistration,
  createLinearBpsCostModel,
  createPromotionCandidate,
  createSourceBinding,
  executeExperiment,
  executeOosPricing,
  executeStandardGateEvaluation,
  executeWalkForwardContract,
  InMemoryExperimentStore,
  LONG_SHORT_OOS_PRICING_METHOD,
  NullGeneratorRegistry,
  reproduceExperiment,
  TemporalGuard,
  verifyExperimentExecution,
} from "../../packages/veil-engine/src/index.ts";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const runner = fileURLToPath(
  new URL("../../packages/veil-agent/runtime/node-runner.mjs", import.meta.url),
);
const schedule = Array.from({ length: 35 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);
const entities = ["AAA", "BBB", "CCC", "DDD"] as const;
const eventTime = schedule.flatMap((time) => entities.map(() => time));
const table = tableFromArrays({
  ticker: schedule.flatMap(() => entities),
  event_time: eventTime,
  available_time: eventTime,
  tradable: eventTime.map(() => true),
  price: schedule.flatMap((_, index) => [
    100 * 1.012 ** index,
    100 * 0.997 ** index,
    100 * 1.002 ** index,
    100 * 1.001 ** index,
  ]),
  volume: eventTime.map(() => 10_000_000),
});
const declaration = normalizeAdapterDeclaration({
  dataset: "stage4-claim-prices",
  version: "2026-08-13",
  entity_key: "ticker",
  event_time: "event_time",
  available_time: "available_time",
  availability_basis: "observed",
  guarantees: {
    point_in_time: true,
    survivorship_free: true,
    tradability_mask: "tradable",
  },
  payload_schema: { price: "float64", volume: "float64" },
  source: { type: "custom", locator: "logical/stage4-claim-prices" },
});
const backend = {
  id: "stage4-claim-memory",
  capabilities: {
    projectionPushdown: false,
    temporalPredicatePushdown: false,
    sourceFingerprint: "content-hash" as const,
    readOnly: true,
  },
  accepts: () => true,
  read: async () => ({
    arrowIpc: tableToIPC(table, "stream"),
    sourceFingerprint: {
      algorithm: "sha256" as const,
      value: "7".repeat(64),
      scope: "source-version" as const,
    },
    runtime: { name: "memory", version: "stage4-acceptance-v1" },
    pushdown: { projectionApplied: false, temporalPredicateApplied: false },
  }),
};
const backends = new BackendRegistry();
backends.register(backend);
const guard = new TemporalGuard(backends);
const binding = createSourceBinding({
  id: "stage4-claim-source",
  backend: backend.id,
  secrets: { credential: "acceptance-only-secret" },
});
const development = await guard.read(
  declaration,
  { asOf: "2025-12-31T00:00:00.000Z", columns: ["ticker", "price"] },
  binding,
);
const costModel = createLinearBpsCostModel({
  reference: "stage4-equities-10bps",
  basisPoints: 10,
});
const nullGenerator = createCenteredBlockBootstrapNullGenerator({
  reference: "stage4-centered-block-bootstrap",
  replications: 128,
  blockLength: 5,
  seed: 20260813,
});
const costModels = new CostModelRegistry();
costModels.register(costModel);
const nullGenerators = new NullGeneratorRegistry();
nullGenerators.register(nullGenerator);
const runtimes = new ArtifactRuntimeRegistry();
runtimes.register(
  createArtifactRuntimeProvider({
    id: "veil-node",
    implementation: { name: "node", version: process.versions.node },
    supports: (constraint) => constraint === ">=20.10.0,<30",
    launch: () => ({ executable: process.execPath, arguments: [runner] }),
  }),
);
const registration = createHypothesisRegistration({
  hypothesisRef: "example.stage4-claim-v1",
  statement: "The strongest cross-sectional price trend persists out of sample after costs.",
  ideaAvailableAt: "2025-11-01T00:00:00.000Z",
  registeredAt: "2025-12-01T00:00:00.000Z",
  source: { kind: "brief", reference: "stage4-claim-brief" },
});

const variants = [];
for (const lookbackDays of [3, 4, 5]) {
  const artifact = createArtifactManifest({
    factor: {
      runtime: { id: "veil-node", constraint: ">=20.10.0,<30" },
      entry: { file: "factor.mjs", callable: "compute" },
      code: await captureArtifactCode({ root: sourceRoot, files: ["factor.mjs"] }),
    },
    paramsLocked: { lookbackDays },
    declaredLiterals: {
      oosPricing: {
        pricingMethodIdentity: LONG_SHORT_OOS_PRICING_METHOD,
        signalColumn: "score",
        priceColumn: "price",
        marketColumns: ["volume"],
        periodsPerYear: 252,
        portfolio: { kind: "long-short-quantile", quantile: 0.25 },
        capacity: {
          portfolioNav: 1_000_000,
          volumeColumn: "volume",
          maximumParticipationRate: 0.05,
        },
        costModelIdentity: omitReference(costModel.toJSON()),
      },
      gatePolicy: {
        policyId: "veil.standard-stage4",
        policyVersion: "0.1.0",
        trialBudget: 16,
        nullGeneratorIdentity: nullGenerator.toJSON(),
        knowledgeCutoff: "2025-12-31T00:00:00.000Z",
      },
    },
    trialsDeclared: 3,
    dataSemantics: {
      datasets: [
        {
          declaration,
          developmentReadSets: [development.readSet.manifestHash],
        },
      ],
    },
    hypothesisRef: registration.hypothesisRef,
    protocol: {
      mode: "rolling",
      folds: 3,
      trainDays: 3,
      oosDays: 10,
      purgeDays: 1,
      embargoDays: 1,
      holdDays: 1,
      executionLagDays: 1,
    },
    costModel: costModel.reference,
  });
  const contractResult = await executeWalkForwardContract({
    artifact,
    codeRoot: sourceRoot,
    decisionSchedule: schedule,
    declaration,
    guard,
    binding,
    runtimes,
    columns: ["ticker", "price", "volume"],
    concurrency: 6,
    retainExecutionEvidence: true,
  });
  const verification = {
    startedAt: "2026-08-12T12:00:00.000Z",
    sourceReference: `stage4-claim-verification-${lookbackDays}`,
  };
  const candidateEvidence = {
    artifact,
    plan: contractResult.plan,
    declaration,
    contractRecord: contractResult.record,
    registration,
    verification,
  };
  const candidate = createPromotionCandidate({
    artifact,
    plan: contractResult.plan,
    declaration,
    contractRecord: contractResult.record,
    registration,
    verification,
  });
  const pricing = await executeOosPricing({
    candidate,
    candidateEvidence,
    contractResult,
    costModels,
  });
  variants.push({ candidate, candidateEvidence, contractResult, pricing });
}

const base = variants[1];
if (base === undefined) throw new Error("Stage 4 base variant is missing");
const neighbors = variants
  .filter((variant) => variant !== base)
  .map((variant) => ({
    result: variant.pricing,
    pricingVerification: {
      candidate: variant.candidate,
      candidateEvidence: variant.candidateEvidence,
    },
  }));
const pricingVerification = {
  candidate: base.candidate,
  candidateEvidence: base.candidateEvidence,
};
const gates = await executeStandardGateEvaluation({
  pricing: base.pricing,
  pricingVerification,
  trialEvidence: {
    sessionLedgerHash: hash("8"),
    sessionAttemptIds: ["stage4-trial-1", "stage4-trial-2", "stage4-trial-3"],
    memorySnapshotHash: hash("9"),
    familyExperimentIds: [],
  },
  nullGenerators,
  parameterNeighbors: neighbors,
});
if (gates.evaluation.verdict !== "accepted") {
  throw new Error(
    `Stage 4 gates did not accept the clean path: ${JSON.stringify(
      gates.methods.map((method) => ({
        gateId: method.gateId,
        outcome: method.outcome,
        reasonCode: method.reasonCode,
        statistics: method.statistics,
      })),
    )}`,
  );
}
const experimentInput = {
  pricing: base.pricing,
  pricingVerification,
  gates,
  issuedAt: "2026-08-13T01:00:00.000Z",
  rationale:
    "The clean Stage 4 path passed pricing, cost, trial, stability, null, and source gates.",
  lessons: ["Preserve the exact read-set snapshot and method identities for reproduction."],
} as const;
const execution = executeExperiment(experimentInput);
if (execution.experiment.claimStatus !== "verified") {
  throw new Error("accepted Stage 4 execution did not issue a verified Experiment");
}
verifyExperimentExecution(JSON.parse(JSON.stringify(execution)), {
  pricingVerification,
  expectedExperimentId: execution.experiment.experimentId,
});
const store = new InMemoryExperimentStore();
await store.append(execution);
const reproduced = await reproduceExperiment({
  expected: JSON.parse(JSON.stringify(execution)),
  verification: {
    pricingVerification,
    expectedExperimentId: execution.experiment.experimentId,
  },
  readSet: { status: "available", tombstoneHash: null, reason: null },
  rerun: () => executeExperiment(experimentInput),
});

const temporaryRoot = await mkdtemp(join(tmpdir(), "veil-stage4-claim-"));
try {
  await mkdir(temporaryRoot, { recursive: true });
  const entries: Array<{
    readonly type: "custom";
    readonly id: string;
    readonly parentId: string | null;
    readonly timestamp: string;
    readonly customType: string;
    readonly data: unknown;
  }> = [];
  const persisted = await persistProjectExperiment({
    projectRoot: temporaryRoot,
    execution,
    pricingVerification,
    artifactCodeRoot: sourceRoot,
    contractResult: base.contractResult,
    gateReplay: {
      trialEvidence: {
        sessionLedgerHash: hash("8"),
        sessionAttemptIds: ["stage4-trial-1", "stage4-trial-2", "stage4-trial-3"],
        memorySnapshotHash: hash("9"),
        familyExperimentIds: [],
      },
      parameterNeighbors: neighbors,
      postCutoffValidation: null,
    },
    getBranch: () => entries,
    appendEntry: (customType, data) => {
      entries.push({
        type: "custom",
        id: "stage4-experiment-entry",
        parentId: null,
        timestamp: "2026-08-13T01:00:01.000Z",
        customType,
        data,
      });
    },
  });
  if (entries[0]?.customType !== VEIL_EXPERIMENT_ENTRY) {
    throw new Error("project Experiment was not appended to Pi memory");
  }
  const archive = await loadProjectExperiment(temporaryRoot, execution.experiment.experimentId);
  const project = {
    root: temporaryRoot,
    projectReference: ".veil/project.yaml" as const,
    datasets: new Map([
      [declaration.dataset, { dataset: declaration.dataset, declaration, binding }],
    ]),
    backends,
    runtimes,
    promotionConcurrency: 6,
    costModels,
    nullGenerators,
  };
  const projectReproduction = await reproduceProjectExperiment({
    project,
    experimentId: execution.experiment.experimentId,
  });
  const deletedSnapshot = archive.readSetSnapshotIds[0];
  if (deletedSnapshot === undefined)
    throw new Error("project archive contains no read-set snapshot");
  await recordProjectReadSetRetentionDeletion({
    projectRoot: temporaryRoot,
    snapshotId: deletedSnapshot,
    deletedAt: "2026-08-13T01:00:02.000Z",
    reason: "Stage 4 retention acceptance",
    actor: "acceptance-operator",
  });
  await rm(join(temporaryRoot, ".veil", "snapshots"), { recursive: true, force: true });
  let retentionFailure: string | null = null;
  try {
    await reproduceProjectExperiment({
      project,
      experimentId: execution.experiment.experimentId,
    });
  } catch (error) {
    retentionFailure =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
  }
  if (retentionFailure !== "READ_SET_UNAVAILABLE") {
    throw new Error("retention deletion did not fail reproduction loudly");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      verdict: execution.experiment.verdict,
      claimStatus: execution.experiment.claimStatus,
      experimentId: execution.experiment.experimentId,
      effectiveTrials: execution.experiment.effectiveTrials,
      gateReasons: execution.experiment.gates.map((gate) => ({
        gateId: gate.gateId,
        outcome: gate.outcome,
        reasonCode: gate.reasonCode,
      })),
      metrics: execution.experiment.metrics,
      memoryExperiments: (await store.list(registration.hypothesisRef)).length,
      reproductionStatus: reproduced.status,
      archiveReference: persisted.archiveReference,
      archiveSnapshotCount: archive.readSetSnapshotIds.length,
      projectReproductionStatus: projectReproduction.status,
      retentionFailure,
    })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function omitReference(input: {
  readonly version: string;
  readonly implementationHash: string;
  readonly configurationHash: string;
}) {
  return {
    version: input.version,
    implementationHash: input.implementationHash,
    configurationHash: input.configurationHash,
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
