import { inspect } from "node:util";
import { EngineConfigurationError } from "./errors.ts";

export interface SourceBindingInput {
  readonly id: string;
  readonly backend: string;
  readonly options?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface SourceBindingSummary {
  readonly id: string;
  readonly backend: string;
  readonly optionKeys: readonly string[];
  readonly secretKeys: readonly string[];
}

export interface ResolvedSourceBinding extends SourceBindingSummary {
  option(name: string): string | undefined;
  secret(name: string): string | undefined;
}

interface BindingState {
  readonly options: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

const BINDING_STATES = new WeakMap<SourceBinding, BindingState>();
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * An opaque capability handed to the engine. Values are kept in a WeakMap and are deliberately
 * absent from enumeration, JSON, inspection, read results, and model-facing diagnostics.
 */
export class SourceBinding {
  readonly id: string;
  readonly backend: string;
  readonly optionKeys: readonly string[];
  readonly secretKeys: readonly string[];

  private constructor(input: SourceBindingInput, state: BindingState) {
    this.id = input.id;
    this.backend = input.backend;
    this.optionKeys = Object.freeze(Object.keys(state.options).sort());
    this.secretKeys = Object.freeze(Object.keys(state.secrets).sort());
    BINDING_STATES.set(this, state);
    Object.freeze(this);
  }

  static create(input: SourceBindingInput): SourceBinding {
    validatePortableId(input.id, "binding id");
    validatePortableId(input.backend, "backend id");
    const options = normalizeValues(input.options, "option");
    const secrets = normalizeValues(input.secrets, "secret");
    for (const key of Object.keys(options)) {
      if (Object.hasOwn(secrets, key)) {
        throw new EngineConfigurationError(
          "INVALID_BINDING",
          `binding key ${JSON.stringify(key)} appears in both options and secrets`,
          "Keep public options and secret values under distinct names.",
        );
      }
    }
    return new SourceBinding(input, { options, secrets });
  }

  toJSON(): SourceBindingSummary {
    return bindingSummary(this);
  }

  [inspect.custom](): string {
    return `SourceBinding ${JSON.stringify(bindingSummary(this))}`;
  }
}

export function createSourceBinding(input: SourceBindingInput): SourceBinding {
  return SourceBinding.create(input);
}

/** Internal capability resolution. This function is intentionally not re-exported by index.ts. */
export function resolveSourceBinding(
  binding: SourceBinding,
  expectedBackend: string,
): ResolvedSourceBinding {
  if (binding.backend !== expectedBackend) {
    throw new EngineConfigurationError(
      "BINDING_BACKEND_MISMATCH",
      `binding ${binding.id} targets ${binding.backend}, not ${expectedBackend}`,
      "Use a binding created for the selected backend.",
    );
  }
  const state = BINDING_STATES.get(binding);
  if (state === undefined) {
    throw new EngineConfigurationError(
      "INVALID_BINDING",
      "source binding was not created by this engine instance",
      "Create bindings with createSourceBinding().",
    );
  }
  const summary = bindingSummary(binding);
  return Object.freeze({
    ...summary,
    option: (name: string) => state.options[name],
    secret: (name: string) => state.secrets[name],
  });
}

function bindingSummary(binding: SourceBinding): SourceBindingSummary {
  return {
    id: binding.id,
    backend: binding.backend,
    optionKeys: binding.optionKeys,
    secretKeys: binding.secretKeys,
  };
}

function normalizeValues(
  input: Readonly<Record<string, string>> | undefined,
  kind: "option" | "secret",
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!PORTABLE_ID.test(key) || typeof value !== "string" || value.length === 0) {
      throw new EngineConfigurationError(
        "INVALID_BINDING",
        `${kind} names must be portable identifiers and values must be non-empty strings`,
        `Correct the invalid ${kind} entry before creating the binding.`,
      );
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function validatePortableId(value: string, label: "binding id" | "backend id"): void {
  if (typeof value !== "string" || !PORTABLE_ID.test(value)) {
    throw new EngineConfigurationError(
      label === "binding id" ? "INVALID_BINDING" : "INVALID_BACKEND_ID",
      `${label} must be a portable identifier`,
      "Use letters, digits, dots, underscores, or hyphens.",
    );
  }
}
