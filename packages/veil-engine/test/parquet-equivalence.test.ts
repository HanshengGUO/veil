import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { type Table, tableFromIPC } from "apache-arrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  TemporalGuard,
} from "../src/index.ts";

const fixturesRoot = fileURLToPath(new URL("fixtures/", import.meta.url));
let generatedRoot: string;

function declaration(type: "csv" | "parquet", locator: string) {
  return normalizeAdapterDeclaration({
    dataset: "file-equivalence",
    version: "1",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true },
    payload_schema: { value: "float64" },
    source: { type, locator },
  });
}

function guard(): TemporalGuard {
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  return new TemporalGuard(registry);
}

function binding() {
  return createSourceBinding({
    id: "file-equivalence",
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root: generatedRoot },
  });
}

function schema(table: Table): readonly (readonly [string, string])[] {
  return table.schema.fields.map((field) => [field.name, field.type.toString()] as const);
}

function column(table: Table, name: string): unknown[] {
  const vector = table.getChild(name);
  if (vector === null) {
    throw new Error(`missing test column ${name}`);
  }
  return Array.from({ length: table.numRows }, (_, index) => vector.get(index));
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

beforeAll(async () => {
  generatedRoot = await mkdtemp(join(tmpdir(), "veil-parquet-equivalence-"));
  const csvPath = join(generatedRoot, "metamorphic.csv");
  const parquetPath = join(generatedRoot, "metamorphic.parquet");
  const invalidTemporalPath = join(generatedRoot, "invalid-temporal.parquet");
  await copyFile(join(fixturesRoot, "metamorphic.csv"), csvPath);

  const duckdb = await import("@duckdb/node-api");
  const instance = await duckdb.DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("set threads = 1");
    const csvScan = `read_csv(${sqlString(csvPath)}, header = true, auto_detect = true, sample_size = -1, strict_mode = true, null_padding = false)`;
    await connection.run(
      `copy (select value, available_time, ticker, event_time from ${csvScan} order by ticker) to ${sqlString(parquetPath)} (format parquet)`,
    );
    const invalidScan = `read_csv(${sqlString(join(fixturesRoot, "invalid-temporal.csv"))}, header = true, auto_detect = true, sample_size = -1, strict_mode = true, null_padding = false)`;
    await connection.run(
      `copy (select * from ${invalidScan}) to ${sqlString(invalidTemporalPath)} (format parquet)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

afterAll(async () => {
  await rm(generatedRoot, { recursive: true, force: true });
});

describe("DuckDB file backend format equivalence", () => {
  it("returns the same guarded rows and canonical schema from CSV and reordered Parquet", async () => {
    const temporalGuard = guard();
    const sourceBinding = binding();
    const [csv, parquet] = await Promise.all([
      temporalGuard.read(
        declaration("csv", "metamorphic.csv"),
        { asOf: "2026-08-12", columns: ["ticker", "value"] },
        sourceBinding,
      ),
      temporalGuard.read(
        declaration("parquet", "metamorphic.parquet"),
        { asOf: "2026-08-12", columns: ["ticker", "value"] },
        sourceBinding,
      ),
    ]);
    const csvTable = tableFromIPC(csv.arrowIpc);
    const parquetTable = tableFromIPC(parquet.arrowIpc);

    expect(schema(parquetTable)).toEqual(schema(csvTable));
    expect(schema(csvTable)).toEqual([
      ["ticker", "Utf8"],
      ["value", "Float64"],
    ]);
    expect(column(csvTable, "ticker")).toEqual(["PAST", "NULLPAYLOAD", "BOUNDARY"]);
    expect(column(parquetTable, "ticker")).toEqual(["BOUNDARY", "NULLPAYLOAD", "PAST"]);
    expect(column(csvTable, "value")).toEqual([1.5, null, 2.5]);
    expect(column(parquetTable, "value")).toEqual([2.5, null, 1.5]);
    expect(csv.sourceFingerprint?.algorithm).toBe("sha256");
    expect(parquet.sourceFingerprint?.algorithm).toBe("sha256");
    expect(parquet.sourceFingerprint?.value).not.toBe(csv.sourceFingerprint?.value);
    expect(parquet.readSet.declarationHash).not.toBe(csv.readSet.declarationHash);
    expect(parquet.readSet.queryHash).toBe(csv.readSet.queryHash);
    expect(parquet.readSet.result.schemaHash).toBe(csv.readSet.result.schemaHash);
    expect(parquet.readSet.result.resultHash).toBe(csv.readSet.result.resultHash);
    expect(parquet.readSet.result.arrowHash).not.toBe(csv.readSet.result.arrowHash);
    expect(parquet.readSet.manifestHash).not.toBe(csv.readSet.manifestHash);
    expect(csv.audit.backendClaimedProjectionPushdown).toBe(true);
    expect(parquet.audit.backendClaimedProjectionPushdown).toBe(true);
    expect(csv.audit.backendClaimedTemporalPushdown).toBe(true);
    expect(parquet.audit.backendClaimedTemporalPushdown).toBe(true);
  });

  it("preserves the same projected schema when both formats return an empty view", async () => {
    const temporalGuard = guard();
    const sourceBinding = binding();
    const [csv, parquet] = await Promise.all([
      temporalGuard.read(
        declaration("csv", "metamorphic.csv"),
        { asOf: "2000-01-01", columns: ["ticker", "value"] },
        sourceBinding,
      ),
      temporalGuard.read(
        declaration("parquet", "metamorphic.parquet"),
        { asOf: "2000-01-01", columns: ["ticker", "value"] },
        sourceBinding,
      ),
    ]);
    const csvTable = tableFromIPC(csv.arrowIpc);
    const parquetTable = tableFromIPC(parquet.arrowIpc);

    expect(csvTable.numRows).toBe(0);
    expect(parquetTable.numRows).toBe(0);
    expect(schema(parquetTable)).toEqual(schema(csvTable));
    expect(parquet.readSet.result.resultHash).toBe(csv.readSet.result.resultHash);
  });

  it("canonicalizes physical column and row order when no projection is requested", async () => {
    const temporalGuard = guard();
    const sourceBinding = binding();
    const [csv, parquet] = await Promise.all([
      temporalGuard.read(
        declaration("csv", "metamorphic.csv"),
        { asOf: "2026-08-12" },
        sourceBinding,
      ),
      temporalGuard.read(
        declaration("parquet", "metamorphic.parquet"),
        { asOf: "2026-08-12" },
        sourceBinding,
      ),
    ]);

    expect(schema(tableFromIPC(parquet.arrowIpc))).not.toEqual(schema(tableFromIPC(csv.arrowIpc)));
    expect(parquet.readSet.result.schema).toEqual(csv.readSet.result.schema);
    expect(parquet.readSet.result.schemaHash).toBe(csv.readSet.result.schemaHash);
    expect(parquet.readSet.result.resultHash).toBe(csv.readSet.result.resultHash);
  });

  it("routes invalid Parquet temporal values through the common C1 guard", async () => {
    await expect(
      guard().read(
        declaration("parquet", "invalid-temporal.parquet"),
        { asOf: "2026-08-12" },
        binding(),
      ),
    ).rejects.toMatchObject({ invariant: "C1" });
  });
});
