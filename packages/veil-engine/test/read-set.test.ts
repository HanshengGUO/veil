import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashAdapterDeclaration, normalizeAdapterDeclaration } from "@veilquant/contract";
import {
  Binary,
  Float64,
  Int64,
  Table,
  tableFromIPC,
  tableToIPC,
  Utf8,
  vectorFromArray,
} from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  READ_SET_FORMAT,
  type TemporalBackend,
  TemporalGuard,
  verifyReadSetManifest,
} from "../src/index.ts";

const fixturesRoot = fileURLToPath(new URL("fixtures/", import.meta.url));

function declaration(version = "1") {
  return normalizeAdapterDeclaration({
    dataset: "read-set-prices",
    version,
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true },
    payload_schema: { value: "float64" },
    source: { type: "csv", locator: "temporal.csv" },
  });
}

function guard(): TemporalGuard {
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  return new TemporalGuard(registry);
}

function binding(root: string, id = "read-set-source") {
  return createSourceBinding({
    id,
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root },
  });
}

function failureFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected read-set verification to fail");
}

interface PrimitiveRow {
  readonly id: string;
  readonly metric: number;
  readonly count: bigint;
  readonly blob: Uint8Array;
}

function primitiveTable(rows: readonly PrimitiveRow[]): Table {
  return new Table({
    id: vectorFromArray(
      rows.map((row) => row.id),
      new Utf8(),
    ),
    event_time: vectorFromArray(
      rows.map(() => "2026-08-11T00:00:00Z"),
      new Utf8(),
    ),
    available_time: vectorFromArray(
      rows.map(() => "2026-08-12T00:00:00Z"),
      new Utf8(),
    ),
    metric: vectorFromArray(
      rows.map((row) => row.metric),
      new Float64(),
    ),
    count: vectorFromArray(
      rows.map((row) => row.count),
      new Int64(),
    ),
    blob: vectorFromArray(
      rows.map((row) => row.blob),
      new Binary(),
    ),
  });
}

function guardedMemory(table: Table, fingerprint: string): TemporalGuard {
  const backend: TemporalBackend = {
    id: "read-set-memory",
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: false,
      sourceFingerprint: "content-hash",
      readOnly: true,
    },
    accepts: (source) => source.type === "custom",
    read: async () => ({
      arrowIpc: tableToIPC(table, "stream"),
      sourceFingerprint: { algorithm: "sha256", value: fingerprint, scope: "source-version" },
      runtime: { name: "memory", version: "test-v1" },
      pushdown: { projectionApplied: false, temporalPredicateApplied: false },
    }),
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  return new TemporalGuard(registry);
}

describe("read-set v0", () => {
  it("attaches a versioned, path-free manifest and independently verifies its evidence", async () => {
    const packageMetadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string; dependencies: Record<string, string> };
    const adapter = declaration();
    const result = await guard().read(
      adapter,
      { asOf: "2026-08-12", columns: ["value", "ticker"] },
      binding(fixturesRoot),
    );
    const manifest = result.readSet;

    expect(manifest.format).toBe(READ_SET_FORMAT);
    expect(manifest.declarationHash).toBe(hashAdapterDeclaration(adapter));
    expect(manifest.source.fingerprint).toEqual(result.sourceFingerprint);
    expect(manifest.query.projection).toEqual(["value", "ticker"]);
    expect(manifest.result.rowCount).toBe(2);
    expect(manifest.result.arrowHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.result.schema.fields.map((field) => field.name)).toEqual(["ticker", "value"]);
    expect(manifest.runtime.backend).toEqual({
      id: DUCKDB_FILE_BACKEND_ID,
      runtime: { name: "duckdb", version: "v1.4.5" },
    });
    expect(manifest.runtime.engine).toBe(`@veilquant/engine@${packageMetadata.version}`);
    expect(manifest.runtime.arrow).toBe(
      `apache-arrow@${packageMetadata.dependencies["apache-arrow"]}`,
    );
    expect(manifest.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(fixturesRoot);

    const serialized: unknown = JSON.parse(JSON.stringify(manifest));
    const verified = verifyReadSetManifest(serialized, {
      arrowIpc: result.arrowIpc,
      declaration: adapter,
      sourceFingerprint: result.sourceFingerprint,
      expectedManifestHash: manifest.manifestHash,
    });

    expect(verified).toEqual(manifest);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.result.schema.fields)).toBe(true);
    expect(
      failureFrom(() =>
        verifyReadSetManifest(manifest, {
          arrowIpc: tableToIPC(tableFromIPC(result.arrowIpc), "file"),
          expectedManifestHash: manifest.manifestHash,
        }),
      ),
    ).toMatchObject({ code: "INVALID_READ_SET" });
  });

  it("fails loudly on manifest tampering, wrong evidence, and corrupt Arrow bytes", async () => {
    const adapter = declaration();
    const result = await guard().read(
      adapter,
      { asOf: "2026-08-12", columns: ["ticker", "value"] },
      binding(fixturesRoot),
    );
    const tampered = JSON.parse(JSON.stringify(result.readSet)) as {
      result: { rowCount: number };
    };
    tampered.result.rowCount += 1;

    expect(
      failureFrom(() => verifyReadSetManifest(tampered, { arrowIpc: result.arrowIpc })),
    ).toMatchObject({ code: "INVALID_READ_SET" });
    expect(
      failureFrom(() =>
        verifyReadSetManifest(result.readSet, {
          arrowIpc: result.arrowIpc,
          expectedManifestHash: `sha256:${"0".repeat(64)}`,
        }),
      ),
    ).toMatchObject({ code: "INVALID_READ_SET" });
    expect(
      failureFrom(() =>
        verifyReadSetManifest(result.readSet, {
          arrowIpc: result.arrowIpc,
          declaration: declaration("2"),
        }),
      ),
    ).toMatchObject({ code: "INVALID_READ_SET" });
    expect(
      failureFrom(() =>
        verifyReadSetManifest(result.readSet, {
          arrowIpc: result.arrowIpc,
          sourceFingerprint: {
            algorithm: "sha256",
            value: "0".repeat(64),
            scope: "source-version",
          },
        }),
      ),
    ).toMatchObject({ code: "INVALID_READ_SET" });
    expect(
      failureFrom(() =>
        verifyReadSetManifest(result.readSet, { arrowIpc: Uint8Array.of(1, 2, 3) }),
      ),
    ).toMatchObject({ code: "INVALID_READ_SET" });
  });

  it("keeps binding ids and absolute roots out of read-set identity", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "veil-read-set-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "veil-read-set-b-"));
    try {
      await Promise.all([
        copyFile(join(fixturesRoot, "temporal.csv"), join(firstRoot, "temporal.csv")),
        copyFile(join(fixturesRoot, "temporal.csv"), join(secondRoot, "temporal.csv")),
      ]);
      const adapter = declaration();
      const [first, second] = await Promise.all([
        guard().read(
          adapter,
          { asOf: "2026-08-12", columns: ["ticker", "value"] },
          binding(firstRoot, "machine-a"),
        ),
        guard().read(
          adapter,
          { asOf: "2026-08-12", columns: ["ticker", "value"] },
          binding(secondRoot, "machine-b"),
        ),
      ]);

      expect(second.readSet).toEqual(first.readSet);
      const serialized = JSON.stringify(first.readSet);
      expect(serialized).not.toContain(firstRoot);
      expect(serialized).not.toContain(secondRoot);
      expect(serialized).not.toContain("machine-a");
      expect(serialized).not.toContain("machine-b");
    } finally {
      await Promise.all([
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("separates query layout from logical result identity", async () => {
    const adapter = declaration();
    const temporalGuard = guard();
    const sourceBinding = binding(fixturesRoot);
    const [tickerFirst, valueFirst] = await Promise.all([
      temporalGuard.read(
        adapter,
        { asOf: "2026-08-12", columns: ["ticker", "value"] },
        sourceBinding,
      ),
      temporalGuard.read(
        adapter,
        { asOf: "2026-08-12", columns: ["value", "ticker"] },
        sourceBinding,
      ),
    ]);

    expect(valueFirst.readSet.queryHash).not.toBe(tickerFirst.readSet.queryHash);
    expect(valueFirst.readSet.result.schemaHash).toBe(tickerFirst.readSet.result.schemaHash);
    expect(valueFirst.readSet.result.resultHash).toBe(tickerFirst.readSet.result.resultHash);
    expect(valueFirst.readSet.result.arrowHash).not.toBe(tickerFirst.readSet.result.arrowHash);
    expect(valueFirst.readSet.manifestHash).not.toBe(tickerFirst.readSet.manifestHash);
  });

  it("canonicalizes binary, bigint, and special floating-point scalars across row order", async () => {
    const rows: readonly PrimitiveRow[] = [
      { id: "nan", metric: Number.NaN, count: 1n, blob: Uint8Array.of(1, 2) },
      { id: "infinity", metric: Number.POSITIVE_INFINITY, count: 2n, blob: Uint8Array.of(3) },
      { id: "negative-zero", metric: -0, count: 3n, blob: Uint8Array.of() },
    ];
    const adapter = normalizeAdapterDeclaration({
      dataset: "primitive-scalars",
      version: "1",
      entity_key: "id",
      event_time: "event_time",
      available_time: "available_time",
      availability_basis: "observed",
      guarantees: { point_in_time: true },
      source: { type: "custom", locator: "logical/primitives" },
    });
    const query = {
      asOf: "2026-08-12",
      columns: ["id", "metric", "count", "blob"],
    } as const;
    const [forward, reverse] = await Promise.all([
      guardedMemory(primitiveTable(rows), "1".repeat(64)).read(
        adapter,
        query,
        createSourceBinding({ id: "forward", backend: "read-set-memory" }),
      ),
      guardedMemory(primitiveTable([...rows].reverse()), "2".repeat(64)).read(
        adapter,
        query,
        createSourceBinding({ id: "reverse", backend: "read-set-memory" }),
      ),
    ]);

    expect(reverse.readSet.result.resultHash).toBe(forward.readSet.result.resultHash);
    expect(reverse.readSet.manifestHash).not.toBe(forward.readSet.manifestHash);
    expect(() =>
      verifyReadSetManifest(forward.readSet, { arrowIpc: forward.arrowIpc }),
    ).not.toThrow();
  });
});
