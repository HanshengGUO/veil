import { createHash } from "node:crypto";
import { inspect } from "node:util";
import type { CostModelConfigurationValue } from "./cost-model.ts";
import { EngineConfigurationError } from "./errors.ts";

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CENTERED_BLOCK_BOOTSTRAP_FORMAT = "veil.null-generator.centered-block-bootstrap.v0";

export interface NullGeneratorDescriptor {
  readonly reference: string;
  readonly version: string;
  readonly implementationHash: string;
  readonly configurationHash: string;
}

export interface NullGeneratorExecutionInput {
  readonly observedReturns: readonly number[];
  readonly configuration: CostModelConfigurationValue;
}

export interface NullGeneratorExecutionResult {
  readonly samples: readonly (readonly number[])[];
}

export interface NullGeneratorProviderInput {
  readonly reference: string;
  readonly version: string;
  readonly implementationHash: string;
  readonly configuration: CostModelConfigurationValue;
  generate(
    input: NullGeneratorExecutionInput,
  ): NullGeneratorExecutionResult | Promise<NullGeneratorExecutionResult>;
}

export interface CreateCenteredBlockBootstrapNullGeneratorInput {
  readonly reference: string;
  readonly replications: number;
  readonly blockLength: number;
  readonly seed: number;
}

interface NullGeneratorProviderState {
  readonly descriptor: NullGeneratorDescriptor;
  readonly configuration: CostModelConfigurationValue;
  readonly generate: NullGeneratorProviderInput["generate"];
}

export interface RegisteredNullGeneration {
  readonly descriptor: NullGeneratorDescriptor;
  readonly samples: readonly (readonly number[])[];
}

const PROVIDER_STATES = new WeakMap<NullGeneratorProvider, NullGeneratorProviderState>();
const REGISTRY_PROVIDERS = new WeakMap<NullGeneratorRegistry, Map<string, NullGeneratorProvider>>();

/** Opaque null-generation capability; raw configuration and callback code remain private. */
export class NullGeneratorProvider {
  readonly reference: string;

  private constructor(reference: string, state: NullGeneratorProviderState) {
    this.reference = reference;
    PROVIDER_STATES.set(this, state);
    Object.freeze(this);
  }

  static create(input: NullGeneratorProviderInput): NullGeneratorProvider {
    if (
      !isPlainRecord(input) ||
      !hasExactKeys(input, [
        "reference",
        "version",
        "implementationHash",
        "configuration",
        "generate",
      ])
    ) {
      throw invalidNull("null-generator provider input has missing or unknown fields");
    }
    if (typeof input.generate !== "function") {
      throw invalidNull("null-generator provider must implement generate()");
    }
    const configuration = normalizeConfiguration(input.configuration);
    const descriptor = deepFreeze({
      reference: portableId(input.reference, "null-generator reference"),
      version: portableId(input.version, "null-generator version"),
      implementationHash: sha256(input.implementationHash, "null-generator implementation hash"),
      configurationHash: hashCanonical("veil.null-generator-configuration.v0", configuration),
    });
    return new NullGeneratorProvider(descriptor.reference, {
      descriptor,
      configuration,
      generate: input.generate,
    });
  }

  toJSON(): NullGeneratorDescriptor {
    return Object.freeze({ ...providerState(this).descriptor });
  }

  [inspect.custom](): string {
    return `NullGeneratorProvider ${JSON.stringify(this.toJSON())}`;
  }
}

export function createNullGeneratorProvider(
  input: NullGeneratorProviderInput,
): NullGeneratorProvider {
  return NullGeneratorProvider.create(input);
}

export class NullGeneratorRegistry {
  constructor() {
    REGISTRY_PROVIDERS.set(this, new Map());
  }

  register(provider: NullGeneratorProvider): void {
    providerState(provider);
    const providers = registryProviders(this);
    if (providers.has(provider.reference)) {
      throw new EngineConfigurationError(
        "DUPLICATE_NULL_GENERATOR",
        `null generator ${provider.reference} is already registered`,
        "Register each logical null-generator reference exactly once.",
      );
    }
    providers.set(provider.reference, provider);
  }

  list(): readonly NullGeneratorDescriptor[] {
    return Object.freeze(
      [...registryProviders(this).values()]
        .map((provider) => provider.toJSON())
        .sort((left, right) => compareText(left.reference, right.reference)),
    );
  }
}

/** Deterministic circular block bootstrap after removing the observed sample mean. */
export function createCenteredBlockBootstrapNullGenerator(
  input: CreateCenteredBlockBootstrapNullGeneratorInput,
): NullGeneratorProvider {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ["reference", "replications", "blockLength", "seed"])
  ) {
    throw invalidNull("centered block-bootstrap input has missing or unknown fields");
  }
  const replications = boundedInteger(input.replications, "null replications", 32, 10_000);
  const blockLength = boundedInteger(input.blockLength, "null block length", 1, 100_000);
  const seed = boundedInteger(input.seed, "null seed", 1, 0xffff_ffff);
  return createNullGeneratorProvider({
    reference: portableId(input.reference, "null-generator reference"),
    version: "0.1.0",
    implementationHash: hashCanonical(CENTERED_BLOCK_BOOTSTRAP_FORMAT, {
      centering: "arithmetic-sample-mean",
      sampling: "circular-fixed-length-blocks",
      prng: "mulberry32-v1",
    }),
    configuration: { blockLength, replications, seed },
    generate: ({ observedReturns, configuration }) => {
      const config = configuration as Readonly<{
        blockLength: number;
        replications: number;
        seed: number;
      }>;
      const mean = observedReturns.reduce((sum, value) => sum + value, 0) / observedReturns.length;
      const centered = observedReturns.map((value) => normalizeZero(value - mean));
      const random = mulberry32(config.seed);
      const samples: number[][] = [];
      for (let replication = 0; replication < config.replications; replication += 1) {
        const sample: number[] = [];
        while (sample.length < centered.length) {
          const start = Math.floor(random() * centered.length);
          for (
            let offset = 0;
            offset < config.blockLength && sample.length < centered.length;
            offset += 1
          ) {
            sample.push(centered[(start + offset) % centered.length] ?? 0);
          }
        }
        samples.push(sample);
      }
      return { samples };
    },
  });
}

/** Validated execution surface used by gates and by plugin conformance tests. */
export async function executeRegisteredNullGenerator(
  registry: NullGeneratorRegistry,
  referenceInput: string,
  observedReturnsInput: readonly number[],
): Promise<RegisteredNullGeneration> {
  const reference = portableId(referenceInput, "null-generator reference");
  const provider = registryProviders(registry).get(reference);
  if (provider === undefined) {
    throw new EngineConfigurationError(
      "NULL_GENERATOR_NOT_FOUND",
      `null generator ${reference} is not registered`,
      "Register the locked null generator or record the optional null gate as unavailable.",
    );
  }
  const observedReturns = normalizeReturns(observedReturnsInput, "observed return series");
  const state = providerState(provider);
  let result: NullGeneratorExecutionResult;
  try {
    result = await state.generate(
      deepFreeze({ observedReturns, configuration: state.configuration }),
    );
  } catch {
    throw new EngineConfigurationError(
      "NULL_GENERATOR_EXECUTION_FAILED",
      `null generator ${reference} failed`,
      "Inspect the trusted generator's private diagnostics and rerun the immutable pricing series.",
    );
  }
  const root = exactRecord(result, ["samples"], "null-generator result");
  if (!Array.isArray(root.samples) || root.samples.length < 32 || root.samples.length > 10_000) {
    throw invalidNull("null generator must return between 32 and 10000 samples");
  }
  const samples = Object.freeze(
    root.samples.map((sample, index) => {
      const normalized = normalizeReturns(sample, `null sample ${index}`);
      if (normalized.length !== observedReturns.length) {
        throw invalidNull("every null sample must match the observed series length");
      }
      return normalized;
    }),
  );
  return deepFreeze({ descriptor: state.descriptor, samples });
}

function normalizeReturns(input: unknown, field: string): readonly number[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1_000_000) {
    throw invalidNull(`${field} must be a non-empty bounded array`);
  }
  return Object.freeze(
    input.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
        throw invalidNull(`${field} contains a non-canonical return`);
      }
      return value;
    }),
  );
}

function normalizeConfiguration(input: unknown): CostModelConfigurationValue {
  return deepFreeze(normalizeConfigurationValue(input, new WeakSet(), 0));
}

function normalizeConfigurationValue(
  input: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): CostModelConfigurationValue {
  if (depth > 32) throw invalidNull("null-generator configuration is too deeply nested");
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw invalidNull("null-generator configuration contains a non-canonical number");
    }
    return input;
  }
  if (typeof input === "string") {
    if (
      input.length === 0 ||
      input.length > 4096 ||
      [...input].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      })
    ) {
      throw invalidNull("null-generator configuration contains invalid text");
    }
    return input;
  }
  if (typeof input !== "object" || ancestors.has(input)) {
    throw invalidNull("null-generator configuration must be acyclic canonical JSON");
  }
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return Object.freeze(
        input.map((value) => normalizeConfigurationValue(value, ancestors, depth + 1)),
      );
    }
    if (!isPlainRecord(input)) {
      throw invalidNull("null-generator configuration must use plain objects");
    }
    return Object.freeze(
      Object.fromEntries(
        Object.keys(input)
          .sort(compareText)
          .map((key) => {
            if (!/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(key)) {
              throw invalidNull("null-generator configuration keys must be portable");
            }
            return [key, normalizeConfigurationValue(input[key], ancestors, depth + 1)];
          }),
      ),
    );
  } finally {
    ancestors.delete(input);
  }
}

function providerState(provider: NullGeneratorProvider): NullGeneratorProviderState {
  const state = PROVIDER_STATES.get(provider);
  if (state === undefined) {
    throw invalidNull("null-generator provider was not created by this engine instance");
  }
  return state;
}

function registryProviders(registry: NullGeneratorRegistry): Map<string, NullGeneratorProvider> {
  const providers = REGISTRY_PROVIDERS.get(registry);
  if (providers === undefined) {
    throw invalidNull("null-generator registry was not created by this engine instance");
  }
  return providers;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isPlainRecord(input) || !hasExactKeys(input, keys)) {
    throw invalidNull(`${field} has missing or unknown fields`);
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
    throw invalidNull(`${field} must be a portable identifier`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidNull(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function boundedInteger(input: unknown, field: string, minimum: number, maximum: number): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  ) {
    throw invalidNull(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return input;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
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
      throw invalidNull("null-generator content contains a non-canonical number");
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
  throw invalidNull("null-generator content contains an unsupported value");
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

function invalidNull(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_NULL_GENERATOR",
    message,
    "Register a deterministic bounded null generator that returns finite series aligned to pricing evidence.",
  );
}
