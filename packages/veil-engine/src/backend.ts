import type { AdapterSource } from "@veilquant/contract";
import { EngineConfigurationError } from "./errors.ts";
import {
  type ResolvedSourceBinding,
  resolveSourceBinding,
  type SourceBinding,
} from "./source-binding.ts";
import type { TemporalReadPlan } from "./temporal-plan.ts";

export interface BackendCapabilities {
  /** Performance hints only. The guard never turns these into trust. */
  readonly projectionPushdown: boolean;
  readonly temporalPredicatePushdown: boolean;
  readonly sourceFingerprint: "content-hash" | "version-token" | "none";
  readonly readOnly: boolean;
}

export interface SourceFingerprint {
  readonly algorithm: string;
  readonly value: string;
  readonly scope: "source-version" | "read-snapshot";
}

export interface BackendRuntime {
  /** Non-secret implementation identity recorded in read-set manifests. */
  readonly name: string;
  readonly version: string;
}

export interface BackendPushdownReport {
  readonly projectionApplied: boolean;
  readonly temporalPredicateApplied: boolean;
}

export interface BackendReadRequest {
  readonly source: AdapterSource;
  readonly plan: TemporalReadPlan;
  readonly binding: ResolvedSourceBinding;
}

export interface BackendReadResult {
  /** Arrow IPC stream/file bytes are the only data-plane boundary exposed to the guard. */
  readonly arrowIpc: Uint8Array;
  readonly sourceFingerprint: SourceFingerprint | null;
  readonly runtime: BackendRuntime | null;
  readonly pushdown: BackendPushdownReport;
}

export interface TemporalBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  accepts(source: AdapterSource): boolean;
  read(request: BackendReadRequest): Promise<BackendReadResult>;
}

export interface BackendDescriptor {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
}

interface RegisteredBackendRead {
  readonly descriptor: BackendDescriptor;
  readonly result: BackendReadResult;
}

const REGISTRY_BACKENDS = new WeakMap<BackendRegistry, Map<string, TemporalBackend>>();

export class BackendRegistry {
  constructor() {
    REGISTRY_BACKENDS.set(this, new Map());
  }

  register(backend: TemporalBackend): void {
    validateBackend(backend);
    const backends = registryBackends(this);
    if (backends.has(backend.id)) {
      throw new EngineConfigurationError(
        "DUPLICATE_BACKEND",
        `backend ${backend.id} is already registered`,
        "Register each backend id exactly once.",
      );
    }
    backends.set(backend.id, backend);
  }

  list(): readonly BackendDescriptor[] {
    return Object.freeze(
      [...registryBackends(this).values()]
        .map((backend) => descriptor(backend))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }
}

/** Internal bridge used by TemporalGuard; intentionally omitted from the package entrypoint. */
export async function readRegisteredBackend(
  registry: BackendRegistry,
  source: AdapterSource,
  plan: TemporalReadPlan,
  binding: SourceBinding,
): Promise<RegisteredBackendRead> {
  const backend = registryBackends(registry).get(binding.backend);
  if (backend === undefined) {
    throw new EngineConfigurationError(
      "BACKEND_NOT_FOUND",
      `backend ${binding.backend} is not registered`,
      "Register the backend before reading this source binding.",
    );
  }
  if (!backend.accepts(source)) {
    throw new EngineConfigurationError(
      "BACKEND_SOURCE_UNSUPPORTED",
      `backend ${backend.id} does not accept source type ${source.type}`,
      "Choose a compatible backend or declare a custom source adapter.",
    );
  }

  const resolvedBinding = resolveSourceBinding(binding, backend.id);
  let result: BackendReadResult;
  try {
    result = await backend.read({
      source,
      plan,
      binding: resolvedBinding,
    });
  } catch (cause) {
    if (cause instanceof EngineConfigurationError) {
      throw sanitizedBackendError(cause, resolvedBinding);
    }
    throw new EngineConfigurationError(
      "BACKEND_READ_FAILED",
      `backend ${backend.id} failed while reading the guarded source`,
      "Inspect the trusted backend's private logs; source paths and credentials are not echoed here.",
    );
  }
  validateBackendResult(result, backend);
  return {
    descriptor: descriptor(backend),
    result: {
      arrowIpc: Uint8Array.from(result.arrowIpc),
      sourceFingerprint:
        result.sourceFingerprint === null ? null : Object.freeze({ ...result.sourceFingerprint }),
      runtime: result.runtime === null ? null : Object.freeze({ ...result.runtime }),
      pushdown: Object.freeze({ ...result.pushdown }),
    },
  };
}

function sanitizedBackendError(
  error: EngineConfigurationError,
  binding: ResolvedSourceBinding,
): EngineConfigurationError {
  const prefix = `[${error.code}] `;
  const message = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  const privateValues = [
    ...binding.optionKeys.map((key) => binding.option(key)),
    ...binding.secretKeys.map((key) => binding.secret(key)),
  ]
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => right.length - left.length);
  return new EngineConfigurationError(
    error.code,
    redactValues(message, privateValues),
    redactValues(error.remedy, privateValues),
  );
}

function redactValues(input: string, privateValues: readonly string[]): string {
  let redacted = input;
  for (const value of privateValues) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function registryBackends(registry: BackendRegistry): Map<string, TemporalBackend> {
  const backends = REGISTRY_BACKENDS.get(registry);
  if (backends === undefined) {
    throw new EngineConfigurationError(
      "INVALID_BACKEND",
      "backend registry was not created by this engine instance",
      "Construct the registry with new BackendRegistry().",
    );
  }
  return backends;
}

function descriptor(backend: TemporalBackend): BackendDescriptor {
  return Object.freeze({
    id: backend.id,
    capabilities: Object.freeze({ ...backend.capabilities }),
  });
}

function validateBackend(backend: TemporalBackend): void {
  if (
    typeof backend !== "object" ||
    backend === null ||
    typeof backend.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(backend.id)
  ) {
    throw new EngineConfigurationError(
      "INVALID_BACKEND_ID",
      "backend id must be a portable identifier",
      "Use letters, digits, dots, underscores, or hyphens.",
    );
  }
  if (typeof backend.accepts !== "function" || typeof backend.read !== "function") {
    throw new EngineConfigurationError(
      "INVALID_BACKEND",
      `backend ${backend.id} does not implement the TemporalBackend contract`,
      "Implement accepts(source) and read(request).",
    );
  }
  if (
    typeof backend.capabilities?.projectionPushdown !== "boolean" ||
    typeof backend.capabilities.temporalPredicatePushdown !== "boolean" ||
    !["content-hash", "version-token", "none"].includes(backend.capabilities.sourceFingerprint) ||
    typeof backend.capabilities.readOnly !== "boolean"
  ) {
    throw new EngineConfigurationError(
      "INVALID_BACKEND",
      `backend ${backend.id} has invalid capability declarations`,
      "Declare all TemporalBackend capabilities with supported values.",
    );
  }
}

function validateBackendResult(result: BackendReadResult, backend: TemporalBackend): void {
  const backendId = backend.id;
  if (
    typeof result !== "object" ||
    result === null ||
    !(result.arrowIpc instanceof Uint8Array) ||
    result.arrowIpc.byteLength === 0
  ) {
    throw invalidResult(backendId, "returned no Arrow IPC data");
  }
  const fingerprint = result.sourceFingerprint;
  if (fingerprint === null) {
    if (backend.capabilities.sourceFingerprint !== "none") {
      throw invalidResult(backendId, "promised a source fingerprint but returned none");
    }
  } else {
    if (
      typeof fingerprint !== "object" ||
      typeof fingerprint.algorithm !== "string" ||
      fingerprint.algorithm.length === 0 ||
      typeof fingerprint.value !== "string" ||
      fingerprint.value.length === 0 ||
      !["source-version", "read-snapshot"].includes(fingerprint.scope)
    ) {
      throw invalidResult(backendId, "returned an invalid source fingerprint");
    }
    if (backend.capabilities.sourceFingerprint === "none") {
      throw invalidResult(backendId, "returned an undeclared source fingerprint");
    }
  }
  const runtime = result.runtime;
  if (
    runtime !== null &&
    (typeof runtime !== "object" ||
      typeof runtime.name !== "string" ||
      runtime.name.length === 0 ||
      typeof runtime.version !== "string" ||
      runtime.version.length === 0)
  ) {
    throw invalidResult(backendId, "returned invalid backend runtime identity");
  }
  if (
    typeof result.pushdown?.projectionApplied !== "boolean" ||
    typeof result.pushdown.temporalPredicateApplied !== "boolean"
  ) {
    throw invalidResult(backendId, "returned an invalid pushdown report");
  }
  if (
    (result.pushdown.projectionApplied && !backend.capabilities.projectionPushdown) ||
    (result.pushdown.temporalPredicateApplied && !backend.capabilities.temporalPredicatePushdown)
  ) {
    throw invalidResult(backendId, "reported pushdown that its capabilities do not declare");
  }
}

function invalidResult(backendId: string, message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_BACKEND_RESULT",
    `backend ${backendId} ${message}`,
    "Fix the backend adapter; the temporal guard fails closed on malformed output.",
  );
}
