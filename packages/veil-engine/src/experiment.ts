import { createHash } from "node:crypto";
import { EngineConfigurationError } from "./errors.ts";
import { type OosPricingResult, verifyOosPricingResult } from "./oos-pricing.ts";
import { verifyPromotionCandidate } from "./promotion.ts";
import {
  createExperimentRecord,
  type ExperimentRecord,
  type ExperimentVerificationEvidence,
  type ExplorationMetricInput,
  type GateEvaluationVerificationEvidence,
  type PricingEvidenceVerificationEvidence,
  verifyExperimentRecord,
  verifyGateEvaluationRecord,
  verifyGatePolicyRecord,
} from "./stage4-evidence.ts";
import {
  assertIssuedStandardGateExecution,
  GATE_METHOD_EVIDENCE_FORMAT,
  type GateMethodEvidence,
  STANDARD_GATE_POLICY_ID,
  STANDARD_GATE_POLICY_VERSION,
  type StandardGateExecutionResult,
  TRIAL_AUDIT_FORMAT,
  type TrialAuditRecord,
} from "./statistical-gates.ts";

export const EXPERIMENT_EXECUTION_FORMAT = "veil.experiment-execution.v0" as const;
export const EXPERIMENT_MEMORY_FORMAT = "veil.experiment-memory.v0" as const;
export const EXPERIMENT_REPRODUCTION_FORMAT = "veil.experiment-reproduction.v0" as const;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const ISSUED_EXPERIMENTS = new WeakSet<object>();

export interface ExperimentExecutionResult {
  readonly format: typeof EXPERIMENT_EXECUTION_FORMAT;
  readonly experiment: ExperimentRecord;
  readonly pricing: OosPricingResult;
  readonly gates: StandardGateExecutionResult;
}

export interface ExecuteExperimentInput {
  readonly pricing: OosPricingResult;
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
  readonly gates: StandardGateExecutionResult;
  readonly issuedAt: string;
  readonly rationale: string;
  readonly lessons: readonly string[];
  readonly explorationMetric?: ExplorationMetricInput;
}

export interface ExperimentExecutionVerificationEvidence {
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
  readonly expectedExperimentId?: string;
}

export interface ExperimentMemoryRecord {
  readonly format: typeof EXPERIMENT_MEMORY_FORMAT;
  readonly experimentId: string;
  readonly hypothesisRef: string;
  readonly candidateHash: string;
  readonly artifactHash: string;
  readonly parameterLockHash: string;
  readonly dataset: ExperimentRecord["dataset"];
  readonly issuedAt: string;
  readonly verdict: ExperimentRecord["verdict"];
  readonly claimStatus: ExperimentRecord["claimStatus"];
  readonly effectiveTrials: number;
  readonly metrics: ExperimentRecord["metrics"];
  readonly gateReasons: readonly {
    readonly gateId: string;
    readonly outcome: ExperimentRecord["gates"][number]["outcome"];
    readonly reasonCode: string;
  }[];
  readonly lessons: readonly string[];
  readonly memoryHash: string;
}

export interface ExperimentMemorySnapshot {
  readonly hypothesisRef: string;
  readonly experimentIds: readonly string[];
  readonly snapshotHash: string;
}

export interface ExperimentStore {
  append(result: ExperimentExecutionResult): Promise<ExperimentMemoryRecord>;
  get(experimentId: string): Promise<ExperimentMemoryRecord | null>;
  list(hypothesisRef?: string): Promise<readonly ExperimentMemoryRecord[]>;
  snapshot(hypothesisRef: string): Promise<ExperimentMemorySnapshot>;
}

export interface ReadSetAvailability {
  readonly status: "available" | "retention-deleted";
  readonly tombstoneHash: string | null;
  readonly reason: string | null;
}

export interface ReproduceExperimentInput {
  readonly expected: unknown;
  readonly verification: ExperimentExecutionVerificationEvidence;
  readonly readSet: ReadSetAvailability;
  readonly rerun: () => ExperimentExecutionResult | Promise<ExperimentExecutionResult>;
}

export interface ExperimentReproductionRecord {
  readonly format: typeof EXPERIMENT_REPRODUCTION_FORMAT;
  readonly experimentId: string;
  readonly reproducedExperimentId: string;
  readonly pricingHash: string;
  readonly gateEvaluationHash: string;
  readonly metricsHash: string;
  readonly status: "matched";
  readonly reproductionHash: string;
}

/** Issues an Experiment only from a gate result produced by the standard executor in this process. */
export function executeExperiment(input: ExecuteExperimentInput): ExperimentExecutionResult {
  const root = exactRecord(
    input,
    [
      "pricing",
      "pricingVerification",
      "gates",
      "issuedAt",
      "rationale",
      "lessons",
      "explorationMetric",
    ],
    "Experiment execution input",
    true,
  );
  requireFields(
    root,
    ["pricing", "pricingVerification", "gates", "issuedAt", "rationale", "lessons"],
    "Experiment execution input",
  );
  const gates = root.gates as StandardGateExecutionResult;
  assertIssuedStandardGateExecution(gates);
  const pricingVerification = root.pricingVerification as PricingEvidenceVerificationEvidence;
  const pricing = verifyOosPricingResult({
    result: root.pricing,
    pricingVerification,
  });
  const gateVerification: GateEvaluationVerificationEvidence = {
    pricingEvidence: pricing.record,
    pricingVerification,
    policy: gates.policy,
    expectedGateEvaluationHash: gates.evaluation.gateEvaluationHash,
  };
  verifyGateEvaluationRecord(gates.evaluation, gateVerification);
  if (
    gates.evaluation.effectiveTrials !== gates.trialAudit.effectiveTrials ||
    gates.evaluation.results.length !== gates.methods.length ||
    gates.evaluation.results.some(
      (gate, index) =>
        gate.evidenceHash !== gates.methods[index]?.evidenceHash ||
        gate.implementationHash !== gates.methods[index]?.implementationHash,
    )
  ) {
    throw invalidExperimentExecution("gate evidence is not aligned with its evaluation");
  }
  const experiment = createExperimentRecord({
    gateEvaluation: gates.evaluation,
    gateEvaluationVerification: gateVerification,
    issuedAt: root.issuedAt as string,
    rationale: root.rationale as string,
    lessons: root.lessons as readonly string[],
    ...(root.explorationMetric === undefined
      ? {}
      : { explorationMetric: root.explorationMetric as ExplorationMetricInput }),
  });
  const result = deepFreeze({
    format: EXPERIMENT_EXECUTION_FORMAT,
    experiment,
    pricing,
    gates,
  });
  ISSUED_EXPERIMENTS.add(result);
  return result;
}

/** Verifies a serialized execution bundle and every content link used by metric reproduction. */
export function verifyExperimentExecution(
  input: unknown,
  evidenceInput: ExperimentExecutionVerificationEvidence,
): ExperimentExecutionResult {
  const evidence = exactRecord(
    evidenceInput,
    ["pricingVerification", "expectedExperimentId"],
    "Experiment execution verification evidence",
    true,
  );
  requireFields(evidence, ["pricingVerification"], "Experiment execution verification evidence");
  const root = exactRecord(
    input,
    ["format", "experiment", "pricing", "gates"],
    "Experiment execution",
  );
  if (root.format !== EXPERIMENT_EXECUTION_FORMAT) {
    throw invalidExperimentExecution("Experiment execution uses an unsupported format");
  }
  const pricingVerification = evidence.pricingVerification as PricingEvidenceVerificationEvidence;
  const pricing = verifyOosPricingResult({ result: root.pricing, pricingVerification });
  const gates = verifyGateBundle(root.gates, pricing, pricingVerification);
  const experimentVerification: ExperimentVerificationEvidence = {
    gateEvaluation: gates.evaluation,
    gateEvaluationVerification: {
      pricingEvidence: pricing.record,
      pricingVerification,
      policy: gates.policy,
      expectedGateEvaluationHash: gates.evaluation.gateEvaluationHash,
    },
    ...(evidence.expectedExperimentId === undefined
      ? {}
      : { expectedExperimentId: evidence.expectedExperimentId as string }),
  };
  const experiment = verifyExperimentRecord(root.experiment, experimentVerification);
  return deepFreeze({
    format: EXPERIMENT_EXECUTION_FORMAT,
    experiment,
    pricing,
    gates,
  });
}

/** Append-only in-memory reference store; adapters can persist the same portable memory records. */
export class InMemoryExperimentStore implements ExperimentStore {
  readonly #records = new Map<string, ExperimentMemoryRecord>();

  async append(result: ExperimentExecutionResult): Promise<ExperimentMemoryRecord> {
    if (!ISSUED_EXPERIMENTS.has(result)) {
      throw invalidExperimentExecution(
        "ExperimentStore accepts only executions issued by this engine instance",
      );
    }
    const record = createExperimentMemoryRecord(result);
    const existing = this.#records.get(record.experimentId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(record)) {
      throw new EngineConfigurationError(
        "DUPLICATE_EXPERIMENT",
        `Experiment ${record.experimentId} already names different memory content`,
        "Keep Experiment ids content-addressed and never overwrite an existing record.",
      );
    }
    if (existing === undefined) this.#records.set(record.experimentId, record);
    return existing ?? record;
  }

  async get(experimentIdInput: string): Promise<ExperimentMemoryRecord | null> {
    const experimentId = sha256(experimentIdInput, "Experiment id");
    return this.#records.get(experimentId) ?? null;
  }

  async list(hypothesisRefInput?: string): Promise<readonly ExperimentMemoryRecord[]> {
    const hypothesisRef =
      hypothesisRefInput === undefined
        ? undefined
        : portableId(hypothesisRefInput, "hypothesis reference");
    return Object.freeze(
      [...this.#records.values()]
        .filter((record) => hypothesisRef === undefined || record.hypothesisRef === hypothesisRef)
        .sort(
          (left, right) =>
            compareText(left.issuedAt, right.issuedAt) ||
            compareText(left.experimentId, right.experimentId),
        ),
    );
  }

  async snapshot(hypothesisRefInput: string): Promise<ExperimentMemorySnapshot> {
    const hypothesisRef = portableId(hypothesisRefInput, "hypothesis reference");
    const experimentIds = Object.freeze(
      (await this.list(hypothesisRef)).map((record) => record.experimentId).sort(compareText),
    );
    const body = { hypothesisRef, experimentIds };
    return deepFreeze({
      ...body,
      snapshotHash: hashCanonical("veil.experiment-memory-snapshot.v0", body),
    });
  }
}

/** Derives the compact append-only memory entry from a trusted complete Experiment execution. */
export function createExperimentMemoryRecord(
  result: ExperimentExecutionResult,
): ExperimentMemoryRecord {
  if (!ISSUED_EXPERIMENTS.has(result)) {
    throw invalidExperimentExecution(
      "Experiment memory can be derived only from an execution issued by this engine instance",
    );
  }
  return memoryRecord(result.experiment);
}

/** Verifies a serialized memory entry without requiring the large pricing/replay bundle. */
export function verifyExperimentMemoryRecord(input: unknown): ExperimentMemoryRecord {
  const root = exactRecord(
    input,
    [
      "format",
      "experimentId",
      "hypothesisRef",
      "candidateHash",
      "artifactHash",
      "parameterLockHash",
      "dataset",
      "issuedAt",
      "verdict",
      "claimStatus",
      "effectiveTrials",
      "metrics",
      "gateReasons",
      "lessons",
      "memoryHash",
    ],
    "Experiment memory record",
  );
  if (root.format !== EXPERIMENT_MEMORY_FORMAT) {
    throw invalidExperimentExecution("Experiment memory uses an unsupported format");
  }
  if (
    !Array.isArray(root.metrics) ||
    !Array.isArray(root.gateReasons) ||
    !Array.isArray(root.lessons)
  ) {
    throw invalidExperimentExecution("Experiment memory arrays are malformed");
  }
  if (
    (root.verdict !== "accepted" && root.verdict !== "degraded" && root.verdict !== "rejected") ||
    (root.claimStatus !== "verified" &&
      root.claimStatus !== "degraded" &&
      root.claimStatus !== "rejected") ||
    (root.verdict === "accepted") !== (root.claimStatus === "verified")
  ) {
    throw invalidExperimentExecution("Experiment memory verdict and claim status disagree");
  }
  const body = deepFreeze({
    format: EXPERIMENT_MEMORY_FORMAT,
    experimentId: sha256(root.experimentId, "Experiment memory id"),
    hypothesisRef: portableId(root.hypothesisRef, "Experiment memory hypothesis"),
    candidateHash: sha256(root.candidateHash, "Experiment memory candidate hash"),
    artifactHash: sha256(root.artifactHash, "Experiment memory artifact hash"),
    parameterLockHash: sha256(root.parameterLockHash, "Experiment memory parameter-lock hash"),
    dataset: root.dataset as ExperimentRecord["dataset"],
    issuedAt: root.issuedAt as string,
    verdict: root.verdict,
    claimStatus: root.claimStatus,
    effectiveTrials: positiveInteger(root.effectiveTrials, "Experiment memory effective trials"),
    metrics: root.metrics as ExperimentRecord["metrics"],
    gateReasons: Object.freeze(
      root.gateReasons.map((input) => {
        const gate = exactRecord(
          input,
          ["gateId", "outcome", "reasonCode"],
          "Experiment memory gate reason",
        );
        if (
          gate.outcome !== "passed" &&
          gate.outcome !== "failed" &&
          gate.outcome !== "unavailable"
        ) {
          throw invalidExperimentExecution("Experiment memory gate outcome is invalid");
        }
        return Object.freeze({
          gateId: portableId(gate.gateId, "Experiment memory gate id"),
          outcome: gate.outcome,
          reasonCode: portableId(gate.reasonCode, "Experiment memory gate reason code"),
        });
      }),
    ),
    lessons: Object.freeze(
      root.lessons.map((lesson) => {
        if (typeof lesson !== "string" || lesson.length === 0 || lesson.length > 1024) {
          throw invalidExperimentExecution("Experiment memory lesson is invalid");
        }
        return lesson;
      }),
    ),
  });
  canonicalJson(body.dataset);
  canonicalJson(body.metrics);
  if (
    (body.verdict === "accepted" && body.gateReasons.some((gate) => gate.outcome !== "passed")) ||
    (body.verdict === "degraded" &&
      (body.gateReasons.some((gate) => gate.outcome === "failed") ||
        !body.gateReasons.some((gate) => gate.outcome === "unavailable"))) ||
    (body.verdict === "rejected" && body.gateReasons.every((gate) => gate.outcome === "passed"))
  ) {
    throw invalidExperimentExecution("Experiment memory gate reasons disagree with its verdict");
  }
  const memoryHash = sha256(root.memoryHash, "Experiment memory hash");
  if (hashCanonical(EXPERIMENT_MEMORY_FORMAT, body) !== memoryHash) {
    throw invalidExperimentExecution("Experiment memory hash does not match its content");
  }
  return deepFreeze({ ...body, memoryHash }) as ExperimentMemoryRecord;
}

/** Re-runs an exact stored manifest and fails loudly on deletion or any metric/evidence drift. */
export async function reproduceExperiment(
  input: ReproduceExperimentInput,
): Promise<ExperimentReproductionRecord> {
  const root = exactRecord(
    input,
    ["expected", "verification", "readSet", "rerun"],
    "Experiment reproduction input",
  );
  if (typeof root.rerun !== "function") {
    throw invalidExperimentExecution("Experiment reproduction requires a rerun callback");
  }
  const availability = normalizeAvailability(root.readSet);
  if (availability.status === "retention-deleted") {
    throw new EngineConfigurationError(
      "READ_SET_UNAVAILABLE",
      "read set unavailable: retention deletion",
      "Preserve the tombstone and treat the published result as attested rather than reproducible.",
    );
  }
  const verification = root.verification as ExperimentExecutionVerificationEvidence;
  const expected = verifyExperimentExecution(root.expected, verification);
  let reproduced: ExperimentExecutionResult;
  try {
    reproduced = await root.rerun();
  } catch {
    throw new EngineConfigurationError(
      "EXPERIMENT_REPRODUCTION_FAILED",
      `Experiment ${expected.experiment.experimentId} could not be rerun`,
      "Inspect the trusted runtime diagnostics and restore the exact read-set snapshot before retrying.",
    );
  }
  if (!ISSUED_EXPERIMENTS.has(reproduced)) {
    throw invalidExperimentExecution("reproduction callback returned an unissued Experiment");
  }
  const expectedBindings = reproductionBindings(expected);
  const reproducedBindings = reproductionBindings(reproduced);
  if (canonicalJson(expectedBindings) !== canonicalJson(reproducedBindings)) {
    throw new EngineConfigurationError(
      "EXPERIMENT_REPRODUCTION_FAILED",
      `Experiment ${expected.experiment.experimentId} reproduced different metrics or evidence`,
      "Compare the artifact, read-set snapshot, pricing payloads, gate reasons, and locked methods.",
    );
  }
  const body = deepFreeze({
    format: EXPERIMENT_REPRODUCTION_FORMAT,
    experimentId: expected.experiment.experimentId,
    reproducedExperimentId: reproduced.experiment.experimentId,
    pricingHash: reproduced.experiment.pricingHash,
    gateEvaluationHash: reproduced.experiment.gateEvaluationHash,
    metricsHash: hashCanonical("veil.experiment-metrics.v0", reproduced.experiment.metrics),
    status: "matched" as const,
  });
  return deepFreeze({
    ...body,
    reproductionHash: hashCanonical(EXPERIMENT_REPRODUCTION_FORMAT, body),
  });
}

function verifyGateBundle(
  input: unknown,
  pricing: OosPricingResult,
  pricingVerification: PricingEvidenceVerificationEvidence,
): StandardGateExecutionResult {
  const root = exactRecord(
    input,
    ["policy", "trialAudit", "methods", "evaluation"],
    "standard gate execution",
  );
  const policy = verifyGatePolicyRecord(root.policy);
  if (
    policy.policyId !== STANDARD_GATE_POLICY_ID ||
    policy.policyVersion !== STANDARD_GATE_POLICY_VERSION
  ) {
    throw invalidExperimentExecution("gate execution does not use the standard Stage 4 policy");
  }
  const candidate = verifyPromotionCandidate(
    pricingVerification.candidate,
    pricingVerification.candidateEvidence,
  );
  const trialAudit = verifyTrialAudit(
    root.trialAudit,
    candidate.candidateHash,
    candidate.hypothesis.hypothesisRef,
  );
  if (!Array.isArray(root.methods) || root.methods.length !== policy.gates.length) {
    throw invalidExperimentExecution("gate method evidence must cover every policy gate");
  }
  const methods = Object.freeze(
    root.methods.map((method, index) =>
      verifyGateMethod(
        method,
        policy.gates[index]?.gateId,
        pricing.record.pricingHash,
        candidate.candidateHash,
        trialAudit.auditHash,
      ),
    ),
  );
  const evaluation = verifyGateEvaluationRecord(root.evaluation, {
    pricingEvidence: pricing.record,
    pricingVerification,
    policy,
  });
  if (
    evaluation.effectiveTrials !== trialAudit.effectiveTrials ||
    evaluation.results.some(
      (result, index) =>
        result.evidenceHash !== methods[index]?.evidenceHash ||
        result.implementationHash !== methods[index]?.implementationHash ||
        result.outcome !== methods[index]?.outcome ||
        result.reasonCode !== methods[index]?.reasonCode,
    )
  ) {
    throw invalidExperimentExecution("gate method evidence differs from the signed evaluation");
  }
  return deepFreeze({ policy, trialAudit, methods, evaluation });
}

function verifyTrialAudit(
  input: unknown,
  candidateHash: string,
  hypothesisRef: string,
): TrialAuditRecord {
  const root = exactRecord(
    input,
    [
      "format",
      "candidateHash",
      "hypothesisRef",
      "declaredTrials",
      "session",
      "memory",
      "observedTrials",
      "effectiveTrials",
      "trialBudget",
      "auditHash",
    ],
    "trial audit",
  );
  if (
    root.format !== TRIAL_AUDIT_FORMAT ||
    root.candidateHash !== candidateHash ||
    root.hypothesisRef !== hypothesisRef
  ) {
    throw invalidExperimentExecution("trial audit does not match the candidate hypothesis");
  }
  const session = exactRecord(root.session, ["ledgerHash", "attemptIds"], "trial session audit");
  const memory = exactRecord(
    root.memory,
    ["snapshotHash", "familyExperimentIds"],
    "trial memory audit",
  );
  if (!Array.isArray(session.attemptIds) || !Array.isArray(memory.familyExperimentIds)) {
    throw invalidExperimentExecution("trial audit counts do not contain source identities");
  }
  const attemptIds = Object.freeze(
    session.attemptIds.map((value) => portableId(value, "session attempt id")),
  );
  const familyExperimentIds = Object.freeze(
    memory.familyExperimentIds.map((value) => sha256(value, "family Experiment id")),
  );
  const declaredTrials = positiveInteger(root.declaredTrials, "declared trials");
  const observedTrials = positiveInteger(root.observedTrials, "observed trials");
  const effectiveTrials = positiveInteger(root.effectiveTrials, "effective trials");
  const trialBudget = positiveInteger(root.trialBudget, "trial budget");
  if (
    observedTrials !== attemptIds.length + familyExperimentIds.length ||
    effectiveTrials !== Math.max(declaredTrials, observedTrials)
  ) {
    throw invalidExperimentExecution("trial audit count does not reproduce from source identities");
  }
  const body = deepFreeze({
    format: TRIAL_AUDIT_FORMAT,
    candidateHash,
    hypothesisRef,
    declaredTrials,
    session: {
      ledgerHash: sha256(session.ledgerHash, "session ledger hash"),
      attemptIds,
    },
    memory: {
      snapshotHash: sha256(memory.snapshotHash, "memory snapshot hash"),
      familyExperimentIds,
    },
    observedTrials,
    effectiveTrials,
    trialBudget,
  });
  const auditHash = sha256(root.auditHash, "trial audit hash");
  if (hashCanonical(TRIAL_AUDIT_FORMAT, body) !== auditHash) {
    throw invalidExperimentExecution("trial audit hash does not match its normalized content");
  }
  return deepFreeze({ ...body, auditHash });
}

function verifyGateMethod(
  input: unknown,
  expectedGateId: string | undefined,
  pricingHash: string,
  candidateHash: string,
  trialAuditHash: string,
): GateMethodEvidence {
  const root = exactRecord(
    input,
    [
      "format",
      "gateId",
      "candidateHash",
      "pricingHash",
      "trialAuditHash",
      "outcome",
      "reasonCode",
      "implementationHash",
      "dependencyHashes",
      "statistics",
      "evidenceHash",
    ],
    "gate method evidence",
  );
  if (
    root.format !== GATE_METHOD_EVIDENCE_FORMAT ||
    root.gateId !== expectedGateId ||
    root.candidateHash !== candidateHash ||
    root.pricingHash !== pricingHash ||
    root.trialAuditHash !== trialAuditHash ||
    !Array.isArray(root.dependencyHashes) ||
    !Array.isArray(root.statistics)
  ) {
    throw invalidExperimentExecution("gate method evidence does not match the evaluation chain");
  }
  const body = deepFreeze({
    format: GATE_METHOD_EVIDENCE_FORMAT,
    gateId: portableId(root.gateId, "gate id"),
    candidateHash,
    pricingHash,
    trialAuditHash,
    outcome: root.outcome,
    reasonCode: portableId(root.reasonCode, "gate reason code"),
    implementationHash: sha256(root.implementationHash, "gate implementation hash"),
    dependencyHashes: Object.freeze(
      root.dependencyHashes.map((value) => sha256(value, "gate dependency hash")),
    ),
    statistics: Object.freeze(
      root.statistics.map((input) => {
        const statistic = exactRecord(input, ["name", "value"], "gate statistic");
        return Object.freeze({
          name: portableId(statistic.name, "gate statistic name"),
          value: canonicalNumber(statistic.value, "gate statistic value"),
        });
      }),
    ),
  });
  const evidenceHash = sha256(root.evidenceHash, "gate evidence hash");
  if (hashCanonical(GATE_METHOD_EVIDENCE_FORMAT, body) !== evidenceHash) {
    throw invalidExperimentExecution("gate method evidence hash does not match its content");
  }
  return deepFreeze({ ...body, evidenceHash }) as GateMethodEvidence;
}

function memoryRecord(experiment: ExperimentRecord): ExperimentMemoryRecord {
  const body = deepFreeze({
    format: EXPERIMENT_MEMORY_FORMAT,
    experimentId: experiment.experimentId,
    hypothesisRef: experiment.hypothesis.hypothesisRef,
    candidateHash: experiment.candidateHash,
    artifactHash: experiment.artifactHash,
    parameterLockHash: experiment.parameterLockHash,
    dataset: experiment.dataset,
    issuedAt: experiment.issuedAt,
    verdict: experiment.verdict,
    claimStatus: experiment.claimStatus,
    effectiveTrials: experiment.effectiveTrials,
    metrics: experiment.metrics,
    gateReasons: Object.freeze(
      experiment.gates.map((gate) =>
        Object.freeze({
          gateId: gate.gateId,
          outcome: gate.outcome,
          reasonCode: gate.reasonCode,
        }),
      ),
    ),
    lessons: experiment.lessons,
  });
  return deepFreeze({
    ...body,
    memoryHash: hashCanonical(EXPERIMENT_MEMORY_FORMAT, body),
  });
}

function reproductionBindings(result: ExperimentExecutionResult): unknown {
  return deepFreeze({
    experimentId: result.experiment.experimentId,
    artifactHash: result.experiment.artifactHash,
    parameterLockHash: result.experiment.parameterLockHash,
    pricingHash: result.experiment.pricingHash,
    gateEvaluationHash: result.experiment.gateEvaluationHash,
    metrics: result.experiment.metrics,
    gates: result.experiment.gates,
    verdict: result.experiment.verdict,
    claimStatus: result.experiment.claimStatus,
  });
}

function normalizeAvailability(input: unknown): ReadSetAvailability {
  const root = exactRecord(input, ["status", "tombstoneHash", "reason"], "read-set availability");
  if (root.status !== "available" && root.status !== "retention-deleted") {
    throw invalidExperimentExecution("read-set availability status is unsupported");
  }
  const deleted = root.status === "retention-deleted";
  if (
    deleted !== (root.tombstoneHash !== null) ||
    deleted !== (typeof root.reason === "string" && root.reason.trim().length > 0)
  ) {
    throw invalidExperimentExecution("read-set tombstone fields disagree with availability");
  }
  return Object.freeze({
    status: root.status,
    tombstoneHash:
      root.tombstoneHash === null ? null : sha256(root.tombstoneHash, "read-set tombstone hash"),
    reason: root.reason as string | null,
  });
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw invalidExperimentExecution(`${field} must be a plain object`);
  const actual = Object.keys(input);
  const allowed = new Set(keys);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && keys.some((key) => !actual.includes(key)))
  ) {
    throw invalidExperimentExecution(`${field} has missing or unknown fields`);
  }
  return input;
}

function requireFields(
  input: Record<string, unknown>,
  fields: readonly string[],
  context: string,
): void {
  if (fields.some((field) => !Object.hasOwn(input, field))) {
    throw invalidExperimentExecution(`${context} has missing fields`);
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function portableId(input: unknown, field: string): string {
  if (typeof input !== "string" || !PORTABLE_ID.test(input)) {
    throw invalidExperimentExecution(`${field} must be a portable identifier`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidExperimentExecution(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw invalidExperimentExecution(`${field} must be a positive safe integer`);
  }
  return input;
}

function canonicalNumber(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || Object.is(input, -0)) {
    throw invalidExperimentExecution(`${field} must be a canonical finite number`);
  }
  return input;
}

function hashCanonical(domain: string, input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(input))
    .digest("hex")}`;
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return JSON.stringify(input);
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw invalidExperimentExecution("Experiment evidence contains a non-canonical number");
    }
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(input)) {
    return `{${Object.keys(input)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  throw invalidExperimentExecution("Experiment evidence contains an unsupported value");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function invalidExperimentExecution(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_EXPERIMENT_EXECUTION",
    message,
    "Use the trusted pricing and standard-gate executors, then preserve their complete content-addressed bundle.",
  );
}
