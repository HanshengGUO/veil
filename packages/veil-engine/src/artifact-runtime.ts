import { isAbsolute } from "node:path";
import { inspect } from "node:util";
import type { ArtifactEntrypoint, ArtifactRuntime } from "./artifact.ts";
import { EngineConfigurationError } from "./errors.ts";

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "CDPATH",
  "ENV",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "HOME",
  "INIT_CWD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "OLDPWD",
  "PATH",
  "PWD",
  "PYTHONHOME",
  "PYTHONPATH",
  "USERPROFILE",
]);
const SECRET_ENVIRONMENT_NAME =
  /(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|TOKEN)/i;

export interface ArtifactRuntimeLaunchContext {
  /** Verified ephemeral code root. The original checkout path is never supplied. */
  readonly codeRoot: string;
  readonly runtime: ArtifactRuntime;
  readonly entry: ArtifactEntrypoint;
}

export interface ArtifactRuntimeLaunch {
  /** Absolute interpreter/runner path. It remains private runtime state. */
  readonly executable: string;
  readonly arguments?: readonly string[];
  /** Explicit deterministic variables only; the developer environment is never inherited. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface ArtifactRuntimeProviderInput {
  readonly id: string;
  readonly implementation: ArtifactRuntimeImplementation;
  supports(constraint: string): boolean;
  launch(
    context: ArtifactRuntimeLaunchContext,
  ): ArtifactRuntimeLaunch | Promise<ArtifactRuntimeLaunch>;
}

export interface ArtifactRuntimeImplementation {
  readonly name: string;
  readonly version: string;
}

export interface ArtifactRuntimeDescriptor {
  readonly id: string;
  readonly implementation: ArtifactRuntimeImplementation;
}

interface ArtifactRuntimeProviderState {
  readonly implementation: ArtifactRuntimeImplementation;
  readonly supports: ArtifactRuntimeProviderInput["supports"];
  readonly launch: ArtifactRuntimeProviderInput["launch"];
}

interface SelectedRuntimeProvider {
  readonly descriptor: ArtifactRuntimeDescriptor;
  launch(context: ArtifactRuntimeLaunchContext): Promise<ArtifactRuntimeLaunch>;
}

const PROVIDER_STATES = new WeakMap<ArtifactRuntimeProvider, ArtifactRuntimeProviderState>();
const REGISTRY_PROVIDERS = new WeakMap<
  ArtifactRuntimeRegistry,
  Map<string, ArtifactRuntimeProvider>
>();

/** Opaque runtime capability: callbacks and executable paths are absent from JSON and inspection. */
export class ArtifactRuntimeProvider {
  readonly id: string;

  private constructor(id: string, state: ArtifactRuntimeProviderState) {
    this.id = id;
    PROVIDER_STATES.set(this, state);
    Object.freeze(this);
  }

  static create(input: ArtifactRuntimeProviderInput): ArtifactRuntimeProvider {
    if (
      !isPlainRecord(input) ||
      !hasExactKeys(input, ["id", "implementation", "supports", "launch"])
    ) {
      throw invalidRuntime("runtime provider input has missing or unknown fields");
    }
    validateId(input.id);
    if (typeof input.supports !== "function" || typeof input.launch !== "function") {
      throw invalidRuntime("runtime provider must implement supports() and launch()");
    }
    const implementation = normalizeImplementation(input.implementation);
    return new ArtifactRuntimeProvider(input.id, {
      implementation,
      supports: input.supports,
      launch: input.launch,
    });
  }

  toJSON(): ArtifactRuntimeDescriptor {
    const state = PROVIDER_STATES.get(this);
    if (state === undefined) {
      throw invalidRuntime("runtime provider was not created by this engine instance");
    }
    return { id: this.id, implementation: state.implementation };
  }

  [inspect.custom](): string {
    return `ArtifactRuntimeProvider ${JSON.stringify(this.toJSON())}`;
  }
}

export function createArtifactRuntimeProvider(
  input: ArtifactRuntimeProviderInput,
): ArtifactRuntimeProvider {
  return ArtifactRuntimeProvider.create(input);
}

export class ArtifactRuntimeRegistry {
  constructor() {
    REGISTRY_PROVIDERS.set(this, new Map());
  }

  register(provider: ArtifactRuntimeProvider): void {
    const state = PROVIDER_STATES.get(provider);
    if (state === undefined) {
      throw invalidRuntime("runtime provider was not created by this engine instance");
    }
    const providers = registryProviders(this);
    if (providers.has(provider.id)) {
      throw new EngineConfigurationError(
        "DUPLICATE_ARTIFACT_RUNTIME",
        `artifact runtime ${provider.id} is already registered`,
        "Register each logical artifact runtime id exactly once.",
      );
    }
    providers.set(provider.id, provider);
  }

  list(): readonly ArtifactRuntimeDescriptor[] {
    return Object.freeze(
      [...registryProviders(this).values()]
        .sort((left, right) => compareText(left.id, right.id))
        .map((provider) => deepFreezeDescriptor(provider.toJSON())),
    );
  }
}

/** Internal selection bridge used only after the artifact and original code have been verified. */
export function selectArtifactRuntimeProvider(
  registry: ArtifactRuntimeRegistry,
  runtime: ArtifactRuntime,
): SelectedRuntimeProvider {
  const provider = registryProviders(registry).get(runtime.id);
  if (provider === undefined) {
    throw new EngineConfigurationError(
      "ARTIFACT_RUNTIME_NOT_FOUND",
      `artifact runtime ${runtime.id} is not registered`,
      "Register a trusted runtime provider for the artifact's logical runtime id.",
    );
  }
  const state = PROVIDER_STATES.get(provider);
  if (state === undefined) {
    throw invalidRuntime("registered runtime provider is not an engine capability");
  }
  let supported: boolean;
  try {
    supported = state.supports(runtime.constraint);
  } catch {
    throw invalidRuntime(`artifact runtime ${runtime.id} failed while checking its constraint`);
  }
  if (supported !== true) {
    throw new EngineConfigurationError(
      "ARTIFACT_RUNTIME_UNSUPPORTED",
      `artifact runtime ${runtime.id} does not satisfy constraint ${runtime.constraint}`,
      "Install a compatible runtime or register a provider that explicitly supports this constraint.",
    );
  }
  return Object.freeze({
    descriptor: deepFreezeDescriptor(provider.toJSON()),
    launch: async (context: ArtifactRuntimeLaunchContext): Promise<ArtifactRuntimeLaunch> => {
      let launch: ArtifactRuntimeLaunch;
      try {
        launch = await state.launch(deepFreezeContext(context));
      } catch {
        throw invalidRuntime(`artifact runtime ${runtime.id} failed to prepare a launch`);
      }
      return normalizeLaunch(launch);
    },
  });
}

function normalizeImplementation(input: unknown): ArtifactRuntimeImplementation {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["name", "version"])) {
    throw invalidRuntime("artifact runtime implementation has missing or unknown fields");
  }
  if (typeof input.name !== "string" || !PORTABLE_ID.test(input.name)) {
    throw invalidRuntime("artifact runtime implementation name must be a portable identifier");
  }
  if (
    typeof input.version !== "string" ||
    input.version.length === 0 ||
    input.version.length > 128 ||
    input.version.trim() !== input.version ||
    hasControlCharacter(input.version) ||
    input.version.includes("/") ||
    input.version.includes("\\") ||
    input.version.includes("\0")
  ) {
    throw invalidRuntime("artifact runtime implementation version must be portable text");
  }
  return Object.freeze({ name: input.name, version: input.version });
}

function hasControlCharacter(input: string): boolean {
  return [...input].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function deepFreezeDescriptor(input: ArtifactRuntimeDescriptor): ArtifactRuntimeDescriptor {
  return Object.freeze({
    id: input.id,
    implementation: Object.freeze({ ...input.implementation }),
  });
}

function normalizeLaunch(input: unknown): ArtifactRuntimeLaunch {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ["executable", "arguments", "environment"], true)
  ) {
    throw invalidRuntime("artifact runtime launch has unknown fields");
  }
  if (
    typeof input.executable !== "string" ||
    !isAbsolute(input.executable) ||
    input.executable.includes("\0")
  ) {
    throw invalidRuntime("artifact runtime executable must be an absolute path");
  }
  if (
    input.arguments !== undefined &&
    (!Array.isArray(input.arguments) ||
      input.arguments.length > 256 ||
      input.arguments.some(
        (argument) =>
          typeof argument !== "string" || argument.length > 16_384 || argument.includes("\0"),
      ))
  ) {
    throw invalidRuntime("artifact runtime arguments must be bounded strings");
  }
  return Object.freeze({
    executable: input.executable,
    arguments: Object.freeze([...(input.arguments ?? [])]),
    environment: normalizeEnvironment(input.environment),
  });
}

function normalizeEnvironment(input: unknown): Readonly<Record<string, string>> {
  if (input === undefined) return Object.freeze({});
  if (!isPlainRecord(input)) {
    throw invalidRuntime("artifact runtime environment must be a plain object");
  }
  const entries: Array<readonly [string, string]> = [];
  for (const name of Object.keys(input).sort(compareText)) {
    const value = input[name];
    if (
      !ENVIRONMENT_NAME.test(name) ||
      FORBIDDEN_ENVIRONMENT_NAMES.has(name.toUpperCase()) ||
      SECRET_ENVIRONMENT_NAME.test(name) ||
      typeof value !== "string" ||
      value.length > 16_384 ||
      value.includes("\0")
    ) {
      throw invalidRuntime("artifact runtime environment contains an unsafe name or value");
    }
    entries.push([name, value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function deepFreezeContext(input: ArtifactRuntimeLaunchContext): ArtifactRuntimeLaunchContext {
  return Object.freeze({
    codeRoot: input.codeRoot,
    runtime: Object.freeze({ ...input.runtime }),
    entry: Object.freeze({ ...input.entry }),
  });
}

function registryProviders(
  registry: ArtifactRuntimeRegistry,
): Map<string, ArtifactRuntimeProvider> {
  const providers = REGISTRY_PROVIDERS.get(registry);
  if (providers === undefined) {
    throw invalidRuntime("artifact runtime registry was not created by this engine instance");
  }
  return providers;
}

function validateId(input: unknown): asserts input is string {
  if (typeof input !== "string" || !PORTABLE_ID.test(input)) {
    throw invalidRuntime("artifact runtime provider id must be a portable identifier");
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): boolean {
  const actual = Object.keys(input);
  const allowed = new Set(keys);
  return (
    actual.every((key) => allowed.has(key)) &&
    (optional || keys.every((key) => actual.includes(key)))
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidRuntime(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_ARTIFACT_RUNTIME",
    message,
    "Use createArtifactRuntimeProvider() with a trusted, path-private runtime adapter.",
  );
}
