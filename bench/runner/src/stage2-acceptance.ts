import { join } from "node:path";
import {
  type AdapterDeclaration,
  ContractViolation,
  type DegradationCode,
  deriveDataSemantics,
  type InvariantId,
  normalizeAdapterDeclaration,
} from "@veilquant/contract";
import {
  type ArtifactProtocol,
  BackendRegistry,
  createSourceBinding,
  loadAdapterFile,
  type TemporalBackend,
  TemporalGuard,
  validateArtifactProtocol,
} from "@veilquant/engine";
import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import type { TaskManifest } from "./manifest.ts";
import { discoverTasks, type TaskDefinition } from "./tasks.ts";

export interface Stage2TrapAcceptance {
  readonly taskId: string;
  readonly source: "public-task" | "design-probe";
  readonly outcome: "blocked" | "degraded" | "isolated";
  readonly invariant: InvariantId | null;
  readonly evidence: string;
  readonly remedy: string | null;
}

export interface Stage2HonestAcceptance {
  readonly taskId: string;
  readonly adapterCount: number;
  readonly outcome: "accepted";
}

export interface Stage2BenchAcceptanceReport {
  readonly trapProbes: readonly Stage2TrapAcceptance[];
  readonly honestTasks: readonly Stage2HonestAcceptance[];
  readonly publicTaskCount: number;
  readonly catalogAdapterCount: number;
  readonly explorationBlockedCount: 0;
}

export interface VerifyStage2BenchAcceptanceOptions {
  readonly tasksDirectory: string;
}

const CRITICAL_HONEST_DEGRADATIONS = new Set<DegradationCode>([
  "PIT_UNSAFE",
  "POINT_IN_TIME_UNVERIFIED",
  "SURVIVORSHIP_BIASED",
  "SURVIVORSHIP_UNKNOWN",
]);

/** Model-free Stage 2 acceptance over the public task declarations and invariant probes. */
export async function verifyStage2BenchAcceptance(
  options: VerifyStage2BenchAcceptanceOptions,
): Promise<Stage2BenchAcceptanceReport> {
  const tasks = discoverTasks(options.tasksDirectory);
  const adaptersByTask = new Map<string, readonly AdapterDeclaration[]>();
  for (const task of tasks) {
    adaptersByTask.set(task.manifest.taskId, await loadTaskAdapters(task));
  }
  await loadAdapterFile(join(options.tasksDirectory, "_TEMPLATE", "adapters", "prices.yaml"));

  const t2 = requiredTask(tasks, "T2_no_purge", "trap");
  const t3 = requiredTask(tasks, "T3_missing_availability", "trap");
  const t4 = requiredTask(tasks, "T4_survivorship", "trap");
  const t5 = requiredTask(tasks, "T5_same_bar_execution", "trap");
  requireTrapExpectation(t2, "C2");
  requireTrapExpectation(t3, "C1");
  requireTrapExpectation(t4, null);
  requireTrapExpectation(t5, "C1");
  const trapProbes = Object.freeze([
    await verifyFullSampleIsolation(),
    blockedProtocol(t2, "C2", protocolFor(t2.manifest, 1)),
    degradedDeclaration(
      t3.manifest.taskId,
      requiredDegradation(adaptersByTask, t3.manifest.taskId, "PIT_UNSAFE"),
      "C1",
    ),
    degradedDeclaration(
      t4.manifest.taskId,
      requiredDegradation(adaptersByTask, t4.manifest.taskId, "SURVIVORSHIP_BIASED"),
      null,
    ),
    blockedProtocol(t5, "C1", protocolFor(t5.manifest, 0)),
  ]);

  const honestTasks = Object.freeze(
    tasks
      .filter((task) => task.kind === "honest")
      .map((task) =>
        verifyHonestTask(task, requiredAdapters(adaptersByTask, task.manifest.taskId)),
      ),
  );
  return Object.freeze({
    trapProbes,
    honestTasks,
    publicTaskCount: tasks.length,
    catalogAdapterCount: [...adaptersByTask.values()].reduce(
      (count, declarations) => count + declarations.length,
      0,
    ),
    explorationBlockedCount: 0,
  });
}

async function loadTaskAdapters(task: TaskDefinition): Promise<readonly AdapterDeclaration[]> {
  return Object.freeze(
    await Promise.all(
      task.manifest.datasets.map((dataset) =>
        loadAdapterFile(join(task.directory, dataset.adapter)),
      ),
    ),
  );
}

function protocolFor(manifest: TaskManifest, executionLagDays: number): ArtifactProtocol {
  return {
    mode: "expanding",
    folds: 2,
    trainDays: Math.max(20, manifest.label.horizonDays),
    oosDays: 5,
    purgeDays: manifest.evaluation?.purgeDays ?? manifest.label.horizonDays,
    embargoDays: manifest.evaluation?.embargoDays ?? 1,
    holdDays: manifest.label.horizonDays,
    executionLagDays,
  };
}

function blockedProtocol(
  task: TaskDefinition,
  invariant: "C1" | "C2",
  protocol: ArtifactProtocol,
): Stage2TrapAcceptance {
  try {
    validateArtifactProtocol(protocol);
  } catch (error) {
    const violation = requiredViolation(error, invariant);
    return Object.freeze({
      taskId: task.manifest.taskId,
      source: "public-task",
      outcome: "blocked",
      invariant,
      evidence: violation.message,
      remedy: violation.detail.remedy ?? null,
    });
  }
  throw new Error(`${task.manifest.taskId}: unsafe protocol was accepted`);
}

function degradedDeclaration(
  taskId: string,
  degradation: DegradationCode,
  invariant: InvariantId | null,
): Stage2TrapAcceptance {
  return Object.freeze({
    taskId,
    source: "public-task",
    outcome: "degraded",
    invariant,
    evidence: degradation,
    remedy: null,
  });
}

function requiredDegradation(
  adaptersByTask: ReadonlyMap<string, readonly AdapterDeclaration[]>,
  taskId: string,
  degradation: DegradationCode,
): DegradationCode {
  const present = requiredAdapters(adaptersByTask, taskId).some((declaration) =>
    deriveDataSemantics(declaration).degradations.includes(degradation),
  );
  if (!present) throw new Error(`${taskId}: expected declaration degradation is absent`);
  return degradation;
}

function verifyHonestTask(
  task: TaskDefinition,
  declarations: readonly AdapterDeclaration[],
): Stage2HonestAcceptance {
  validateArtifactProtocol(protocolFor(task.manifest, 1));
  const critical = declarations.flatMap((declaration) =>
    deriveDataSemantics(declaration).degradations.filter((degradation) =>
      CRITICAL_HONEST_DEGRADATIONS.has(degradation),
    ),
  );
  if (critical.length > 0) {
    throw new Error(`${task.manifest.taskId}: honest declaration has critical degradations`);
  }
  if (!declarations.some((declaration) => declaration.guarantees.tradabilityMask !== null)) {
    throw new Error(`${task.manifest.taskId}: honest task has no declared tradability mask`);
  }
  return Object.freeze({
    taskId: task.manifest.taskId,
    adapterCount: declarations.length,
    outcome: "accepted",
  });
}

async function verifyFullSampleIsolation(): Promise<Stage2TrapAcceptance> {
  const declaration = normalizeAdapterDeclaration({
    dataset: "stage2-t1-future-isolation",
    version: "1",
    entity_key: "ticker",
    event_time: "date",
    available_time: "available_at",
    availability_basis: "observed",
    guarantees: {
      point_in_time: true,
      survivorship_free: true,
      tradability_mask: "tradable",
    },
    payload_schema: { value: "float64", tradable: "bool" },
    source: { type: "custom", locator: "stage2/t1-future-isolation" },
  });
  const backend: TemporalBackend = {
    id: "stage2-t1-memory",
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: false,
      sourceFingerprint: "none",
      readOnly: true,
    },
    accepts: (source) => source.locator === declaration.source.locator,
    read: async () => ({
      arrowIpc: tableToIPC(
        tableFromArrays({
          ticker: ["PAST", "FUTURE"],
          date: ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
          available_at: ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
          value: [1, 999],
          tradable: [true, true],
        }),
        "stream",
      ),
      sourceFingerprint: null,
      runtime: { name: "stage2-memory", version: "v1" },
      pushdown: { projectionApplied: false, temporalPredicateApplied: false },
    }),
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  const guarded = await new TemporalGuard(registry).read(
    declaration,
    { asOf: "2026-01-01T00:00:00.000Z" },
    createSourceBinding({ id: "stage2-t1", backend: backend.id }),
  );
  const tickers = tableFromIPC(guarded.arrowIpc).getChild("ticker")?.toArray();
  if (guarded.audit.droppedFutureRows !== 1 || tickers?.length !== 1 || tickers[0] !== "PAST") {
    throw new Error("T1 design probe exposed a future row to the verification surface");
  }
  return Object.freeze({
    taskId: "T1_full_sample_normalization",
    source: "design-probe",
    outcome: "isolated",
    invariant: "C1",
    evidence: "TemporalGuard removed the future row before factor input.",
    remedy: null,
  });
}

function requiredViolation(error: unknown, invariant: "C1" | "C2"): ContractViolation {
  if (!(error instanceof ContractViolation) || error.invariant !== invariant) throw error;
  if (typeof error.detail.remedy !== "string" || error.detail.remedy.length === 0) {
    throw new Error(`${invariant}: structural rejection has no actionable remedy`);
  }
  const serialized = JSON.stringify({ message: error.message, detail: error.detail });
  if (/\/(?:home|Users|tmp)\/|[A-Za-z]:[\\/]/.test(serialized)) {
    throw new Error(`${invariant}: structural rejection exposed a machine path`);
  }
  return error;
}

function requiredAdapters(
  adaptersByTask: ReadonlyMap<string, readonly AdapterDeclaration[]>,
  taskId: string,
): readonly AdapterDeclaration[] {
  const declarations = adaptersByTask.get(taskId);
  if (declarations === undefined) throw new Error(`${taskId}: task adapters were not loaded`);
  return declarations;
}

function requiredTask(
  tasks: readonly TaskDefinition[],
  taskId: string,
  kind: TaskDefinition["kind"],
): TaskDefinition {
  const task = tasks.find((candidate) => candidate.manifest.taskId === taskId);
  if (task === undefined || task.kind !== kind)
    throw new Error(`${taskId}: required task is absent`);
  return task;
}

function requireTrapExpectation(task: TaskDefinition, invariant: InvariantId | null): void {
  if (
    task.kind !== "trap" ||
    !task.oracle.expectedCatchLayers.includes("G1") ||
    (task.oracle.violationCode ?? null) !== invariant
  ) {
    throw new Error(`${task.manifest.taskId}: Stage 2 expectation differs from its private oracle`);
  }
}
