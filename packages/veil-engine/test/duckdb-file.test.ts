import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromIPC } from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  TemporalGuard,
} from "../src/index.ts";

const fixturesRoot = fileURLToPath(new URL("fixtures/", import.meta.url));

function csvDeclaration(locator = "temporal.csv") {
  return normalizeAdapterDeclaration({
    dataset: "csv-prices",
    version: "1",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true },
    payload_schema: { value: "float64" },
    source: { type: "csv", locator },
  });
}

function guardedCsv(): TemporalGuard {
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  return new TemporalGuard(registry);
}

function binding(root = fixturesRoot) {
  return createSourceBinding({
    id: "test-csv",
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root },
  });
}

describe("DuckDB CSV backend", () => {
  it("serves a projected point-in-time view with boundary equality and a content fingerprint", async () => {
    const sourcePath = join(fixturesRoot, "temporal.csv");
    const sourceBytes = await readFile(sourcePath);
    const expectedHash = createHash("sha256").update(sourceBytes).digest("hex");

    const result = await guardedCsv().read(
      csvDeclaration(),
      { asOf: "2026-08-12", columns: ["ticker", "value"] },
      binding(),
    );
    const table = tableFromIPC(result.arrowIpc);

    expect(table.schema.fields.map((field) => field.name)).toEqual(["ticker", "value"]);
    expect(table.numRows).toBe(2);
    expect(table.getChild("ticker")?.toArray()).toEqual(["PAST", "BOUNDARY"]);
    expect(table.getChild("value")?.toArray()).toEqual(new Float64Array([1.5, 2.5]));
    expect(result.audit.backendClaimedProjectionPushdown).toBe(true);
    expect(result.audit.backendClaimedTemporalPushdown).toBe(true);
    expect(result.audit.droppedFutureRows).toBe(0);
    expect(result.sourceFingerprint).toMatchObject({
      algorithm: "sha256",
      scope: "source-version",
    });
    expect(result.sourceFingerprint?.manifest?.files).toEqual([
      {
        logicalName: "temporal.csv",
        byteLength: sourceBytes.byteLength,
        contentHash: `sha256:${expectedHash}`,
      },
    ]);
    expect(result.sourceFingerprint?.value).toBe(
      result.sourceFingerprint?.manifest?.manifestHash.slice("sha256:".length),
    );
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
  });

  it("preserves the projected Arrow schema when pushdown returns no rows", async () => {
    const result = await guardedCsv().read(
      csvDeclaration(),
      { asOf: "2000-01-01", columns: ["ticker", "value"] },
      binding(),
    );
    const table = tableFromIPC(result.arrowIpc);

    expect(table.numRows).toBe(0);
    expect(table.schema.fields.map((field) => [field.name, field.type.toString()])).toEqual([
      ["ticker", "Utf8"],
      ["value", "Float64"],
    ]);
  });

  it("uses event_time with the same backend when availability is undeclared", async () => {
    const declaration = normalizeAdapterDeclaration({
      dataset: "csv-events",
      version: "1",
      entity_key: "ticker",
      event_time: "event_time",
      available_time: null,
      source: { type: "csv", locator: "temporal.csv" },
    });
    const result = await guardedCsv().read(declaration, { asOf: "2026-08-11" }, binding());

    expect(tableFromIPC(result.arrowIpc).numRows).toBe(2);
    expect(result.semantics.degradations).toContain("PIT_UNSAFE");
    expect(result.audit.backendClaimedTemporalPushdown).toBe(true);
  });

  it("falls back to the common guard so invalid temporal values fail as C1", async () => {
    await expect(
      guardedCsv().read(csvDeclaration("invalid-temporal.csv"), { asOf: "2026-08-12" }, binding()),
    ).rejects.toMatchObject({ invariant: "C1" });
  });

  it("isolates concurrent decision times without shared mutable query state", async () => {
    const guard = guardedCsv();
    const sourceBinding = binding();
    const [early, late] = await Promise.all([
      guard.read(csvDeclaration(), { asOf: "2026-08-11" }, sourceBinding),
      guard.read(csvDeclaration(), { asOf: "2026-08-13" }, sourceBinding),
    ]);

    expect(tableFromIPC(early.arrowIpc).numRows).toBe(1);
    expect(tableFromIPC(late.arrowIpc).numRows).toBe(3);
  });

  it("separates changed source identity from an unchanged guarded result", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "veil-csv-"));
    try {
      await copyFile(join(fixturesRoot, "temporal.csv"), join(temporaryRoot, "temporal.csv"));
      const first = await guardedCsv().read(
        csvDeclaration(),
        { asOf: "2026-08-12" },
        binding(temporaryRoot),
      );
      await appendFile(
        join(temporaryRoot, "temporal.csv"),
        "LATER,2026-08-13T00:00:00Z,2026-08-14T00:00:00Z,4.5\n",
      );
      const second = await guardedCsv().read(
        csvDeclaration(),
        { asOf: "2026-08-12" },
        binding(temporaryRoot),
      );

      expect(second.sourceFingerprint?.value).not.toBe(first.sourceFingerprint?.value);
      expect(second.readSet.queryHash).toBe(first.readSet.queryHash);
      expect(second.readSet.result.resultHash).toBe(first.readSet.result.resultHash);
      expect(second.readSet.result.arrowHash).toBe(first.readSet.result.arrowHash);
      expect(second.readSet.manifestHash).not.toBe(first.readSet.manifestHash);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a locator that escapes the binding root without echoing an absolute path", async () => {
    const escapedLocator = join("..", basename(fileURLToPath(import.meta.url)));
    const failure: unknown = await guardedCsv()
      .read(csvDeclaration(escapedLocator), { asOf: "2026-08-12" }, binding())
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "INVALID_SOURCE" });
    expect(String(failure)).not.toContain(dirname(fixturesRoot));
  });
});
