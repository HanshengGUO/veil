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

const root = fileURLToPath(new URL(".", import.meta.url));
const declaration = await loadAdapterFile(new URL("adapter.yaml", import.meta.url));
const registry = new BackendRegistry();
registry.register(new DuckDbFileBackend());

const result = await new TemporalGuard(registry).read(
  declaration,
  { asOf: "2026-08-12", columns: ["ticker", "value"] },
  createSourceBinding({
    id: "csv-pit-example",
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root },
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
