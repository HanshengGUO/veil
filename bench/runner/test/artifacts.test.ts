import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectArtifactManifest } from "../src/artifacts.ts";

const directories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `veil-${label}-`));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("agent artifact manifests", () => {
  it("hashes a sorted content-addressed file inventory", () => {
    const root = temporaryDirectory("artifacts");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "z.txt"), "z\n");
    writeFileSync(join(root, "nested", "a.txt"), "a\n");

    const first = collectArtifactManifest(root);
    const second = collectArtifactManifest(root);
    expect(first).toEqual(second);
    expect(first.files.map((file) => file.path)).toEqual(["nested/a.txt", "z.txt"]);
    expect(first.treeSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects links instead of hashing files outside the artifact tree", () => {
    const root = temporaryDirectory("artifact-link");
    const outside = temporaryDirectory("artifact-outside");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "secret.txt"));

    expect(() => collectArtifactManifest(root)).toThrow("symbolic link");
  });
});
