import { describe, expect, it } from "vitest";
import {
  createSourceManifest,
  SOURCE_MANIFEST_FORMAT,
  sourceFingerprintFromManifest,
  verifySourceManifest,
} from "../src/index.ts";

const A_HASH = `sha256:${"a".repeat(64)}`;
const B_HASH = `sha256:${"b".repeat(64)}`;

describe("source manifest v0", () => {
  it("sorts portable logical names and independently verifies its identity", () => {
    const manifest = createSourceManifest([
      { logicalName: "years/2026.csv", byteLength: 26, contentHash: B_HASH },
      { logicalName: "years/2025.csv", byteLength: 25, contentHash: A_HASH },
    ]);

    expect(manifest.format).toBe(SOURCE_MANIFEST_FORMAT);
    expect(manifest.files.map((file) => file.logicalName)).toEqual([
      "years/2025.csv",
      "years/2026.csv",
    ]);
    expect(manifest.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifySourceManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.files)).toBe(true);

    const reversed = createSourceManifest([...manifest.files].reverse());
    expect(reversed).toEqual(manifest);
    const fingerprint = sourceFingerprintFromManifest(manifest);
    expect(fingerprint).toEqual({
      algorithm: "sha256",
      value: manifest.manifestHash.slice("sha256:".length),
      scope: "source-version",
      manifest,
    });
  });

  it("rejects reordered, tampered, duplicate, and non-portable evidence", () => {
    const manifest = createSourceManifest([
      { logicalName: "a.csv", byteLength: 1, contentHash: A_HASH },
      { logicalName: "b.csv", byteLength: 1, contentHash: B_HASH },
    ]);
    const reordered = JSON.parse(JSON.stringify(manifest)) as {
      files: unknown[];
    };
    reordered.files.reverse();
    expect(() => verifySourceManifest(reordered)).toThrowError(
      expect.objectContaining({ code: "INVALID_SOURCE_MANIFEST" }),
    );

    const tampered = JSON.parse(JSON.stringify(manifest)) as {
      files: Array<{ byteLength: number }>;
    };
    const firstFile = tampered.files[0];
    if (firstFile === undefined) {
      throw new Error("source manifest fixture has no files");
    }
    firstFile.byteLength += 1;
    expect(() => verifySourceManifest(tampered)).toThrowError(
      expect.objectContaining({ code: "INVALID_SOURCE_MANIFEST" }),
    );

    expect(() =>
      createSourceManifest([
        { logicalName: "same.csv", byteLength: 1, contentHash: A_HASH },
        { logicalName: "same.csv", byteLength: 1, contentHash: B_HASH },
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE_MANIFEST" }));
    for (const logicalName of ["../escape.csv", "/absolute.csv", "a\\b.csv", "a//b.csv"]) {
      expect(() =>
        createSourceManifest([{ logicalName, byteLength: 1, contentHash: A_HASH }]),
      ).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE_MANIFEST" }));
    }
  });
});
