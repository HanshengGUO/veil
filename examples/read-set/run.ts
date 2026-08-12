import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  loadAdapterFile,
  TemporalGuard,
  verifyReadSetManifest,
} from "../../packages/veil-engine/src/index.ts";

const sourceRoot = fileURLToPath(new URL("../csv-pit/", import.meta.url));
const declaration = await loadAdapterFile(new URL("adapter.yaml", import.meta.url));
const registry = new BackendRegistry();
registry.register(new DuckDbFileBackend());

const result = await new TemporalGuard(registry).read(
  declaration,
  { asOf: "2026-08-12", columns: ["ticker", "value"] },
  createSourceBinding({
    id: "read-set-example",
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root: sourceRoot },
  }),
);

const snapshotRoot = await mkdtemp(join(tmpdir(), "veil-read-set-"));
try {
  const manifestPath = join(snapshotRoot, "read-set.json");
  const arrowPath = join(snapshotRoot, "data.arrow");
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(result.readSet, null, 2)}\n`, "utf8"),
    writeFile(arrowPath, result.arrowIpc),
  ]);

  const storedManifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const storedArrow = await readFile(arrowPath);
  const verified = verifyReadSetManifest(storedManifest, {
    arrowIpc: storedArrow,
    declaration,
    sourceFingerprint: result.sourceFingerprint,
    expectedManifestHash: result.readSet.manifestHash,
  });

  console.log(
    JSON.stringify({
      ok: true,
      format: verified.format,
      rows: verified.result.rowCount,
      declarationHash: verified.declarationHash,
      queryHash: verified.queryHash,
      sourceFingerprint: verified.source.fingerprint?.algorithm ?? null,
      resultHash: verified.result.resultHash,
      arrowHash: verified.result.arrowHash,
      manifestHash: verified.manifestHash,
    }),
  );
} finally {
  await rm(snapshotRoot, { recursive: true, force: true });
}
