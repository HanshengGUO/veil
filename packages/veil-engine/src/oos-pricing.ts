import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { AdapterDeclaration } from "@veilquant/contract";
import { type Table, tableFromIPC, type Vector } from "apache-arrow";
import { verifyArtifactManifest } from "./artifact.ts";
import {
  type CostModelCharge,
  type CostModelDescriptor,
  type CostModelMarketData,
  type CostModelMarketScalar,
  type CostModelRegistry,
  type CostModelTrade,
  executeRegisteredCostModel,
} from "./cost-model.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  type PromotionCandidateVerificationEvidence,
  verifyPromotionCandidate,
} from "./promotion.ts";
import { verifyReadSetResultIdentity } from "./read-set.ts";
import {
  createPricingEvidenceRecord,
  type ExperimentMetric,
  type PricingEvidenceRecord,
  type PricingEvidenceVerificationEvidence,
  type Stage4MethodIdentity,
  verifyPricingEvidenceRecord,
} from "./stage4-evidence.ts";
import { verifyVerificationView } from "./verification-view.ts";
import {
  admitArtifactOutput,
  type WalkForwardContractExecution,
  type WalkForwardContractResult,
} from "./walk-forward-contract.ts";
import {
  createWalkForwardContractExecutionRecord,
  verifyWalkForwardContractRecord,
  type WalkForwardContractExecutionRecord,
} from "./walk-forward-contract-record.ts";
import { verifyWalkForwardPlan, type WalkForwardPlan } from "./walk-forward-plan.ts";

export const OOS_PRICING_TRADES_FORMAT = "veil.oos-pricing-trades.v0" as const;
export const OOS_GROSS_RETURNS_FORMAT = "veil.oos-gross-returns.v0" as const;
export const OOS_COSTS_FORMAT = "veil.oos-costs.v0" as const;
export const OOS_NET_RETURNS_FORMAT = "veil.oos-net-returns.v0" as const;
export const QUANTILE_OOS_PRICING_METHOD_ID = "veil.quantile-close-to-close" as const;
export const QUANTILE_OOS_PRICING_METHOD_VERSION = "0.1.0" as const;

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PRICING_METHOD_SPEC = Object.freeze({
  portfolios: ["cross-sectional-long-only-quantile", "cross-sectional-long-short-quantile"],
  sizing: "optional-positive-artifact-weight-normalized-within-each-side",
  rebalance: "every-holdDays-from-fold-oos-start",
  execution: "signal-index-plus-executionLagDays",
  executionTradability:
    "reapply-adapter-mask-carry-masked-positions-rescale-executable-side-budget",
  return: "close-to-close-at-execution-through-hold-horizon",
  foldBoundary: "flat-at-start-no-synthetic-terminal-liquidation",
  missingHeldPrice: "fail-closed",
  tieBreak: "canonical-entity-key-ascending",
});

export const QUANTILE_OOS_PRICING_METHOD: Stage4MethodIdentity = Object.freeze({
  id: QUANTILE_OOS_PRICING_METHOD_ID,
  version: QUANTILE_OOS_PRICING_METHOD_VERSION,
  implementationHash: hashCanonical("veil.oos-pricing-method.v0", PRICING_METHOD_SPEC),
});

/** Backward-compatible names for the generalized quantile method introduced before v0.2 release. */
export const LONG_SHORT_OOS_PRICING_METHOD_ID = QUANTILE_OOS_PRICING_METHOD_ID;
export const LONG_SHORT_OOS_PRICING_METHOD_VERSION = QUANTILE_OOS_PRICING_METHOD_VERSION;
export const LONG_SHORT_OOS_PRICING_METHOD = QUANTILE_OOS_PRICING_METHOD;

export interface QuantileOosPricingConfiguration {
  readonly pricingMethodIdentity: Stage4MethodIdentity;
  /** Numeric artifact-output column ranked independently at each rebalance decision. */
  readonly signalColumn: string;
  /** Positive source column used for close-to-close returns and execution-market evidence. */
  readonly priceColumn: string;
  /** Extra current-session source fields supplied to the CostModel. */
  readonly marketColumns?: readonly string[];
  readonly periodsPerYear: number;
  readonly portfolio: {
    readonly kind: "long-only-quantile" | "long-short-quantile";
    /** Gross exposure is one: all long, or 0.5 long and 0.5 short. */
    readonly quantile: number;
    /** Optional positive artifact output used for trailing-information position sizing. */
    readonly weightColumn?: string | null;
  };
  readonly capacity?: {
    /** Portfolio NAV in the same currency as price times volume. */
    readonly portfolioNav: number;
    readonly volumeColumn: string;
    readonly maximumParticipationRate: number;
  } | null;
  /** Descriptor fields frozen before verification; `reference` is the artifact's costModel. */
  readonly costModelIdentity: Omit<CostModelDescriptor, "reference">;
}

export type LongShortOosPricingConfiguration = QuantileOosPricingConfiguration;

export interface NormalizedQuantileOosPricingConfiguration {
  readonly pricingMethodIdentity: Stage4MethodIdentity;
  readonly signalColumn: string;
  readonly priceColumn: string;
  readonly marketColumns: readonly string[];
  readonly periodsPerYear: number;
  readonly portfolio: {
    readonly kind: "long-only-quantile" | "long-short-quantile";
    readonly quantile: number;
    readonly weightColumn: string | null;
  };
  readonly capacity: {
    readonly portfolioNav: number;
    readonly volumeColumn: string;
    readonly maximumParticipationRate: number;
  } | null;
  readonly costModelIdentity: Omit<CostModelDescriptor, "reference">;
}

export type NormalizedLongShortOosPricingConfiguration = NormalizedQuantileOosPricingConfiguration;

export interface OosPricingTradesPayload {
  readonly format: typeof OOS_PRICING_TRADES_FORMAT;
  readonly candidateHash: string;
  readonly pricingMethod: Stage4MethodIdentity;
  readonly configuration: NormalizedQuantileOosPricingConfiguration;
  readonly trades: readonly CostModelTrade[];
  readonly marketData: readonly CostModelMarketData[];
  readonly tradesHash: string;
}

export interface OosReturnContribution {
  readonly entityKey: string;
  readonly weight: number;
  readonly previousPrice: number;
  readonly price: number;
  readonly assetReturn: number;
  readonly contribution: number;
}

export interface OosGrossReturnObservation {
  readonly foldIndex: number;
  readonly decisionIndex: number;
  readonly decisionTime: string;
  readonly contributions: readonly OosReturnContribution[];
  readonly value: number;
}

export interface OosSeriesObservation {
  readonly foldIndex: number;
  readonly decisionIndex: number;
  readonly decisionTime: string;
  readonly value: number;
}

export interface OosGrossReturnsPayload {
  readonly format: typeof OOS_GROSS_RETURNS_FORMAT;
  readonly candidateHash: string;
  readonly tradesHash: string;
  readonly observations: readonly OosGrossReturnObservation[];
  readonly grossReturnsHash: string;
}

export interface OosCostsPayload {
  readonly format: typeof OOS_COSTS_FORMAT;
  readonly candidateHash: string;
  readonly tradesHash: string;
  readonly costModel: CostModelDescriptor;
  readonly charges: readonly CostModelCharge[];
  readonly observations: readonly OosSeriesObservation[];
  readonly costsHash: string;
}

export interface OosNetReturnsPayload {
  readonly format: typeof OOS_NET_RETURNS_FORMAT;
  readonly candidateHash: string;
  readonly grossReturnsHash: string;
  readonly costsHash: string;
  readonly observations: readonly OosSeriesObservation[];
  readonly netReturnsHash: string;
}

export interface OosPricingPayloads {
  readonly trades: OosPricingTradesPayload;
  readonly grossReturns: OosGrossReturnsPayload;
  readonly costs: OosCostsPayload;
  readonly netReturns: OosNetReturnsPayload;
}

export interface OosPricingResult {
  readonly record: PricingEvidenceRecord;
  /** Store these immutable payloads under the four hashes carried by `record.series`. */
  readonly payloads: OosPricingPayloads;
}

export interface VerifyOosPricingResultInput {
  readonly result: unknown;
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
}

export interface ExecuteOosPricingInput {
  readonly candidate: unknown;
  readonly candidateEvidence: PromotionCandidateVerificationEvidence;
  /** Complete retained output of the exact contract run cited by the candidate. */
  readonly contractResult: WalkForwardContractResult;
  readonly costModels: CostModelRegistry;
}

interface ReplayedExecution {
  readonly record: WalkForwardContractExecutionRecord;
  readonly source: Table;
  readonly admitted: Table;
}

interface MarketPoint {
  readonly price: number;
  readonly fields: Readonly<Record<string, CostModelMarketScalar>>;
  readonly executable: boolean;
}

interface DecisionSnapshot {
  readonly execution: ReplayedExecution;
  readonly market: ReadonlyMap<string, MarketPoint>;
  readonly scores: ReadonlyMap<string, number>;
  readonly sizes: ReadonlyMap<string, number>;
}

interface TradesBody {
  readonly format: typeof OOS_PRICING_TRADES_FORMAT;
  readonly candidateHash: string;
  readonly pricingMethod: Stage4MethodIdentity;
  readonly configuration: NormalizedQuantileOosPricingConfiguration;
  readonly trades: readonly CostModelTrade[];
  readonly marketData: readonly CostModelMarketData[];
}

interface GrossReturnsBody {
  readonly format: typeof OOS_GROSS_RETURNS_FORMAT;
  readonly candidateHash: string;
  readonly tradesHash: string;
  readonly observations: readonly OosGrossReturnObservation[];
}

interface CostsBody {
  readonly format: typeof OOS_COSTS_FORMAT;
  readonly candidateHash: string;
  readonly tradesHash: string;
  readonly costModel: CostModelDescriptor;
  readonly charges: readonly CostModelCharge[];
  readonly observations: readonly OosSeriesObservation[];
}

interface NetReturnsBody {
  readonly format: typeof OOS_NET_RETURNS_FORMAT;
  readonly candidateHash: string;
  readonly grossReturnsHash: string;
  readonly costsHash: string;
  readonly observations: readonly OosSeriesObservation[];
}

/** Prices one replay-verified candidate; aggregate metrics are never accepted from the caller. */
export async function executeOosPricing(input: ExecuteOosPricingInput): Promise<OosPricingResult> {
  const root = exactRecord(
    input,
    ["candidate", "candidateEvidence", "contractResult", "costModels"],
    "OOS pricing input",
  );
  const candidateEvidence = root.candidateEvidence as PromotionCandidateVerificationEvidence;
  const candidate = verifyPromotionCandidate(root.candidate, candidateEvidence);
  const artifact = verifyArtifactManifest(candidateEvidence.artifact, {
    expectedArtifactHash: candidate.artifactHash,
  });
  const plan = verifyWalkForwardPlan(candidateEvidence.plan, {
    expectedPlanHash: candidate.planHash,
  });
  const contract = verifyWalkForwardContractRecord(candidateEvidence.contractRecord, {
    artifact,
    plan,
    declaration: candidateEvidence.declaration,
    expectedHash: candidate.contractHash,
  });
  const configuration = normalizeConfiguration(
    artifact.declaredLiterals.oosPricing,
    artifact.costModel,
  );
  const executions = replayContractResult(
    root.contractResult,
    artifact,
    plan,
    candidateEvidence.declaration,
    contract.contractHash,
    candidate.parameterLockHash,
  );
  const { trades, marketData, grossObservations } = priceFolds(
    plan,
    executions,
    candidateEvidence.declaration,
    configuration,
  );
  const tradesPayload = issueTradesPayload(
    candidate.candidateHash,
    configuration,
    trades,
    marketData,
  );
  const costExecution = await executeRegisteredCostModel(
    root.costModels as CostModelRegistry,
    candidate.gateInputs.costModel,
    { trades, marketData },
  );
  const expectedCostModel: CostModelDescriptor = Object.freeze({
    reference: artifact.costModel,
    ...configuration.costModelIdentity,
  });
  if (canonicalJson(costExecution.descriptor) !== canonicalJson(expectedCostModel)) {
    throw invalidPricing(
      "registered cost-model identity differs from the artifact's locked pricing declaration",
    );
  }
  const grossReturnsPayload = issueGrossReturnsPayload(
    candidate.candidateHash,
    tradesPayload.tradesHash,
    grossObservations,
  );
  const costObservations = aggregateCosts(grossObservations, trades, costExecution.charges);
  const costsPayload = issueCostsPayload(
    candidate.candidateHash,
    tradesPayload.tradesHash,
    costExecution.descriptor,
    costExecution.charges,
    costObservations,
  );
  const netObservations = grossObservations.map((gross, index) => {
    const cost = costObservations[index];
    if (cost === undefined || !sameObservationIdentity(gross, cost)) {
      throw invalidPricing("cost series is not aligned with gross OOS returns");
    }
    return Object.freeze({
      foldIndex: gross.foldIndex,
      decisionIndex: gross.decisionIndex,
      decisionTime: gross.decisionTime,
      value: normalizeZero(gross.value - cost.value),
    });
  });
  const netReturnsPayload = issueNetReturnsPayload(
    candidate.candidateHash,
    grossReturnsPayload.grossReturnsHash,
    costsPayload.costsHash,
    netObservations,
  );
  const metrics = pricingMetrics(
    grossObservations.map((observation) => observation.value),
    netObservations.map((observation) => observation.value),
    trades,
    costObservations,
    configuration.periodsPerYear,
  );
  const record = createPricingEvidenceRecord({
    candidate,
    candidateEvidence,
    pricingMethod: QUANTILE_OOS_PRICING_METHOD,
    costModel: costExecution.descriptor,
    sample: {
      observations: grossObservations.length,
      periodsPerYear: configuration.periodsPerYear,
    },
    series: {
      tradesHash: tradesPayload.tradesHash,
      grossReturnsHash: grossReturnsPayload.grossReturnsHash,
      costsHash: costsPayload.costsHash,
      netReturnsHash: netReturnsPayload.netReturnsHash,
    },
    metrics,
  });
  return deepFreeze({
    record,
    payloads: {
      trades: tradesPayload,
      grossReturns: grossReturnsPayload,
      costs: costsPayload,
      netReturns: netReturnsPayload,
    },
  });
}

/** Recomputes every pricing payload identity and aggregate metric before gates consume the series. */
export function verifyOosPricingResult(input: VerifyOosPricingResultInput): OosPricingResult {
  const request = exactRecord(
    input,
    ["result", "pricingVerification"],
    "OOS pricing verification input",
  );
  const root = exactRecord(request.result, ["record", "payloads"], "OOS pricing result");
  const record = verifyPricingEvidenceRecord(
    root.record,
    request.pricingVerification as PricingEvidenceVerificationEvidence,
  );
  const payloads = exactRecord(
    root.payloads,
    ["trades", "grossReturns", "costs", "netReturns"],
    "OOS pricing payloads",
  );
  const trades = verifyTradesPayload(payloads.trades, record);
  const grossReturns = verifyGrossReturnsPayload(payloads.grossReturns, record, trades);
  const costs = verifyCostsPayload(payloads.costs, record, trades, grossReturns);
  const netReturns = verifyNetReturnsPayload(payloads.netReturns, record, grossReturns, costs);
  const derived = pricingMetrics(
    grossReturns.observations.map((observation) => observation.value),
    netReturns.observations.map((observation) => observation.value),
    trades.trades,
    costs.observations,
    record.sample.periodsPerYear,
  );
  if (canonicalJson(sortMetrics(derived)) !== canonicalJson(record.metrics)) {
    throw invalidPricing("aggregate metrics do not reproduce from the immutable pricing series");
  }
  return deepFreeze({
    record,
    payloads: { trades, grossReturns, costs, netReturns },
  });
}

function verifyTradesPayload(
  input: unknown,
  record: PricingEvidenceRecord,
): OosPricingTradesPayload {
  const root = exactRecord(
    input,
    [
      "format",
      "candidateHash",
      "pricingMethod",
      "configuration",
      "trades",
      "marketData",
      "tradesHash",
    ],
    "OOS trades payload",
  );
  if (
    root.format !== OOS_PRICING_TRADES_FORMAT ||
    root.candidateHash !== record.candidateHash ||
    canonicalJson(root.pricingMethod) !== canonicalJson(record.pricingMethod)
  ) {
    throw invalidPricing("trades payload does not match its pricing record");
  }
  const configuration = root.configuration as NormalizedQuantileOosPricingConfiguration;
  if (
    !isPlainRecord(configuration) ||
    configuration.periodsPerYear !== record.sample.periodsPerYear
  ) {
    throw invalidPricing("trades payload configuration does not match its pricing sample");
  }
  if (!Array.isArray(root.trades) || !Array.isArray(root.marketData)) {
    throw invalidPricing("trades payload must contain trade and market-data arrays");
  }
  const trades = root.trades as unknown as readonly CostModelTrade[];
  const marketData = root.marketData as unknown as readonly CostModelMarketData[];
  if (trades.length !== marketData.length) {
    throw invalidPricing("trades payload market data must cover every trade");
  }
  for (let index = 0; index < trades.length; index += 1) {
    verifyTrade(trades[index], marketData[index], index);
  }
  const body: TradesBody = {
    format: OOS_PRICING_TRADES_FORMAT,
    candidateHash: record.candidateHash,
    pricingMethod: root.pricingMethod as Stage4MethodIdentity,
    configuration,
    trades,
    marketData,
  };
  const tradesHash = sha256(root.tradesHash, "trades payload hash");
  if (
    hashCanonical(OOS_PRICING_TRADES_FORMAT, body) !== tradesHash ||
    record.series.tradesHash !== tradesHash
  ) {
    throw invalidPricing("trades payload hash does not match its pricing record");
  }
  return deepFreeze({ ...body, tradesHash });
}

function verifyTrade(
  tradeInput: CostModelTrade | undefined,
  marketInput: CostModelMarketData | undefined,
  index: number,
): void {
  const trade = exactRecord(
    tradeInput,
    [
      "tradeId",
      "foldIndex",
      "signalDecisionIndex",
      "executionDecisionIndex",
      "signalTime",
      "executionTime",
      "entityKey",
      "previousWeight",
      "targetWeight",
      "weightChange",
    ],
    `pricing trade ${index}`,
  );
  const market = exactRecord(
    marketInput,
    ["tradeId", "price", "fields"],
    `pricing market row ${index}`,
  );
  if (
    sha256(trade.tradeId, `pricing trade ${index} id`) !==
      sha256(market.tradeId, `pricing market row ${index} trade id`) ||
    !isPlainRecord(market.fields)
  ) {
    throw invalidPricing("pricing trade and market-data identities are not aligned");
  }
  const previousWeight = canonicalNumber(trade.previousWeight, "pricing previous weight");
  const targetWeight = canonicalNumber(trade.targetWeight, "pricing target weight");
  const weightChange = canonicalNumber(trade.weightChange, "pricing weight change");
  if (normalizeZero(targetWeight - previousWeight) !== weightChange) {
    throw invalidPricing("pricing trade weight change is inconsistent");
  }
  if (canonicalNumber(market.price, "pricing market price") <= 0) {
    throw invalidPricing("pricing market price must be positive");
  }
  canonicalJson(trade);
  canonicalJson(market);
}

function verifyGrossReturnsPayload(
  input: unknown,
  record: PricingEvidenceRecord,
  trades: OosPricingTradesPayload,
): OosGrossReturnsPayload {
  const root = exactRecord(
    input,
    ["format", "candidateHash", "tradesHash", "observations", "grossReturnsHash"],
    "OOS gross-returns payload",
  );
  if (
    root.format !== OOS_GROSS_RETURNS_FORMAT ||
    root.candidateHash !== record.candidateHash ||
    root.tradesHash !== trades.tradesHash ||
    !Array.isArray(root.observations) ||
    root.observations.length !== record.sample.observations
  ) {
    throw invalidPricing("gross-returns payload does not match its pricing record");
  }
  const observations = root.observations as unknown as readonly OosGrossReturnObservation[];
  for (let index = 0; index < observations.length; index += 1) {
    verifyGrossObservation(observations[index], index);
  }
  const body: GrossReturnsBody = {
    format: OOS_GROSS_RETURNS_FORMAT,
    candidateHash: record.candidateHash,
    tradesHash: trades.tradesHash,
    observations,
  };
  const grossReturnsHash = sha256(root.grossReturnsHash, "gross-returns payload hash");
  if (
    hashCanonical(OOS_GROSS_RETURNS_FORMAT, body) !== grossReturnsHash ||
    record.series.grossReturnsHash !== grossReturnsHash
  ) {
    throw invalidPricing("gross-returns payload hash does not match its pricing record");
  }
  return deepFreeze({ ...body, grossReturnsHash });
}

function verifyGrossObservation(input: OosGrossReturnObservation | undefined, index: number): void {
  const root = exactRecord(
    input,
    ["foldIndex", "decisionIndex", "decisionTime", "contributions", "value"],
    `gross-return observation ${index}`,
  );
  if (!Array.isArray(root.contributions)) {
    throw invalidPricing("gross-return contributions must be an array");
  }
  let value = 0;
  for (const [contributionIndex, contributionInput] of root.contributions.entries()) {
    const contribution = exactRecord(
      contributionInput,
      ["entityKey", "weight", "previousPrice", "price", "assetReturn", "contribution"],
      `gross-return contribution ${index}:${contributionIndex}`,
    );
    const weight = canonicalNumber(contribution.weight, "gross-return weight");
    const previousPrice = canonicalNumber(
      contribution.previousPrice,
      "gross-return previous price",
    );
    const price = canonicalNumber(contribution.price, "gross-return price");
    const assetReturn = canonicalNumber(contribution.assetReturn, "gross asset return");
    const amount = canonicalNumber(contribution.contribution, "gross return contribution");
    if (
      previousPrice <= 0 ||
      price <= 0 ||
      normalizeZero(price / previousPrice - 1) !== assetReturn ||
      normalizeZero(weight * assetReturn) !== amount
    ) {
      throw invalidPricing("gross-return contribution does not reproduce from price and weight");
    }
    value += amount;
  }
  if (normalizeZero(value) !== canonicalNumber(root.value, "gross-return value")) {
    throw invalidPricing("gross-return observation does not equal its contributions");
  }
  canonicalJson(root);
}

function verifyCostsPayload(
  input: unknown,
  record: PricingEvidenceRecord,
  trades: OosPricingTradesPayload,
  gross: OosGrossReturnsPayload,
): OosCostsPayload {
  const root = exactRecord(
    input,
    ["format", "candidateHash", "tradesHash", "costModel", "charges", "observations", "costsHash"],
    "OOS costs payload",
  );
  if (
    root.format !== OOS_COSTS_FORMAT ||
    root.candidateHash !== record.candidateHash ||
    root.tradesHash !== trades.tradesHash ||
    canonicalJson(root.costModel) !== canonicalJson(record.costModel) ||
    !Array.isArray(root.charges) ||
    !Array.isArray(root.observations) ||
    root.charges.length !== trades.trades.length ||
    root.observations.length !== gross.observations.length
  ) {
    throw invalidPricing("costs payload does not match its pricing record");
  }
  const charges = root.charges as unknown as readonly CostModelCharge[];
  const observations = root.observations as unknown as readonly OosSeriesObservation[];
  const byDecision = new Map<string, number>();
  for (let index = 0; index < charges.length; index += 1) {
    const charge = exactRecord(charges[index], ["tradeId", "cost"], `pricing cost charge ${index}`);
    const trade = trades.trades[index];
    if (trade === undefined || charge.tradeId !== trade.tradeId) {
      throw invalidPricing("cost charges do not follow canonical trade order");
    }
    const cost = canonicalNumber(charge.cost, `pricing cost charge ${index}`);
    if (cost < 0) throw invalidPricing("pricing costs cannot be negative");
    const key = observationKey(trade.foldIndex, trade.executionDecisionIndex);
    byDecision.set(key, normalizeZero((byDecision.get(key) ?? 0) + cost));
  }
  for (let index = 0; index < observations.length; index += 1) {
    const observation = verifySeriesObservation(
      observations[index],
      gross.observations[index],
      `cost observation ${index}`,
    );
    const expected =
      byDecision.get(observationKey(observation.foldIndex, observation.decisionIndex)) ?? 0;
    if (observation.value !== expected || observation.value < 0) {
      throw invalidPricing("cost observation does not equal its trade charges");
    }
  }
  const body: CostsBody = {
    format: OOS_COSTS_FORMAT,
    candidateHash: record.candidateHash,
    tradesHash: trades.tradesHash,
    costModel: record.costModel,
    charges,
    observations,
  };
  const costsHash = sha256(root.costsHash, "costs payload hash");
  if (
    hashCanonical(OOS_COSTS_FORMAT, body) !== costsHash ||
    record.series.costsHash !== costsHash
  ) {
    throw invalidPricing("costs payload hash does not match its pricing record");
  }
  return deepFreeze({ ...body, costsHash });
}

function verifyNetReturnsPayload(
  input: unknown,
  record: PricingEvidenceRecord,
  gross: OosGrossReturnsPayload,
  costs: OosCostsPayload,
): OosNetReturnsPayload {
  const root = exactRecord(
    input,
    ["format", "candidateHash", "grossReturnsHash", "costsHash", "observations", "netReturnsHash"],
    "OOS net-returns payload",
  );
  if (
    root.format !== OOS_NET_RETURNS_FORMAT ||
    root.candidateHash !== record.candidateHash ||
    root.grossReturnsHash !== gross.grossReturnsHash ||
    root.costsHash !== costs.costsHash ||
    !Array.isArray(root.observations) ||
    root.observations.length !== gross.observations.length
  ) {
    throw invalidPricing("net-returns payload does not match gross returns and costs");
  }
  const observations = root.observations as unknown as readonly OosSeriesObservation[];
  for (let index = 0; index < observations.length; index += 1) {
    const observation = verifySeriesObservation(
      observations[index],
      gross.observations[index],
      `net-return observation ${index}`,
    );
    const grossValue = gross.observations[index]?.value;
    const costValue = costs.observations[index]?.value;
    if (
      grossValue === undefined ||
      costValue === undefined ||
      observation.value !== normalizeZero(grossValue - costValue)
    ) {
      throw invalidPricing("net return does not equal gross return less cost");
    }
  }
  const body: NetReturnsBody = {
    format: OOS_NET_RETURNS_FORMAT,
    candidateHash: record.candidateHash,
    grossReturnsHash: gross.grossReturnsHash,
    costsHash: costs.costsHash,
    observations,
  };
  const netReturnsHash = sha256(root.netReturnsHash, "net-returns payload hash");
  if (
    hashCanonical(OOS_NET_RETURNS_FORMAT, body) !== netReturnsHash ||
    record.series.netReturnsHash !== netReturnsHash
  ) {
    throw invalidPricing("net-returns payload hash does not match its pricing record");
  }
  return deepFreeze({ ...body, netReturnsHash });
}

function verifySeriesObservation(
  input: OosSeriesObservation | undefined,
  expected:
    | Pick<OosGrossReturnObservation, "foldIndex" | "decisionIndex" | "decisionTime">
    | undefined,
  field: string,
): OosSeriesObservation {
  const root = exactRecord(input, ["foldIndex", "decisionIndex", "decisionTime", "value"], field);
  const observation = root as unknown as OosSeriesObservation;
  if (expected === undefined || !sameObservationIdentity(expected, observation)) {
    throw invalidPricing(`${field} is not aligned with the gross-return series`);
  }
  canonicalNumber(root.value, `${field} value`);
  canonicalJson(root);
  return observation;
}

function sortMetrics(metrics: readonly ExperimentMetric[]): readonly ExperimentMetric[] {
  return Object.freeze(
    [...metrics].sort((left, right) => {
      const leftIdentity = `${left.scope}\0${left.basis}\0${left.name}\0${left.unit}`;
      const rightIdentity = `${right.scope}\0${right.basis}\0${right.name}\0${right.unit}`;
      return compareText(leftIdentity, rightIdentity);
    }),
  );
}

function replayContractResult(
  input: unknown,
  artifact: ReturnType<typeof verifyArtifactManifest>,
  plan: WalkForwardPlan,
  declaration: AdapterDeclaration,
  expectedContractHash: string,
  expectedParameterLockHash: string,
): readonly ReplayedExecution[] {
  const root = exactRecord(
    input,
    ["plan", "parameterLockHash", "executionCount", "executionEvidence", "executions", "record"],
    "walk-forward contract result",
  );
  const resultPlan = verifyWalkForwardPlan(root.plan, { expectedPlanHash: plan.planHash });
  const record = verifyWalkForwardContractRecord(root.record, {
    artifact,
    plan: resultPlan,
    declaration,
    expectedHash: expectedContractHash,
  });
  if (root.parameterLockHash !== expectedParameterLockHash) {
    throw invalidPricing("contract result parameter lock differs from the promotion candidate");
  }
  if (root.executionEvidence !== "retained") {
    throw invalidPricing(
      "OOS pricing requires retained execution evidence; compact records alone contain no prices",
    );
  }
  if (
    typeof root.executionCount !== "number" ||
    !Number.isSafeInteger(root.executionCount) ||
    root.executionCount !== record.executions.length ||
    !Array.isArray(root.executions) ||
    root.executions.length !== root.executionCount
  ) {
    throw invalidPricing("contract result does not contain the complete retained execution set");
  }
  return Object.freeze(
    root.executions.map((execution, index) =>
      replayExecution(
        execution,
        record.executions[index],
        artifact,
        resultPlan,
        declaration,
        index,
      ),
    ),
  );
}

function replayExecution(
  input: unknown,
  expected: WalkForwardContractExecutionRecord | undefined,
  artifact: ReturnType<typeof verifyArtifactManifest>,
  plan: WalkForwardPlan,
  declaration: AdapterDeclaration,
  index: number,
): ReplayedExecution {
  if (expected === undefined) throw invalidPricing("contract execution topology is incomplete");
  const root = exactRecord(
    input,
    ["source", "view", "execution", "admitted", "record"],
    `execution ${index}`,
  );
  const source = exactRecord(root.source, ["readSet", "arrowIpc"], `execution ${index} source`);
  const view = exactRecord(root.view, ["manifest", "arrowIpc"], `execution ${index} view`);
  const admitted = exactRecord(
    root.admitted,
    ["result", "arrowIpc"],
    `execution ${index} admitted output`,
  );
  const sourceArrow = nonemptyArrow(source.arrowIpc, `execution ${index} source Arrow`);
  const viewArrow = nonemptyArrow(view.arrowIpc, `execution ${index} view Arrow`);
  const output = root.execution as WalkForwardContractExecution["execution"];
  if (
    !isPlainRecord(output) ||
    !(output.arrowIpc instanceof Uint8Array) ||
    output.arrowIpc.byteLength === 0 ||
    output.outputArrowHash !== hashBytes(output.arrowIpc)
  ) {
    throw invalidPricing(`execution ${index} artifact output bytes do not match their identity`);
  }
  const verifiedView = verifyVerificationView(view.manifest, {
    sourceReadSet: source.readSet as WalkForwardContractExecution["source"]["readSet"],
    sourceArrowIpc: sourceArrow,
    declaration,
    plan,
    foldIndex: expected.foldIndex,
    role: expected.role,
    decisionIndex: expected.decisionIndex,
    arrowIpc: viewArrow,
    expectedViewHash: expected.viewHash,
  });
  const replayedAdmission = admitArtifactOutput({
    inputArrowIpc: viewArrow,
    outputArrowIpc: output.arrowIpc,
    declaration,
    decisionTime: expected.decisionTime,
    role: expected.role,
  });
  const admittedArrow = nonemptyArrow(admitted.arrowIpc, `execution ${index} admitted Arrow`);
  const suppliedAdmission = verifyReadSetResultIdentity(admitted.result, admittedArrow);
  if (
    canonicalJson(suppliedAdmission) !== canonicalJson(replayedAdmission.result) ||
    suppliedAdmission.arrowHash !== hashBytes(admittedArrow)
  ) {
    throw invalidPricing(`execution ${index} admitted output does not replay from child output`);
  }
  const recreated = createWalkForwardContractExecutionRecord({
    artifact,
    plan,
    view: verifiedView,
    execution: output,
    admittedOutput: replayedAdmission.result,
  });
  if (
    canonicalJson(recreated) !== canonicalJson(expected) ||
    canonicalJson(root.record) !== canonicalJson(expected)
  ) {
    throw invalidPricing(`execution ${index} does not match the complete contract record`);
  }
  return Object.freeze({
    record: recreated,
    source: decodeArrow(sourceArrow, `execution ${index} source`),
    admitted: decodeArrow(replayedAdmission.arrowIpc, `execution ${index} admitted output`),
  });
}

function priceFolds(
  plan: WalkForwardPlan,
  executions: readonly ReplayedExecution[],
  declaration: AdapterDeclaration,
  configuration: NormalizedQuantileOosPricingConfiguration,
): {
  readonly trades: readonly CostModelTrade[];
  readonly marketData: readonly CostModelMarketData[];
  readonly grossObservations: readonly OosGrossReturnObservation[];
} {
  const trades: CostModelTrade[] = [];
  const marketData: CostModelMarketData[] = [];
  const grossObservations: OosGrossReturnObservation[] = [];
  for (const fold of plan.folds) {
    const foldExecutions = executions.filter(
      (execution) =>
        execution.record.foldIndex === fold.index && execution.record.role === "out-of-sample",
    );
    if (foldExecutions.length !== fold.outOfSample.sessionCount) {
      throw invalidPricing(`fold ${fold.index} lacks complete OOS execution evidence`);
    }
    const snapshots = foldExecutions.map((execution, offset) => {
      const expectedIndex = fold.outOfSample.startIndex + offset;
      if (execution.record.decisionIndex !== expectedIndex) {
        throw invalidPricing(
          `fold ${fold.index} OOS executions are not in canonical session order`,
        );
      }
      return decisionSnapshot(execution, declaration, configuration);
    });
    let positions = new Map<string, number>();
    for (let offset = 0; offset < snapshots.length; offset += 1) {
      const snapshot = snapshots[offset];
      if (snapshot === undefined) throw invalidPricing("OOS snapshot topology is incomplete");
      const signalOffset = offset - plan.protocol.executionLagDays;
      if (signalOffset >= 0 && signalOffset % plan.protocol.holdDays === 0) {
        const signal = snapshots[signalOffset];
        if (signal === undefined) throw invalidPricing("OOS signal snapshot is missing");
        const target = executableTargetWeights(
          signal.scores,
          signal.sizes,
          snapshot.market,
          positions,
          configuration.portfolio,
        );
        const touched = [...new Set([...positions.keys(), ...target.keys()])].sort(compareText);
        for (const entityKey of touched) {
          const previousWeight = positions.get(entityKey) ?? 0;
          const targetWeight = target.get(entityKey) ?? 0;
          const weightChange = normalizeZero(targetWeight - previousWeight);
          if (weightChange === 0) continue;
          const point = snapshot.market.get(entityKey);
          if (point === undefined) {
            throw invalidPricing(
              `fold ${fold.index} cannot price a trade because execution-market data is missing`,
            );
          }
          if (!point.executable) {
            throw invalidPricing(
              `fold ${fold.index} attempted to trade an execution-time masked entity`,
            );
          }
          const tradeBody = {
            foldIndex: fold.index,
            signalDecisionIndex: signal.execution.record.decisionIndex,
            executionDecisionIndex: snapshot.execution.record.decisionIndex,
            signalTime: signal.execution.record.decisionTime,
            executionTime: snapshot.execution.record.decisionTime,
            entityKey,
            previousWeight,
            targetWeight,
            weightChange,
          };
          const trade = Object.freeze({
            tradeId: hashCanonical("veil.oos-pricing-trade.v0", tradeBody),
            ...tradeBody,
          });
          trades.push(trade);
          marketData.push(
            deepFreeze({ tradeId: trade.tradeId, price: point.price, fields: point.fields }),
          );
        }
        positions = target;
      }
      const contributions: OosReturnContribution[] = [];
      if (positions.size > 0) {
        const previous = snapshots[offset - 1];
        if (previous === undefined) {
          throw invalidPricing("an OOS position became active before a prior close was available");
        }
        for (const [entityKey, weight] of [...positions.entries()].sort(([left], [right]) =>
          compareText(left, right),
        )) {
          const before = previous.market.get(entityKey);
          const current = snapshot.market.get(entityKey);
          if (before === undefined || current === undefined) {
            throw invalidPricing(
              `fold ${fold.index} cannot price a held position because a close is missing`,
            );
          }
          const assetReturn = normalizeZero(current.price / before.price - 1);
          const contribution = normalizeZero(weight * assetReturn);
          contributions.push(
            Object.freeze({
              entityKey,
              weight,
              previousPrice: before.price,
              price: current.price,
              assetReturn,
              contribution,
            }),
          );
        }
      }
      grossObservations.push(
        Object.freeze({
          foldIndex: fold.index,
          decisionIndex: snapshot.execution.record.decisionIndex,
          decisionTime: snapshot.execution.record.decisionTime,
          contributions: Object.freeze(contributions),
          value: normalizeZero(contributions.reduce((sum, item) => sum + item.contribution, 0)),
        }),
      );
    }
  }
  if (grossObservations.length === 0) {
    throw invalidPricing("OOS pricing requires at least one out-of-sample observation");
  }
  return deepFreeze({
    trades: Object.freeze(trades),
    marketData: Object.freeze(marketData),
    grossObservations: Object.freeze(grossObservations),
  });
}

function decisionSnapshot(
  execution: ReplayedExecution,
  declaration: AdapterDeclaration,
  configuration: NormalizedQuantileOosPricingConfiguration,
): DecisionSnapshot {
  const decisionMillis = Date.parse(execution.record.decisionTime);
  const sourceEntity = requiredVector(execution.source, declaration.entityKey, "source entity key");
  const sourceEvent = requiredVector(execution.source, declaration.eventTime, "source event time");
  const sourcePrice = requiredVector(execution.source, configuration.priceColumn, "source price");
  const maskColumn = declaration.guarantees.tradabilityMask;
  const sourceMask =
    maskColumn === null
      ? null
      : requiredVector(execution.source, maskColumn, "source tradability mask");
  const marketVectors = new Map(
    configuration.marketColumns.map((column) => [
      column,
      requiredVector(execution.source, column, `source market column ${column}`),
    ]),
  );
  const market = new Map<string, MarketPoint>();
  for (let row = 0; row < execution.source.numRows; row += 1) {
    if (timeMillis(sourceEvent.get(row), "source event time") !== decisionMillis) continue;
    const entityKey = canonicalEntity(sourceEntity.get(row));
    if (market.has(entityKey)) {
      throw invalidPricing("pricing source contains duplicate entity rows at one decision time");
    }
    const price = positiveNumber(sourcePrice.get(row), "pricing source price");
    const fields: Array<readonly [string, CostModelMarketScalar]> = [];
    for (const column of configuration.marketColumns) {
      const vector = marketVectors.get(column);
      if (vector === undefined) throw invalidPricing("pricing market column is unavailable");
      fields.push([column, marketValue(vector.get(row))]);
    }
    market.set(
      entityKey,
      deepFreeze({
        price,
        fields: Object.fromEntries(fields),
        executable: sourceMask === null || sourceMask.get(row) === true,
      }),
    );
  }
  const outputEntity = requiredVector(
    execution.admitted,
    declaration.entityKey,
    "artifact entity key",
  );
  const signal = requiredVector(execution.admitted, configuration.signalColumn, "artifact signal");
  const size =
    configuration.portfolio.weightColumn === null
      ? null
      : requiredVector(
          execution.admitted,
          configuration.portfolio.weightColumn,
          "artifact portfolio weight",
        );
  const scores = new Map<string, number>();
  const sizes = new Map<string, number>();
  for (let row = 0; row < execution.admitted.numRows; row += 1) {
    const entityKey = canonicalEntity(outputEntity.get(row));
    if (scores.has(entityKey)) {
      throw invalidPricing(
        "artifact output contains duplicate signals for one entity and decision",
      );
    }
    const value = optionalNumber(signal.get(row));
    const rawSize = size === null ? 1 : optionalNumber(size.get(row));
    if (value !== null && size !== null && (rawSize === null || rawSize <= 0)) {
      throw invalidPricing(
        "artifact portfolio weight must be positive whenever its signal is present",
      );
    }
    if (value !== null && rawSize !== null) {
      scores.set(entityKey, value);
      sizes.set(entityKey, rawSize);
    }
  }
  return Object.freeze({ execution, market, scores, sizes });
}

function targetWeights(
  scores: ReadonlyMap<string, number>,
  sizes: ReadonlyMap<string, number>,
  portfolio: NormalizedQuantileOosPricingConfiguration["portfolio"],
): Map<string, number> {
  const ranked = [...scores.entries()].sort(
    ([leftEntity, leftScore], [rightEntity, rightScore]) =>
      rightScore - leftScore || compareText(leftEntity, rightEntity),
  );
  if (ranked.length < (portfolio.kind === "long-only-quantile" ? 1 : 2)) return new Map();
  const bucket = Math.min(
    Math.max(1, Math.floor(ranked.length * portfolio.quantile)),
    portfolio.kind === "long-only-quantile" ? ranked.length : Math.floor(ranked.length / 2),
  );
  const target = new Map<string, number>();
  allocateSide(
    target,
    ranked.slice(0, bucket),
    sizes,
    portfolio.kind === "long-only-quantile" ? 1 : 0.5,
  );
  if (portfolio.kind === "long-short-quantile") {
    const shorts = ranked.slice(-bucket);
    if (shorts.some(([entityKey]) => target.has(entityKey))) {
      throw invalidPricing("long-short quantile construction produced overlapping buckets");
    }
    allocateSide(target, shorts, sizes, -0.5);
  }
  return target;
}

function allocateSide(
  target: Map<string, number>,
  selected: readonly (readonly [string, number])[],
  sizes: ReadonlyMap<string, number>,
  exposure: number,
): void {
  const denominator = selected.reduce((sum, [entityKey]) => sum + (sizes.get(entityKey) ?? 1), 0);
  if (!(denominator > 0)) throw invalidPricing("portfolio side has no positive sizing weight");
  for (const [entityKey] of selected) {
    target.set(entityKey, normalizeZero((exposure * (sizes.get(entityKey) ?? 1)) / denominator));
  }
}

/**
 * Applies the adapter's execution-time tradability mask before constructing the next book.
 * Positions that cannot be traded are carried, while each executable side uses only the gross
 * exposure left after those carried positions. This avoids both impossible halt-day fills and an
 * accidental gross-exposure increase.
 */
function executableTargetWeights(
  scores: ReadonlyMap<string, number>,
  sizes: ReadonlyMap<string, number>,
  market: ReadonlyMap<string, MarketPoint>,
  positions: ReadonlyMap<string, number>,
  portfolio: NormalizedQuantileOosPricingConfiguration["portfolio"],
): Map<string, number> {
  const executableScores = new Map(
    [...scores].filter(([entityKey]) => market.get(entityKey)?.executable === true),
  );
  const executableSizes = new Map(
    [...sizes].filter(([entityKey]) => market.get(entityKey)?.executable === true),
  );
  const executableTarget = targetWeights(executableScores, executableSizes, portfolio);
  const carried = [...positions].filter(
    ([entityKey]) => market.get(entityKey)?.executable !== true,
  );
  const carriedLong = carried.reduce((sum, [, weight]) => sum + (weight > 0 ? weight : 0), 0);
  const carriedShort = carried.reduce(
    (sum, [, weight]) => sum + (weight < 0 ? Math.abs(weight) : 0),
    0,
  );
  const longBudget = portfolio.kind === "long-only-quantile" ? 1 : 0.5;
  const shortBudget = portfolio.kind === "long-only-quantile" ? 0 : 0.5;
  if (carriedLong > longBudget + Number.EPSILON || carriedShort > shortBudget + Number.EPSILON) {
    throw invalidPricing("carried masked positions exceed the locked side exposure");
  }
  const longScale = Math.max(0, longBudget - carriedLong) / longBudget;
  const shortScale = shortBudget === 0 ? 0 : Math.max(0, shortBudget - carriedShort) / shortBudget;
  const target = new Map<string, number>();
  for (const [entityKey, weight] of executableTarget) {
    target.set(entityKey, normalizeZero(weight * (weight > 0 ? longScale : shortScale)));
  }
  for (const [entityKey, weight] of carried) target.set(entityKey, weight);
  return target;
}

function aggregateCosts(
  gross: readonly OosGrossReturnObservation[],
  trades: readonly CostModelTrade[],
  charges: readonly CostModelCharge[],
): readonly OosSeriesObservation[] {
  if (trades.length !== charges.length) {
    throw invalidPricing("cost model charges do not cover the priced trades");
  }
  const byDecision = new Map<string, number>();
  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    const charge = charges[index];
    if (trade === undefined || charge === undefined || charge.tradeId !== trade.tradeId) {
      throw invalidPricing("cost model charge identities differ from the priced trades");
    }
    const key = observationKey(trade.foldIndex, trade.executionDecisionIndex);
    byDecision.set(key, normalizeZero((byDecision.get(key) ?? 0) + charge.cost));
  }
  return Object.freeze(
    gross.map((observation) =>
      Object.freeze({
        foldIndex: observation.foldIndex,
        decisionIndex: observation.decisionIndex,
        decisionTime: observation.decisionTime,
        value:
          byDecision.get(observationKey(observation.foldIndex, observation.decisionIndex)) ?? 0,
      }),
    ),
  );
}

function issueTradesPayload(
  candidateHash: string,
  configuration: NormalizedQuantileOosPricingConfiguration,
  trades: readonly CostModelTrade[],
  marketData: readonly CostModelMarketData[],
): OosPricingTradesPayload {
  const body: TradesBody = {
    format: OOS_PRICING_TRADES_FORMAT,
    candidateHash,
    pricingMethod: QUANTILE_OOS_PRICING_METHOD,
    configuration,
    trades,
    marketData,
  };
  return deepFreeze({ ...body, tradesHash: hashCanonical(OOS_PRICING_TRADES_FORMAT, body) });
}

function issueGrossReturnsPayload(
  candidateHash: string,
  tradesHash: string,
  observations: readonly OosGrossReturnObservation[],
): OosGrossReturnsPayload {
  const body: GrossReturnsBody = {
    format: OOS_GROSS_RETURNS_FORMAT,
    candidateHash,
    tradesHash,
    observations,
  };
  return deepFreeze({
    ...body,
    grossReturnsHash: hashCanonical(OOS_GROSS_RETURNS_FORMAT, body),
  });
}

function issueCostsPayload(
  candidateHash: string,
  tradesHash: string,
  costModel: CostModelDescriptor,
  charges: readonly CostModelCharge[],
  observations: readonly OosSeriesObservation[],
): OosCostsPayload {
  const body: CostsBody = {
    format: OOS_COSTS_FORMAT,
    candidateHash,
    tradesHash,
    costModel,
    charges,
    observations,
  };
  return deepFreeze({ ...body, costsHash: hashCanonical(OOS_COSTS_FORMAT, body) });
}

function issueNetReturnsPayload(
  candidateHash: string,
  grossReturnsHash: string,
  costsHash: string,
  observations: readonly OosSeriesObservation[],
): OosNetReturnsPayload {
  const body: NetReturnsBody = {
    format: OOS_NET_RETURNS_FORMAT,
    candidateHash,
    grossReturnsHash,
    costsHash,
    observations,
  };
  return deepFreeze({ ...body, netReturnsHash: hashCanonical(OOS_NET_RETURNS_FORMAT, body) });
}

function pricingMetrics(
  gross: readonly number[],
  net: readonly number[],
  trades: readonly CostModelTrade[],
  costs: readonly OosSeriesObservation[],
  periodsPerYear: number,
): readonly ExperimentMetric[] {
  const grossSummary = returnMetrics(gross, periodsPerYear);
  const netSummary = returnMetrics(net, periodsPerYear);
  const metrics: ExperimentMetric[] = [];
  for (const [basis, summary] of [
    ["gross", grossSummary],
    ["net", netSummary],
  ] as const) {
    metrics.push(
      metric("annual-return", basis, "decimal", summary.annualReturn),
      metric("annual-volatility", basis, "decimal", summary.annualVolatility),
      metric("max-drawdown", basis, "decimal", summary.maxDrawdown),
      metric("sharpe", basis, "ratio", summary.sharpe),
    );
  }
  const turnover = trades.reduce((sum, trade) => sum + Math.abs(trade.weightChange), 0);
  metrics.push(
    metric("annual-turnover", "gross", "decimal", (turnover * periodsPerYear) / gross.length),
    metric(
      "total-cost",
      "net",
      "decimal",
      costs.reduce((sum, observation) => sum + observation.value, 0),
    ),
  );
  return Object.freeze(metrics);
}

function returnMetrics(
  values: readonly number[],
  periodsPerYear: number,
): {
  readonly annualReturn: number;
  readonly annualVolatility: number;
  readonly sharpe: number;
  readonly maxDrawdown: number;
} {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.length > 1
      ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
      : 0;
  const annualReturn = normalizeZero(mean * periodsPerYear);
  const annualVolatility = normalizeZero(Math.sqrt(variance) * Math.sqrt(periodsPerYear));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of values) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return Object.freeze({
    annualReturn,
    annualVolatility,
    sharpe: annualVolatility > 0 ? normalizeZero(annualReturn / annualVolatility) : 0,
    maxDrawdown: normalizeZero(maxDrawdown),
  });
}

function metric(
  name: string,
  basis: "gross" | "net",
  unit: "decimal" | "ratio",
  value: number,
): ExperimentMetric {
  if (!Number.isFinite(value)) throw invalidPricing(`derived metric ${name} is not finite`);
  return Object.freeze({
    name,
    scope: "walk-forward-oos",
    basis,
    unit,
    value: normalizeZero(value),
  });
}

function normalizeConfiguration(
  input: unknown,
  costModelReference: string,
): NormalizedQuantileOosPricingConfiguration {
  const root = exactRecord(
    input,
    [
      "signalColumn",
      "priceColumn",
      "marketColumns",
      "periodsPerYear",
      "portfolio",
      "capacity",
      "costModelIdentity",
      "pricingMethodIdentity",
    ],
    "OOS pricing configuration",
    true,
  );
  for (const field of [
    "signalColumn",
    "priceColumn",
    "periodsPerYear",
    "portfolio",
    "costModelIdentity",
    "pricingMethodIdentity",
  ]) {
    if (!Object.hasOwn(root, field))
      throw invalidPricing(`OOS pricing configuration lacks ${field}`);
  }
  const signalColumn = fieldName(root.signalColumn, "signal column");
  const priceColumn = fieldName(root.priceColumn, "price column");
  const marketColumns = normalizeMarketColumns(root.marketColumns, priceColumn);
  const periodsPerYear = positiveInteger(root.periodsPerYear, "periods per year");
  const portfolio = exactRecord(
    root.portfolio,
    ["kind", "quantile", "weightColumn"],
    "portfolio configuration",
    true,
  );
  if (!Object.hasOwn(portfolio, "kind") || !Object.hasOwn(portfolio, "quantile")) {
    throw invalidPricing("portfolio configuration lacks kind or quantile");
  }
  if (portfolio.kind !== "long-only-quantile" && portfolio.kind !== "long-short-quantile") {
    throw invalidPricing("OOS pricing supports only long-only or long-short quantile portfolios");
  }
  const quantile = canonicalNumber(portfolio.quantile, "portfolio quantile");
  if (quantile <= 0 || quantile > 0.5) {
    throw invalidPricing("portfolio quantile must be greater than zero and at most 0.5");
  }
  const weightColumn =
    portfolio.weightColumn === undefined || portfolio.weightColumn === null
      ? null
      : fieldName(portfolio.weightColumn, "portfolio weight column");
  const capacity = normalizeCapacity(root.capacity, marketColumns);
  const pricingMethod = exactRecord(
    root.pricingMethodIdentity,
    ["id", "version", "implementationHash"],
    "locked pricing-method identity",
  );
  const pricingMethodIdentity = Object.freeze({
    id: portableId(pricingMethod.id, "locked pricing-method id"),
    version: portableId(pricingMethod.version, "locked pricing-method version"),
    implementationHash: sha256(
      pricingMethod.implementationHash,
      "locked pricing-method implementation hash",
    ),
  });
  if (canonicalJson(pricingMethodIdentity) !== canonicalJson(QUANTILE_OOS_PRICING_METHOD)) {
    throw invalidPricing("artifact pricing-method identity is unsupported by this executor");
  }
  const costModel = exactRecord(
    root.costModelIdentity,
    ["version", "implementationHash", "configurationHash"],
    "locked cost-model identity",
  );
  if (typeof costModelReference !== "string" || costModelReference.length === 0) {
    throw invalidPricing("artifact cost-model reference is invalid");
  }
  const costModelIdentity = Object.freeze({
    version: portableId(costModel.version, "locked cost-model version"),
    implementationHash: sha256(
      costModel.implementationHash,
      "locked cost-model implementation hash",
    ),
    configurationHash: sha256(costModel.configurationHash, "locked cost-model configuration hash"),
  });
  return deepFreeze({
    pricingMethodIdentity,
    signalColumn,
    priceColumn,
    marketColumns,
    periodsPerYear,
    portfolio: { kind: portfolio.kind, quantile, weightColumn },
    capacity,
    costModelIdentity,
  });
}

function normalizeCapacity(
  input: unknown,
  marketColumns: readonly string[],
): NormalizedQuantileOosPricingConfiguration["capacity"] {
  if (input === undefined || input === null) return null;
  const root = exactRecord(
    input,
    ["portfolioNav", "volumeColumn", "maximumParticipationRate"],
    "capacity configuration",
  );
  const portfolioNav = canonicalNumber(root.portfolioNav, "capacity portfolio NAV");
  const volumeColumn = fieldName(root.volumeColumn, "capacity volume column");
  const maximumParticipationRate = canonicalNumber(
    root.maximumParticipationRate,
    "maximum participation rate",
  );
  if (portfolioNav <= 0) throw invalidPricing("capacity portfolio NAV must be positive");
  if (maximumParticipationRate <= 0 || maximumParticipationRate > 1) {
    throw invalidPricing("maximum participation rate must be greater than zero and at most one");
  }
  if (!marketColumns.includes(volumeColumn)) {
    throw invalidPricing("capacity volume column must also appear in marketColumns");
  }
  return Object.freeze({ portfolioNav, volumeColumn, maximumParticipationRate });
}

function normalizeMarketColumns(input: unknown, priceColumn: string): readonly string[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > 64) {
    throw invalidPricing("market columns must be an array of at most 64 field names");
  }
  const columns = input.map((column) => fieldName(column, "market column")).sort(compareText);
  if (columns.includes(priceColumn) || new Set(columns).size !== columns.length) {
    throw invalidPricing("market columns must be unique and exclude the price column");
  }
  return Object.freeze(columns);
}

function sameObservationIdentity(
  left: Pick<OosGrossReturnObservation, "foldIndex" | "decisionIndex" | "decisionTime">,
  right: Pick<OosSeriesObservation, "foldIndex" | "decisionIndex" | "decisionTime">,
): boolean {
  return (
    left.foldIndex === right.foldIndex &&
    left.decisionIndex === right.decisionIndex &&
    left.decisionTime === right.decisionTime
  );
}

function observationKey(foldIndex: number, decisionIndex: number): string {
  return `${foldIndex}:${decisionIndex}`;
}

function requiredVector(table: Table, name: string, field: string): Vector {
  const vector = table.getChild(name);
  if (vector === null) throw invalidPricing(`${field} column ${name} is missing`);
  return vector;
}

function decodeArrow(input: Uint8Array, field: string): Table {
  try {
    return tableFromIPC(input);
  } catch {
    throw invalidPricing(`${field} is unreadable Arrow IPC`);
  }
}

function nonemptyArrow(input: unknown, field: string): Uint8Array {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw invalidPricing(`${field} must be non-empty Arrow IPC`);
  }
  return input;
}

function optionalNumber(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? normalizeZero(input) : null;
  if (
    typeof input === "bigint" &&
    input <= BigInt(Number.MAX_SAFE_INTEGER) &&
    input >= BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return Number(input);
  }
  return null;
}

function positiveNumber(input: unknown, field: string): number {
  const value = optionalNumber(input);
  if (value === null || value <= 0)
    throw invalidPricing(`${field} must be a positive finite number`);
  return value;
}

function marketValue(input: unknown): CostModelMarketScalar {
  if (input === null || typeof input === "boolean" || typeof input === "string") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw invalidPricing("cost-model market data contains a non-canonical number");
    }
    return input;
  }
  if (typeof input === "bigint") {
    if (input <= BigInt(Number.MAX_SAFE_INTEGER) && input >= BigInt(Number.MIN_SAFE_INTEGER)) {
      return Number(input);
    }
    return `bigint:${input.toString()}`;
  }
  if (input instanceof Date && Number.isFinite(input.valueOf())) return input.toISOString();
  if (input instanceof Uint8Array) return `base64:${Buffer.from(input).toString("base64")}`;
  throw invalidPricing("cost-model market data contains an unsupported Arrow scalar");
}

function canonicalEntity(input: unknown): string {
  if (typeof input === "string") return `string:${JSON.stringify(input)}`;
  if (typeof input === "boolean") return `boolean:${input}`;
  if (typeof input === "bigint") return `bigint:${input.toString()}`;
  if (typeof input === "number" && Number.isFinite(input) && !Object.is(input, -0)) {
    return `number:${input}`;
  }
  if (input instanceof Date && Number.isFinite(input.valueOf())) return `date:${input.valueOf()}`;
  if (input instanceof Uint8Array) return `bytes:${Buffer.from(input).toString("base64")}`;
  throw invalidPricing("pricing evidence contains an invalid entity key");
}

function timeMillis(input: unknown, field: string): number {
  const value =
    input instanceof Date
      ? input.valueOf()
      : typeof input === "number"
        ? input
        : typeof input === "string"
          ? Date.parse(input)
          : Number.NaN;
  if (!Number.isFinite(value)) throw invalidPricing(`${field} contains an invalid timestamp`);
  return value;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw invalidPricing(`${field} must be a plain object`);
  const allowed = new Set(keys);
  const actual = Object.keys(input);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && keys.some((key) => !actual.includes(key)))
  ) {
    throw invalidPricing(`${field} has missing or unknown fields`);
  }
  return input;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function fieldName(input: unknown, field: string): string {
  if (typeof input !== "string" || !FIELD_NAME.test(input)) {
    throw invalidPricing(`${field} must be a portable field name`);
  }
  return input;
}

function portableId(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(input)) {
    throw invalidPricing(`${field} must be a portable identifier`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidPricing(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw invalidPricing(`${field} must be a positive safe integer`);
  }
  return input;
}

function canonicalNumber(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || Object.is(input, -0)) {
    throw invalidPricing(`${field} must be a canonical finite number`);
  }
  return input;
}

function hashBytes(input: Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
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
      throw invalidPricing("pricing evidence contains a non-canonical number");
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
  throw invalidPricing("pricing evidence contains an unsupported value");
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

function invalidPricing(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_OOS_PRICING",
    message,
    "Replay the complete retained contract evidence with explicit signal, price, and registered cost-model semantics.",
  );
}
