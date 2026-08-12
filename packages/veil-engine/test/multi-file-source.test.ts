import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromIPC } from "apache-arrow";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertUnchangedFileSource,
  captureBoundFileSource,
  withStableFileSource,
} from "../src/file-source.ts";
import {
  BackendRegistry,
  createSourceBinding,
  DUCKDB_FILE_BACKEND_ID,
  DuckDbFileBackend,
  TemporalGuard,
  verifyReadSetManifest,
} from "../src/index.ts";

const HEADER = "ticker,event_time,available_time,value\n";
const PART_A = `${HEADER}PAST,2026-08-10T00:00:00Z,2026-08-11T00:00:00Z,1.5\nFUTURE,2026-08-12T00:00:00Z,2026-08-13T00:00:00Z,99\n`;
const PART_B = `${HEADER}BOUNDARY,2026-08-11T00:00:00Z,2026-08-12T00:00:00Z,2.5\n`;
const PART_C_FUTURE = `${HEADER}LATER,2026-08-13T00:00:00Z,2026-08-14T00:00:00Z,4.5\n`;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function declaration(locator = "parts/*.csv") {
  return normalizeAdapterDeclaration({
    dataset: "multi-file-prices",
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

function guard(): TemporalGuard {
  const registry = new BackendRegistry();
  registry.register(new DuckDbFileBackend());
  return new TemporalGuard(registry);
}

function binding(root: string, id: string) {
  return createSourceBinding({
    id,
    backend: DUCKDB_FILE_BACKEND_ID,
    options: { root },
  });
}

async function sourceRoot(label: string, reverseCreation = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `veil-multi-${label}-`));
  temporaryRoots.push(root);
  await mkdir(join(root, "parts"));
  const files: ReadonlyArray<readonly [string, string]> = [
    ["a.csv", PART_A],
    ["b.csv", PART_B],
  ];
  for (const [name, content] of reverseCreation ? [...files].reverse() : files) {
    await writeFile(join(root, "parts", name), content);
  }
  const timestamp =
    label === "first" ? new Date("2001-01-01T00:00:00Z") : new Date("2031-01-01T00:00:00Z");
  await Promise.all(files.map(([name]) => utimes(join(root, "parts", name), timestamp, timestamp)));
  return root;
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

describe("multi-file source manifests", () => {
  it("reads a sorted file set with identity independent of root and creation order", async () => {
    const firstRoot = await sourceRoot("first", true);
    const secondRoot = await sourceRoot("second");
    const adapter = declaration();
    const [first, second] = await Promise.all([
      guard().read(
        adapter,
        { asOf: "2026-08-12", columns: ["ticker", "value"] },
        binding(firstRoot, "first-machine"),
      ),
      guard().read(
        adapter,
        { asOf: "2026-08-12", columns: ["ticker", "value"] },
        binding(secondRoot, "second-machine"),
      ),
    ]);

    const table = tableFromIPC(first.arrowIpc);
    expect(table.getChild("ticker")?.toArray()).toEqual(["PAST", "BOUNDARY"]);
    expect(first.sourceFingerprint).toEqual(second.sourceFingerprint);
    expect(first.readSet).toEqual(second.readSet);
    expect(first.sourceFingerprint?.manifest?.files).toEqual([
      {
        logicalName: "parts/a.csv",
        byteLength: Buffer.byteLength(PART_A),
        contentHash: sha256(PART_A),
      },
      {
        logicalName: "parts/b.csv",
        byteLength: Buffer.byteLength(PART_B),
        contentHash: sha256(PART_B),
      },
    ]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(firstRoot);
    expect(serialized).not.toContain(secondRoot);
    expect(serialized).not.toContain("first-machine");
    expect(serialized).not.toContain("second-machine");

    const tampered = JSON.parse(JSON.stringify(first.readSet)) as {
      source: {
        fingerprint: { manifest: { files: Array<{ byteLength: number }> } };
      };
    };
    const firstFile = tampered.source.fingerprint.manifest.files[0];
    if (firstFile === undefined) {
      throw new Error("multi-file read-set fixture has no source members");
    }
    firstFile.byteLength += 1;
    expect(() =>
      verifyReadSetManifest(tampered, {
        arrowIpc: first.arrowIpc,
        expectedManifestHash: first.readSet.manifestHash,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_READ_SET" }));
  });

  it("changes source identity when a matching member is added without changing guarded rows", async () => {
    const root = await sourceRoot("membership");
    const adapter = declaration();
    const sourceBinding = binding(root, "membership");
    const first = await guard().read(adapter, { asOf: "2026-08-12" }, sourceBinding);
    await writeFile(join(root, "parts", "c.csv"), PART_C_FUTURE);
    const second = await guard().read(adapter, { asOf: "2026-08-12" }, sourceBinding);

    expect(second.sourceFingerprint?.value).not.toBe(first.sourceFingerprint?.value);
    expect(second.sourceFingerprint?.manifest?.files).toHaveLength(3);
    expect(second.readSet.result.resultHash).toBe(first.readSet.result.resultHash);
    expect(second.readSet.manifestHash).not.toBe(first.readSet.manifestHash);
  });

  it("detects added, removed, and replaced members as source changes", async () => {
    const root = await sourceRoot("changes");
    const before = await captureBoundFileSource(root, "parts/*.csv");

    await writeFile(join(root, "parts", "c.csv"), PART_C_FUTURE);
    const added = await captureBoundFileSource(root, "parts/*.csv");
    expect(() => assertUnchangedFileSource(before, added)).toThrowError(
      expect.objectContaining({ code: "SOURCE_CHANGED" }),
    );

    await rm(join(root, "parts", "c.csv"));
    await writeFile(join(root, "parts", "b.csv"), PART_C_FUTURE);
    const replaced = await captureBoundFileSource(root, "parts/*.csv");
    expect(() => assertUnchangedFileSource(before, replaced)).toThrowError(
      expect.objectContaining({ code: "SOURCE_CHANGED" }),
    );

    await rm(join(root, "parts", "b.csv"));
    const removed = await captureBoundFileSource(root, "parts/*.csv");
    expect(() => assertUnchangedFileSource(before, removed)).toThrowError(
      expect.objectContaining({ code: "SOURCE_CHANGED" }),
    );
  });

  it("fails a live file operation when membership changes after its first capture", async () => {
    const root = await sourceRoot("live-change");

    await expect(
      withStableFileSource(root, "parts/*.csv", async (source) => {
        expect(source.paths).toHaveLength(2);
        await writeFile(join(root, "parts", "c.csv"), PART_C_FUTURE);
        return "must-not-escape";
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("supports recursive globs and rejects unsafe or empty patterns without leaking roots", async () => {
    const root = await sourceRoot("patterns");
    await mkdir(join(root, "parts", "nested"));
    await writeFile(join(root, "parts", "nested", "c.csv"), PART_C_FUTURE);
    const recursive = await guard().read(
      declaration("parts/**/*.csv"),
      { asOf: "2026-08-12" },
      binding(root, "recursive"),
    );
    expect(recursive.sourceFingerprint?.manifest?.files.map((file) => file.logicalName)).toEqual([
      "parts/a.csv",
      "parts/b.csv",
      "parts/nested/c.csv",
    ]);

    for (const locator of ["../*.csv", "parts/[ab].csv", "missing/*.csv"]) {
      const failure: unknown = await guard()
        .read(declaration(locator), { asOf: "2026-08-12" }, binding(root, "unsafe"))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "INVALID_SOURCE" });
      expect(String(failure)).not.toContain(root);
    }
  });
});
