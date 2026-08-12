import { describe, expect, it } from "vitest";
import {
  parseModelReference,
  parseProviderEnvironmentOverride,
  resolveProviderEnvironmentOverride,
} from "../src/model.ts";

describe("Pi model references", () => {
  it("parses a provider/model pair without losing slashes in the model id", () => {
    expect(parseModelReference("openrouter/vendor/model", "high")).toEqual({
      provider: "openrouter",
      model: "vendor/model",
      thinkingLevel: "high",
    });
  });

  it("rejects malformed references and thinking levels", () => {
    expect(() => parseModelReference("model-only")).toThrow(/provider\/model-id/);
    expect(() => parseModelReference("anthropic/model", "extreme")).toThrow(/thinking level/);
  });

  it("resolves provider overrides without copying the secret into configuration", () => {
    const override = parseProviderEnvironmentOverride("TEST_BASE_URL", "TEST_API_KEY");
    expect(override).toEqual({
      baseUrlVariable: "TEST_BASE_URL",
      apiKeyVariable: "TEST_API_KEY",
    });
    if (override === undefined) throw new Error("expected a provider override");
    expect(
      resolveProviderEnvironmentOverride(override, {
        TEST_BASE_URL: "https://example.test/v1",
        TEST_API_KEY: "secret-value",
      }),
    ).toEqual({
      baseUrl: "https://example.test/v1",
      apiKeyReference: "$TEST_API_KEY",
    });
  });

  it("requires a complete, valid provider environment override", () => {
    expect(parseProviderEnvironmentOverride(undefined, undefined)).toBeUndefined();
    expect(() => parseProviderEnvironmentOverride("BASE_URL", undefined)).toThrow(/together/);
    expect(() => parseProviderEnvironmentOverride("not-valid!", "API_KEY")).toThrow(
      /environment variable/,
    );
    expect(() =>
      resolveProviderEnvironmentOverride(
        { baseUrlVariable: "BASE_URL", apiKeyVariable: "API_KEY" },
        { BASE_URL: "file:///tmp/socket", API_KEY: "secret" },
      ),
    ).toThrow(/HTTP\(S\)/);
  });
});
