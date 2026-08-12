export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModelReference {
  provider: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
}

export interface PiProviderEnvironmentOverride {
  baseUrlVariable: string;
  apiKeyVariable: string;
}

export interface ResolvedPiProviderOverride {
  baseUrl: string;
  apiKeyReference: string;
}

const THINKING_LEVELS = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseModelReference(value: string, thinking = "medium"): PiModelReference {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("model must be provider/model-id");
  }
  if (!THINKING_LEVELS.has(thinking as PiThinkingLevel)) {
    throw new Error(`unsupported thinking level: ${thinking}`);
  }
  return {
    provider: value.slice(0, separator),
    model: value.slice(separator + 1),
    thinkingLevel: thinking as PiThinkingLevel,
  };
}

export function parseProviderEnvironmentOverride(
  baseUrlVariable: string | undefined,
  apiKeyVariable: string | undefined,
): PiProviderEnvironmentOverride | undefined {
  if (baseUrlVariable === undefined && apiKeyVariable === undefined) return undefined;
  if (baseUrlVariable === undefined || apiKeyVariable === undefined) {
    throw new Error("--provider-base-url-env and --provider-api-key-env must be supplied together");
  }
  if (!ENVIRONMENT_VARIABLE.test(baseUrlVariable)) {
    throw new Error("--provider-base-url-env must name an environment variable");
  }
  if (!ENVIRONMENT_VARIABLE.test(apiKeyVariable)) {
    throw new Error("--provider-api-key-env must name an environment variable");
  }
  return { baseUrlVariable, apiKeyVariable };
}

export function resolveProviderEnvironmentOverride(
  override: PiProviderEnvironmentOverride,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedPiProviderOverride {
  const baseUrl = environment[override.baseUrlVariable];
  const apiKey = environment[override.apiKeyVariable];
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error(`provider base URL environment variable is unset: ${override.baseUrlVariable}`);
  }
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`provider API key environment variable is unset: ${override.apiKeyVariable}`);
  }

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new Error(
      `provider base URL environment variable is not an HTTP(S) URL: ${override.baseUrlVariable}`,
    );
  }

  return { baseUrl, apiKeyReference: `$${override.apiKeyVariable}` };
}

export function assertPiRuntime(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(
      `Pi model sessions require Node >=22.19.0; current runtime is ${process.versions.node}. ` +
        "Task verification and deterministic scoring remain supported on Node 20.",
    );
  }
}
