import { createHash } from "node:crypto";
import { normalizeDecisionTime } from "@veilquant/contract";
import { verifyArtifactManifest } from "./artifact.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  executeRegisteredNullGenerator,
  type NullGeneratorDescriptor,
  type NullGeneratorRegistry,
} from "./null-generator.ts";
import {
  type OosPricingResult,
  type OosSeriesObservation,
  type VerifyOosPricingResultInput,
  verifyOosPricingResult,
} from "./oos-pricing.ts";
import { verifyPromotionCandidate } from "./promotion.ts";
import {
  createGateEvaluationRecord,
  createGatePolicyRecord,
  type GateEvaluationRecord,
  type GateMethodResultInput,
  type GateOutcome,
  type GatePolicyEntry,
  type GatePolicyRecord,
  type PricingEvidenceVerificationEvidence,
} from "./stage4-evidence.ts";

export const TRIAL_AUDIT_FORMAT = "veil.trial-audit.v0" as const;
export const GATE_METHOD_EVIDENCE_FORMAT = "veil.gate-method-evidence.v0" as const;
export const STANDARD_GATE_POLICY_ID = "veil.standard-stage4" as const;
export const STANDARD_GATE_POLICY_VERSION = "0.1.0" as const;

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MINIMUM_OBSERVATIONS = 30;
const STANDARD_DSR_CONFIDENCE = 0.95;
const HIGHER_DSR_CONFIDENCE = 0.99;
const COST_STRESS_MULTIPLIER = 2;
const MINIMUM_FOLDS = 3;
const MINIMUM_POSITIVE_FOLD_FRACTION = 2 / 3;
const MAXIMUM_FOLD_CONCENTRATION = 0.6;
const MINIMUM_PARAMETER_NEIGHBORS = 2;
const MINIMUM_POSITIVE_PARAMETER_FRACTION = 2 / 3;
const NULL_SIGNIFICANCE = 0.05;
const ISSUED_GATE_EXECUTIONS = new WeakSet<object>();

type GateId =
  | "capacity-sensitivity"
  | "cost-sensitivity"
  | "hypothesis-contamination"
  | "null-falsification"
  | "parameter-stability"
  | "trial-budget"
  | "trials-aware-deflated-sharpe"
  | "walk-forward-stability";

const GATES = Object.freeze([
  gate("capacity-sensitivity", "costs", false),
  gate("cost-sensitivity", "costs", true),
  gate("hypothesis-contamination", "statistical-gates", false),
  gate("null-falsification", "statistical-gates", false),
  gate("parameter-stability", "statistical-gates", true),
  gate("trial-budget", "statistical-gates", true),
  gate("trials-aware-deflated-sharpe", "statistical-gates", true),
  gate("walk-forward-stability", "statistical-gates", true),
] satisfies readonly GatePolicyEntry[]);

const METHOD_SPECS = Object.freeze({
  "capacity-sensitivity": {
    rule: "maximum-trade-participation-at-locked-portfolio-nav",
    unit: "fraction-of-execution-session-market-notional",
  },
  "cost-sensitivity": {
    metric: "net-sharpe-and-annual-return",
    stressMultiplier: COST_STRESS_MULTIPLIER,
    rule: "positive-under-locked-costs-and-doubled-costs",
  },
  "hypothesis-contamination": {
    rule: "post-knowledge-cutoff-oos-required-for-llm-originated-historical-hypothesis",
  },
  "null-falsification": {
    statistic: "one-sided-empirical-sharpe-p-value",
    alpha: NULL_SIGNIFICANCE,
    correction: "plus-one",
  },
  "parameter-stability": {
    minimumNeighbors: MINIMUM_PARAMETER_NEIGHBORS,
    minimumPositiveFraction: MINIMUM_POSITIVE_PARAMETER_FRACTION,
    rule: "independently-priced-neighboring-parameter-locks",
  },
  "trial-budget": {
    count: "max-declared-or-session-plus-family-memory",
    rule: "effective-trials-at-most-preregistered-budget",
  },
  "trials-aware-deflated-sharpe": {
    estimator: "bailey-lopez-de-prado-deflated-sharpe",
    standardConfidence: STANDARD_DSR_CONFIDENCE,
    higherConfidence: HIGHER_DSR_CONFIDENCE,
    minimumObservations: MINIMUM_OBSERVATIONS,
  },
  "walk-forward-stability": {
    minimumFolds: MINIMUM_FOLDS,
    minimumPositiveFoldFraction: MINIMUM_POSITIVE_FOLD_FRACTION,
    maximumAbsoluteReturnConcentration: MAXIMUM_FOLD_CONCENTRATION,
  },
});

export interface TrialCountEvidence {
  readonly sessionLedgerHash: string;
  readonly sessionAttemptIds: readonly string[];
  readonly memorySnapshotHash: string;
  readonly familyExperimentIds: readonly string[];
}

export interface TrialAuditRecord {
  readonly format: typeof TRIAL_AUDIT_FORMAT;
  readonly candidateHash: string;
  readonly hypothesisRef: string;
  readonly declaredTrials: number;
  readonly session: {
    readonly ledgerHash: string;
    readonly attemptIds: readonly string[];
  };
  readonly memory: {
    readonly snapshotHash: string;
    readonly familyExperimentIds: readonly string[];
  };
  readonly observedTrials: number;
  readonly effectiveTrials: number;
  readonly trialBudget: number;
  readonly auditHash: string;
}

export interface GateStatistic {
  readonly name: string;
  readonly value: number;
}

export interface DeflatedSharpeResult {
  readonly sampleSharpe: number;
  readonly expectedMaximumSharpe: number;
  readonly probability: number;
}

export interface GateMethodEvidence {
  readonly format: typeof GATE_METHOD_EVIDENCE_FORMAT;
  readonly gateId: string;
  readonly candidateHash: string;
  readonly pricingHash: string;
  readonly trialAuditHash: string;
  readonly outcome: GateOutcome;
  readonly reasonCode: string;
  readonly implementationHash: string;
  readonly dependencyHashes: readonly string[];
  readonly statistics: readonly GateStatistic[];
  readonly evidenceHash: string;
}

export interface StandardGateExecutionResult {
  readonly policy: GatePolicyRecord;
  readonly trialAudit: TrialAuditRecord;
  readonly methods: readonly GateMethodEvidence[];
  readonly evaluation: GateEvaluationRecord;
}

export interface ExecuteStandardGateEvaluationInput {
  readonly pricing: unknown;
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
  readonly trialEvidence: TrialCountEvidence;
  readonly nullGenerators: NullGeneratorRegistry;
  readonly parameterNeighbors?: readonly VerifyOosPricingResultInput[];
  readonly postCutoffValidation?: VerifyOosPricingResultInput;
}

interface LockedGateConfiguration {
  readonly policyId: typeof STANDARD_GATE_POLICY_ID;
  readonly policyVersion: typeof STANDARD_GATE_POLICY_VERSION;
  readonly trialBudget: number;
  readonly nullGeneratorIdentity: NullGeneratorDescriptor | null;
  readonly knowledgeCutoff: string | null;
}

interface GateContext {
  readonly pricing: OosPricingResult;
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
  readonly audit: TrialAuditRecord;
  readonly locked: LockedGateConfiguration;
  readonly significanceTier: "standard" | "higher";
  readonly hypothesisRef: string;
  readonly nullGenerators: NullGeneratorRegistry;
  readonly parameterNeighbors: readonly VerifyOosPricingResultInput[];
  readonly postCutoffValidation?: VerifyOosPricingResultInput;
}

/** Executes the immutable Stage 4 policy; callers cannot supply thresholds or effective trial counts. */
export async function executeStandardGateEvaluation(
  input: ExecuteStandardGateEvaluationInput,
): Promise<StandardGateExecutionResult> {
  const root = exactRecord(
    input,
    [
      "pricing",
      "pricingVerification",
      "trialEvidence",
      "nullGenerators",
      "parameterNeighbors",
      "postCutoffValidation",
    ],
    "standard gate execution input",
    true,
  );
  requireFields(
    root,
    ["pricing", "pricingVerification", "trialEvidence", "nullGenerators"],
    "standard gate execution input",
  );
  const pricingVerification = root.pricingVerification as PricingEvidenceVerificationEvidence;
  const pricing = verifyOosPricingResult({
    result: root.pricing,
    pricingVerification,
  });
  const candidate = verifyPromotionCandidate(
    pricingVerification.candidate,
    pricingVerification.candidateEvidence,
  );
  const artifact = verifyArtifactManifest(pricingVerification.candidateEvidence.artifact, {
    expectedArtifactHash: candidate.artifactHash,
  });
  const locked = normalizeLockedGateConfiguration(artifact.declaredLiterals.gatePolicy);
  const policy = createGatePolicyRecord({
    policyId: locked.policyId,
    policyVersion: locked.policyVersion,
    gates: GATES,
  });
  const audit = createTrialAudit(
    candidate.candidateHash,
    candidate.hypothesis.hypothesisRef,
    candidate.gateInputs.trialsDeclared,
    locked.trialBudget,
    root.trialEvidence as TrialCountEvidence,
  );
  const context: GateContext = {
    pricing,
    pricingVerification,
    audit,
    locked,
    significanceTier: candidate.gateInputs.significanceTier,
    hypothesisRef: candidate.hypothesis.hypothesisRef,
    nullGenerators: root.nullGenerators as NullGeneratorRegistry,
    parameterNeighbors: normalizeNeighborInputs(root.parameterNeighbors),
    ...(root.postCutoffValidation === undefined
      ? {}
      : { postCutoffValidation: root.postCutoffValidation as VerifyOosPricingResultInput }),
  };
  const methods: GateMethodEvidence[] = [];
  for (const policyGate of policy.gates) {
    methods.push(await executeGate(policyGate.gateId as GateId, context));
  }
  const results: GateMethodResultInput[] = methods.map((method) => ({
    gateId: method.gateId,
    outcome: method.outcome,
    implementationHash: method.implementationHash,
    evidenceHash: method.evidenceHash,
    reasonCode: method.reasonCode,
  }));
  const evaluation = createGateEvaluationRecord({
    pricingEvidence: pricing.record,
    pricingVerification,
    policy,
    effectiveTrials: audit.effectiveTrials,
    results,
  });
  const result = deepFreeze({
    policy,
    trialAudit: audit,
    methods: Object.freeze(methods),
    evaluation,
  });
  ISSUED_GATE_EXECUTIONS.add(result);
  return result;
}

/** Internal issuer check used by the safe Experiment boundary. */
export function assertIssuedStandardGateExecution(input: StandardGateExecutionResult): void {
  if (!ISSUED_GATE_EXECUTIONS.has(input)) {
    throw invalidGate("Experiment issuance requires a gate execution produced by this engine");
  }
}

function gate(
  gateId: GateId,
  category: GatePolicyEntry["category"],
  required: boolean,
): GatePolicyEntry {
  return Object.freeze({ gateId, gateVersion: "0.1.0", category, required });
}

async function executeGate(gateId: GateId, context: GateContext): Promise<GateMethodEvidence> {
  switch (gateId) {
    case "capacity-sensitivity":
      return capacitySensitivity(context);
    case "cost-sensitivity":
      return costSensitivity(context);
    case "hypothesis-contamination":
      return hypothesisContamination(context);
    case "null-falsification":
      return nullFalsification(context);
    case "parameter-stability":
      return parameterStability(context);
    case "trial-budget":
      return trialBudget(context);
    case "trials-aware-deflated-sharpe":
      return deflatedSharpe(context);
    case "walk-forward-stability":
      return walkForwardStability(context);
  }
}

function capacitySensitivity(context: GateContext): GateMethodEvidence {
  const capacity = context.pricing.payloads.trades.configuration.capacity;
  if (capacity === null) {
    return methodEvidence(
      context,
      "capacity-sensitivity",
      "unavailable",
      "capacity-configuration-unavailable",
      [],
      [context.pricing.payloads.trades.tradesHash],
    );
  }
  const marketByTrade = new Map(
    context.pricing.payloads.trades.marketData.map((row) => [row.tradeId, row]),
  );
  let maximumParticipation = 0;
  for (const trade of context.pricing.payloads.trades.trades) {
    const market = marketByTrade.get(trade.tradeId);
    const volume = market?.fields[capacity.volumeColumn];
    if (
      market === undefined ||
      typeof volume !== "number" ||
      !Number.isFinite(volume) ||
      volume <= 0
    ) {
      return methodEvidence(
        context,
        "capacity-sensitivity",
        "failed",
        "capacity-market-data-invalid",
        [statistic("capacity-trades", context.pricing.payloads.trades.trades.length)],
        [context.pricing.payloads.trades.tradesHash],
      );
    }
    const participation =
      (Math.abs(trade.weightChange) * capacity.portfolioNav) / (market.price * volume);
    maximumParticipation = Math.max(maximumParticipation, participation);
  }
  const passed = maximumParticipation <= capacity.maximumParticipationRate;
  return methodEvidence(
    context,
    "capacity-sensitivity",
    passed ? "passed" : "failed",
    passed ? "capacity-stress-passed" : "capacity-participation-exceeded",
    [
      statistic("capacity-trades", context.pricing.payloads.trades.trades.length),
      statistic("maximum-participation-rate", maximumParticipation),
      statistic("participation-limit", capacity.maximumParticipationRate),
      statistic("portfolio-nav", capacity.portfolioNav),
    ],
    [context.pricing.payloads.trades.tradesHash],
  );
}

function costSensitivity(context: GateContext): GateMethodEvidence {
  const gross = values(context.pricing.payloads.grossReturns.observations);
  const costs = values(context.pricing.payloads.costs.observations);
  const net = values(context.pricing.payloads.netReturns.observations);
  const totalCost = costs.reduce((sum, value) => sum + value, 0);
  const turnover = context.pricing.payloads.trades.trades.reduce(
    (sum, trade) => sum + Math.abs(trade.weightChange),
    0,
  );
  const stressed = gross.map((value, index) =>
    normalizeZero(value - COST_STRESS_MULTIPLIER * (costs[index] ?? 0)),
  );
  const currentSummary = returnSummary(net, context.pricing.record.sample.periodsPerYear);
  const stressedSummary = returnSummary(stressed, context.pricing.record.sample.periodsPerYear);
  const priced = turnover === 0 || totalCost > 0;
  const passed =
    priced &&
    currentSummary.annualReturn > 0 &&
    currentSummary.sharpe > 0 &&
    stressedSummary.annualReturn > 0 &&
    stressedSummary.sharpe > 0;
  return methodEvidence(
    context,
    "cost-sensitivity",
    passed ? "passed" : "failed",
    passed ? "cost-stress-passed" : !priced ? "turnover-without-cost" : "cost-stress-failed",
    [
      statistic("turnover", turnover),
      statistic("total-cost", totalCost),
      statistic("net-sharpe", currentSummary.sharpe),
      statistic("stressed-net-sharpe", stressedSummary.sharpe),
      statistic("stressed-net-annual-return", stressedSummary.annualReturn),
    ],
    [context.pricing.payloads.costs.costsHash, context.pricing.payloads.netReturns.netReturnsHash],
  );
}

function hypothesisContamination(context: GateContext): GateMethodEvidence {
  const cutoff = context.locked.knowledgeCutoff;
  if (cutoff === null) {
    return methodEvidence(
      context,
      "hypothesis-contamination",
      "unavailable",
      "knowledge-cutoff-unavailable",
      [],
      [],
    );
  }
  const latest = latestDecisionTime(context.pricing.payloads.netReturns.observations);
  if (Date.parse(latest) > Date.parse(cutoff)) {
    return methodEvidence(
      context,
      "hypothesis-contamination",
      "passed",
      "base-oos-postdates-knowledge-cutoff",
      [statistic("post-cutoff-observations", countAfter(context.pricing, cutoff))],
      [context.pricing.record.pricingHash],
    );
  }
  if (context.postCutoffValidation === undefined) {
    return methodEvidence(
      context,
      "hypothesis-contamination",
      "failed",
      "post-cutoff-validation-required",
      [statistic("post-cutoff-observations", 0)],
      [context.pricing.record.pricingHash],
    );
  }
  const validation = verifyCompatiblePricing(
    context,
    context.postCutoffValidation,
    "post-cutoff validation",
  );
  const postCutoffObservations = countAfter(validation, cutoff);
  const summary = returnSummary(
    values(validation.payloads.netReturns.observations).filter(
      (_, index) =>
        Date.parse(validation.payloads.netReturns.observations[index]?.decisionTime ?? "") >
        Date.parse(cutoff),
    ),
    validation.record.sample.periodsPerYear,
  );
  const passed = postCutoffObservations >= MINIMUM_OBSERVATIONS && summary.annualReturn > 0;
  return methodEvidence(
    context,
    "hypothesis-contamination",
    passed ? "passed" : "failed",
    passed ? "post-cutoff-validation-passed" : "post-cutoff-validation-failed",
    [
      statistic("post-cutoff-observations", postCutoffObservations),
      statistic("post-cutoff-annual-return", summary.annualReturn),
    ],
    [context.pricing.record.pricingHash, validation.record.pricingHash],
  );
}

async function nullFalsification(context: GateContext): Promise<GateMethodEvidence> {
  const locked = context.locked.nullGeneratorIdentity;
  if (locked === null) {
    return methodEvidence(
      context,
      "null-falsification",
      "unavailable",
      "null-generator-not-locked",
      [],
      [],
    );
  }
  const registered = context.nullGenerators
    .list()
    .find((descriptor) => descriptor.reference === locked.reference);
  if (registered === undefined) {
    return methodEvidence(
      context,
      "null-falsification",
      "unavailable",
      "null-generator-not-registered",
      [],
      [locked.implementationHash, locked.configurationHash],
    );
  }
  if (canonicalJson(registered) !== canonicalJson(locked)) {
    throw invalidGate("registered null-generator identity differs from the artifact lock");
  }
  const observed = values(context.pricing.payloads.netReturns.observations);
  const generated = await executeRegisteredNullGenerator(
    context.nullGenerators,
    locked.reference,
    observed,
  );
  if (canonicalJson(generated.descriptor) !== canonicalJson(locked)) {
    throw invalidGate("null-generator execution returned a substituted identity");
  }
  const observedSharpe = returnSummary(
    observed,
    context.pricing.record.sample.periodsPerYear,
  ).sharpe;
  const nullSharpes = generated.samples.map(
    (sample) => returnSummary(sample, context.pricing.record.sample.periodsPerYear).sharpe,
  );
  const exceedances = nullSharpes.filter((value) => value >= observedSharpe).length;
  const pValue = (exceedances + 1) / (nullSharpes.length + 1);
  const passed = observedSharpe > 0 && pValue <= NULL_SIGNIFICANCE;
  const samplesHash = hashCanonical("veil.null-generator-samples.v0", generated.samples);
  return methodEvidence(
    context,
    "null-falsification",
    passed ? "passed" : "failed",
    passed ? "null-falsification-passed" : "null-falsification-failed",
    [
      statistic("observed-sharpe", observedSharpe),
      statistic("null-replications", nullSharpes.length),
      statistic("null-exceedances", exceedances),
      statistic("null-p-value", pValue),
    ],
    [
      context.pricing.record.pricingHash,
      locked.implementationHash,
      locked.configurationHash,
      samplesHash,
    ],
  );
}

function parameterStability(context: GateContext): GateMethodEvidence {
  if (context.parameterNeighbors.length < MINIMUM_PARAMETER_NEIGHBORS) {
    return methodEvidence(
      context,
      "parameter-stability",
      "unavailable",
      "parameter-neighborhood-incomplete",
      [statistic("parameter-neighbors", context.parameterNeighbors.length)],
      context.parameterNeighbors.map(
        (neighbor) => verifyOosPricingResult(neighbor).record.pricingHash,
      ),
    );
  }
  const neighbors = context.parameterNeighbors.map((neighbor) =>
    verifyCompatiblePricing(context, neighbor, "parameter neighbor"),
  );
  const locks = new Set(neighbors.map((neighbor) => neighbor.record.parameterLockHash));
  locks.add(context.pricing.record.parameterLockHash);
  if (locks.size !== neighbors.length + 1) {
    throw invalidGate("parameter-neighbor evidence contains a duplicate parameter lock");
  }
  const runs = [context.pricing, ...neighbors];
  const summaries = runs.map((run) =>
    returnSummary(values(run.payloads.netReturns.observations), run.record.sample.periodsPerYear),
  );
  const positive = summaries.filter(
    (summary) => summary.annualReturn > 0 && summary.sharpe > 0,
  ).length;
  const fraction = positive / summaries.length;
  const passed = fraction >= MINIMUM_POSITIVE_PARAMETER_FRACTION;
  return methodEvidence(
    context,
    "parameter-stability",
    passed ? "passed" : "failed",
    passed ? "parameter-stability-passed" : "parameter-stability-failed",
    [
      statistic("parameter-runs", summaries.length),
      statistic("positive-parameter-runs", positive),
      statistic("positive-parameter-fraction", fraction),
      statistic("minimum-parameter-sharpe", Math.min(...summaries.map((item) => item.sharpe))),
    ],
    runs.map((run) => run.record.pricingHash),
  );
}

function trialBudget(context: GateContext): GateMethodEvidence {
  const passed = context.audit.effectiveTrials <= context.audit.trialBudget;
  return methodEvidence(
    context,
    "trial-budget",
    passed ? "passed" : "failed",
    passed ? "trial-budget-available" : "trial-budget-exhausted",
    [
      statistic("declared-trials", context.audit.declaredTrials),
      statistic("observed-trials", context.audit.observedTrials),
      statistic("effective-trials", context.audit.effectiveTrials),
      statistic("trial-budget", context.audit.trialBudget),
    ],
    [context.audit.auditHash],
  );
}

function deflatedSharpe(context: GateContext): GateMethodEvidence {
  const returns = values(context.pricing.payloads.netReturns.observations);
  const confidence =
    context.significanceTier === "higher" ? HIGHER_DSR_CONFIDENCE : STANDARD_DSR_CONFIDENCE;
  if (returns.length < MINIMUM_OBSERVATIONS) {
    return methodEvidence(
      context,
      "trials-aware-deflated-sharpe",
      "failed",
      "insufficient-oos-observations",
      [
        statistic("observations", returns.length),
        statistic("minimum-observations", MINIMUM_OBSERVATIONS),
      ],
      [context.pricing.payloads.netReturns.netReturnsHash, context.audit.auditHash],
    );
  }
  const result = computeDeflatedSharpe(returns, context.audit.effectiveTrials);
  const passed = result.probability >= confidence;
  return methodEvidence(
    context,
    "trials-aware-deflated-sharpe",
    passed ? "passed" : "failed",
    passed ? "deflated-sharpe-passed" : "deflated-sharpe-failed",
    [
      statistic("observations", returns.length),
      statistic("effective-trials", context.audit.effectiveTrials),
      statistic("sample-sharpe", result.sampleSharpe),
      statistic("expected-maximum-sharpe", result.expectedMaximumSharpe),
      statistic("deflated-sharpe-probability", result.probability),
      statistic("required-confidence", confidence),
    ],
    [context.pricing.payloads.netReturns.netReturnsHash, context.audit.auditHash],
  );
}

function walkForwardStability(context: GateContext): GateMethodEvidence {
  const returns = context.pricing.payloads.netReturns.observations;
  const byFold = new Map<number, number>();
  for (const observation of returns) {
    byFold.set(
      observation.foldIndex,
      normalizeZero((byFold.get(observation.foldIndex) ?? 0) + observation.value),
    );
  }
  const foldReturns = [...byFold.values()];
  const positive = foldReturns.filter((value) => value > 0).length;
  const positiveFraction = foldReturns.length === 0 ? 0 : positive / foldReturns.length;
  const absolute = foldReturns.reduce((sum, value) => sum + Math.abs(value), 0);
  const concentration =
    absolute === 0 ? 1 : Math.max(...foldReturns.map((value) => Math.abs(value))) / absolute;
  const passed =
    foldReturns.length >= MINIMUM_FOLDS &&
    positiveFraction >= MINIMUM_POSITIVE_FOLD_FRACTION &&
    concentration <= MAXIMUM_FOLD_CONCENTRATION;
  return methodEvidence(
    context,
    "walk-forward-stability",
    passed ? "passed" : "failed",
    passed
      ? "walk-forward-stability-passed"
      : foldReturns.length < MINIMUM_FOLDS
        ? "insufficient-walk-forward-folds"
        : "walk-forward-concentration-failed",
    [
      statistic("folds", foldReturns.length),
      statistic("positive-folds", positive),
      statistic("positive-fold-fraction", positiveFraction),
      statistic("maximum-fold-concentration", concentration),
    ],
    [context.pricing.payloads.netReturns.netReturnsHash],
  );
}

function createTrialAudit(
  candidateHash: string,
  hypothesisRef: string,
  declaredTrials: number,
  trialBudgetValue: number,
  input: TrialCountEvidence,
): TrialAuditRecord {
  const root = exactRecord(
    input,
    ["sessionLedgerHash", "sessionAttemptIds", "memorySnapshotHash", "familyExperimentIds"],
    "trial count evidence",
  );
  if (!Array.isArray(root.sessionAttemptIds) || !Array.isArray(root.familyExperimentIds)) {
    throw invalidTrial("trial evidence must contain session-attempt and family-experiment arrays");
  }
  const attemptIds = canonicalUniquePortableIds(root.sessionAttemptIds, "session attempt id");
  const experimentIds = canonicalUniqueHashes(root.familyExperimentIds, "family experiment id");
  if (attemptIds.length === 0) {
    throw invalidTrial("trial evidence must include the current verification attempt");
  }
  const observedTrials = attemptIds.length + experimentIds.length;
  const effectiveTrials = Math.max(declaredTrials, observedTrials);
  const body = deepFreeze({
    format: TRIAL_AUDIT_FORMAT,
    candidateHash: sha256(candidateHash, "trial-audit candidate hash"),
    hypothesisRef: portableId(hypothesisRef, "trial-audit hypothesis reference"),
    declaredTrials: positiveInteger(declaredTrials, "declared trial count", 1_000_000),
    session: {
      ledgerHash: sha256(root.sessionLedgerHash, "session ledger hash"),
      attemptIds,
    },
    memory: {
      snapshotHash: sha256(root.memorySnapshotHash, "memory snapshot hash"),
      familyExperimentIds: experimentIds,
    },
    observedTrials,
    effectiveTrials,
    trialBudget: positiveInteger(trialBudgetValue, "trial budget", 1_000_000),
  });
  return deepFreeze({ ...body, auditHash: hashCanonical(TRIAL_AUDIT_FORMAT, body) });
}

function normalizeLockedGateConfiguration(input: unknown): LockedGateConfiguration {
  const root = exactRecord(
    input,
    ["policyId", "policyVersion", "trialBudget", "nullGeneratorIdentity", "knowledgeCutoff"],
    "locked gate policy",
  );
  if (
    root.policyId !== STANDARD_GATE_POLICY_ID ||
    root.policyVersion !== STANDARD_GATE_POLICY_VERSION
  ) {
    throw invalidGate("artifact uses an unsupported locked gate policy");
  }
  const knowledgeCutoff =
    root.knowledgeCutoff === null
      ? null
      : canonicalTime(root.knowledgeCutoff, "model knowledge cutoff");
  return deepFreeze({
    policyId: STANDARD_GATE_POLICY_ID,
    policyVersion: STANDARD_GATE_POLICY_VERSION,
    trialBudget: positiveInteger(root.trialBudget, "trial budget", 1_000_000),
    nullGeneratorIdentity:
      root.nullGeneratorIdentity === null
        ? null
        : normalizeNullDescriptor(root.nullGeneratorIdentity),
    knowledgeCutoff,
  });
}

function normalizeNullDescriptor(input: unknown): NullGeneratorDescriptor {
  const root = exactRecord(
    input,
    ["reference", "version", "implementationHash", "configurationHash"],
    "locked null-generator identity",
  );
  return Object.freeze({
    reference: portableId(root.reference, "null-generator reference"),
    version: portableId(root.version, "null-generator version"),
    implementationHash: sha256(root.implementationHash, "null-generator implementation hash"),
    configurationHash: sha256(root.configurationHash, "null-generator configuration hash"),
  });
}

function normalizeNeighborInputs(input: unknown): readonly VerifyOosPricingResultInput[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > 64) {
    throw invalidGate("parameter neighbors must be an array of at most 64 pricing results");
  }
  return Object.freeze(input as unknown as VerifyOosPricingResultInput[]);
}

function verifyCompatiblePricing(
  context: GateContext,
  input: VerifyOosPricingResultInput,
  field: string,
): OosPricingResult {
  const pricing = verifyOosPricingResult(input);
  const candidate = verifyPromotionCandidate(
    input.pricingVerification.candidate,
    input.pricingVerification.candidateEvidence,
  );
  if (
    candidate.hypothesis.hypothesisRef !== context.hypothesisRef ||
    canonicalJson(pricing.record.dataset) !== canonicalJson(context.pricing.record.dataset) ||
    canonicalJson(pricing.record.pricingMethod) !==
      canonicalJson(context.pricing.record.pricingMethod) ||
    canonicalJson(pricing.record.costModel) !== canonicalJson(context.pricing.record.costModel) ||
    pricing.record.sample.periodsPerYear !== context.pricing.record.sample.periodsPerYear
  ) {
    throw invalidGate(`${field} is not comparable with the base candidate`);
  }
  return pricing;
}

function methodEvidence(
  context: GateContext,
  gateId: GateId,
  outcome: GateOutcome,
  reasonCode: string,
  statisticsInput: readonly GateStatistic[],
  dependencyHashesInput: readonly string[],
): GateMethodEvidence {
  const statistics = Object.freeze(
    [...statisticsInput]
      .map((item) => statistic(item.name, item.value))
      .sort((left, right) => compareText(left.name, right.name)),
  );
  if (new Set(statistics.map((item) => item.name)).size !== statistics.length) {
    throw invalidGate("gate statistics contain a duplicate name");
  }
  const dependencyHashes = Object.freeze(
    [...new Set(dependencyHashesInput.map((value) => sha256(value, "gate dependency hash")))].sort(
      compareText,
    ),
  );
  const implementationHash = hashCanonical("veil.standard-gate-method.v0", {
    gateId,
    specification: METHOD_SPECS[gateId],
  });
  const body = deepFreeze({
    format: GATE_METHOD_EVIDENCE_FORMAT,
    gateId,
    candidateHash: context.pricing.record.candidateHash,
    pricingHash: context.pricing.record.pricingHash,
    trialAuditHash: context.audit.auditHash,
    outcome,
    reasonCode: portableId(reasonCode, "gate reason code"),
    implementationHash,
    dependencyHashes,
    statistics,
  });
  return deepFreeze({
    ...body,
    evidenceHash: hashCanonical(GATE_METHOD_EVIDENCE_FORMAT, body),
  });
}

function statistic(name: string, value: number): GateStatistic {
  return Object.freeze({
    name: portableId(name, "gate statistic name"),
    value: canonicalNumber(value, `gate statistic ${name}`),
  });
}

function values(observations: readonly OosSeriesObservation[]): readonly number[] {
  return observations.map((observation) => observation.value);
}

function returnSummary(
  returns: readonly number[],
  periodsPerYear: number,
): { readonly annualReturn: number; readonly sharpe: number } {
  if (returns.length === 0) return Object.freeze({ annualReturn: 0, sharpe: 0 });
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.length > 1
      ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
      : 0;
  const annualReturn = normalizeZero(mean * periodsPerYear);
  const annualVolatility = Math.sqrt(variance) * Math.sqrt(periodsPerYear);
  return Object.freeze({
    annualReturn,
    sharpe: annualVolatility > 0 ? normalizeZero(annualReturn / annualVolatility) : 0,
  });
}

/** Deterministic statistical primitive used by the trials-aware gate. */
export function computeDeflatedSharpe(
  returns: readonly number[],
  trials: number,
): DeflatedSharpeResult {
  if (
    !Array.isArray(returns) ||
    returns.length < 2 ||
    returns.some((value) => !Number.isFinite(value) || Object.is(value, -0)) ||
    !Number.isSafeInteger(trials) ||
    trials <= 0 ||
    trials > 1_000_000
  ) {
    throw invalidGate(
      "deflated Sharpe requires canonical returns and a bounded positive trial count",
    );
  }
  const count = returns.length;
  const mean = returns.reduce((sum, value) => sum + value, 0) / count;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
  const standardDeviation = Math.sqrt(variance);
  if (!(standardDeviation > 0)) {
    return Object.freeze({ sampleSharpe: 0, expectedMaximumSharpe: 0, probability: 0 });
  }
  const sampleSharpe = mean / standardDeviation;
  const skewness =
    returns.reduce((sum, value) => sum + ((value - mean) / standardDeviation) ** 3, 0) / count;
  const kurtosis =
    returns.reduce((sum, value) => sum + ((value - mean) / standardDeviation) ** 4, 0) / count;
  const sharpeVariance = Math.max(
    Number.EPSILON,
    (1 - skewness * sampleSharpe + ((kurtosis - 1) / 4) * sampleSharpe ** 2) / (count - 1),
  );
  const expectedMaximumSharpe =
    trials <= 1
      ? 0
      : Math.sqrt(sharpeVariance) *
        ((1 - 0.577_215_664_901_532_9) * inverseNormalCdf(1 - 1 / trials) +
          0.577_215_664_901_532_9 * inverseNormalCdf(1 - 1 / (trials * Math.E)));
  const probability = normalCdf((sampleSharpe - expectedMaximumSharpe) / Math.sqrt(sharpeVariance));
  return deepFreeze({
    sampleSharpe: normalizeZero(sampleSharpe),
    expectedMaximumSharpe: normalizeZero(expectedMaximumSharpe),
    probability: normalizeZero(probability),
  });
}

// Acklam's inverse-normal approximation; deterministic and accurate well beyond gate thresholds.
function inverseNormalCdf(probability: number): number {
  if (!(probability > 0 && probability < 1)) {
    throw invalidGate("inverse-normal probability must be strictly between zero and one");
  }
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    const numerator =
      (((((c[0] ?? 0) * q + (c[1] ?? 0)) * q + (c[2] ?? 0)) * q + (c[3] ?? 0)) * q + (c[4] ?? 0)) *
        q +
      (c[5] ?? 0);
    const denominator =
      ((((d[0] ?? 0) * q + (d[1] ?? 0)) * q + (d[2] ?? 0)) * q + (d[3] ?? 0)) * q + 1;
    return numerator / denominator;
  }
  if (probability > high) return -inverseNormalCdf(1 - probability);
  const q = probability - 0.5;
  const r = q * q;
  const numerator =
    (((((a[0] ?? 0) * r + (a[1] ?? 0)) * r + (a[2] ?? 0)) * r + (a[3] ?? 0)) * r + (a[4] ?? 0)) *
      r +
    (a[5] ?? 0);
  const denominator =
    (((((b[0] ?? 0) * r + (b[1] ?? 0)) * r + (b[2] ?? 0)) * r + (b[3] ?? 0)) * r + (b[4] ?? 0)) *
      r +
    1;
  return (numerator * q) / denominator;
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.min(1, Math.max(0, 0.5 * (1 + sign * erf)));
}

function latestDecisionTime(observations: readonly OosSeriesObservation[]): string {
  const latest = observations.reduce(
    (value, observation) =>
      Date.parse(observation.decisionTime) > Date.parse(value) ? observation.decisionTime : value,
    observations[0]?.decisionTime ?? "",
  );
  return canonicalTime(latest, "latest OOS decision time");
}

function countAfter(pricing: OosPricingResult, cutoff: string): number {
  return pricing.payloads.netReturns.observations.filter(
    (observation) => Date.parse(observation.decisionTime) > Date.parse(cutoff),
  ).length;
}

function canonicalUniquePortableIds(input: unknown[], field: string): readonly string[] {
  const values = input.map((value) => portableId(value, field)).sort(compareText);
  if (new Set(values).size !== values.length) throw invalidTrial(`${field}s must be unique`);
  return Object.freeze(values);
}

function canonicalUniqueHashes(input: unknown[], field: string): readonly string[] {
  const values = input.map((value) => sha256(value, field)).sort(compareText);
  if (new Set(values).size !== values.length) throw invalidTrial(`${field}s must be unique`);
  return Object.freeze(values);
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw invalidGate(`${field} must be a plain object`);
  const actual = Object.keys(input);
  const allowed = new Set(keys);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && keys.some((key) => !actual.includes(key)))
  ) {
    throw invalidGate(`${field} has missing or unknown fields`);
  }
  return input;
}

function requireFields(
  input: Record<string, unknown>,
  fields: readonly string[],
  context: string,
): void {
  if (fields.some((field) => !Object.hasOwn(input, field))) {
    throw invalidGate(`${context} has missing fields`);
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function portableId(input: unknown, field: string): string {
  if (typeof input !== "string" || !PORTABLE_ID.test(input)) {
    throw invalidGate(`${field} must be a portable identifier`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidGate(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function canonicalNumber(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || Object.is(input, -0)) {
    throw invalidGate(`${field} must be a canonical finite number`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string, maximum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0 || input > maximum) {
    throw invalidGate(`${field} must be a positive integer at most ${maximum}`);
  }
  return input;
}

function canonicalTime(input: unknown, field: string): string {
  if (typeof input !== "string") throw invalidGate(`${field} must be a canonical UTC instant`);
  try {
    const normalized = normalizeDecisionTime(input);
    if (normalized !== input) throw new Error("not canonical");
    return normalized;
  } catch {
    throw invalidGate(`${field} must be a canonical UTC instant`);
  }
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
      throw invalidGate("gate evidence contains a non-canonical number");
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
  throw invalidGate("gate evidence contains an unsupported value");
}

function normalizeZero(input: number): number {
  return input === 0 ? 0 : input;
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

function invalidTrial(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_TRIAL_AUDIT",
    message,
    "Supply the complete active-session attempt ledger and same-hypothesis experiment snapshot.",
  );
}

function invalidGate(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_GATE_EXECUTION",
    message,
    "Replay immutable pricing evidence with the artifact-locked Stage 4 policy and registered methods.",
  );
}
