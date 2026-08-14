import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { EngineConfigurationError } from "./errors.ts";

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_CONFIGURATION_DEPTH = 32;
const MAX_CONFIGURATION_ENTRIES = 4_096;
const LINEAR_BPS_METHOD_FORMAT = "veil.cost-model.linear-bps.v0" as const;
const HONG_KONG_EQUITY_METHOD_FORMAT = "veil.cost-model.hong-kong-equity.v0" as const;
const CRYPTO_FUTURES_METHOD_FORMAT = "veil.cost-model.crypto-futures.v0" as const;

export type CostModelConfigurationValue =
  | null
  | boolean
  | number
  | string
  | readonly CostModelConfigurationValue[]
  | { readonly [key: string]: CostModelConfigurationValue };

export type CostModelMarketScalar = null | boolean | number | string;

export interface CostModelTrade {
  readonly tradeId: string;
  readonly foldIndex: number;
  readonly signalDecisionIndex: number;
  readonly executionDecisionIndex: number;
  readonly signalTime: string;
  readonly executionTime: string;
  readonly entityKey: string;
  readonly previousWeight: number;
  readonly targetWeight: number;
  readonly weightChange: number;
}

export interface CostModelMarketData {
  readonly tradeId: string;
  readonly price: number;
  readonly fields: Readonly<Record<string, CostModelMarketScalar>>;
}

export interface CostModelCharge {
  readonly tradeId: string;
  /** Fraction of portfolio NAV charged for this trade. Must be finite and non-negative. */
  readonly cost: number;
}

export interface CostModelExecutionInput {
  readonly trades: readonly CostModelTrade[];
  readonly marketData: readonly CostModelMarketData[];
  readonly configuration: CostModelConfigurationValue;
}

export interface CostModelExecutionResult {
  readonly charges: readonly CostModelCharge[];
}

export interface CostModelDescriptor {
  readonly reference: string;
  readonly version: string;
  readonly implementationHash: string;
  readonly configurationHash: string;
}

export interface CostModelProviderInput {
  /** Logical reference frozen into the artifact and promotion candidate. */
  readonly reference: string;
  readonly version: string;
  /** Content identity of the implementation, supplied by the plugin package. */
  readonly implementationHash: string;
  /** Immutable model parameters. Only their hash leaves the provider boundary. */
  readonly configuration: CostModelConfigurationValue;
  evaluate(
    input: CostModelExecutionInput,
  ): CostModelExecutionResult | Promise<CostModelExecutionResult>;
}

export interface CreateLinearBpsCostModelInput {
  readonly reference: string;
  readonly basisPoints: number;
}

export interface CreateHongKongEquityCostModelInput {
  readonly reference: string;
  readonly commissionBps: number;
  readonly tradingFeeBps: number;
  readonly transactionLevyBps: number;
  readonly stampDutyBps: number;
}

export interface CreateCryptoFuturesCostModelInput {
  readonly reference: string;
  readonly takerFeeBps: number;
  readonly slippageBps: number;
}

interface CostModelProviderState {
  readonly descriptor: CostModelDescriptor;
  readonly configuration: CostModelConfigurationValue;
  readonly evaluate: CostModelProviderInput["evaluate"];
}

interface ExecuteRegisteredCostModelInput {
  readonly trades: readonly CostModelTrade[];
  readonly marketData: readonly CostModelMarketData[];
}

export interface RegisteredCostModelExecution {
  readonly descriptor: CostModelDescriptor;
  readonly charges: readonly CostModelCharge[];
}

const PROVIDER_STATES = new WeakMap<CostModelProvider, CostModelProviderState>();
const REGISTRY_PROVIDERS = new WeakMap<CostModelRegistry, Map<string, CostModelProvider>>();

/** Opaque trusted capability. Callback code and raw configuration are absent from JSON. */
export class CostModelProvider {
  readonly reference: string;

  private constructor(reference: string, state: CostModelProviderState) {
    this.reference = reference;
    PROVIDER_STATES.set(this, state);
    Object.freeze(this);
  }

  static create(input: CostModelProviderInput): CostModelProvider {
    if (
      !isPlainRecord(input) ||
      !hasExactKeys(input, [
        "reference",
        "version",
        "implementationHash",
        "configuration",
        "evaluate",
      ])
    ) {
      throw invalidCostModel("cost model provider input has missing or unknown fields");
    }
    const reference = portableId(input.reference, "cost model reference");
    const version = portableId(input.version, "cost model version");
    const implementationHash = sha256(input.implementationHash, "cost model implementation hash");
    if (typeof input.evaluate !== "function") {
      throw invalidCostModel("cost model provider must implement evaluate()");
    }
    const configuration = normalizeConfiguration(input.configuration);
    const descriptor = deepFreeze({
      reference,
      version,
      implementationHash,
      configurationHash: hashCanonical("veil.cost-model-configuration.v0", configuration),
    });
    return new CostModelProvider(reference, {
      descriptor,
      configuration,
      evaluate: input.evaluate,
    });
  }

  toJSON(): CostModelDescriptor {
    return cloneDescriptor(providerState(this).descriptor);
  }

  [inspect.custom](): string {
    return `CostModelProvider ${JSON.stringify(this.toJSON())}`;
  }
}

export function createCostModelProvider(input: CostModelProviderInput): CostModelProvider {
  return CostModelProvider.create(input);
}

export class CostModelRegistry {
  constructor() {
    REGISTRY_PROVIDERS.set(this, new Map());
  }

  register(provider: CostModelProvider): void {
    providerState(provider);
    const providers = registryProviders(this);
    if (providers.has(provider.reference)) {
      throw new EngineConfigurationError(
        "DUPLICATE_COST_MODEL",
        `cost model ${provider.reference} is already registered`,
        "Register each logical cost-model reference exactly once.",
      );
    }
    providers.set(provider.reference, provider);
  }

  list(): readonly CostModelDescriptor[] {
    return Object.freeze(
      [...registryProviders(this).values()]
        .map((provider) => provider.toJSON())
        .sort((left, right) => compareText(left.reference, right.reference)),
    );
  }
}

/** A deterministic turnover model: `abs(weight change) * basisPoints / 10_000`. */
export function createLinearBpsCostModel(input: CreateLinearBpsCostModelInput): CostModelProvider {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["reference", "basisPoints"])) {
    throw invalidCostModel("linear-bps cost model input has missing or unknown fields");
  }
  const basisPoints = canonicalNumber(input.basisPoints, "linear-bps basis points");
  if (basisPoints < 0 || basisPoints > 10_000) {
    throw invalidCostModel("linear-bps basis points must be between 0 and 10000");
  }
  return createCostModelProvider({
    reference: portableId(input.reference, "linear-bps cost model reference"),
    version: "0.1.0",
    implementationHash: hashCanonical(LINEAR_BPS_METHOD_FORMAT, {
      formula: "abs-weight-change-times-basis-points-over-10000",
      outputUnit: "portfolio-nav-fraction",
    }),
    configuration: { basisPoints },
    evaluate: ({ trades, configuration }) => {
      const config = configuration as Readonly<{ basisPoints: number }>;
      return {
        charges: trades.map((trade) => ({
          tradeId: trade.tradeId,
          cost: normalizeZero((Math.abs(trade.weightChange) * config.basisPoints) / 10_000),
        })),
      };
    },
  });
}

/** Hong Kong cash-equity schedule with buy-side stamp duty and two-sided exchange charges. */
export function createHongKongEquityCostModel(
  input: CreateHongKongEquityCostModelInput,
): CostModelProvider {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      "reference",
      "commissionBps",
      "tradingFeeBps",
      "transactionLevyBps",
      "stampDutyBps",
    ])
  ) {
    throw invalidCostModel("Hong Kong equity cost model input has missing or unknown fields");
  }
  const configuration = {
    commissionBps: boundedBps(input.commissionBps, "Hong Kong commission"),
    tradingFeeBps: boundedBps(input.tradingFeeBps, "Hong Kong trading fee"),
    transactionLevyBps: boundedBps(input.transactionLevyBps, "Hong Kong transaction levy"),
    stampDutyBps: boundedBps(input.stampDutyBps, "Hong Kong stamp duty"),
  };
  return createCostModelProvider({
    reference: portableId(input.reference, "Hong Kong equity cost model reference"),
    version: "0.1.0",
    implementationHash: hashCanonical(HONG_KONG_EQUITY_METHOD_FORMAT, {
      formula:
        "abs-weight-change-times-two-sided-fees-plus-positive-weight-change-times-stamp-duty",
      outputUnit: "portfolio-nav-fraction",
    }),
    configuration,
    evaluate: ({ trades, configuration: rawConfiguration }) => {
      const config = rawConfiguration as Readonly<typeof configuration>;
      const twoSided = config.commissionBps + config.tradingFeeBps + config.transactionLevyBps;
      return {
        charges: trades.map((trade) => ({
          tradeId: trade.tradeId,
          cost: normalizeZero(
            (Math.abs(trade.weightChange) * twoSided +
              Math.max(0, trade.weightChange) * config.stampDutyBps) /
              10_000,
          ),
        })),
      };
    },
  });
}

/** Crypto-futures taker execution with an explicit deterministic slippage allowance. */
export function createCryptoFuturesCostModel(
  input: CreateCryptoFuturesCostModelInput,
): CostModelProvider {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["reference", "takerFeeBps", "slippageBps"])) {
    throw invalidCostModel("crypto futures cost model input has missing or unknown fields");
  }
  const configuration = {
    takerFeeBps: boundedBps(input.takerFeeBps, "crypto futures taker fee"),
    slippageBps: boundedBps(input.slippageBps, "crypto futures slippage"),
  };
  return createCostModelProvider({
    reference: portableId(input.reference, "crypto futures cost model reference"),
    version: "0.1.0",
    implementationHash: hashCanonical(CRYPTO_FUTURES_METHOD_FORMAT, {
      formula: "abs-weight-change-times-taker-fee-plus-slippage",
      outputUnit: "portfolio-nav-fraction",
    }),
    configuration,
    evaluate: ({ trades, configuration: rawConfiguration }) => {
      const config = rawConfiguration as Readonly<typeof configuration>;
      const totalBps = config.takerFeeBps + config.slippageBps;
      return {
        charges: trades.map((trade) => ({
          tradeId: trade.tradeId,
          cost: normalizeZero((Math.abs(trade.weightChange) * totalBps) / 10_000),
        })),
      };
    },
  });
}

/** Validated execution surface used by pricing and by plugin conformance tests. */
export async function executeRegisteredCostModel(
  registry: CostModelRegistry,
  referenceInput: string,
  input: ExecuteRegisteredCostModelInput,
): Promise<RegisteredCostModelExecution> {
  const reference = portableId(referenceInput, "cost model reference");
  const provider = registryProviders(registry).get(reference);
  if (provider === undefined) {
    throw new EngineConfigurationError(
      "COST_MODEL_NOT_FOUND",
      `cost model ${reference} is not registered`,
      "Register the exact cost-model reference frozen into the promotion candidate.",
    );
  }
  const state = providerState(provider);
  const executionInput = normalizeExecutionInput(input, state.configuration);
  let output: CostModelExecutionResult;
  try {
    output = await state.evaluate(executionInput);
  } catch {
    throw new EngineConfigurationError(
      "COST_MODEL_EXECUTION_FAILED",
      `cost model ${reference} failed while pricing trades`,
      "Inspect the trusted cost model's private diagnostics and rerun the same immutable trades.",
    );
  }
  return deepFreeze({
    descriptor: cloneDescriptor(state.descriptor),
    charges: normalizeCharges(output, executionInput.trades),
  });
}

function normalizeExecutionInput(
  input: ExecuteRegisteredCostModelInput,
  configuration: CostModelConfigurationValue,
): CostModelExecutionInput {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["trades", "marketData"])) {
    throw invalidCostModel("cost model execution input has missing or unknown fields");
  }
  if (!Array.isArray(input.trades) || !Array.isArray(input.marketData)) {
    throw invalidCostModel("cost model execution requires trade and market-data arrays");
  }
  const trades = Object.freeze(input.trades.map((trade, index) => normalizeTrade(trade, index)));
  const marketData = Object.freeze(
    input.marketData.map((market, index) => normalizeMarketData(market, index)),
  );
  if (marketData.length !== trades.length) {
    throw invalidCostModel("cost model market data must cover every trade exactly once");
  }
  for (let index = 0; index < trades.length; index += 1) {
    if (marketData[index]?.tradeId !== trades[index]?.tradeId) {
      throw invalidCostModel("cost model market data must follow canonical trade order");
    }
  }
  return deepFreeze({ trades, marketData, configuration });
}

function normalizeTrade(input: unknown, index: number): CostModelTrade {
  const root = exactRecord(
    input,
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
    `cost model trade ${index}`,
  );
  const previousWeight = canonicalNumber(root.previousWeight, `trade ${index} previous weight`);
  const targetWeight = canonicalNumber(root.targetWeight, `trade ${index} target weight`);
  const weightChange = canonicalNumber(root.weightChange, `trade ${index} weight change`);
  if (!Object.is(normalizeZero(targetWeight - previousWeight), weightChange)) {
    throw invalidCostModel(`trade ${index} weight change is inconsistent`);
  }
  return deepFreeze({
    tradeId: sha256(root.tradeId, `trade ${index} id`),
    foldIndex: nonnegativeInteger(root.foldIndex, `trade ${index} fold index`),
    signalDecisionIndex: nonnegativeInteger(
      root.signalDecisionIndex,
      `trade ${index} signal decision index`,
    ),
    executionDecisionIndex: nonnegativeInteger(
      root.executionDecisionIndex,
      `trade ${index} execution decision index`,
    ),
    signalTime: canonicalTime(root.signalTime, `trade ${index} signal time`),
    executionTime: canonicalTime(root.executionTime, `trade ${index} execution time`),
    entityKey: boundedString(root.entityKey, `trade ${index} entity key`, 16_384),
    previousWeight,
    targetWeight,
    weightChange,
  });
}

function normalizeMarketData(input: unknown, index: number): CostModelMarketData {
  const root = exactRecord(input, ["tradeId", "price", "fields"], `cost model market row ${index}`);
  const price = canonicalNumber(root.price, `market row ${index} price`);
  if (price <= 0) throw invalidCostModel(`market row ${index} price must be positive`);
  if (!isPlainRecord(root.fields)) {
    throw invalidCostModel(`market row ${index} fields must be a plain object`);
  }
  const fields: Array<readonly [string, CostModelMarketScalar]> = [];
  for (const name of Object.keys(root.fields).sort(compareText)) {
    fields.push([
      portableField(name, `market row ${index} field`),
      marketScalar(root.fields[name]),
    ]);
  }
  return deepFreeze({
    tradeId: sha256(root.tradeId, `market row ${index} trade id`),
    price,
    fields: Object.fromEntries(fields),
  });
}

function normalizeCharges(
  input: unknown,
  trades: readonly CostModelTrade[],
): readonly CostModelCharge[] {
  const root = exactRecord(input, ["charges"], "cost model result");
  if (!Array.isArray(root.charges) || root.charges.length !== trades.length) {
    throw invalidCostModel("cost model must return exactly one charge per trade");
  }
  return Object.freeze(
    root.charges.map((charge, index) => {
      const item = exactRecord(charge, ["tradeId", "cost"], `cost model charge ${index}`);
      const tradeId = sha256(item.tradeId, `cost model charge ${index} trade id`);
      if (tradeId !== trades[index]?.tradeId) {
        throw invalidCostModel("cost model charges must follow canonical trade order");
      }
      const cost = canonicalNumber(item.cost, `cost model charge ${index} cost`);
      if (cost < 0) throw invalidCostModel("cost model charges cannot be negative");
      return Object.freeze({ tradeId, cost });
    }),
  );
}

function normalizeConfiguration(input: unknown): CostModelConfigurationValue {
  const entries = { count: 0 };
  return deepFreeze(normalizeConfigurationValue(input, new WeakSet(), 0, entries));
}

function normalizeConfigurationValue(
  input: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  entries: { count: number },
): CostModelConfigurationValue {
  entries.count += 1;
  if (depth > MAX_CONFIGURATION_DEPTH || entries.count > MAX_CONFIGURATION_ENTRIES) {
    throw invalidCostModel("cost model configuration exceeds its structural limits");
  }
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") return canonicalNumber(input, "cost model configuration number");
  if (typeof input === "string")
    return boundedString(input, "cost model configuration string", 4096);
  if (typeof input !== "object") {
    throw invalidCostModel("cost model configuration must be canonical JSON data");
  }
  if (ancestors.has(input)) throw invalidCostModel("cost model configuration contains a cycle");
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return Object.freeze(
        input.map((value) => normalizeConfigurationValue(value, ancestors, depth + 1, entries)),
      );
    }
    if (!isPlainRecord(input)) {
      throw invalidCostModel("cost model configuration must use plain objects");
    }
    return Object.freeze(
      Object.fromEntries(
        Object.keys(input)
          .sort(compareText)
          .map((key) => [
            portableField(key, "cost model configuration key"),
            normalizeConfigurationValue(input[key], ancestors, depth + 1, entries),
          ]),
      ),
    );
  } finally {
    ancestors.delete(input);
  }
}

function providerState(provider: CostModelProvider): CostModelProviderState {
  const state = PROVIDER_STATES.get(provider);
  if (state === undefined) {
    throw invalidCostModel("cost model provider was not created by this engine instance");
  }
  return state;
}

function registryProviders(registry: CostModelRegistry): Map<string, CostModelProvider> {
  const providers = REGISTRY_PROVIDERS.get(registry);
  if (providers === undefined) {
    throw invalidCostModel("cost model registry was not created by this engine instance");
  }
  return providers;
}

function cloneDescriptor(input: CostModelDescriptor): CostModelDescriptor {
  return Object.freeze({ ...input });
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isPlainRecord(input) || !hasExactKeys(input, keys)) {
    throw invalidCostModel(`${field} has missing or unknown fields`);
  }
  return input;
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(input);
  const allowed = new Set(keys);
  return actual.length === keys.length && actual.every((key) => allowed.has(key));
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function portableId(input: unknown, field: string): string {
  if (typeof input !== "string" || !PORTABLE_ID.test(input)) {
    throw invalidCostModel(`${field} must be a portable identifier`);
  }
  return input;
}

function portableField(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(input)) {
    throw invalidCostModel(`${field} must be a portable field name`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidCostModel(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidCostModel(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function canonicalNumber(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || Object.is(input, -0)) {
    throw invalidCostModel(`${field} must be a canonical finite number`);
  }
  return input;
}

function boundedBps(input: unknown, field: string): number {
  const value = canonicalNumber(input, `${field} basis points`);
  if (value < 0 || value > 10_000) {
    throw invalidCostModel(`${field} basis points must be between 0 and 10000`);
  }
  return value;
}

function canonicalTime(input: unknown, field: string): string {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input))) {
    throw invalidCostModel(`${field} must be a canonical UTC instant`);
  }
  const normalized = new Date(Date.parse(input)).toISOString();
  if (normalized !== input) throw invalidCostModel(`${field} must be a canonical UTC instant`);
  return input;
}

function boundedString(input: unknown, field: string, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum ||
    [...input].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    })
  ) {
    throw invalidCostModel(`${field} must be bounded printable text`);
  }
  return input;
}

function marketScalar(input: unknown): CostModelMarketScalar {
  if (input === null || typeof input === "boolean" || typeof input === "string") return input;
  return canonicalNumber(input, "cost model market scalar");
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
      throw invalidCostModel("cost model content contains a non-canonical number");
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
  throw invalidCostModel("cost model content contains an unsupported value");
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

function invalidCostModel(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_COST_MODEL",
    message,
    "Register a deterministic cost model with immutable configuration and one non-negative charge per trade.",
  );
}
