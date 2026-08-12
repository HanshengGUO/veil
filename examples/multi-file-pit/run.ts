import { fileURLToPath } from "node:url";
import { tableFromIPC } from "apache-arrow";
import {
  BackendRegistry,
  createSourceBinding,
  DuckDbFileBackend,
  loadAdapterFile,
  TemporalGuard,
  verifySourceManifest,
} from "../../packages/veil-engine/src/index.ts";

const root = fileURLToPath(new URL("./", import.meta.url));
const declaration = await loadAdapterFile(new URL("adapter.yaml", import.meta.url));
const backend = new DuckDbFileBackend();
const registry = new BackendRegistry();
registry.register(backend);

const result = await new TemporalGuard(registry).read(
  declaration,
  { asOf: "2026-08-12", columns: ["ticker", "value"] },
  createSourceBinding({
    id: "multi-file-example",
    backend: backend.id,
    options: { root },
  }),
);
const sourceManifest = result.sourceFingerprint?.manifest;
if (sourceManifest === undefined) {
  throw new Error("default file backend omitted its source manifest");
}
const verified = verifySourceManifest(JSON.parse(JSON.stringify(sourceManifest)));
const table = tableFromIPC(result.arrowIpc);

console.log(
  JSON.stringify({
    ok: true,
    rows: table.numRows,
    tickers: table.getChild("ticker")?.toArray(),
    files: verified.files.map((file) => file.logicalName),
    sourceManifestHash: verified.manifestHash,
    resultHash: result.readSet.result.resultHash,
  }),
);
