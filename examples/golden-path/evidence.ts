import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactRuntimeRegistry,
  BackendRegistry,
  CompositeSourceBackend,
  captureArtifactCode,
  createArtifactManifest,
  createArtifactRuntimeProvider,
  createCompositeSource,
  createHypothesisRegistration,
  createPromotionCandidate,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  executeWalkForwardContract,
  loadAdapterFile,
  TemporalGuard,
  verifyCompositeSource,
  verifyPromotionCandidate,
  verifyWalkForwardContractRecord,
} from "../../packages/veil-engine/src/index.ts";
import {
  EMBARGO_DAYS,
  FOLD_COUNT,
  HOLD_DAYS,
  LOOKBACKS,
  OOS_BLOCK_DAYS,
  PURGE_DAYS,
  WARMUP_DAYS,
} from "./research.ts";

export interface GoldenPathEvidenceReport {
  readonly componentRows: {
    readonly prices: number;
    readonly membership: number;
    readonly composite: number;
    readonly eligible: number;
  };
  readonly primaryReadSetId: string;
  readonly membershipReadSetId: string;
  readonly compositeManifestHash: string;
  readonly artifactHash: string;
  readonly planHash: string;
  readonly executionCount: number;
  readonly contractHash: string;
  readonly candidateHash: string;
  readonly candidateStatus: "awaiting-pricing-and-gates";
  readonly claimStatus: "unverified";
}

export interface RunGoldenPathEvidenceInput {
  readonly dataDir: string;
  readonly dates: readonly string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const last = <T>(values: readonly T[]): T => {
  const value = values.at(-1);
  if (value === undefined) throw new Error("golden-path evidence requires a non-empty schedule");
  return value;
};
const decisionTime = (date: string): string => `${date}T00:00:00.000Z`;

/** Runs the honest study through the Stage 2 structural evidence path, without pricing it. */
export async function runGoldenPathEvidence(
  input: RunGoldenPathEvidenceInput,
): Promise<GoldenPathEvidenceReport> {
  const [pricesDeclaration, membershipDeclaration, outputDeclaration] = await Promise.all([
    loadAdapterFile(new URL("adapters/prices.yaml", import.meta.url)),
    loadAdapterFile(new URL("adapters/universe-history.yaml", import.meta.url)),
    loadAdapterFile(new URL("adapters/research-panel.yaml", import.meta.url)),
  ]);
  const fileBackends = new BackendRegistry();
  fileBackends.register(new DuckDbFileBackend());
  const fileGuard = new TemporalGuard(fileBackends);
  const pricesBinding = createSourceBinding({
    id: "golden-path-prices",
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root: input.dataDir },
  });
  const membershipBinding = createSourceBinding({
    id: "golden-path-membership",
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root: input.dataDir },
  });
  const sourceAsOf = decisionTime(last(input.dates));
  const [prices, membership] = await Promise.all([
    fileGuard.read(pricesDeclaration, { asOf: sourceAsOf }, pricesBinding),
    fileGuard.read(membershipDeclaration, { asOf: sourceAsOf }, membershipBinding),
  ]);
  const compositeInput = {
    primary: {
      declaration: pricesDeclaration,
      readSet: prices.readSet,
      arrowIpc: prices.arrowIpc,
    },
    membership: {
      declaration: membershipDeclaration,
      readSet: membership.readSet,
      arrowIpc: membership.arrowIpc,
    },
    outputDeclaration,
    membershipColumn: "in_universe",
    outputAvailableTimeColumn: "eligible_at",
    outputMembershipColumn: "in_universe",
    outputMaskColumn: "eligible",
  } as const;
  const composite = createCompositeSource(compositeInput);
  verifyCompositeSource(composite.manifest, {
    ...compositeInput,
    arrowIpc: composite.arrowIpc,
    expectedManifestHash: composite.manifest.manifestHash,
  });

  const compositeBackends = new BackendRegistry();
  compositeBackends.register(
    new CompositeSourceBackend({ snapshot: composite, declaration: outputDeclaration }),
  );
  const compositeGuard = new TemporalGuard(compositeBackends);
  const compositeBinding = createSourceBinding({
    id: "golden-path-research-panel",
    backend: "composite-source",
  });
  const development = await compositeGuard.read(
    outputDeclaration,
    { asOf: decisionTime(input.dates[WARMUP_DAYS - 1] ?? input.dates[0] ?? "") },
    compositeBinding,
  );

  const artifact = createArtifactManifest({
    factor: {
      runtime: { id: "node-golden-path", constraint: ">=20,<30" },
      entry: { file: "factor.mjs", callable: "compute" },
      code: await captureArtifactCode({ root: here, files: ["factor.mjs"] }),
    },
    paramsLocked: {
      candidateLookbacks: [...LOOKBACKS],
      standardization: "expanding",
      selectionScope: "training-fold-only",
    },
    declaredLiterals: { minimumHistory: 20, longShortQuantile: 0.2 },
    trialsDeclared: LOOKBACKS.length,
    dataSemantics: {
      datasets: [
        {
          declaration: outputDeclaration,
          developmentReadSets: [development.readSet.manifestHash],
        },
      ],
    },
    hypothesisRef: "golden-path.short-horizon-momentum.v1",
    protocol: {
      mode: "expanding",
      folds: FOLD_COUNT,
      trainDays: input.dates.length - PURGE_DAYS - EMBARGO_DAYS - FOLD_COUNT * OOS_BLOCK_DAYS,
      oosDays: OOS_BLOCK_DAYS,
      purgeDays: PURGE_DAYS,
      embargoDays: EMBARGO_DAYS,
      holdDays: HOLD_DAYS,
      executionLagDays: 1,
    },
    costModel: "golden-path-10bps-v1",
  });
  const runtimes = new ArtifactRuntimeRegistry();
  let executionLaunches = 0;
  runtimes.register(
    createArtifactRuntimeProvider({
      id: "node-golden-path",
      implementation: { name: "node", version: process.versions.node },
      supports: (constraint) => constraint === ">=20,<30",
      launch: () => {
        executionLaunches += 1;
        if (executionLaunches === 1 || executionLaunches % 50 === 0) {
          console.error(
            `[golden-path evidence] artifact executions: ${executionLaunches}/${FOLD_COUNT * (OOS_BLOCK_DAYS + 1)}`,
          );
        }
        return {
          executable: process.execPath,
          arguments: [fileURLToPath(new URL("runner.mjs", import.meta.url))],
        };
      },
    }),
  );
  const schedule = input.dates.map(decisionTime);
  const contract = await executeWalkForwardContract({
    artifact,
    codeRoot: here,
    decisionSchedule: schedule,
    declaration: outputDeclaration,
    guard: compositeGuard,
    binding: compositeBinding,
    runtimes,
    columns: ["ticker", "date", "close", "eligible"],
    concurrency: 8,
    retainExecutionEvidence: false,
  });
  verifyWalkForwardContractRecord(contract.record, {
    artifact,
    plan: contract.plan,
    declaration: outputDeclaration,
    expectedHash: contract.record.contractHash,
  });

  const registration = createHypothesisRegistration({
    hypothesisRef: artifact.hypothesisRef,
    statement:
      "Instruments with high trailing 3-20 session returns outperform low-return instruments over five sessions, out of sample and after costs.",
    ideaAvailableAt: "2015-01-01T00:00:00.000Z",
    registeredAt: "2015-12-01T00:00:00.000Z",
    source: { kind: "brief", reference: "golden-path-registration-v1" },
  });
  const verification = {
    startedAt: "2025-01-02T00:00:00.000Z",
    sourceReference: "golden-path-verification-v1",
  } as const;
  const candidate = createPromotionCandidate({
    artifact,
    plan: contract.plan,
    declaration: outputDeclaration,
    contractRecord: contract.record,
    verification,
    registration,
  });
  verifyPromotionCandidate(candidate, {
    artifact,
    plan: contract.plan,
    declaration: outputDeclaration,
    contractRecord: contract.record,
    registration,
    verification,
    expectedCandidateHash: candidate.candidateHash,
  });
  assertStructuralOnly(candidate);

  return Object.freeze({
    componentRows: Object.freeze({
      prices: prices.readSet.result.rowCount,
      membership: membership.readSet.result.rowCount,
      composite: composite.manifest.result.rowCount,
      eligible: composite.manifest.audit.eligibleRows,
    }),
    primaryReadSetId: prices.readSet.manifestHash,
    membershipReadSetId: membership.readSet.manifestHash,
    compositeManifestHash: composite.manifest.manifestHash,
    artifactHash: artifact.artifactHash,
    planHash: contract.plan.planHash,
    executionCount: contract.executionCount,
    contractHash: contract.record.contractHash,
    candidateHash: candidate.candidateHash,
    candidateStatus: candidate.status,
    claimStatus: candidate.claimStatus,
  });
}

function assertStructuralOnly(input: unknown): void {
  const forbidden = new Set([
    "price",
    "prices",
    "return",
    "returns",
    "metric",
    "metrics",
    "gates",
    "verdict",
    "experimentid",
  ]);
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key.toLowerCase())) {
        throw new Error(`promotion candidate contains forbidden outcome field ${key}`);
      }
      visit(child);
    }
  };
  visit(input);
}
