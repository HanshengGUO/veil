import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AdapterDeclaration, normalizeAdapterDeclaration } from "@veilquant/contract";
import { type Table, tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ArtifactManifest,
  type ArtifactProtocol,
  ArtifactRuntimeRegistry,
  BackendRegistry,
  CostModelRegistry,
  captureArtifactCode,
  createArtifactManifest,
  createArtifactRuntimeProvider,
  createHypothesisRegistration,
  createLinearBpsCostModel,
  createPromotionCandidate,
  createSourceBinding,
  executeExperiment,
  executeOosPricing,
  executeStandardGateEvaluation,
  executeWalkForwardContract,
  type GuardedReadResult,
  InMemoryExperimentStore,
  LONG_SHORT_OOS_PRICING_METHOD,
  type LongShortOosPricingConfiguration,
  NullGeneratorRegistry,
  reproduceExperiment,
  type TemporalBackend,
  TemporalGuard,
  verifyExperimentExecution,
  verifyHypothesisRegistration,
  verifyOosPricingResult,
  verifyPromotionCandidate,
  verifyWalkForwardContractRecord,
} from "../src/index.ts";
import {
  createExperimentRecord,
  createGateEvaluationRecord,
  createGatePolicyRecord,
  createPricingEvidenceRecord,
  verifyExperimentRecord,
  verifyGateEvaluationRecord,
  verifyGatePolicyRecord,
  verifyPricingEvidenceRecord,
} from "../src/stage4-evidence.ts";

const childEntrypoint = fileURLToPath(
  new URL("fixtures/artifact-runtime-child.ts", import.meta.url),
);
const tsxImportUrl = import.meta.resolve("tsx");
const roots: string[] = [];
const schedule = Array.from({ length: 7 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);
const protocol: ArtifactProtocol = {
  mode: "rolling",
  folds: 2,
  trainDays: 3,
  oosDays: 1,
  purgeDays: 1,
  embargoDays: 1,
  holdDays: 1,
  executionLagDays: 1,
};
const verificationStart = {
  startedAt: "2026-08-12T12:00:00.000Z",
  sourceReference: "verification-run-001",
} as const;

let codeRoot: string;
let adapter: ReturnType<typeof declaration>;
let artifact: ArtifactManifest;
let development: GuardedReadResult;
let primary: ReturnType<typeof backendHarness>;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(async () => {
  codeRoot = await mkdtemp(join(tmpdir(), "veil-contract-source-"));
  roots.push(codeRoot);
  await mkdir(join(codeRoot, "src"));
  await writeFile(
    join(codeRoot, "src", "factor.mjs"),
    "export const compute = (table) => table;\n",
  );
  adapter = declaration();
  primary = backendHarness("contract-memory-a", sourceTable());
  development = await primary.guard.read(
    adapter,
    { asOf: "2025-12-31", columns: ["ticker", "value"] },
    primary.binding,
  );
  artifact = await buildArtifact(adapter, development.readSet.manifestHash);
});

function declaration(mask: string | null = "tradable") {
  return normalizeAdapterDeclaration({
    dataset: "contract-prices",
    version: "2026-08-12",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true, tradability_mask: mask },
    payload_schema: { value: "float64" },
    source: { type: "custom", locator: "logical/contract-prices" },
  });
}

function sourceTable(mask?: readonly (boolean | null)[]): Table {
  const eventTime = schedule.flatMap((time) => [time, time]);
  return tableFromArrays({
    ticker: schedule.flatMap(() => ["AAA", "BBB"]),
    event_time: eventTime,
    available_time: eventTime,
    tradable: mask ?? schedule.flatMap((_, index) => [true, index !== 5]),
    value: eventTime.map((_, index) => index + 1),
  });
}

function backendHarness(id: string, table: Table) {
  let reads = 0;
  const backend: TemporalBackend = {
    id,
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: false,
      sourceFingerprint: "content-hash",
      readOnly: true,
    },
    accepts: (source) => source.type === "custom",
    read: async () => {
      reads += 1;
      return {
        arrowIpc: tableToIPC(table, "stream"),
        sourceFingerprint: {
          algorithm: "sha256",
          value: "c".repeat(64),
          scope: "source-version",
        },
        runtime: { name: "memory", version: `${id}-v1` },
        pushdown: { projectionApplied: false, temporalPredicateApplied: false },
      };
    },
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  return {
    guard: new TemporalGuard(registry),
    binding: createSourceBinding({
      id,
      backend: id,
      secrets: { credential: `${id}-private` },
    }),
    reads: () => reads,
  };
}

async function buildArtifact(
  selectedAdapter: AdapterDeclaration,
  developmentReadSetId: string,
  selectedProtocol: ArtifactProtocol = protocol,
  oosPricing?: LongShortOosPricingConfiguration,
): Promise<ArtifactManifest> {
  const code = await captureArtifactCode({ root: codeRoot, files: ["src/factor.mjs"] });
  const lockedPricing =
    oosPricing ??
    ({
      pricingMethodIdentity: {
        id: "close-to-close-v1",
        version: "0.1.0",
        implementationHash: hash("1"),
      },
      signalColumn: "value",
      priceColumn: "value",
      periodsPerYear: 252,
      portfolio: { kind: "long-short-quantile", quantile: 0.5 },
      costModelIdentity: {
        version: "0.1.0",
        implementationHash: hash("2"),
        configurationHash: hash("3"),
      },
    } satisfies LongShortOosPricingConfiguration);
  return createArtifactManifest({
    factor: {
      runtime: { id: "node", constraint: ">=20,<30" },
      entry: { file: "src/factor.mjs", callable: "compute" },
      code,
    },
    paramsLocked: { lookbackDays: 20 },
    declaredLiterals: {
      cutoff: 1.5,
      gatePolicy: {
        policyId: "veil.standard-stage4",
        policyVersion: "0.1.0",
        trialBudget: 16,
        nullGeneratorIdentity: null,
        knowledgeCutoff: null,
      },
      oosPricing: lockedPricing,
    },
    trialsDeclared: 4,
    dataSemantics: {
      datasets: [{ declaration: selectedAdapter, developmentReadSets: [developmentReadSetId] }],
    },
    hypothesisRef: "test.contract-v1",
    protocol: selectedProtocol,
    costModel: "test-bps-v1",
  });
}

function runtimes(mode: string | ((launch: number) => string) = "success") {
  let launches = 0;
  const registry = new ArtifactRuntimeRegistry();
  registry.register(
    createArtifactRuntimeProvider({
      id: "node",
      implementation: { name: "node", version: process.versions.node },
      supports: (constraint) => constraint === ">=20,<30",
      launch: () => {
        launches += 1;
        const childMode = typeof mode === "string" ? mode : mode(launches);
        return {
          executable: process.execPath,
          arguments: ["--import", tsxImportUrl, childEntrypoint, childMode],
        };
      },
    }),
  );
  return { registry, launches: () => launches };
}

function run(
  selectedArtifact = artifact,
  selectedAdapter: AdapterDeclaration = adapter,
  source = primary,
  runtime = runtimes().registry,
  selectedSchedule: readonly string[] = schedule,
  executionOptions: {
    readonly concurrency?: number;
    readonly retainExecutionEvidence?: boolean;
    readonly columns?: readonly string[];
  } = {},
) {
  return executeWalkForwardContract({
    artifact: selectedArtifact,
    codeRoot,
    decisionSchedule: selectedSchedule,
    declaration: selectedAdapter,
    guard: source.guard,
    binding: source.binding,
    runtimes: runtime,
    columns: ["ticker", "value"],
    ...executionOptions,
  });
}

describe("walk-forward contract verification", () => {
  it("issues deterministic complete C1-C4 evidence while admitting only current OOS rows", async () => {
    const first = await run();
    const second = await run();

    expect(first.record.status).toBe("contract-verified");
    expect(first.record.invariants).toEqual(["C1", "C2", "C3", "C4"]);
    expect(first.record).toEqual(second.record);
    expect(first.executions).toHaveLength(4);
    expect(
      first.executions.map((entry) => [entry.record.role, entry.record.decisionIndex]),
    ).toEqual([
      ["train", 2],
      ["out-of-sample", 5],
      ["train", 3],
      ["out-of-sample", 6],
    ]);
    expect(first.executions.map((entry) => entry.admitted.result.rowCount)).toEqual([6, 1, 6, 2]);
    expect(first.executions.map((entry) => entry.source.readSet.query.asOf)).toEqual([
      schedule[2],
      schedule[5],
      schedule[3],
      schedule[6],
    ]);
    expect(first.executions[0]?.source.readSet.query.projection).toEqual([
      "ticker",
      "value",
      "event_time",
      "tradable",
    ]);
    expect(
      first.executions
        .filter((entry) => entry.record.role === "out-of-sample")
        .map((entry) => tableFromIPC(entry.admitted.arrowIpc).getChild("event_time")?.toArray()),
    ).toEqual([[schedule[5]], [schedule[6], schedule[6]]]);
    expect(first.executions[1]?.view.manifest.audit.droppedUntradableRows).toBe(1);
    expect(first.executions[1]?.view.manifest.audit.decisionRows).toBe(1);
    const firstOosView = tableFromIPC(first.executions[1]?.view.arrowIpc ?? new Uint8Array());
    const firstOosEntities = firstOosView.getChild("ticker");
    const firstOosTimes = firstOosView.getChild("event_time");
    expect(
      Array.from({ length: firstOosView.numRows }, (_, row) => [
        firstOosEntities?.get(row),
        firstOosTimes?.get(row),
      ]).filter(([, eventTime]) => eventTime === schedule[5]),
    ).toEqual([["AAA", schedule[5]]]);
    expect(new Set(first.record.executions.map((entry) => entry.parameterLockHash))).toEqual(
      new Set([first.parameterLockHash]),
    );

    expect(
      verifyWalkForwardContractRecord(JSON.parse(JSON.stringify(first.record)), {
        artifact,
        plan: first.plan,
        declaration: adapter,
        expectedHash: first.record.contractHash,
      }),
    ).toEqual(first.record);
    const serialized = JSON.stringify(first.record);
    expect(serialized).not.toContain(codeRoot);
    expect(serialized).not.toContain(primary.binding.id);
    expect(serialized).not.toContain("private");
    for (const absent of [
      "metrics",
      "prices",
      "returns",
      "gates",
      "verdict",
      "stderr",
      "duration",
    ]) {
      expect(serialized).not.toContain(`"${absent}"`);
    }
  });

  it("can discard large Arrow evidence under bounded concurrency without changing the record", async () => {
    const retained = await run();
    const compact = await run(artifact, adapter, primary, runtimes().registry, schedule, {
      concurrency: 2,
      retainExecutionEvidence: false,
    });

    expect(compact.executionCount).toBe(4);
    expect(compact.executionEvidence).toBe("discarded");
    expect(compact.executions).toEqual([]);
    expect(compact.record).toEqual(retained.record);
  });

  it("allows overlapping fold roles to share one decision-time source read-set", async () => {
    const overlappingSchedule = Array.from({ length: 11 }, (_, index) =>
      new Date(Date.UTC(2026, 1, index + 1)).toISOString(),
    );
    const eventTime = overlappingSchedule.flatMap((time) => [time, time]);
    const source = backendHarness(
      "contract-overlapping-folds",
      tableFromArrays({
        ticker: overlappingSchedule.flatMap(() => ["AAA", "BBB"]),
        event_time: eventTime,
        available_time: eventTime,
        tradable: eventTime.map(() => true),
        value: eventTime.map((_, index) => index + 1),
      }),
    );
    const developmentRead = await source.guard.read(
      adapter,
      { asOf: "2025-12-31", columns: ["ticker", "value"] },
      source.binding,
    );
    const overlappingArtifact = await buildArtifact(adapter, developmentRead.readSet.manifestHash, {
      mode: "expanding",
      folds: 2,
      trainDays: 3,
      oosDays: 3,
      purgeDays: 1,
      embargoDays: 1,
      holdDays: 1,
      executionLagDays: 1,
    });
    const result = await run(
      overlappingArtifact,
      adapter,
      source,
      runtimes().registry,
      overlappingSchedule,
    );
    const repeatedDecision = result.record.executions.filter(
      (execution) => execution.decisionIndex === 5,
    );

    expect(repeatedDecision.map((execution) => [execution.foldIndex, execution.role])).toEqual([
      [0, "out-of-sample"],
      [1, "train"],
    ]);
    expect(new Set(repeatedDecision.map((execution) => execution.sourceReadSetId)).size).toBe(1);
    expect(new Set(repeatedDecision.map((execution) => execution.viewHash)).size).toBe(2);
    expect(new Set(repeatedDecision.map((execution) => execution.requestHash)).size).toBe(2);
    expect(new Set(repeatedDecision.map((execution) => execution.executionHash)).size).toBe(2);
    expect(
      verifyWalkForwardContractRecord(JSON.parse(JSON.stringify(result.record)), {
        artifact: overlappingArtifact,
        plan: result.plan,
        declaration: adapter,
      }),
    ).toEqual(result.record);
  });

  it("fails C4 before I/O or child launch when no tradability mask is declared", async () => {
    const unmasked = declaration(null);
    const unmaskedSource = backendHarness("contract-unmasked", sourceTable());
    const read = await unmaskedSource.guard.read(
      unmasked,
      { asOf: "2025-12-31", columns: ["ticker", "value"] },
      unmaskedSource.binding,
    );
    const unmaskedArtifact = await buildArtifact(unmasked, read.readSet.manifestHash);
    const runtime = runtimes();
    const readsBefore = unmaskedSource.reads();

    await expect(
      run(unmaskedArtifact, unmasked, unmaskedSource, runtime.registry),
    ).rejects.toMatchObject({
      invariant: "C4",
      detail: {
        remedy:
          "Use a registered dataset whose adapter already declares a truthful guarantees.tradability_mask, or keep the result exploratory; never add a guarantee without source evidence.",
      },
    });
    expect(unmaskedSource.reads()).toBe(readsBefore);
    expect(runtime.launches()).toBe(0);
  });

  it("fails C4 before child launch for an omitted or non-boolean mask", async () => {
    const missing = backendHarness(
      "contract-missing-mask",
      tableFromArrays({
        ticker: ["AAA"],
        event_time: [schedule[0]],
        available_time: [schedule[0]],
        value: [1],
      }),
    );
    const missingRuntime = runtimes();
    await expect(run(artifact, adapter, missing, missingRuntime.registry)).rejects.toMatchObject({
      invariant: "C4",
    });
    expect(missingRuntime.launches()).toBe(0);

    const invalidMask = schedule.flatMap((_, index) => [true, index === 1 ? null : true]);
    const invalid = backendHarness("contract-null-mask", sourceTable(invalidMask));
    const invalidRuntime = runtimes();
    await expect(run(artifact, adapter, invalid, invalidRuntime.registry)).rejects.toMatchObject({
      invariant: "C4",
    });
    expect(invalidRuntime.launches()).toBe(0);
  });

  it("rejects child output that reintroduces a masked row or a future row", async () => {
    const reintroduced = runtimes((launch) => (launch === 2 ? "untradable-row" : "success"));
    await expect(run(artifact, adapter, primary, reintroduced.registry)).rejects.toMatchObject({
      invariant: "C4",
    });
    expect(reintroduced.launches()).toBe(2);

    const future = runtimes((launch) => (launch === 2 ? "future-row" : "success"));
    await expect(run(artifact, adapter, primary, future.registry)).rejects.toMatchObject({
      invariant: "C1",
    });
    expect(future.launches()).toBe(2);
  });

  it("returns no contract record after a partial run and maps invalid topology to C2", async () => {
    const partial = runtimes((launch) => (launch === 2 ? "nonzero" : "success"));
    await expect(run(artifact, adapter, primary, partial.registry)).rejects.toMatchObject({
      code: "ARTIFACT_EXECUTION_FAILED",
    });
    expect(partial.launches()).toBe(2);

    const invalid = runtimes();
    const readsBefore = primary.reads();
    const topologyError: unknown = await run(
      artifact,
      adapter,
      primary,
      invalid.registry,
      schedule.slice(0, -1),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(topologyError).toBeInstanceOf(Error);
    expect(topologyError).toMatchObject({
      invariant: "C2",
      detail: {
        remedy:
          "Use the artifact's rolling or expanding protocol and supply every required UTC session.",
      },
    });
    expect((topologyError as Error).message).toBe(
      "[C2] walk-forward topology is invalid: decision schedule must contain exactly 7 sessions for the declared protocol",
    );
    expect(primary.reads()).toBe(readsBefore);
    expect(invalid.launches()).toBe(0);
  });

  it("reports C2/C3/C4 when serialized contract structure drifts", async () => {
    const result = await run();
    const parameterDrift = JSON.parse(JSON.stringify(result.record)) as {
      executions: Array<{ parameterLockHash: string }>;
    };
    const first = parameterDrift.executions[0];
    if (first === undefined) throw new Error("test execution missing");
    first.parameterLockHash = `sha256:${"0".repeat(64)}`;
    expect(() =>
      verifyWalkForwardContractRecord(parameterDrift, {
        artifact,
        plan: result.plan,
        declaration: adapter,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C3" }));

    const partial = JSON.parse(JSON.stringify(result.record)) as { executions: unknown[] };
    partial.executions.pop();
    expect(() =>
      verifyWalkForwardContractRecord(partial, {
        artifact,
        plan: result.plan,
        declaration: adapter,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C2" }));

    const maskDrift = JSON.parse(JSON.stringify(result.record)) as {
      executions: Array<{ maskAudit: { inputRows: number } }>;
    };
    const masked = maskDrift.executions[0];
    if (masked === undefined) throw new Error("test execution missing");
    masked.maskAudit.inputRows += 1;
    expect(() =>
      verifyWalkForwardContractRecord(maskDrift, {
        artifact,
        plan: result.plan,
        declaration: adapter,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C4" }));
  });

  it("remains backend-neutral while retaining opaque source lineage", async () => {
    const replacement = backendHarness("contract-memory-b", sourceTable());
    const first = await run();
    const second = await run(artifact, adapter, replacement);

    expect(second.executions.map((entry) => entry.admitted.result.rowCount)).toEqual([6, 1, 6, 2]);
    expect(second.record.contractHash).not.toBe(first.record.contractHash);
    expect(second.record.executions[0]?.sourceReadSetId).not.toBe(
      first.record.executions[0]?.sourceReadSetId,
    );
    const serialized = JSON.stringify(second.record);
    expect(serialized).not.toContain("contract-memory-a");
    expect(serialized).not.toContain("contract-memory-b");
    expect(serialized).not.toContain("credential");
  });
}, 15_000);

describe("promotion evidence boundary", () => {
  it("binds a preregistered hypothesis to contract evidence without issuing a claim", async () => {
    const result = await run();
    const registration = createHypothesisRegistration({
      hypothesisRef: artifact.hypothesisRef,
      statement: "Tradable short-horizon winners outperform after costs.",
      ideaAvailableAt: "2025-01-01T00:00:00.000Z",
      registeredAt: "2025-12-01T00:00:00.000Z",
      source: { kind: "brief", reference: "session-entry-001" },
    });
    expect(
      verifyHypothesisRegistration(JSON.parse(JSON.stringify(registration)), {
        expectedRegistrationHash: registration.registrationHash,
      }),
    ).toEqual(registration);

    const candidate = createPromotionCandidate({
      artifact,
      plan: result.plan,
      declaration: adapter,
      contractRecord: result.record,
      verification: verificationStart,
      registration,
    });
    expect(candidate.status).toBe("awaiting-pricing-and-gates");
    expect(candidate.structuralStatus).toBe("contract-verified");
    expect(candidate.claimStatus).toBe("unverified");
    expect(candidate.hypothesis).toEqual({
      hypothesisRef: artifact.hypothesisRef,
      registrationHash: registration.registrationHash,
      registrationStatus: "preregistered",
    });
    expect(candidate.gateInputs).toEqual({
      costModel: artifact.costModel,
      trialsDeclared: artifact.trialsDeclared,
      significanceTier: "standard",
    });
    expect(candidate.requiredEvidence).toEqual(["pricing", "costs", "statistical-gates"]);
    expect(
      verifyPromotionCandidate(JSON.parse(JSON.stringify(candidate)), {
        artifact,
        plan: result.plan,
        declaration: adapter,
        contractRecord: result.record,
        registration,
        verification: verificationStart,
        expectedCandidateHash: candidate.candidateHash,
      }),
    ).toEqual(candidate);
    expect(() =>
      verifyPromotionCandidate(candidate, {
        artifact,
        plan: result.plan,
        declaration: adapter,
        contractRecord: result.record,
        registration,
        verification: {
          ...verificationStart,
          sourceReference: "verification-run-002",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PROMOTION_CANDIDATE" }));

    const tampered = JSON.parse(JSON.stringify(candidate)) as { claimStatus: string };
    tampered.claimStatus = "verified";
    expect(() =>
      verifyPromotionCandidate(tampered, {
        artifact,
        plan: result.plan,
        declaration: adapter,
        contractRecord: result.record,
        registration,
        verification: verificationStart,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PROMOTION_CANDIDATE" }));

    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toContain(codeRoot);
    expect(serialized).not.toContain(primary.binding.id);
    for (const absent of ["metric", "return", "sharpe", "verdict", "experimentId"]) {
      expect(serialized.toLowerCase()).not.toContain(`"${absent.toLowerCase()}"`);
    }
  });

  it("normalizes registration content and rejects forged chronology or source references", () => {
    expect(() =>
      createHypothesisRegistration({
        hypothesisRef: artifact.hypothesisRef,
        statement: "The idea cannot appear after it was registered.",
        ideaAvailableAt: "2026-01-02T00:00:00.000Z",
        registeredAt: "2026-01-01T00:00:00.000Z",
        source: { kind: "brief", reference: "session-entry-002" },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_HYPOTHESIS_REGISTRATION" }));
    expect(() =>
      createHypothesisRegistration({
        hypothesisRef: artifact.hypothesisRef,
        statement: "Runtime paths are not durable registration references.",
        ideaAvailableAt: "2025-01-01T00:00:00.000Z",
        registeredAt: "2025-12-01T00:00:00.000Z",
        source: { kind: "external", reference: "/private/session.jsonl" },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_HYPOTHESIS_REGISTRATION" }));

    const registration = createHypothesisRegistration({
      hypothesisRef: artifact.hypothesisRef,
      statement: "A replayable hypothesis.",
      ideaAvailableAt: "2025-01-01T00:00:00.000Z",
      registeredAt: "2025-12-01T00:00:00.000Z",
      source: { kind: "explicit", reference: "session-entry-003" },
    });
    const tampered = JSON.parse(JSON.stringify(registration)) as { statement: string };
    tampered.statement = "A rewritten hypothesis.";
    expect(() => verifyHypothesisRegistration(tampered)).toThrowError(
      expect.objectContaining({ code: "INVALID_HYPOTHESIS_REGISTRATION" }),
    );
  });

  it("keeps an unregistered finding exploratory and rejects late or mismatched registration", async () => {
    const result = await run();
    const exploratory = createPromotionCandidate({
      artifact,
      plan: result.plan,
      declaration: adapter,
      contractRecord: result.record,
      verification: verificationStart,
      registration: null,
    });
    expect(exploratory.hypothesis.registrationStatus).toBe("exploratory");
    expect(exploratory.hypothesis.registrationHash).toBeNull();
    expect(exploratory.gateInputs.significanceTier).toBe("higher");

    const late = createHypothesisRegistration({
      hypothesisRef: artifact.hypothesisRef,
      statement: "This was written after verification began.",
      ideaAvailableAt: "2026-08-12T12:00:00.000Z",
      registeredAt: "2026-08-12T12:00:00.000Z",
      source: { kind: "explicit", reference: "session-entry-late" },
    });
    expect(() =>
      createPromotionCandidate({
        artifact,
        plan: result.plan,
        declaration: adapter,
        contractRecord: result.record,
        verification: verificationStart,
        registration: late,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C6" }));

    const wrongHypothesis = createHypothesisRegistration({
      hypothesisRef: "another-hypothesis",
      statement: "A different claim.",
      ideaAvailableAt: "2025-01-01T00:00:00.000Z",
      registeredAt: "2025-12-01T00:00:00.000Z",
      source: { kind: "external", reference: "literature-entry-001" },
    });
    expect(() =>
      createPromotionCandidate({
        artifact,
        plan: result.plan,
        declaration: adapter,
        contractRecord: result.record,
        verification: verificationStart,
        registration: wrongHypothesis,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C6" }));
  });

  it("rejects non-contract promotion inputs as C5 and preserves underlying contract violations", async () => {
    const result = await run();
    const input = {
      artifact,
      plan: result.plan,
      declaration: adapter,
      verification: verificationStart,
      registration: null,
    };
    expect(() =>
      createPromotionCandidate({
        ...input,
        contractRecord: result.executions[0]?.execution,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C5" }));
    expect(() =>
      createPromotionCandidate({
        ...input,
        contractRecord: { format: "exploration-result", sharpe: 9.9 },
      }),
    ).toThrowError(
      expect.objectContaining({
        invariant: "C5",
        detail: expect.objectContaining({
          context: { recordFormat: "unsupported-object" },
        }),
      }),
    );

    const badHash = JSON.parse(JSON.stringify(result.record)) as { contractHash: string };
    badHash.contractHash = `sha256:${"0".repeat(64)}`;
    expect(() => createPromotionCandidate({ ...input, contractRecord: badHash })).toThrowError(
      expect.objectContaining({ invariant: "C5" }),
    );

    const parameterDrift = JSON.parse(JSON.stringify(result.record)) as {
      parameterLockHash: string;
    };
    parameterDrift.parameterLockHash = `sha256:${"0".repeat(64)}`;
    expect(() =>
      createPromotionCandidate({ ...input, contractRecord: parameterDrift }),
    ).toThrowError(expect.objectContaining({ invariant: "C3" }));
  });
});

describe("Stage 4 claim evidence boundary", () => {
  it("deterministically prices a long-only OOS portfolio through the cost model", async () => {
    const pricingSchedule = Array.from({ length: 8 }, (_, index) =>
      new Date(Date.UTC(2026, 2, index + 1)).toISOString(),
    );
    const eventTime = pricingSchedule.flatMap((time) => [time, time]);
    const aaa = [10, 12, 16, 20, 24, 32, 40, 50];
    const values = aaa.flatMap((price) => [price, 20]);
    const source = backendHarness(
      "contract-pricing",
      tableFromArrays({
        ticker: pricingSchedule.flatMap(() => ["AAA", "BBB"]),
        event_time: eventTime,
        available_time: eventTime,
        tradable: eventTime.map(() => true),
        value: values,
      }),
    );
    const developmentRead = await source.guard.read(
      adapter,
      { asOf: "2025-12-31", columns: ["ticker", "value"] },
      source.binding,
    );
    const costModel = createLinearBpsCostModel({
      reference: "test-bps-v1",
      basisPoints: 10,
    });
    const costModelDescriptor = costModel.toJSON();
    const pricingArtifact = await buildArtifact(
      adapter,
      developmentRead.readSet.manifestHash,
      {
        mode: "rolling",
        folds: 1,
        trainDays: 3,
        oosDays: 3,
        purgeDays: 1,
        embargoDays: 1,
        holdDays: 1,
        executionLagDays: 1,
      },
      {
        pricingMethodIdentity: LONG_SHORT_OOS_PRICING_METHOD,
        signalColumn: "value",
        priceColumn: "value",
        periodsPerYear: 252,
        portfolio: { kind: "long-only-quantile", quantile: 0.5 },
        costModelIdentity: {
          version: costModelDescriptor.version,
          implementationHash: costModelDescriptor.implementationHash,
          configurationHash: costModelDescriptor.configurationHash,
        },
      },
    );
    const contractResult = await run(
      pricingArtifact,
      adapter,
      source,
      runtimes().registry,
      pricingSchedule,
    );
    const registration = createHypothesisRegistration({
      hypothesisRef: pricingArtifact.hypothesisRef,
      statement: "The higher-valued eligible instrument outperforms after costs.",
      ideaAvailableAt: "2025-01-01T00:00:00.000Z",
      registeredAt: "2025-12-01T00:00:00.000Z",
      source: { kind: "brief", reference: "session-entry-pricing" },
    });
    const candidateEvidence = {
      artifact: pricingArtifact,
      plan: contractResult.plan,
      declaration: adapter,
      contractRecord: contractResult.record,
      registration,
      verification: verificationStart,
    };
    const candidate = createPromotionCandidate({
      artifact: pricingArtifact,
      plan: contractResult.plan,
      declaration: adapter,
      contractRecord: contractResult.record,
      registration,
      verification: verificationStart,
    });
    const costModels = new CostModelRegistry();
    costModels.register(costModel);
    const input = {
      candidate,
      candidateEvidence,
      contractResult,
      costModels,
    };
    const first = await executeOosPricing(input);
    const second = await executeOosPricing(input);

    expect(first).toEqual(second);
    expect(first.record.status).toBe("priced");
    expect(first.record.costModel.reference).toBe(pricingArtifact.costModel);
    expect(first.record.costModel.configurationHash).toBe(costModels.list()[0]?.configurationHash);
    expect(first.record.sample).toEqual({ observations: 3, periodsPerYear: 252 });
    expect(first.payloads.trades.trades).toHaveLength(1);
    expect(first.payloads.grossReturns.observations.map((row) => row.value)).toEqual([
      0, 0.25, 0.25,
    ]);
    expect(first.payloads.costs.observations.map((row) => row.value)).toEqual([0, 0.001, 0]);
    expect(first.payloads.netReturns.observations.map((row) => row.value)).toEqual([
      0, 0.249, 0.25,
    ]);
    expect(first.record.series).toEqual({
      tradesHash: first.payloads.trades.tradesHash,
      grossReturnsHash: first.payloads.grossReturns.grossReturnsHash,
      costsHash: first.payloads.costs.costsHash,
      netReturnsHash: first.payloads.netReturns.netReturnsHash,
    });
    expect(verifyPricingEvidenceRecord(first.record, { candidate, candidateEvidence })).toEqual(
      first.record,
    );
    expect(
      verifyOosPricingResult({
        result: JSON.parse(JSON.stringify(first)),
        pricingVerification: { candidate, candidateEvidence },
      }),
    ).toEqual(first);
    expect(Object.isFrozen(first.payloads.netReturns.observations)).toBe(true);

    const gates = await executeStandardGateEvaluation({
      pricing: first,
      pricingVerification: { candidate, candidateEvidence },
      trialEvidence: {
        sessionLedgerHash: hash("e"),
        sessionAttemptIds: ["verification-run-001"],
        memorySnapshotHash: hash("f"),
        familyExperimentIds: [],
      },
      nullGenerators: new NullGeneratorRegistry(),
    });
    expect(gates.trialAudit.effectiveTrials).toBe(pricingArtifact.trialsDeclared);
    expect(gates.evaluation.verdict).toBe("rejected");
    expect(gates.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "cost-sensitivity",
          outcome: "passed",
        }),
        expect.objectContaining({
          gateId: "trials-aware-deflated-sharpe",
          outcome: "failed",
          reasonCode: "insufficient-oos-observations",
        }),
        expect.objectContaining({
          gateId: "walk-forward-stability",
          outcome: "failed",
          reasonCode: "insufficient-walk-forward-folds",
        }),
      ]),
    );

    const experimentInput = {
      pricing: first,
      pricingVerification: { candidate, candidateEvidence },
      gates,
      issuedAt: "2026-08-13T00:00:00.000Z",
      rationale: "The complete policy rejected a statistically incomplete short sample.",
      lessons: ["Collect enough OOS folds and parameter-neighbor evidence before claiming."],
    } as const;
    const experiment = executeExperiment(experimentInput);
    expect(experiment.experiment.verdict).toBe("rejected");
    expect(experiment.experiment.claimStatus).toBe("rejected");
    expect(
      verifyExperimentExecution(JSON.parse(JSON.stringify(experiment)), {
        pricingVerification: { candidate, candidateEvidence },
        expectedExperimentId: experiment.experiment.experimentId,
      }),
    ).toEqual(experiment);

    const store = new InMemoryExperimentStore();
    const memory = await store.append(experiment);
    expect(await store.get(experiment.experiment.experimentId)).toEqual(memory);
    expect(await store.snapshot(candidate.hypothesis.hypothesisRef)).toMatchObject({
      experimentIds: [experiment.experiment.experimentId],
    });
    const reproduction = await reproduceExperiment({
      expected: JSON.parse(JSON.stringify(experiment)),
      verification: {
        pricingVerification: { candidate, candidateEvidence },
        expectedExperimentId: experiment.experiment.experimentId,
      },
      readSet: { status: "available", tombstoneHash: null, reason: null },
      rerun: () => executeExperiment(experimentInput),
    });
    expect(reproduction.status).toBe("matched");
    await expect(
      reproduceExperiment({
        expected: experiment,
        verification: { pricingVerification: { candidate, candidateEvidence } },
        readSet: {
          status: "retention-deleted",
          tombstoneHash: hash("0"),
          reason: "Vendor retention policy",
        },
        rerun: () => executeExperiment(experimentInput),
      }),
    ).rejects.toMatchObject({ code: "READ_SET_UNAVAILABLE" });

    const tamperedPricing = JSON.parse(JSON.stringify(first)) as {
      payloads: { netReturns: { observations: Array<{ value: number }> } };
    };
    const firstNet = tamperedPricing.payloads.netReturns.observations[0];
    if (firstNet === undefined) throw new Error("test pricing result lacks observations");
    firstNet.value = 0.01;
    expect(() =>
      verifyOosPricingResult({
        result: tamperedPricing,
        pricingVerification: { candidate, candidateEvidence },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_OOS_PRICING" }));

    const missing = new CostModelRegistry();
    await expect(executeOosPricing({ ...input, costModels: missing })).rejects.toMatchObject({
      code: "COST_MODEL_NOT_FOUND",
    });
    const substituted = new CostModelRegistry();
    substituted.register(
      createLinearBpsCostModel({ reference: pricingArtifact.costModel, basisPoints: 0 }),
    );
    await expect(executeOosPricing({ ...input, costModels: substituted })).rejects.toMatchObject({
      code: "INVALID_OOS_PRICING",
    });
    await expect(
      executeOosPricing({
        ...input,
        contractResult: {
          ...contractResult,
          executionEvidence: "discarded",
          executions: [],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_OOS_PRICING" });
  });

  it("applies the declared tradability mask again at execution time", async () => {
    const pricingAdapter = normalizeAdapterDeclaration({
      dataset: "contract-prices",
      version: "2026-08-12",
      entity_key: "ticker",
      event_time: "event_time",
      available_time: "available_time",
      availability_basis: "observed",
      guarantees: { point_in_time: true, tradability_mask: "tradable" },
      payload_schema: { value: "float64", volume: "float64" },
      source: { type: "custom", locator: "logical/contract-prices" },
    });
    const pricingSchedule = Array.from({ length: 8 }, (_, index) =>
      new Date(Date.UTC(2026, 3, index + 1)).toISOString(),
    );
    const tickers = ["AAA", "BBB", "CCC", "DDD"];
    const aaa = [10, 12, 16, 20, 24, 32, 40, 50];
    const eventTime = pricingSchedule.flatMap((time) => tickers.map(() => time));
    const tradable = pricingSchedule.flatMap((_, dateIndex) =>
      tickers.map((ticker) => !(dateIndex === 6 && ticker === "AAA")),
    );
    const source = backendHarness(
      "contract-pricing-mask",
      tableFromArrays({
        ticker: pricingSchedule.flatMap(() => tickers),
        event_time: eventTime,
        available_time: eventTime,
        tradable,
        value: pricingSchedule.flatMap((_, dateIndex) => [aaa[dateIndex], 20, 10, 30]),
        volume: tradable.map((eligible) => (eligible ? 1_000 : 0)),
      }),
    );
    const developmentRead = await source.guard.read(
      pricingAdapter,
      { asOf: "2025-12-31", columns: ["ticker", "value"] },
      source.binding,
    );
    const costModel = createLinearBpsCostModel({
      reference: "test-bps-v1",
      basisPoints: 10,
    });
    const descriptor = costModel.toJSON();
    const pricingArtifact = await buildArtifact(
      pricingAdapter,
      developmentRead.readSet.manifestHash,
      {
        mode: "rolling",
        folds: 1,
        trainDays: 3,
        oosDays: 3,
        purgeDays: 1,
        embargoDays: 1,
        holdDays: 1,
        executionLagDays: 1,
      },
      {
        pricingMethodIdentity: LONG_SHORT_OOS_PRICING_METHOD,
        signalColumn: "value",
        priceColumn: "value",
        marketColumns: ["volume"],
        periodsPerYear: 252,
        portfolio: {
          kind: "long-short-quantile",
          quantile: 0.5,
          weightColumn: "volume",
        },
        capacity: {
          portfolioNav: 100,
          volumeColumn: "volume",
          maximumParticipationRate: 0.1,
        },
        costModelIdentity: {
          version: descriptor.version,
          implementationHash: descriptor.implementationHash,
          configurationHash: descriptor.configurationHash,
        },
      },
    );
    const contractResult = await run(
      pricingArtifact,
      pricingAdapter,
      source,
      runtimes().registry,
      pricingSchedule,
      { columns: ["ticker", "value", "volume"] },
    );
    const registration = createHypothesisRegistration({
      hypothesisRef: pricingArtifact.hypothesisRef,
      statement: "Execution-time masks prevent impossible fills.",
      ideaAvailableAt: "2025-01-01T00:00:00.000Z",
      registeredAt: "2025-12-01T00:00:00.000Z",
      source: { kind: "brief", reference: "session-entry-pricing-mask" },
    });
    const candidateEvidence = {
      artifact: pricingArtifact,
      plan: contractResult.plan,
      declaration: pricingAdapter,
      contractRecord: contractResult.record,
      registration,
      verification: verificationStart,
    };
    const candidate = createPromotionCandidate({
      artifact: pricingArtifact,
      plan: contractResult.plan,
      declaration: pricingAdapter,
      contractRecord: contractResult.record,
      registration,
      verification: verificationStart,
    });
    const costModels = new CostModelRegistry();
    costModels.register(costModel);
    const pricing = await executeOosPricing({
      candidate,
      candidateEvidence,
      contractResult,
      costModels,
    });

    expect(pricing.payloads.trades.trades).toHaveLength(2);
    expect(pricing.payloads.trades.marketData.every((row) => Number(row.fields.volume) > 0)).toBe(
      true,
    );
    expect(pricing.payloads.trades.trades.map((trade) => trade.entityKey)).toEqual([
      'string:"CCC"',
      'string:"DDD"',
    ]);
    const gates = await executeStandardGateEvaluation({
      pricing,
      pricingVerification: { candidate, candidateEvidence },
      trialEvidence: {
        sessionLedgerHash: hash("7"),
        sessionAttemptIds: ["verification-run-mask"],
        memorySnapshotHash: hash("8"),
        familyExperimentIds: [],
      },
      nullGenerators: new NullGeneratorRegistry(),
    });
    expect(gates.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "capacity-sensitivity",
          outcome: "passed",
          reasonCode: "capacity-stress-passed",
        }),
      ]),
    );
  });

  it("binds pricing and a complete gate policy into a citable content-addressed Experiment", async () => {
    const evidence = await stage4Evidence();

    expect(evidence.pricing.status).toBe("priced");
    expect(evidence.pricing.candidateHash).toBe(evidence.candidate.candidateHash);
    expect(evidence.pricing.costModel.reference).toBe(artifact.costModel);
    expect(evidence.pricing.metrics.some((metric) => metric.basis === "net")).toBe(true);
    expect(
      verifyPricingEvidenceRecord(JSON.parse(JSON.stringify(evidence.pricing)), {
        ...evidence.pricingVerification,
        expectedPricingHash: evidence.pricing.pricingHash,
      }),
    ).toEqual(evidence.pricing);
    expect(verifyGatePolicyRecord(JSON.parse(JSON.stringify(evidence.policy)))).toEqual(
      evidence.policy,
    );
    expect(
      verifyGateEvaluationRecord(JSON.parse(JSON.stringify(evidence.evaluation)), {
        ...evidence.gateVerification,
        expectedGateEvaluationHash: evidence.evaluation.gateEvaluationHash,
      }),
    ).toEqual(evidence.evaluation);
    expect(evidence.evaluation.verdict).toBe("accepted");
    expect(evidence.experiment.claimStatus).toBe("verified");
    expect(evidence.experiment.verdict).toBe("accepted");
    expect(evidence.experiment.evaporation).toMatchObject({
      exploration: { status: "unverified", value: 1.5 },
      verifiedValue: 0.7,
      delta: 0.8,
    });
    expect(
      verifyExperimentRecord(JSON.parse(JSON.stringify(evidence.experiment)), {
        gateEvaluation: evidence.evaluation,
        gateEvaluationVerification: evidence.gateVerification,
        expectedExperimentId: evidence.experiment.experimentId,
      }),
    ).toEqual(evidence.experiment);
    expect(Object.isFrozen(evidence.experiment)).toBe(true);
    expect(evidence.candidate.claimStatus).toBe("unverified");

    const serialized = JSON.stringify(evidence.experiment);
    expect(serialized).not.toContain(codeRoot);
    expect(serialized).not.toContain(primary.binding.id);
    expect(serialized).not.toContain("credential");
  });

  it("fails closed on incomplete policies, undercounted trials, and altered evidence", async () => {
    const evidence = await stage4Evidence();

    expect(() =>
      createGatePolicyRecord({
        policyId: "incomplete-policy",
        policyVersion: "0.1.0",
        gates: [
          {
            gateId: "trials-aware-significance",
            gateVersion: "0.1.0",
            category: "statistical-gates",
            required: true,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GATE_POLICY" }));
    expect(() =>
      createGateEvaluationRecord({
        pricingEvidence: evidence.pricing,
        pricingVerification: evidence.pricingVerification,
        policy: evidence.policy,
        effectiveTrials: artifact.trialsDeclared - 1,
        results: gateInputs("passed", "passed"),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GATE_EVALUATION" }));
    expect(() =>
      createGateEvaluationRecord({
        pricingEvidence: evidence.pricing,
        pricingVerification: evidence.pricingVerification,
        policy: evidence.policy,
        effectiveTrials: artifact.trialsDeclared,
        results: gateInputs("passed", "passed").slice(1),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GATE_EVALUATION" }));

    const changedPricing = JSON.parse(JSON.stringify(evidence.pricing)) as {
      series: { netReturnsHash: string };
    };
    changedPricing.series.netReturnsHash = hash("f");
    expect(() =>
      verifyPricingEvidenceRecord(changedPricing, evidence.pricingVerification),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PRICING_EVIDENCE" }));

    const changedGate = JSON.parse(JSON.stringify(evidence.evaluation)) as {
      results: Array<{ outcome: string }>;
    };
    const firstGate = changedGate.results[0];
    if (firstGate === undefined) throw new Error("test gate result missing");
    firstGate.outcome = "failed";
    expect(() => verifyGateEvaluationRecord(changedGate, evidence.gateVerification)).toThrowError(
      expect.objectContaining({ code: "INVALID_GATE_EVALUATION" }),
    );

    const changedExperiment = JSON.parse(JSON.stringify(evidence.experiment)) as {
      metrics: Array<{ value: number }>;
    };
    const firstMetric = changedExperiment.metrics[0];
    if (firstMetric === undefined) throw new Error("test metric missing");
    firstMetric.value += 1;
    expect(() =>
      verifyExperimentRecord(changedExperiment, {
        gateEvaluation: evidence.evaluation,
        gateEvaluationVerification: evidence.gateVerification,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EXPERIMENT" }));
  });

  it("derives degraded and rejected claim states from the immutable policy", async () => {
    const evidence = await stage4Evidence();
    const degradedEvaluation = createGateEvaluationRecord({
      pricingEvidence: evidence.pricing,
      pricingVerification: evidence.pricingVerification,
      policy: evidence.policy,
      effectiveTrials: artifact.trialsDeclared,
      results: gateInputs("passed", "unavailable"),
    });
    const degradedVerification = {
      ...evidence.gateVerification,
      expectedGateEvaluationHash: degradedEvaluation.gateEvaluationHash,
    };
    const degraded = createExperimentRecord({
      gateEvaluation: degradedEvaluation,
      gateEvaluationVerification: degradedVerification,
      issuedAt: "2026-08-12T13:00:00.000Z",
      rationale: "Required gates passed, but optional null evidence was unavailable.",
      lessons: ["Keep the result qualified until a registered null method is available."],
    });
    expect(degraded.verdict).toBe("degraded");
    expect(degraded.claimStatus).toBe("degraded");

    const optionalFailure = createGateEvaluationRecord({
      pricingEvidence: evidence.pricing,
      pricingVerification: evidence.pricingVerification,
      policy: evidence.policy,
      effectiveTrials: artifact.trialsDeclared,
      results: gateInputs("passed", "failed"),
    });
    expect(optionalFailure.verdict).toBe("rejected");

    const rejectedEvaluation = createGateEvaluationRecord({
      pricingEvidence: evidence.pricing,
      pricingVerification: evidence.pricingVerification,
      policy: evidence.policy,
      effectiveTrials: artifact.trialsDeclared,
      results: gateInputs("failed", "passed"),
    });
    const rejected = createExperimentRecord({
      gateEvaluation: rejectedEvaluation,
      gateEvaluationVerification: {
        ...evidence.gateVerification,
        expectedGateEvaluationHash: rejectedEvaluation.gateEvaluationHash,
      },
      issuedAt: "2026-08-12T13:00:00.000Z",
      rationale: "The required trials-aware significance gate failed.",
      lessons: ["Do not promote the effect claim."],
    });
    expect(rejected.verdict).toBe("rejected");
    expect(rejected.claimStatus).toBe("rejected");
    expect(rejected.metrics).toEqual(evidence.pricing.metrics);
  });
});

async function stage4Evidence() {
  const result = await run();
  const registration = createHypothesisRegistration({
    hypothesisRef: artifact.hypothesisRef,
    statement: "Tradable short-horizon winners outperform after costs.",
    ideaAvailableAt: "2025-01-01T00:00:00.000Z",
    registeredAt: "2025-12-01T00:00:00.000Z",
    source: { kind: "brief", reference: "session-entry-stage4" },
  });
  const candidateEvidence = {
    artifact,
    plan: result.plan,
    declaration: adapter,
    contractRecord: result.record,
    registration,
    verification: verificationStart,
  };
  const candidate = createPromotionCandidate({
    artifact,
    plan: result.plan,
    declaration: adapter,
    contractRecord: result.record,
    registration,
    verification: verificationStart,
  });
  const pricingVerification = { candidate, candidateEvidence };
  const pricing = createPricingEvidenceRecord({
    candidate,
    candidateEvidence,
    pricingMethod: {
      id: "close-to-close-v1",
      version: "0.1.0",
      implementationHash: hash("1"),
    },
    costModel: {
      reference: artifact.costModel,
      version: "0.1.0",
      implementationHash: hash("2"),
      configurationHash: hash("3"),
    },
    sample: { observations: 2, periodsPerYear: 252 },
    series: {
      tradesHash: hash("4"),
      grossReturnsHash: hash("5"),
      costsHash: hash("6"),
      netReturnsHash: hash("7"),
    },
    metrics: [
      {
        name: "sharpe",
        scope: "walk-forward-oos",
        basis: "net",
        unit: "ratio",
        value: 0.7,
      },
      {
        name: "sharpe",
        scope: "walk-forward-oos",
        basis: "gross",
        unit: "ratio",
        value: 1.1,
      },
    ],
  });
  const policy = createGatePolicyRecord({
    policyId: "stage4-standard-v0",
    policyVersion: "0.1.0",
    gates: [
      {
        gateId: "trials-aware-significance",
        gateVersion: "0.1.0",
        category: "statistical-gates",
        required: true,
      },
      {
        gateId: "cost-sensitivity",
        gateVersion: "0.1.0",
        category: "costs",
        required: true,
      },
      {
        gateId: "null-falsification",
        gateVersion: "0.1.0",
        category: "statistical-gates",
        required: false,
      },
    ],
  });
  const evaluation = createGateEvaluationRecord({
    pricingEvidence: pricing,
    pricingVerification,
    policy,
    effectiveTrials: artifact.trialsDeclared,
    results: gateInputs("passed", "passed"),
  });
  const gateVerification = {
    pricingEvidence: pricing,
    pricingVerification,
    policy,
  };
  const experiment = createExperimentRecord({
    gateEvaluation: evaluation,
    gateEvaluationVerification: gateVerification,
    issuedAt: "2026-08-12T13:00:00.000Z",
    rationale: "Pricing and every required gate completed against one immutable candidate.",
    lessons: ["Keep the candidate, pricing, policy, and gate identities together."],
    explorationMetric: {
      name: "sharpe",
      basis: "net",
      unit: "ratio",
      value: 1.5,
    },
  });
  return {
    candidate,
    candidateEvidence,
    pricing,
    pricingVerification,
    policy,
    evaluation,
    gateVerification,
    experiment,
  };
}

function gateInputs(
  requiredStatistical: "failed" | "passed",
  optionalNull: "failed" | "passed" | "unavailable",
) {
  return [
    {
      gateId: "cost-sensitivity",
      outcome: "passed" as const,
      implementationHash: hash("8"),
      evidenceHash: hash("9"),
      reasonCode: "within-cost-envelope",
    },
    {
      gateId: "trials-aware-significance",
      outcome: requiredStatistical,
      implementationHash: hash("a"),
      evidenceHash: hash("b"),
      reasonCode: requiredStatistical === "passed" ? "threshold-passed" : "threshold-not-met",
    },
    {
      gateId: "null-falsification",
      outcome: optionalNull,
      implementationHash: hash("c"),
      evidenceHash: hash("d"),
      reasonCode: optionalNull === "passed" ? "null-rejected" : "method-unavailable",
    },
  ];
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
