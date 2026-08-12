import { inspect } from "node:util";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  type BackendReadRequest,
  BackendRegistry,
  createSourceBinding,
  createSourceManifest,
  EngineConfigurationError,
  sourceFingerprintFromManifest,
  type TemporalBackend,
  TemporalGuard,
} from "../src/index.ts";

function adapterWithAvailability() {
  return normalizeAdapterDeclaration({
    dataset: "prices",
    version: "1",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true },
    source: { type: "custom", locator: "logical/prices" },
  });
}

function backendReturning(
  columns: Record<string, readonly unknown[]>,
  onRead?: (request: BackendReadRequest) => void,
): TemporalBackend {
  return {
    id: "memory-arrow",
    capabilities: {
      projectionPushdown: true,
      temporalPredicatePushdown: true,
      sourceFingerprint: "content-hash",
      readOnly: true,
    },
    accepts: (source) => source.type === "custom",
    read: async (request) => {
      onRead?.(request);
      return {
        arrowIpc: tableToIPC(tableFromArrays(columns), "stream"),
        sourceFingerprint: {
          algorithm: "sha256",
          value: "a".repeat(64),
          scope: "source-version",
        },
        runtime: { name: "memory", version: "test-v1" },
        pushdown: {
          projectionApplied: true,
          temporalPredicateApplied: true,
        },
      };
    },
  };
}

describe("database-neutral temporal guard", () => {
  it("filters future rows even when a backend claims it already applied the predicate", async () => {
    let captured: BackendReadRequest | undefined;
    const backend = backendReturning(
      {
        ticker: ["A", "B"],
        event_time: ["2026-08-11T00:00:00Z", "2026-08-12T00:00:00Z"],
        available_time: ["2026-08-12T00:00:00Z", "2026-08-13T00:00:00Z"],
        value: [1, 99],
      },
      (request) => {
        captured = request;
      },
    );
    const registry = new BackendRegistry();
    registry.register(backend);
    const binding = createSourceBinding({
      id: "research-memory",
      backend: backend.id,
      options: { root: "/private/source/root" },
      secrets: { apiKey: "do-not-serialize-this" },
    });

    const result = await new TemporalGuard(registry).read(
      adapterWithAvailability(),
      { asOf: "2026-08-12", columns: ["ticker", "value"] },
      binding,
    );
    const table = tableFromIPC(result.arrowIpc);

    expect(table.numRows).toBe(1);
    expect(table.schema.fields.map((field) => field.name)).toEqual(["ticker", "value"]);
    expect(table.getChild("ticker")?.get(0)).toBe("A");
    expect(result.audit.droppedFutureRows).toBe(1);
    expect(result.audit.backendClaimedTemporalPushdown).toBe(true);
    expect(captured?.plan.temporalPredicate).toEqual({
      column: "available_time",
      operator: "<=",
      value: "2026-08-12T00:00:00.000Z",
    });
    expect(captured?.plan.backendProjection).toEqual([
      "ticker",
      "value",
      "event_time",
      "available_time",
    ]);
    expect(JSON.stringify(captured?.plan)).not.toMatch(/duckdb|\bsql\b/i);
  });

  it("uses event_time as a marked fallback without changing the backend interface", async () => {
    const declaration = normalizeAdapterDeclaration({
      dataset: "events",
      version: "1",
      entity_key: "id",
      event_time: "happened_at",
      available_time: null,
      source: { type: "custom", locator: "logical/events" },
    });
    const registry = new BackendRegistry();
    registry.register(
      backendReturning({
        id: ["past", "future"],
        happened_at: ["2026-08-11T00:00:00Z", "2026-08-13T00:00:00Z"],
      }),
    );

    const result = await new TemporalGuard(registry).read(
      declaration,
      { asOf: "2026-08-12" },
      createSourceBinding({ id: "events", backend: "memory-arrow" }),
    );

    expect(tableFromIPC(result.arrowIpc).numRows).toBe(1);
    expect(result.plan.temporalPredicate.column).toBe("happened_at");
    expect(result.semantics.degradations).toContain("PIT_UNSAFE");
  });

  it("keeps binding values out of serialization while making them available to the backend", async () => {
    const binding = createSourceBinding({
      id: "private-feed",
      backend: "memory-arrow",
      options: { root: "/private/source/root" },
      secrets: { apiKey: "do-not-serialize-this" },
    });
    let backendSawSecret = false;
    const backend = backendReturning(
      {
        ticker: ["A"],
        event_time: ["2026-08-11T00:00:00Z"],
        available_time: ["2026-08-12T00:00:00Z"],
      },
      (request) => {
        backendSawSecret = request.binding.secret("apiKey") === "do-not-serialize-this";
        expect(request.binding.option("root")).toBe("/private/source/root");
      },
    );
    const registry = new BackendRegistry();
    registry.register(backend);

    const result = await new TemporalGuard(registry).read(
      adapterWithAvailability(),
      { asOf: "2026-08-12" },
      binding,
    );
    const serialized = `${JSON.stringify(binding)}\n${inspect(binding)}\n${JSON.stringify(result)}`;

    expect(backendSawSecret).toBe(true);
    expect(serialized).not.toContain("do-not-serialize-this");
    expect(serialized).not.toContain("/private/source/root");
    expect(serialized).toContain("apiKey");
  });

  it("fails closed when the backend omits the temporal guard column", async () => {
    const registry = new BackendRegistry();
    registry.register(
      backendReturning({
        ticker: ["A"],
        event_time: ["2026-08-11T00:00:00Z"],
      }),
    );

    await expect(
      new TemporalGuard(registry).read(
        adapterWithAvailability(),
        { asOf: "2026-08-12" },
        createSourceBinding({ id: "missing-column", backend: "memory-arrow" }),
      ),
    ).rejects.toMatchObject({ invariant: "C1" });
  });

  it("fails closed with C1 when a backend returns an invalid temporal value", async () => {
    const registry = new BackendRegistry();
    registry.register(
      backendReturning({
        ticker: ["A"],
        event_time: ["2026-08-11T00:00:00Z"],
        available_time: ["not-a-time"],
      }),
    );

    await expect(
      new TemporalGuard(registry).read(
        adapterWithAvailability(),
        { asOf: "2026-08-12" },
        createSourceBinding({ id: "invalid-time", backend: "memory-arrow" }),
      ),
    ).rejects.toMatchObject({ invariant: "C1" });
  });

  it("allows an unversioned backend without confusing missing identity with temporal safety", async () => {
    const base = backendReturning({
      ticker: ["A"],
      event_time: ["2026-08-11T00:00:00Z"],
      available_time: ["2026-08-12T00:00:00Z"],
    });
    const backend: TemporalBackend = {
      ...base,
      id: "ephemeral-arrow",
      capabilities: { ...base.capabilities, sourceFingerprint: "none" },
      read: async (request) => ({ ...(await base.read(request)), sourceFingerprint: null }),
    };
    const registry = new BackendRegistry();
    registry.register(backend);

    const result = await new TemporalGuard(registry).read(
      adapterWithAvailability(),
      { asOf: "2026-08-12" },
      createSourceBinding({ id: "ephemeral", backend: backend.id }),
    );

    expect(result.sourceFingerprint).toBeNull();
    expect(result.readSet.source.fingerprint).toBeNull();
    expect(result.audit.droppedFutureRows).toBe(0);
  });
});

describe("backend registry", () => {
  it("does not expose an unguarded read method", () => {
    const registry = new BackendRegistry();

    expect("read" in registry).toBe(false);
    expect(Object.keys(registry)).toEqual([]);
    expect(Object.getOwnPropertySymbols(Object.getPrototypeOf(registry))).toEqual([]);
  });

  it("does not echo binding values when a trusted backend fails", async () => {
    const backend = backendReturning({});
    const registry = new BackendRegistry();
    registry.register({
      ...backend,
      read: async (request) => {
        throw new Error(
          `failed at ${request.binding.option("root")} with ${request.binding.secret("apiKey")}`,
        );
      },
    });

    const failure: unknown = await new TemporalGuard(registry)
      .read(
        adapterWithAvailability(),
        { asOf: "2026-08-12" },
        createSourceBinding({
          id: "failing-source",
          backend: backend.id,
          options: { root: "/private/source/root" },
          secrets: { apiKey: "do-not-serialize-this" },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "BACKEND_READ_FAILED" });
    expect(String(failure)).not.toMatch(/private\/source|do-not-serialize-this/);
  });

  it("rejects duplicate ids and binding/backend mismatches", async () => {
    const registry = new BackendRegistry();
    registry.register(backendReturning({}));
    expect(() => registry.register(backendReturning({}))).toThrow(EngineConfigurationError);

    await expect(
      new TemporalGuard(registry).read(
        adapterWithAvailability(),
        { asOf: "2026-08-12" },
        createSourceBinding({ id: "wrong", backend: "another-backend" }),
      ),
    ).rejects.toMatchObject({ code: "BACKEND_NOT_FOUND" });
  });

  it("rejects an invalid backend runtime identity", async () => {
    const base = backendReturning({
      ticker: ["A"],
      event_time: ["2026-08-11T00:00:00Z"],
      available_time: ["2026-08-12T00:00:00Z"],
    });
    const registry = new BackendRegistry();
    registry.register({
      ...base,
      read: async (request) => ({
        ...(await base.read(request)),
        runtime: { name: "", version: "" },
      }),
    });

    await expect(
      new TemporalGuard(registry).read(
        adapterWithAvailability(),
        { asOf: "2026-08-12" },
        createSourceBinding({ id: "invalid-runtime", backend: base.id }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_BACKEND_RESULT" });
  });

  it("rejects a source fingerprint that does not match its embedded manifest", async () => {
    const base = backendReturning({
      ticker: ["A"],
      event_time: ["2026-08-11T00:00:00Z"],
      available_time: ["2026-08-12T00:00:00Z"],
    });
    const manifest = createSourceManifest([
      {
        logicalName: "part.csv",
        byteLength: 1,
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    ]);
    const registry = new BackendRegistry();
    registry.register({
      ...base,
      read: async (request) => ({
        ...(await base.read(request)),
        sourceFingerprint: {
          ...sourceFingerprintFromManifest(manifest),
          value: "0".repeat(64),
        },
      }),
    });

    await expect(
      new TemporalGuard(registry).read(
        adapterWithAvailability(),
        { asOf: "2026-08-12" },
        createSourceBinding({ id: "invalid-manifest", backend: base.id }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_BACKEND_RESULT" });
  });
});
