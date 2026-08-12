import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  openReadSetSnapshotRecovery,
  openReadSetSnapshotStore,
  READ_SET_SNAPSHOT_FORMAT,
  READ_SET_SNAPSHOT_INSPECTION_FORMAT,
  READ_SET_SNAPSHOT_RECOVERY_FORMAT,
  ReadSetSnapshotRecovery,
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

function recoveryDirectory(root: string, operationId: string): string {
  const hex = operationId.slice("sha256:".length);
  return join(root, "read-set-snapshot-quarantine-v0", hex.slice(0, 2), hex);
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

  it("inspects valid, missing, corrupt, and evidence-mismatched snapshots without mutation", async () => {
    const root = await temporaryRoot("inspect");
    const { result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });
    const missingId = `sha256:${"0".repeat(64)}`;

    expect(await store.inspect(missingId)).toEqual({
      format: READ_SET_SNAPSHOT_INSPECTION_FORMAT,
      id: missingId,
      status: "missing",
      snapshot: null,
    });
    const written = await store.put(result.readSet, result.arrowIpc);
    expect(await store.inspect(written.snapshot.id)).toEqual({
      format: READ_SET_SNAPSHOT_INSPECTION_FORMAT,
      id: written.snapshot.id,
      status: "valid",
      snapshot: written.snapshot,
    });
    expect(
      await store.inspect(written.snapshot.id, {
        sourceFingerprint: {
          algorithm: "sha256",
          value: "0".repeat(64),
          scope: "source-version",
        },
      }),
    ).toMatchObject({ status: "invalid", snapshot: null });
    expect((await store.inspect(written.snapshot.id)).status).toBe("valid");

    await writeFile(
      join(snapshotDirectory(root, written.snapshot.id), "data.arrow"),
      Uint8Array.of(1, 2, 3),
    );
    expect(await store.inspect(written.snapshot.id)).toMatchObject({
      status: "invalid",
      snapshot: null,
    });
    expect(
      await readFile(join(snapshotDirectory(root, written.snapshot.id), "data.arrow")),
    ).toEqual(Buffer.from([1, 2, 3]));
  });

  it("quarantines corrupt evidence with a durable audit, then permits explicit republication", async () => {
    const root = await temporaryRoot("recovery");
    const { result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });
    const written = await store.put(result.readSet, result.arrowIpc);
    const corruptArrow = join(snapshotDirectory(root, written.snapshot.id), "data.arrow");
    await writeFile(corruptArrow, Uint8Array.of(1, 2, 3));

    const recovery = await openReadSetSnapshotRecovery({ root });
    expect(JSON.parse(JSON.stringify(recovery))).toEqual({
      format: READ_SET_SNAPSHOT_RECOVERY_FORMAT,
    });
    expect(JSON.stringify(recovery)).not.toContain(root);
    const record = await recovery.quarantine({
      snapshotId: written.snapshot.id,
      actor: "test.operator",
      reason: "Arrow evidence was truncated during a simulated disk failure.",
    });

    expect(record).toMatchObject({
      format: READ_SET_SNAPSHOT_RECOVERY_FORMAT,
      action: "quarantine",
      outcome: "quarantined",
      snapshotId: written.snapshot.id,
      actor: "test.operator",
    });
    expect(record.operationId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record.auditHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await recovery.read(record.operationId)).toEqual(record);
    expect(await store.inspect(written.snapshot.id)).toMatchObject({ status: "missing" });
    await expect(store.read(written.snapshot.id)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
    });
    const operation = recoveryDirectory(root, record.operationId);
    expect((await readdir(operation)).sort()).toEqual(["intent.json", "object", "result.json"]);
    expect(await readFile(join(operation, "object", "data.arrow"))).toEqual(Buffer.from([1, 2, 3]));

    const republished = await store.put(result.readSet, result.arrowIpc);
    expect(republished.created).toBe(true);
    expect((await store.read(written.snapshot.id)).arrowIpc).toEqual(result.arrowIpc);
    expect(await recovery.read(record.operationId)).toEqual(record);
  });

  it("refuses valid, missing, and malformed recovery targets without moving evidence", async () => {
    const root = await temporaryRoot("recovery-refusal");
    const { result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });
    const written = await store.put(result.readSet, result.arrowIpc);
    const recovery = await openReadSetSnapshotRecovery({ root });

    await expect(
      recovery.quarantine({
        snapshotId: written.snapshot.id,
        actor: "test.operator",
        reason: "This valid object must not move.",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_RECOVERY_REFUSED" });
    expect((await store.read(written.snapshot.id)).arrowIpc).toEqual(result.arrowIpc);

    const hex = written.snapshot.id.slice("sha256:".length);
    const lock = join(
      dirname(snapshotDirectory(root, written.snapshot.id)),
      `.${hex}.recovery-lock`,
    );
    await mkdir(lock);
    await expect(store.put(result.readSet, result.arrowIpc)).rejects.toMatchObject({
      code: "SNAPSHOT_RECOVERY_BUSY",
    });
    await rmdir(lock);

    await expect(
      recovery.quarantine({
        snapshotId: `sha256:${"0".repeat(64)}`,
        actor: "test.operator",
        reason: "A typo must remain a no-op.",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_NOT_FOUND" });
    await expect(
      recovery.quarantine({
        snapshotId: "not-a-hash",
        actor: "test.operator",
        reason: "Malformed identity.",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT_RECOVERY" });
    await expect(
      recovery.quarantine({
        snapshotId: written.snapshot.id,
        actor: "test.operator",
        reason: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT_RECOVERY" });
    await expect(
      recovery.quarantine({
        snapshotId: written.snapshot.id,
        actor: "test.operator",
        reason: "first line\u2028second line",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT_RECOVERY" });
    expect((await store.inspect(written.snapshot.id)).status).toBe("valid");
  });

  it("allows only one concurrent operator to quarantine a corrupt identity", async () => {
    const root = await temporaryRoot("recovery-concurrent");
    const { result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });
    const written = await store.put(result.readSet, result.arrowIpc);
    await writeFile(
      join(snapshotDirectory(root, written.snapshot.id), "data.arrow"),
      Uint8Array.of(1, 2, 3),
    );
    const recovery = await openReadSetSnapshotRecovery({ root });

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        recovery.quarantine({
          snapshotId: written.snapshot.id,
          actor: `operator-${index}`,
          reason: "Concurrent quarantine convergence test.",
        }),
      ),
    );
    const completed = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof recovery.quarantine>>> =>
        attempt.status === "fulfilled",
    );
    expect(completed).toHaveLength(1);
    const rejectionCodes = attempts.flatMap((attempt) =>
      attempt.status === "rejected" &&
      typeof attempt.reason === "object" &&
      attempt.reason !== null &&
      "code" in attempt.reason
        ? [String(attempt.reason.code)]
        : [],
    );
    expect(rejectionCodes).toHaveLength(11);
    expect(
      rejectionCodes.every((code) =>
        ["SNAPSHOT_RECOVERY_BUSY", "SNAPSHOT_NOT_FOUND"].includes(code),
      ),
    ).toBe(true);
    expect(await recovery.read(completed[0].value.operationId)).toEqual(completed[0].value);
    expect((await store.inspect(written.snapshot.id)).status).toBe("missing");
  });

  it("quarantines a snapshot symlink itself and refuses an unsafe shard", async () => {
    const root = await temporaryRoot("recovery-symlink");
    const outside = await temporaryRoot("recovery-outside");
    const { result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });
    const written = await store.put(result.readSet, result.arrowIpc);
    const location = snapshotDirectory(root, written.snapshot.id);
    const outsideFile = join(outside, "outside.txt");
    await writeFile(outsideFile, "outside remains untouched\n");
    await rm(location, { recursive: true });
    await symlink(outsideFile, location, "file");
    expect((await store.inspect(written.snapshot.id)).status).toBe("invalid");

    const recovery = await openReadSetSnapshotRecovery({ root });
    const record = await recovery.quarantine({
      snapshotId: written.snapshot.id,
      actor: "test.operator",
      reason: "The object path was replaced with a symbolic link.",
    });
    expect(
      (await lstat(join(recoveryDirectory(root, record.operationId), "object"))).isSymbolicLink(),
    ).toBe(true);
    expect(await readFile(outsideFile, "utf8")).toBe("outside remains untouched\n");

    const secondRoot = await temporaryRoot("recovery-shard-symlink");
    const secondStore = await openReadSetSnapshotStore({ root: secondRoot });
    const secondWrite = await secondStore.put(result.readSet, result.arrowIpc);
    const secondRecovery = await openReadSetSnapshotRecovery({ root: secondRoot });
    const shard = dirname(snapshotDirectory(secondRoot, secondWrite.snapshot.id));
    await rm(shard, { recursive: true });
    await symlink(outside, shard, "junction");
    expect((await secondStore.inspect(secondWrite.snapshot.id)).status).toBe("invalid");
    await expect(
      secondRecovery.quarantine({
        snapshotId: secondWrite.snapshot.id,
        actor: "test.operator",
        reason: "Unsafe shard must not be followed.",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT_RECOVERY" });
    expect(await readFile(outsideFile, "utf8")).toBe("outside remains untouched\n");
  });

  it("detects tampering in a completed recovery audit", async () => {
    const root = await temporaryRoot("recovery-audit");
    const { result } = await guardedFixture();
    const store = await openReadSetSnapshotStore({ root });
    const written = await store.put(result.readSet, result.arrowIpc);
    await writeFile(
      join(snapshotDirectory(root, written.snapshot.id), "data.arrow"),
      Uint8Array.of(1, 2, 3),
    );
    const recovery = await openReadSetSnapshotRecovery({ root });
    const record = await recovery.quarantine({
      snapshotId: written.snapshot.id,
      actor: "test.operator",
      reason: "Audit tampering test.",
    });
    const resultPath = join(recoveryDirectory(root, record.operationId), "result.json");
    const tampered = JSON.parse(await readFile(resultPath, "utf8")) as { actor: string };
    tampered.actor = "another.operator";
    await writeFile(resultPath, `${JSON.stringify(tampered)}\n`);

    await expect(recovery.read(record.operationId)).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT_RECOVERY",
    });
  });

  it("protects recovery construction with the same validated root boundary", async () => {
    const root = await temporaryRoot("recovery-constructor");
    await expect(openReadSetSnapshotRecovery({ root: "relative-store" })).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT_STORE",
    });
    const UnsafeConstructor = ReadSetSnapshotRecovery as unknown as new (root: string) => unknown;
    expect(() => new UnsafeConstructor(root)).toThrowError(
      expect.objectContaining({ code: "INVALID_SNAPSHOT_RECOVERY" }),
    );
  });
});
