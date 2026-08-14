import { createHash } from "node:crypto";
import {
  type AdapterDeclaration,
  type DegradationCode,
  deriveDataSemantics,
  normalizeDecisionTime,
} from "@veilquant/contract";
import { type ArtifactManifest, verifyArtifactManifest } from "./artifact.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  type PromotionCandidateRecord,
  type PromotionCandidateVerificationEvidence,
  verifyPromotionCandidate,
} from "./promotion.ts";
import {
  verifyWalkForwardContractRecord,
  type WalkForwardContractRecord,
} from "./walk-forward-contract-record.ts";

export const PRICING_EVIDENCE_FORMAT = "veil.pricing-evidence.v0" as const;
export const GATE_POLICY_FORMAT = "veil.gate-policy.v0" as const;
export const GATE_EVALUATION_FORMAT = "veil.gate-evaluation.v0" as const;
export const EXPERIMENT_FORMAT = "veil.experiment.v0" as const;

const PRICING_HASH_DOMAIN = PRICING_EVIDENCE_FORMAT;
const GATE_POLICY_HASH_DOMAIN = GATE_POLICY_FORMAT;
const GATE_EVALUATION_HASH_DOMAIN = GATE_EVALUATION_FORMAT;
const EXPERIMENT_HASH_DOMAIN = EXPERIMENT_FORMAT;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const MAX_METRICS = 128;
const MAX_GATES = 64;
const MAX_LESSONS = 64;

export type ExperimentMetricBasis = "gross" | "net";
export type ExperimentMetricUnit = "count" | "decimal" | "ratio";

export interface ExperimentMetric {
  readonly name: string;
  readonly scope: "walk-forward-oos";
  readonly basis: ExperimentMetricBasis;
  readonly unit: ExperimentMetricUnit;
  readonly value: number;
}

export interface Stage4MethodIdentity {
  readonly id: string;
  readonly version: string;
  readonly implementationHash: string;
}

export interface PricingEvidenceRecord {
  readonly format: typeof PRICING_EVIDENCE_FORMAT;
  readonly status: "priced";
  readonly candidateHash: string;
  readonly artifactHash: string;
  readonly planHash: string;
  readonly contractHash: string;
  readonly parameterLockHash: string;
  readonly dataset: {
    readonly dataset: string;
    readonly version: string;
    readonly declarationHash: string;
    readonly degradations: readonly DegradationCode[];
  };
  readonly pricingMethod: Stage4MethodIdentity;
  readonly costModel: {
    readonly reference: string;
    readonly version: string;
    readonly implementationHash: string;
    readonly configurationHash: string;
  };
  readonly sample: {
    readonly observations: number;
    readonly periodsPerYear: number;
  };
  /** Immutable payload identities. The payloads themselves remain in the trusted evidence store. */
  readonly series: {
    readonly tradesHash: string;
    readonly grossReturnsHash: string;
    readonly costsHash: string;
    readonly netReturnsHash: string;
  };
  readonly metrics: readonly ExperimentMetric[];
  readonly pricingHash: string;
}

export interface CreatePricingEvidenceInput {
  readonly candidate: unknown;
  readonly candidateEvidence: PromotionCandidateVerificationEvidence;
  readonly pricingMethod: Stage4MethodIdentity;
  readonly costModel: PricingEvidenceRecord["costModel"];
  readonly sample: PricingEvidenceRecord["sample"];
  readonly series: PricingEvidenceRecord["series"];
  readonly metrics: readonly ExperimentMetric[];
}

export interface PricingEvidenceVerificationEvidence {
  readonly candidate: unknown;
  readonly candidateEvidence: PromotionCandidateVerificationEvidence;
  readonly expectedPricingHash?: string;
}

export type GateEvidenceCategory = "costs" | "statistical-gates";
export type GateOutcome = "failed" | "passed" | "unavailable";
export type GateVerdict = "accepted" | "degraded" | "rejected";

export interface GatePolicyEntry {
  readonly gateId: string;
  readonly gateVersion: string;
  readonly category: GateEvidenceCategory;
  readonly required: boolean;
}

export interface GatePolicyRecord {
  readonly format: typeof GATE_POLICY_FORMAT;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly gates: readonly GatePolicyEntry[];
  readonly policyHash: string;
}

export interface CreateGatePolicyInput {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly gates: readonly GatePolicyEntry[];
}

export interface GateMethodResultInput {
  readonly gateId: string;
  readonly outcome: GateOutcome;
  readonly implementationHash: string;
  readonly evidenceHash: string;
  readonly reasonCode: string;
}

export interface GateResultRecord extends GatePolicyEntry {
  readonly outcome: GateOutcome;
  readonly implementationHash: string;
  readonly evidenceHash: string;
  readonly reasonCode: string;
}

export interface GateEvaluationRecord {
  readonly format: typeof GATE_EVALUATION_FORMAT;
  readonly status: "complete";
  readonly candidateHash: string;
  readonly pricingHash: string;
  readonly policyHash: string;
  readonly effectiveTrials: number;
  readonly results: readonly GateResultRecord[];
  readonly verdict: GateVerdict;
  readonly gateEvaluationHash: string;
}

export interface CreateGateEvaluationInput {
  readonly pricingEvidence: unknown;
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
  readonly policy: unknown;
  readonly effectiveTrials: number;
  readonly results: readonly GateMethodResultInput[];
}

export interface GateEvaluationVerificationEvidence {
  readonly pricingEvidence: unknown;
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
  readonly policy: unknown;
  readonly expectedGateEvaluationHash?: string;
}

export interface ExperimentEvaporation {
  readonly metric: Omit<ExperimentMetric, "value">;
  readonly exploration: {
    readonly status: "unverified";
    readonly value: number;
  };
  readonly verifiedValue: number;
  readonly delta: number;
}

export interface ExperimentRecord {
  readonly format: typeof EXPERIMENT_FORMAT;
  readonly status: "complete";
  readonly candidateHash: string;
  readonly artifactHash: string;
  readonly planHash: string;
  readonly contractHash: string;
  readonly parameterLockHash: string;
  readonly pricingHash: string;
  readonly gateEvaluationHash: string;
  readonly policyHash: string;
  readonly pricing: {
    readonly method: Stage4MethodIdentity;
    readonly costModel: PricingEvidenceRecord["costModel"];
    readonly sample: PricingEvidenceRecord["sample"];
    readonly series: PricingEvidenceRecord["series"];
  };
  readonly effectiveTrials: number;
  readonly hypothesis: PromotionCandidateRecord["hypothesis"];
  readonly dataset: PricingEvidenceRecord["dataset"];
  readonly metrics: readonly ExperimentMetric[];
  readonly gates: readonly GateResultRecord[];
  readonly verdict: GateVerdict;
  /** Only `verified` may support an unqualified positive effect claim. */
  readonly claimStatus: "degraded" | "rejected" | "verified";
  readonly evaporation: ExperimentEvaporation | null;
  readonly issuedAt: string;
  readonly rationale: string;
  readonly lessons: readonly string[];
  /** The Experiment id is the content hash of every field above. */
  readonly experimentId: string;
}

export interface ExplorationMetricInput extends Omit<ExperimentMetric, "scope"> {
  readonly scope?: "walk-forward-oos";
}

export interface CreateExperimentInput {
  readonly gateEvaluation: unknown;
  readonly gateEvaluationVerification: GateEvaluationVerificationEvidence;
  readonly issuedAt: string;
  readonly rationale: string;
  readonly lessons: readonly string[];
  readonly explorationMetric?: ExplorationMetricInput;
}

export interface ExperimentVerificationEvidence {
  readonly gateEvaluation: unknown;
  readonly gateEvaluationVerification: GateEvaluationVerificationEvidence;
  readonly expectedExperimentId?: string;
}

type PricingBody = Omit<PricingEvidenceRecord, "pricingHash">;
type GatePolicyBody = Omit<GatePolicyRecord, "policyHash">;
type GateEvaluationBody = Omit<GateEvaluationRecord, "gateEvaluationHash">;
type ExperimentBody = Omit<ExperimentRecord, "experimentId">;

interface StructuralChain {
  readonly candidate: PromotionCandidateRecord;
  readonly artifact: ArtifactManifest;
  readonly contract: WalkForwardContractRecord;
  readonly declaration: AdapterDeclaration;
}

interface PricingChain {
  readonly pricing: PricingEvidenceRecord;
  readonly structural: StructuralChain;
}

interface GateChain extends PricingChain {
  readonly policy: GatePolicyRecord;
  readonly evaluation: GateEvaluationRecord;
}

/** Internal issuer. Stage 4 pricing execution will call this after producing immutable series. */
export function createPricingEvidenceRecord(
  input: CreatePricingEvidenceInput,
): PricingEvidenceRecord {
  const root = exactRecord(
    input,
    ["candidate", "candidateEvidence", "pricingMethod", "costModel", "sample", "series", "metrics"],
    "pricing evidence input",
    invalidPricing,
  );
  const structural = verifyStructuralChain(
    root.candidate,
    root.candidateEvidence as PromotionCandidateVerificationEvidence,
  );
  const body = pricingBody(
    structural,
    root.pricingMethod,
    root.costModel,
    root.sample,
    root.series,
    root.metrics,
  );
  return deepFreeze({
    ...body,
    pricingHash: hashCanonical(PRICING_HASH_DOMAIN, body, invalidPricing),
  });
}

export function verifyPricingEvidenceRecord(
  input: unknown,
  evidenceInput: PricingEvidenceVerificationEvidence,
): PricingEvidenceRecord {
  return verifyPricingChain(input, evidenceInput).pricing;
}

/** Internal policy issuer. A policy must require cost and statistical evidence. */
export function createGatePolicyRecord(input: CreateGatePolicyInput): GatePolicyRecord {
  const root = exactRecord(
    input,
    ["policyId", "policyVersion", "gates"],
    "gate policy input",
    invalidGatePolicy,
  );
  const body = gatePolicyBody(root.policyId, root.policyVersion, root.gates);
  return deepFreeze({
    ...body,
    policyHash: hashCanonical(GATE_POLICY_HASH_DOMAIN, body, invalidGatePolicy),
  });
}

export function verifyGatePolicyRecord(input: unknown): GatePolicyRecord {
  const root = exactRecord(
    input,
    ["format", "policyId", "policyVersion", "gates", "policyHash"],
    "gate policy",
    invalidGatePolicy,
  );
  if (root.format !== GATE_POLICY_FORMAT) {
    throw invalidGatePolicy("gate policy uses an unsupported format");
  }
  const body = gatePolicyBody(root.policyId, root.policyVersion, root.gates);
  const policyHash = sha256(root.policyHash, "gate policy hash", invalidGatePolicy);
  if (hashCanonical(GATE_POLICY_HASH_DOMAIN, body, invalidGatePolicy) !== policyHash) {
    throw invalidGatePolicy("gate policy hash does not match its normalized content");
  }
  return deepFreeze({ ...body, policyHash });
}

/** Internal issuer. Results must cover every gate in the immutable policy exactly once. */
export function createGateEvaluationRecord(input: CreateGateEvaluationInput): GateEvaluationRecord {
  const root = exactRecord(
    input,
    ["pricingEvidence", "pricingVerification", "policy", "effectiveTrials", "results"],
    "gate evaluation input",
    invalidGateEvaluation,
  );
  const pricing = verifyPricingChain(
    root.pricingEvidence,
    root.pricingVerification as PricingEvidenceVerificationEvidence,
  );
  const policy = verifyGatePolicyRecord(root.policy);
  const effectiveTrials = positiveInteger(
    root.effectiveTrials,
    "effective trial count",
    invalidGateEvaluation,
  );
  if (effectiveTrials < pricing.structural.candidate.gateInputs.trialsDeclared) {
    throw invalidGateEvaluation(
      "effective trial count cannot be lower than the candidate's declared count",
    );
  }
  const results = gateResultsFromInputs(root.results, policy);
  const body = gateEvaluationBody(pricing.pricing, policy, effectiveTrials, results);
  return deepFreeze({
    ...body,
    gateEvaluationHash: hashCanonical(GATE_EVALUATION_HASH_DOMAIN, body, invalidGateEvaluation),
  });
}

export function verifyGateEvaluationRecord(
  input: unknown,
  evidenceInput: GateEvaluationVerificationEvidence,
): GateEvaluationRecord {
  return verifyGateChain(input, evidenceInput).evaluation;
}

/** Internal issuer. No Experiment exists until pricing and every policy gate are complete. */
export function createExperimentRecord(input: CreateExperimentInput): ExperimentRecord {
  const root = exactRecord(
    input,
    [
      "gateEvaluation",
      "gateEvaluationVerification",
      "issuedAt",
      "rationale",
      "lessons",
      "explorationMetric",
    ],
    "experiment input",
    invalidExperiment,
    true,
  );
  requireFields(
    root,
    ["gateEvaluation", "gateEvaluationVerification", "issuedAt", "rationale", "lessons"],
    invalidExperiment,
    "experiment input",
  );
  const chain = verifyGateChain(
    root.gateEvaluation,
    root.gateEvaluationVerification as GateEvaluationVerificationEvidence,
  );
  const body = experimentBody(
    chain,
    root.issuedAt,
    root.rationale,
    root.lessons,
    root.explorationMetric,
  );
  return deepFreeze({
    ...body,
    experimentId: hashCanonical(EXPERIMENT_HASH_DOMAIN, body, invalidExperiment),
  });
}

export function verifyExperimentRecord(
  input: unknown,
  evidenceInput: ExperimentVerificationEvidence,
): ExperimentRecord {
  const evidence = exactRecord(
    evidenceInput,
    ["gateEvaluation", "gateEvaluationVerification", "expectedExperimentId"],
    "experiment verification evidence",
    invalidExperiment,
    true,
  );
  requireFields(
    evidence,
    ["gateEvaluation", "gateEvaluationVerification"],
    invalidExperiment,
    "experiment verification evidence",
  );
  const chain = verifyGateChain(
    evidence.gateEvaluation,
    evidence.gateEvaluationVerification as GateEvaluationVerificationEvidence,
  );
  const root = exactRecord(
    input,
    [
      "format",
      "status",
      "candidateHash",
      "artifactHash",
      "planHash",
      "contractHash",
      "parameterLockHash",
      "pricingHash",
      "gateEvaluationHash",
      "policyHash",
      "pricing",
      "effectiveTrials",
      "hypothesis",
      "dataset",
      "metrics",
      "gates",
      "verdict",
      "claimStatus",
      "evaporation",
      "issuedAt",
      "rationale",
      "lessons",
      "experimentId",
    ],
    "experiment",
    invalidExperiment,
  );
  if (root.format !== EXPERIMENT_FORMAT || root.status !== "complete") {
    throw invalidExperiment("experiment uses an unsupported format or status");
  }
  const body = experimentBody(
    rootChainFields(root, chain),
    root.issuedAt,
    root.rationale,
    root.lessons,
    {
      fromRecord: root.evaporation,
    },
  );
  if (!sameCanonicalExperimentBindings(root, body)) {
    throw invalidExperiment("experiment does not match its pricing and gate evidence");
  }
  const experimentId = sha256(root.experimentId, "experiment id", invalidExperiment);
  if (hashCanonical(EXPERIMENT_HASH_DOMAIN, body, invalidExperiment) !== experimentId) {
    throw invalidExperiment("experiment id does not match its normalized content");
  }
  if (
    evidence.expectedExperimentId !== undefined &&
    sha256(evidence.expectedExperimentId, "expected experiment id", invalidExperiment) !==
      experimentId
  ) {
    throw invalidExperiment("experiment differs from the expected content id");
  }
  return deepFreeze({ ...body, experimentId });
}

function verifyStructuralChain(
  candidateInput: unknown,
  evidence: PromotionCandidateVerificationEvidence,
): StructuralChain {
  const candidate = verifyPromotionCandidate(candidateInput, evidence);
  const artifact = verifyArtifactManifest(evidence.artifact, {
    expectedArtifactHash: candidate.artifactHash,
  });
  const contract = verifyWalkForwardContractRecord(evidence.contractRecord, {
    artifact,
    plan: evidence.plan,
    declaration: evidence.declaration,
    expectedHash: candidate.contractHash,
  });
  return deepFreeze({ candidate, artifact, contract, declaration: evidence.declaration });
}

function pricingBody(
  structural: StructuralChain,
  pricingMethodInput: unknown,
  costModelInput: unknown,
  sampleInput: unknown,
  seriesInput: unknown,
  metricsInput: unknown,
): PricingBody {
  const pricingMethod = methodIdentity(pricingMethodInput, "pricing method", invalidPricing);
  const costRoot = exactRecord(
    costModelInput,
    ["reference", "version", "implementationHash", "configurationHash"],
    "cost model",
    invalidPricing,
  );
  const reference = portableId(costRoot.reference, "cost model reference", invalidPricing);
  if (reference !== structural.candidate.gateInputs.costModel) {
    throw invalidPricing("cost model reference does not match the promotion candidate");
  }
  const costModel = Object.freeze({
    reference,
    version: portableId(costRoot.version, "cost model version", invalidPricing),
    implementationHash: sha256(
      costRoot.implementationHash,
      "cost model implementation hash",
      invalidPricing,
    ),
    configurationHash: sha256(
      costRoot.configurationHash,
      "cost model configuration hash",
      invalidPricing,
    ),
  });
  requireLockedPricingIdentities(structural, pricingMethod, costModel);
  const sampleRoot = exactRecord(
    sampleInput,
    ["observations", "periodsPerYear"],
    "pricing sample",
    invalidPricing,
  );
  const sample = Object.freeze({
    observations: positiveInteger(sampleRoot.observations, "sample observations", invalidPricing),
    periodsPerYear: positiveInteger(
      sampleRoot.periodsPerYear,
      "sample periods per year",
      invalidPricing,
    ),
  });
  const seriesRoot = exactRecord(
    seriesInput,
    ["tradesHash", "grossReturnsHash", "costsHash", "netReturnsHash"],
    "pricing series",
    invalidPricing,
  );
  const series = Object.freeze({
    tradesHash: sha256(seriesRoot.tradesHash, "trades hash", invalidPricing),
    grossReturnsHash: sha256(seriesRoot.grossReturnsHash, "gross returns hash", invalidPricing),
    costsHash: sha256(seriesRoot.costsHash, "cost series hash", invalidPricing),
    netReturnsHash: sha256(seriesRoot.netReturnsHash, "net returns hash", invalidPricing),
  });
  const metrics = normalizeMetrics(metricsInput, invalidPricing);
  if (!metrics.some((metric) => metric.basis === "net")) {
    throw invalidPricing("pricing evidence must contain at least one net metric after costs");
  }
  return deepFreeze({
    format: PRICING_EVIDENCE_FORMAT,
    status: "priced",
    candidateHash: structural.candidate.candidateHash,
    artifactHash: structural.candidate.artifactHash,
    planHash: structural.candidate.planHash,
    contractHash: structural.candidate.contractHash,
    parameterLockHash: structural.candidate.parameterLockHash,
    dataset: datasetIdentity(structural),
    pricingMethod,
    costModel,
    sample,
    series,
    metrics,
  });
}

function requireLockedPricingIdentities(
  structural: StructuralChain,
  pricingMethod: Stage4MethodIdentity,
  costModel: PricingEvidenceRecord["costModel"],
): void {
  const declaration = structural.artifact.declaredLiterals.oosPricing;
  if (!isPlainRecord(declaration)) {
    throw invalidPricing(
      "artifact must freeze declaredLiterals.oosPricing before pricing evidence can exist",
    );
  }
  const method = methodIdentity(
    declaration.pricingMethodIdentity,
    "locked pricing method",
    invalidPricing,
  );
  const cost = exactRecord(
    declaration.costModelIdentity,
    ["version", "implementationHash", "configurationHash"],
    "locked cost model",
    invalidPricing,
  );
  const lockedCostModel = Object.freeze({
    reference: structural.artifact.costModel,
    version: portableId(cost.version, "locked cost model version", invalidPricing),
    implementationHash: sha256(
      cost.implementationHash,
      "locked cost model implementation hash",
      invalidPricing,
    ),
    configurationHash: sha256(
      cost.configurationHash,
      "locked cost model configuration hash",
      invalidPricing,
    ),
  });
  if (
    canonicalJson(method, invalidPricing) !== canonicalJson(pricingMethod, invalidPricing) ||
    canonicalJson(lockedCostModel, invalidPricing) !== canonicalJson(costModel, invalidPricing)
  ) {
    throw invalidPricing("pricing or cost-model identity differs from the artifact parameter lock");
  }
}

function verifyPricingChain(
  input: unknown,
  evidenceInput: PricingEvidenceVerificationEvidence,
): PricingChain {
  const evidence = exactRecord(
    evidenceInput,
    ["candidate", "candidateEvidence", "expectedPricingHash"],
    "pricing verification evidence",
    invalidPricing,
    true,
  );
  requireFields(
    evidence,
    ["candidate", "candidateEvidence"],
    invalidPricing,
    "pricing verification evidence",
  );
  const structural = verifyStructuralChain(
    evidence.candidate,
    evidence.candidateEvidence as PromotionCandidateVerificationEvidence,
  );
  const root = exactRecord(
    input,
    [
      "format",
      "status",
      "candidateHash",
      "artifactHash",
      "planHash",
      "contractHash",
      "parameterLockHash",
      "dataset",
      "pricingMethod",
      "costModel",
      "sample",
      "series",
      "metrics",
      "pricingHash",
    ],
    "pricing evidence",
    invalidPricing,
  );
  if (root.format !== PRICING_EVIDENCE_FORMAT || root.status !== "priced") {
    throw invalidPricing("pricing evidence uses an unsupported format or status");
  }
  const body = pricingBody(
    structural,
    root.pricingMethod,
    root.costModel,
    root.sample,
    root.series,
    root.metrics,
  );
  if (!sameCanonicalPricingBindings(root, body)) {
    throw invalidPricing("pricing evidence does not match its promotion candidate");
  }
  const pricingHash = sha256(root.pricingHash, "pricing hash", invalidPricing);
  if (hashCanonical(PRICING_HASH_DOMAIN, body, invalidPricing) !== pricingHash) {
    throw invalidPricing("pricing hash does not match its normalized content");
  }
  if (
    evidence.expectedPricingHash !== undefined &&
    sha256(evidence.expectedPricingHash, "expected pricing hash", invalidPricing) !== pricingHash
  ) {
    throw invalidPricing("pricing evidence differs from the expected content id");
  }
  return deepFreeze({ pricing: { ...body, pricingHash }, structural });
}

function gatePolicyBody(
  policyIdInput: unknown,
  policyVersionInput: unknown,
  gatesInput: unknown,
): GatePolicyBody {
  if (!Array.isArray(gatesInput) || gatesInput.length === 0 || gatesInput.length > MAX_GATES) {
    throw invalidGatePolicy(`gate policy must contain between 1 and ${MAX_GATES} gates`);
  }
  const gates = gatesInput
    .map((input) => normalizeGatePolicyEntry(input))
    .sort(compareGatePolicyEntries);
  const ids = new Set<string>();
  for (const gate of gates) {
    if (ids.has(gate.gateId)) {
      throw invalidGatePolicy("gate policy contains a duplicate gate id");
    }
    ids.add(gate.gateId);
  }
  for (const category of ["costs", "statistical-gates"] as const) {
    if (!gates.some((gate) => gate.category === category && gate.required)) {
      throw invalidGatePolicy(`gate policy must require ${category} evidence`);
    }
  }
  return deepFreeze({
    format: GATE_POLICY_FORMAT,
    policyId: portableId(policyIdInput, "gate policy id", invalidGatePolicy),
    policyVersion: portableId(policyVersionInput, "gate policy version", invalidGatePolicy),
    gates: Object.freeze(gates),
  });
}

function normalizeGatePolicyEntry(input: unknown): GatePolicyEntry {
  const root = exactRecord(
    input,
    ["gateId", "gateVersion", "category", "required"],
    "gate policy entry",
    invalidGatePolicy,
  );
  if (root.category !== "costs" && root.category !== "statistical-gates") {
    throw invalidGatePolicy("gate policy category is unsupported");
  }
  if (typeof root.required !== "boolean") {
    throw invalidGatePolicy("gate policy required flag must be boolean");
  }
  return Object.freeze({
    gateId: portableId(root.gateId, "gate id", invalidGatePolicy),
    gateVersion: portableId(root.gateVersion, "gate version", invalidGatePolicy),
    category: root.category,
    required: root.required,
  });
}

function gateResultsFromInputs(
  input: unknown,
  policy: GatePolicyRecord,
): readonly GateResultRecord[] {
  if (!Array.isArray(input) || input.length !== policy.gates.length) {
    throw invalidGateEvaluation("gate results must cover every policy gate exactly once");
  }
  const byId = new Map<string, GateMethodResultInput>();
  for (const value of input) {
    const root = exactRecord(
      value,
      ["gateId", "outcome", "implementationHash", "evidenceHash", "reasonCode"],
      "gate method result",
      invalidGateEvaluation,
    );
    const gateId = portableId(root.gateId, "gate result id", invalidGateEvaluation);
    if (byId.has(gateId)) {
      throw invalidGateEvaluation("gate results contain a duplicate gate id");
    }
    byId.set(gateId, {
      gateId,
      outcome: gateOutcome(root.outcome),
      implementationHash: sha256(
        root.implementationHash,
        "gate implementation hash",
        invalidGateEvaluation,
      ),
      evidenceHash: sha256(root.evidenceHash, "gate evidence hash", invalidGateEvaluation),
      reasonCode: portableId(root.reasonCode, "gate reason code", invalidGateEvaluation),
    });
  }
  return Object.freeze(
    policy.gates.map((gate) => {
      const result = byId.get(gate.gateId);
      if (result === undefined) {
        throw invalidGateEvaluation("gate results are missing a policy gate");
      }
      return Object.freeze({ ...gate, ...result });
    }),
  );
}

function gateResultsFromRecord(
  input: unknown,
  policy: GatePolicyRecord,
): readonly GateResultRecord[] {
  if (!Array.isArray(input) || input.length !== policy.gates.length) {
    throw invalidGateEvaluation("gate evaluation must contain every policy result exactly once");
  }
  const normalized = input.map((value) => {
    const root = exactRecord(
      value,
      [
        "gateId",
        "gateVersion",
        "category",
        "required",
        "outcome",
        "implementationHash",
        "evidenceHash",
        "reasonCode",
      ],
      "gate result",
      invalidGateEvaluation,
    );
    const policyEntry = normalizeGatePolicyEntry({
      gateId: root.gateId,
      gateVersion: root.gateVersion,
      category: root.category,
      required: root.required,
    });
    return Object.freeze({
      ...policyEntry,
      outcome: gateOutcome(root.outcome),
      implementationHash: sha256(
        root.implementationHash,
        "gate implementation hash",
        invalidGateEvaluation,
      ),
      evidenceHash: sha256(root.evidenceHash, "gate evidence hash", invalidGateEvaluation),
      reasonCode: portableId(root.reasonCode, "gate reason code", invalidGateEvaluation),
    });
  });
  const ordered = [...normalized].sort(compareGatePolicyEntries);
  if (
    canonicalJson(ordered, invalidGateEvaluation) !== canonicalJson(input, invalidGateEvaluation)
  ) {
    throw invalidGateEvaluation("gate results are not in canonical policy order");
  }
  for (let index = 0; index < policy.gates.length; index += 1) {
    const gate = policy.gates[index];
    const result = ordered[index];
    if (
      gate === undefined ||
      result === undefined ||
      canonicalJson(gate, invalidGateEvaluation) !==
        canonicalJson(
          {
            gateId: result.gateId,
            gateVersion: result.gateVersion,
            category: result.category,
            required: result.required,
          },
          invalidGateEvaluation,
        )
    ) {
      throw invalidGateEvaluation("gate result does not match its immutable policy entry");
    }
  }
  return Object.freeze(ordered);
}

function gateEvaluationBody(
  pricing: PricingEvidenceRecord,
  policy: GatePolicyRecord,
  effectiveTrials: number,
  results: readonly GateResultRecord[],
): GateEvaluationBody {
  return deepFreeze({
    format: GATE_EVALUATION_FORMAT,
    status: "complete",
    candidateHash: pricing.candidateHash,
    pricingHash: pricing.pricingHash,
    policyHash: policy.policyHash,
    effectiveTrials,
    results,
    verdict: gateVerdict(results),
  });
}

function verifyGateChain(
  input: unknown,
  evidenceInput: GateEvaluationVerificationEvidence,
): GateChain {
  const evidence = exactRecord(
    evidenceInput,
    ["pricingEvidence", "pricingVerification", "policy", "expectedGateEvaluationHash"],
    "gate evaluation verification evidence",
    invalidGateEvaluation,
    true,
  );
  requireFields(
    evidence,
    ["pricingEvidence", "pricingVerification", "policy"],
    invalidGateEvaluation,
    "gate evaluation verification evidence",
  );
  const pricing = verifyPricingChain(
    evidence.pricingEvidence,
    evidence.pricingVerification as PricingEvidenceVerificationEvidence,
  );
  const policy = verifyGatePolicyRecord(evidence.policy);
  const root = exactRecord(
    input,
    [
      "format",
      "status",
      "candidateHash",
      "pricingHash",
      "policyHash",
      "effectiveTrials",
      "results",
      "verdict",
      "gateEvaluationHash",
    ],
    "gate evaluation",
    invalidGateEvaluation,
  );
  if (root.format !== GATE_EVALUATION_FORMAT || root.status !== "complete") {
    throw invalidGateEvaluation("gate evaluation uses an unsupported format or status");
  }
  const effectiveTrials = positiveInteger(
    root.effectiveTrials,
    "effective trial count",
    invalidGateEvaluation,
  );
  if (effectiveTrials < pricing.structural.candidate.gateInputs.trialsDeclared) {
    throw invalidGateEvaluation(
      "effective trial count cannot be lower than the candidate's declared count",
    );
  }
  const results = gateResultsFromRecord(root.results, policy);
  const body = gateEvaluationBody(pricing.pricing, policy, effectiveTrials, results);
  if (!sameCanonicalGateBindings(root, body)) {
    throw invalidGateEvaluation("gate evaluation does not match its pricing evidence or policy");
  }
  const gateEvaluationHash = sha256(
    root.gateEvaluationHash,
    "gate evaluation hash",
    invalidGateEvaluation,
  );
  if (
    hashCanonical(GATE_EVALUATION_HASH_DOMAIN, body, invalidGateEvaluation) !== gateEvaluationHash
  ) {
    throw invalidGateEvaluation("gate evaluation hash does not match its normalized content");
  }
  if (
    evidence.expectedGateEvaluationHash !== undefined &&
    sha256(
      evidence.expectedGateEvaluationHash,
      "expected gate evaluation hash",
      invalidGateEvaluation,
    ) !== gateEvaluationHash
  ) {
    throw invalidGateEvaluation("gate evaluation differs from the expected content id");
  }
  return deepFreeze({
    ...pricing,
    policy,
    evaluation: { ...body, gateEvaluationHash },
  });
}

function experimentBody(
  chain: GateChain,
  issuedAtInput: unknown,
  rationaleInput: unknown,
  lessonsInput: unknown,
  explorationInput: unknown,
): ExperimentBody {
  const issuedAt = canonicalTime(issuedAtInput, "experiment issuance time", invalidExperiment);
  if (Date.parse(issuedAt) < Date.parse(chain.structural.candidate.verification.startedAt)) {
    throw invalidExperiment("experiment cannot be issued before verification starts");
  }
  const rationale = printableText(rationaleInput, "experiment rationale", 4096, invalidExperiment);
  const lessons = normalizeLessons(lessonsInput);
  const evaporation = normalizeEvaporation(explorationInput, chain.pricing.metrics);
  return deepFreeze({
    format: EXPERIMENT_FORMAT,
    status: "complete",
    candidateHash: chain.structural.candidate.candidateHash,
    artifactHash: chain.structural.candidate.artifactHash,
    planHash: chain.structural.candidate.planHash,
    contractHash: chain.structural.candidate.contractHash,
    parameterLockHash: chain.structural.candidate.parameterLockHash,
    pricingHash: chain.pricing.pricingHash,
    gateEvaluationHash: chain.evaluation.gateEvaluationHash,
    policyHash: chain.policy.policyHash,
    pricing: Object.freeze({
      method: chain.pricing.pricingMethod,
      costModel: chain.pricing.costModel,
      sample: chain.pricing.sample,
      series: chain.pricing.series,
    }),
    effectiveTrials: chain.evaluation.effectiveTrials,
    hypothesis: chain.structural.candidate.hypothesis,
    dataset: chain.pricing.dataset,
    metrics: chain.pricing.metrics,
    gates: chain.evaluation.results,
    verdict: chain.evaluation.verdict,
    claimStatus: claimStatus(chain.evaluation.verdict),
    evaporation,
    issuedAt,
    rationale,
    lessons,
  });
}

function rootChainFields(root: Record<string, unknown>, chain: GateChain): GateChain {
  if (
    root.candidateHash !== chain.structural.candidate.candidateHash ||
    root.artifactHash !== chain.structural.candidate.artifactHash ||
    root.planHash !== chain.structural.candidate.planHash ||
    root.contractHash !== chain.structural.candidate.contractHash ||
    root.parameterLockHash !== chain.structural.candidate.parameterLockHash ||
    root.pricingHash !== chain.pricing.pricingHash ||
    root.gateEvaluationHash !== chain.evaluation.gateEvaluationHash ||
    root.policyHash !== chain.policy.policyHash
  ) {
    throw invalidExperiment("experiment identities do not match their replayed evidence");
  }
  return chain;
}

function normalizeEvaporation(
  input: unknown,
  metrics: readonly ExperimentMetric[],
): ExperimentEvaporation | null {
  if (input === undefined || input === null) return null;
  if (isPlainRecord(input) && Object.hasOwn(input, "fromRecord")) {
    const wrapper = exactRecord(input, ["fromRecord"], "evaporation wrapper", invalidExperiment);
    return evaporationFromRecord(wrapper.fromRecord, metrics);
  }
  const root = exactRecord(
    input,
    ["name", "scope", "basis", "unit", "value"],
    "exploration metric",
    invalidExperiment,
    true,
  );
  requireFields(root, ["name", "basis", "unit", "value"], invalidExperiment, "exploration metric");
  if (root.scope !== undefined && root.scope !== "walk-forward-oos") {
    throw invalidExperiment("exploration metric scope is unsupported");
  }
  const identity = metricIdentity(root, invalidExperiment);
  const match = metrics.find((metric) => sameMetricIdentity(metric, identity));
  if (match === undefined) {
    throw invalidExperiment("exploration metric does not match a verified pricing metric");
  }
  const explorationValue = finiteNumber(root.value, "exploration metric value", invalidExperiment);
  return evaporationRecord(identity, explorationValue, match.value);
}

function evaporationFromRecord(
  input: unknown,
  metrics: readonly ExperimentMetric[],
): ExperimentEvaporation | null {
  if (input === null) return null;
  const root = exactRecord(
    input,
    ["metric", "exploration", "verifiedValue", "delta"],
    "experiment evaporation",
    invalidExperiment,
  );
  const metricRoot = exactRecord(
    root.metric,
    ["name", "scope", "basis", "unit"],
    "evaporation metric identity",
    invalidExperiment,
  );
  const identity = metricIdentity(metricRoot, invalidExperiment);
  const explorationRoot = exactRecord(
    root.exploration,
    ["status", "value"],
    "evaporation exploration metric",
    invalidExperiment,
  );
  if (explorationRoot.status !== "unverified") {
    throw invalidExperiment("evaporation exploration metric must remain unverified");
  }
  const match = metrics.find((metric) => sameMetricIdentity(metric, identity));
  if (match === undefined) {
    throw invalidExperiment("evaporation metric does not match verified pricing evidence");
  }
  const explorationValue = finiteNumber(
    explorationRoot.value,
    "evaporation exploration value",
    invalidExperiment,
  );
  const verifiedValue = finiteNumber(
    root.verifiedValue,
    "evaporation verified value",
    invalidExperiment,
  );
  const delta = finiteNumber(root.delta, "evaporation delta", invalidExperiment);
  const expected = evaporationRecord(identity, explorationValue, match.value);
  if (verifiedValue !== expected.verifiedValue || delta !== expected.delta) {
    throw invalidExperiment("evaporation values do not match the cited verified metric");
  }
  return expected;
}

function evaporationRecord(
  metric: Omit<ExperimentMetric, "value">,
  explorationValue: number,
  verifiedValue: number,
): ExperimentEvaporation {
  const delta = explorationValue - verifiedValue;
  if (!Number.isFinite(delta) || Object.is(delta, -0)) {
    throw invalidExperiment("evaporation delta is not a canonical finite number");
  }
  return deepFreeze({
    metric,
    exploration: Object.freeze({ status: "unverified", value: explorationValue }),
    verifiedValue,
    delta,
  });
}

function datasetIdentity(structural: StructuralChain): PricingEvidenceRecord["dataset"] {
  const semantics = deriveDataSemantics(structural.declaration);
  return deepFreeze({
    dataset: structural.contract.dataset.dataset,
    version: structural.contract.dataset.version,
    declarationHash: structural.contract.dataset.declarationHash,
    degradations: Object.freeze([...semantics.degradations]),
  });
}

function normalizeMetrics(input: unknown, error: ErrorFactory): readonly ExperimentMetric[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_METRICS) {
    throw error(`metrics must contain between 1 and ${MAX_METRICS} entries`);
  }
  const metrics = input.map((value) => normalizeMetric(value, error)).sort(compareMetrics);
  for (let index = 1; index < metrics.length; index += 1) {
    const previous = metrics[index - 1];
    const current = metrics[index];
    if (previous !== undefined && current !== undefined && sameMetricIdentity(previous, current)) {
      throw error("metrics contain a duplicate identity");
    }
  }
  return Object.freeze(metrics);
}

function normalizeMetric(input: unknown, error: ErrorFactory): ExperimentMetric {
  const root = exactRecord(
    input,
    ["name", "scope", "basis", "unit", "value"],
    "experiment metric",
    error,
  );
  if (root.scope !== "walk-forward-oos") {
    throw error("experiment metric scope is unsupported");
  }
  const identity = metricIdentity(root, error);
  return Object.freeze({
    ...identity,
    value: finiteNumber(root.value, "metric value", error),
  });
}

function metricIdentity(
  input: Record<string, unknown>,
  error: ErrorFactory,
): Omit<ExperimentMetric, "value"> {
  if (input.basis !== "gross" && input.basis !== "net") {
    throw error("metric basis is unsupported");
  }
  if (input.unit !== "count" && input.unit !== "decimal" && input.unit !== "ratio") {
    throw error("metric unit is unsupported");
  }
  return Object.freeze({
    name: portableId(input.name, "metric name", error),
    scope: "walk-forward-oos",
    basis: input.basis,
    unit: input.unit,
  });
}

function methodIdentity(input: unknown, field: string, error: ErrorFactory): Stage4MethodIdentity {
  const root = exactRecord(input, ["id", "version", "implementationHash"], field, error);
  return Object.freeze({
    id: portableId(root.id, `${field} id`, error),
    version: portableId(root.version, `${field} version`, error),
    implementationHash: sha256(root.implementationHash, `${field} implementation hash`, error),
  });
}

function normalizeLessons(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > MAX_LESSONS) {
    throw invalidExperiment(`experiment lessons must contain at most ${MAX_LESSONS} entries`);
  }
  return Object.freeze(
    input.map((lesson) => printableText(lesson, "experiment lesson", 1024, invalidExperiment)),
  );
}

function gateOutcome(input: unknown): GateOutcome {
  if (input !== "failed" && input !== "passed" && input !== "unavailable") {
    throw invalidGateEvaluation("gate outcome is unsupported");
  }
  return input;
}

function gateVerdict(results: readonly GateResultRecord[]): GateVerdict {
  if (
    results.some(
      (result) =>
        result.outcome === "failed" || (result.required && result.outcome === "unavailable"),
    )
  ) {
    return "rejected";
  }
  if (results.some((result) => result.outcome === "unavailable")) return "degraded";
  return "accepted";
}

function claimStatus(verdict: GateVerdict): ExperimentRecord["claimStatus"] {
  if (verdict === "accepted") return "verified";
  return verdict;
}

function compareGatePolicyEntries(left: GatePolicyEntry, right: GatePolicyEntry): number {
  return compareText(left.category, right.category) || compareText(left.gateId, right.gateId);
}

function compareMetrics(left: ExperimentMetric, right: ExperimentMetric): number {
  return (
    compareText(left.scope, right.scope) ||
    compareText(left.basis, right.basis) ||
    compareText(left.name, right.name) ||
    compareText(left.unit, right.unit)
  );
}

function sameMetricIdentity(
  left: Omit<ExperimentMetric, "value">,
  right: Omit<ExperimentMetric, "value">,
): boolean {
  return (
    left.name === right.name &&
    left.scope === right.scope &&
    left.basis === right.basis &&
    left.unit === right.unit
  );
}

function sameCanonicalPricingBindings(root: Record<string, unknown>, body: PricingBody): boolean {
  return [
    "candidateHash",
    "artifactHash",
    "planHash",
    "contractHash",
    "parameterLockHash",
    "dataset",
  ].every(
    (field) =>
      canonicalJson(root[field], invalidPricing) ===
      canonicalJson(body[field as keyof PricingBody], invalidPricing),
  );
}

function sameCanonicalGateBindings(
  root: Record<string, unknown>,
  body: GateEvaluationBody,
): boolean {
  return ["candidateHash", "pricingHash", "policyHash", "verdict"].every(
    (field) =>
      canonicalJson(root[field], invalidGateEvaluation) ===
      canonicalJson(body[field as keyof GateEvaluationBody], invalidGateEvaluation),
  );
}

function sameCanonicalExperimentBindings(
  root: Record<string, unknown>,
  body: ExperimentBody,
): boolean {
  return [
    "candidateHash",
    "artifactHash",
    "planHash",
    "contractHash",
    "parameterLockHash",
    "pricingHash",
    "gateEvaluationHash",
    "policyHash",
    "pricing",
    "effectiveTrials",
    "hypothesis",
    "dataset",
    "metrics",
    "gates",
    "verdict",
    "claimStatus",
  ].every(
    (field) =>
      canonicalJson(root[field], invalidExperiment) ===
      canonicalJson(body[field as keyof ExperimentBody], invalidExperiment),
  );
}

type ErrorFactory = (message: string) => EngineConfigurationError;

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
  error: ErrorFactory,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw error(`${field} must be an object`);
  const actual = Object.keys(input);
  const allowed = new Set(expectedKeys);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && expectedKeys.some((key) => !actual.includes(key)))
  ) {
    throw error(`${field} has missing or unknown fields`);
  }
  return input;
}

function requireFields(
  input: Record<string, unknown>,
  fields: readonly string[],
  error: ErrorFactory,
  context: string,
): void {
  if (fields.some((field) => !Object.hasOwn(input, field))) {
    throw error(`${context} has missing fields`);
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function portableId(input: unknown, field: string, error: ErrorFactory): string {
  if (typeof input !== "string" || !PORTABLE_ID.test(input)) {
    throw error(`${field} must be a portable identifier`);
  }
  return input;
}

function sha256(input: unknown, field: string, error: ErrorFactory): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw error(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string, error: ErrorFactory): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw error(`${field} must be a positive safe integer`);
  }
  return input;
}

function finiteNumber(input: unknown, field: string, error: ErrorFactory): number {
  if (typeof input !== "number" || !Number.isFinite(input) || Object.is(input, -0)) {
    throw error(`${field} must be a canonical finite number`);
  }
  return input;
}

function printableText(
  input: unknown,
  field: string,
  maximum: number,
  error: ErrorFactory,
): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum ||
    [...input].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    })
  ) {
    throw error(`${field} must be printable text of at most ${maximum} characters`);
  }
  return input;
}

function canonicalTime(input: unknown, field: string, error: ErrorFactory): string {
  if (typeof input !== "string") throw error(`${field} must be a canonical UTC instant`);
  try {
    const normalized = normalizeDecisionTime(input);
    if (normalized !== input) throw new Error("not canonical");
    return normalized;
  } catch {
    throw error(`${field} must be a canonical UTC instant`);
  }
}

function hashCanonical(domain: string, input: unknown, error: ErrorFactory): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(input, error))
    .digest("hex")}`;
}

function canonicalJson(input: unknown, error: ErrorFactory): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return JSON.stringify(input);
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw error("record contains a non-canonical number");
    }
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => canonicalJson(value, error)).join(",")}]`;
  }
  if (isPlainRecord(input)) {
    return `{${Object.keys(input)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key], error)}`)
      .join(",")}}`;
  }
  throw error("record contains an unsupported value");
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

function invalidPricing(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_PRICING_EVIDENCE",
    message,
    "Reprice the replay-verified candidate and retain immutable trade, return, and cost evidence.",
  );
}

function invalidGatePolicy(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_GATE_POLICY",
    message,
    "Use a content-addressed policy that requires both cost and statistical evidence.",
  );
}

function invalidGateEvaluation(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_GATE_EVALUATION",
    message,
    "Run every gate in the cited policy against the same immutable pricing evidence.",
  );
}

function invalidExperiment(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_EXPERIMENT",
    message,
    "Issue the Experiment only from replay-verified pricing and a complete policy-bound gate evaluation.",
  );
}
