import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableFromIPC } from "apache-arrow";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  loadAdapterFile,
  TemporalGuard,
} from "../../packages/veil-engine/src/index.ts";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const generatedRoot = await mkdtemp(join(tmpdir(), "veil-parquet-pit-"));
try {
  const csvPath = fileURLToPath(new URL("../csv-pit/data/prices.csv", import.meta.url));
  const parquetPath = join(generatedRoot, "prices.parquet");
  const duckdb = await import("@duckdb/node-api");
  const instance = await duckdb.DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("set threads = 1");
    const csvScan = `read_csv(${sqlString(csvPath)}, header = true, auto_detect = true, sample_size = -1, strict_mode = true, null_padding = false)`;
    await connection.run(
      `copy (select value, available_time, ticker, event_time from ${csvScan}) to ${sqlString(parquetPath)} (format parquet)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  const declaration = await loadAdapterFile(new URL("adapter.yaml", import.meta.url));
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  const result = await new TemporalGuard(registry).read(
    declaration,
    { asOf: "2026-08-12", columns: ["ticker", "value"] },
    createSourceBinding({
      id: "parquet-pit-example",
      backend: DUCKDB_FILE_BACKEND_ID,
      options: { root: generatedRoot },
    }),
  );
  const table = tableFromIPC(result.arrowIpc);
  const tickers = [...(table.getChild("ticker")?.toArray() ?? [])];

  if (JSON.stringify(tickers) !== JSON.stringify(["PAST", "BOUNDARY"])) {
    throw new Error(`future sentinel crossed the guard: ${JSON.stringify(tickers)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      rows: table.numRows,
      tickers,
      futureRowsVisible: tickers.includes("FUTURE"),
      fingerprint: result.sourceFingerprint?.algorithm,
      temporalPushdown: result.audit.backendClaimedTemporalPushdown,
    }),
  );
} finally {
  await rm(generatedRoot, { recursive: true, force: true });
}
