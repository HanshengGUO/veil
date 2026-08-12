import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  openReadSetSnapshotStore,
  READ_SET_SNAPSHOT_FORMAT,
  ReadSetSnapshotStore,
  TemporalGuard,
} from "../src/index.ts";

const fixturesRoot = fileURLToPath(new URL("fixtures/", import.meta.url));
const snapshotRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    snapshotRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `veil-snapshot-${label}-`));
  snapshotRoots.push(root);
  return root;
}

async function guardedFixture() {
  const declaration = normalizeAdapterDeclaration({
    dataset: "snapshot-prices",
    version: "1",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true },
    payload_schema: { value: "float64" },
    source: { type: "csv", locator: "temporal.csv" },
  });
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  const result = await new TemporalGuard(registry).read(
    declaration,
    { asOf: "2026-08-12", columns: ["ticker", "value"] },
    createSourceBinding({
      id: "snapshot-fixture",
      backend: DUCKDB_FILE_BACKEND_ID,
      options: { root: fixturesRoot },
    }),
  );
  return { declaration, result };
}

function snapshotDirectory(root: string, id: string): string {
  const hex = id.slice("sha256:".length);
  return join(root, "read-set-snapshots-v0", hex.slice(0, 2), hex);
}

describe("read-set snapshot store", () => {
  it("durably publishes and independently reloads guarded Arrow evidence", async () => {
    const root = await temporaryRoot("roundtrip");
    const { declaration, result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });

    expect(JSON.parse(JSON.stringify(store))).toEqual({ format: READ_SET_SNAPSHOT_FORMAT });
    expect(JSON.stringify(store)).not.toContain(root);

    const first = await store.put(result.readSet, result.arrowIpc);
    const repeated = await store.put(result.readSet, result.arrowIpc);

    expect(first.created).toBe(true);
    expect(repeated).toEqual({ created: false, snapshot: first.snapshot });
    expect(first.snapshot).toEqual({
      format: READ_SET_SNAPSHOT_FORMAT,
      id: result.readSet.manifestHash,
      rowCount: result.readSet.result.rowCount,
      resultHash: result.readSet.result.resultHash,
      arrowHash: result.readSet.result.arrowHash,
    });

    const loaded = await store.read(first.snapshot.id, {
      declaration,
      sourceFingerprint: result.sourceFingerprint,
    });
    expect(loaded.manifest).toEqual(result.readSet);
    expect(loaded.arrowIpc).toEqual(result.arrowIpc);
    expect((await readdir(snapshotDirectory(root, first.snapshot.id))).sort()).toEqual([
      "data.arrow",
      "manifest.json",
    ]);

    loaded.arrowIpc[0] = loaded.arrowIpc[0] ^ 0xff;
    expect((await store.read(first.snapshot.id)).arrowIpc).toEqual(result.arrowIpc);
  });

  it("allows exactly one concurrent writer to publish an identity", async () => {
    const root = await temporaryRoot("concurrent");
    const { result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });

    const writes = await Promise.all(
      Array.from({ length: 16 }, () => store.put(result.readSet, result.arrowIpc)),
    );
    expect(writes.filter((write) => write.created)).toHaveLength(1);
    expect(new Set(writes.map((write) => write.snapshot.id))).toEqual(
      new Set([result.readSet.manifestHash]),
    );

    const location = snapshotDirectory(root, result.readSet.manifestHash);
    expect((await readdir(dirname(location))).sort()).toEqual([basename(location)]);
    expect((await store.read(result.readSet.manifestHash)).arrowIpc).toEqual(result.arrowIpc);
  });

  it("fails closed for missing, truncated, and tampered objects", async () => {
    const { result } = await guardedFixture();

    const missingRoot = await temporaryRoot("missing");
    const missingStore = await openReadSetSnapshotStore({ root: missingRoot });
    await missingStore.put(result.readSet, result.arrowIpc);
    const missingLocation = snapshotDirectory(missingRoot, result.readSet.manifestHash);
    await rm(join(missingLocation, "data.arrow"));
    await expect(missingStore.read(result.readSet.manifestHash)).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT",
    });
    await rm(missingLocation, { recursive: true });
    await expect(missingStore.read(result.readSet.manifestHash)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
    });

    const truncatedRoot = await temporaryRoot("truncated");
    const truncatedStore = await openReadSetSnapshotStore({ root: truncatedRoot });
    await truncatedStore.put(result.readSet, result.arrowIpc);
    const truncatedArrow = join(
      snapshotDirectory(truncatedRoot, result.readSet.manifestHash),
      "data.arrow",
    );
    await writeFile(truncatedArrow, Uint8Array.of(1, 2, 3));
    await expect(truncatedStore.read(result.readSet.manifestHash)).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT",
    });
    await expect(truncatedStore.put(result.readSet, result.arrowIpc)).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT",
    });
    expect(await readFile(truncatedArrow)).toEqual(Buffer.from([1, 2, 3]));

    const tamperedRoot = await temporaryRoot("tampered");
    const tamperedStore = await openReadSetSnapshotStore({ root: tamperedRoot });
    await tamperedStore.put(result.readSet, result.arrowIpc);
    const manifestPath = join(
      snapshotDirectory(tamperedRoot, result.readSet.manifestHash),
      "manifest.json",
    );
    const tampered = JSON.parse(await readFile(manifestPath, "utf8")) as {
      result: { rowCount: number };
    };
    tampered.result.rowCount += 1;
    await writeFile(manifestPath, `${JSON.stringify(tampered)}\n`);
    await expect(tamperedStore.read(result.readSet.manifestHash)).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT",
    });
  });

  it("keeps snapshot identity stable when the store moves to another path", async () => {
    const sourceRoot = await temporaryRoot("source-path");
    const targetRoot = await temporaryRoot("target-path");
    const { declaration, result } = await guardedFixture();
    const sourceStore = await openReadSetSnapshotStore({ root: sourceRoot });
    const written = await sourceStore.put(result.readSet, result.arrowIpc);

    await cp(join(sourceRoot, "read-set-snapshots-v0"), join(targetRoot, "read-set-snapshots-v0"), {
      recursive: true,
    });
    const targetStore = await openReadSetSnapshotStore({ root: targetRoot });
    const loaded = await targetStore.read(written.snapshot.id, {
      declaration,
      sourceFingerprint: result.sourceFingerprint,
    });

    expect(loaded.manifest).toEqual(result.readSet);
    expect(loaded.arrowIpc).toEqual(result.arrowIpc);
    expect(JSON.stringify(loaded.manifest)).not.toContain(sourceRoot);
    expect(JSON.stringify(loaded.manifest)).not.toContain(targetRoot);
  });

  it("rejects unsafe roots and mismatched replay evidence without leaking paths", async () => {
    const root = await temporaryRoot("evidence");
    const { result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });
    await store.put(result.readSet, result.arrowIpc);

    await expect(
      store.read(result.readSet.manifestHash, {
        sourceFingerprint: {
          algorithm: "sha256",
          value: "0".repeat(64),
          scope: "source-version",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT" });
    await expect(openReadSetSnapshotStore({ root: "relative-store" })).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT_STORE",
    });
    await expect(openReadSetSnapshotStore({ root: "/" })).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT_STORE",
    });
    const UnsafeConstructor = ReadSetSnapshotStore as unknown as new (root: string) => unknown;
    expect(() => new UnsafeConstructor(root)).toThrowError(
      expect.objectContaining({ code: "INVALID_SNAPSHOT_STORE" }),
    );
  });
});
