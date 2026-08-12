import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdapterDeclaration, normalizeAdapterDeclaration } from "@veilquant/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_CODE_FORMAT,
  ARTIFACT_FORMAT,
  type ArtifactCodeManifest,
  type CreateArtifactManifestInput,
  captureArtifactCode,
  createArtifactManifest,
  verifyArtifactCode,
  verifyArtifactCodeManifest,
  verifyArtifactManifest,
} from "../src/index.ts";

const READ_SET_A = `sha256:${"a".repeat(64)}`;
const READ_SET_B = `sha256:${"b".repeat(64)}`;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function declaration(dataset = "artifact-prices", version = "1"): AdapterDeclaration {
  return normalizeAdapterDeclaration({
    dataset,
    version,
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true, tradability_mask: "tradable" },
    payload_schema: { tradable: "bool", value: "float64" },
    source: { type: "csv", locator: "prices.csv" },
  });
}

async function codeRoot(label: string, reverse = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `veil-artifact-${label}-`));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"));
  const files: ReadonlyArray<readonly [string, string]> = [
    ["src/factor.py", "def compute(data_view):\n    return data_view\n"],
    ["requirements.lock", "pyarrow==21.0.0\n"],
  ];
  for (const [name, content] of reverse ? [...files].reverse() : files) {
    await writeFile(join(root, name), content);
  }
  const timestamp =
    label === "first" ? new Date("2001-01-01T00:00:00Z") : new Date("2031-01-01T00:00:00Z");
  await Promise.all(files.map(([name]) => utimes(join(root, name), timestamp, timestamp)));
  return root;
}

function artifactInput(
  code: ArtifactCodeManifest,
  overrides: Partial<CreateArtifactManifestInput> = {},
): CreateArtifactManifestInput {
  return {
    factor: {
      runtime: { id: "python", constraint: ">=3.11,<4" },
      entry: { file: "src/factor.py", callable: "compute" },
      code,
    },
    paramsLocked: { zscoreWindow: 20, nested: { threshold: 0.25, enabled: true } },
    declaredLiterals: { selectedCutoff: 1.5 },
    trialsDeclared: 7,
    dataSemantics: {
      datasets: [{ declaration: declaration(), developmentReadSets: [READ_SET_A] }],
    },
    hypothesisRef: "hypothesis.momentum-v1",
    protocol: {
      mode: "expanding",
      folds: 6,
      trainDays: 504,
      oosDays: 63,
      purgeDays: 5,
      embargoDays: 2,
      holdDays: 5,
    },
    costModel: "equities-bps-v1",
    ...overrides,
  };
}

describe("content-addressed artifacts", () => {
  it("produces one identity across roots, creation order, mtimes, and JSON round-trips", async () => {
    const firstRoot = await codeRoot("first", true);
    const secondRoot = await codeRoot("second");
    const [firstCode, secondCode] = await Promise.all([
      captureArtifactCode({ root: firstRoot, files: ["src/factor.py", "requirements.lock"] }),
      captureArtifactCode({ root: secondRoot, files: ["requirements.lock", "src/factor.py"] }),
    ]);

    expect(firstCode).toEqual(secondCode);
    expect(firstCode.format).toBe(ARTIFACT_CODE_FORMAT);
    expect(firstCode.files.map((file) => file.logicalName)).toEqual([
      "requirements.lock",
      "src/factor.py",
    ]);
    expect(firstCode.treeHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await verifyArtifactCode(secondRoot, firstCode)).toEqual(firstCode);

    const first = createArtifactManifest(artifactInput(firstCode));
    const second = createArtifactManifest(
      artifactInput(secondCode, {
        paramsLocked: { nested: { enabled: true, threshold: 0.25 }, zscoreWindow: 20 },
      }),
    );
    expect(first).toEqual(second);
    expect(first.format).toBe(ARTIFACT_FORMAT);
    expect(first.artifactHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(first.paramsLocked)).toEqual(["nested", "zscoreWindow"]);
    expect(
      verifyArtifactManifest(JSON.parse(JSON.stringify(first)), {
        expectedArtifactHash: first.artifactHash,
        dataSemantics: {
          datasets: [{ declaration: declaration(), developmentReadSets: [READ_SET_A] }],
        },
      }),
    ).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.factor.code.files)).toBe(true);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(firstRoot);
    expect(serialized).not.toContain(secondRoot);
  });

  it("changes identity when code, parameters, runtime, protocol, or development evidence changes", async () => {
    const root = await codeRoot("identity");
    const code = await captureArtifactCode({
      root,
      files: ["requirements.lock", "src/factor.py"],
    });
    const baseline = createArtifactManifest(artifactInput(code));

    await writeFile(join(root, "src/factor.py"), "def compute(data_view):\n    return None\n");
    const changedCode = await captureArtifactCode({
      root,
      files: ["requirements.lock", "src/factor.py"],
    });
    const identities = [
      createArtifactManifest(artifactInput(changedCode)).artifactHash,
      createArtifactManifest(artifactInput(code, { paramsLocked: { zscoreWindow: 21 } }))
        .artifactHash,
      createArtifactManifest(
        artifactInput(code, {
          factor: {
            runtime: { id: "python", constraint: ">=3.12,<4" },
            entry: { file: "src/factor.py", callable: "compute" },
            code,
          },
        }),
      ).artifactHash,
      createArtifactManifest(
        artifactInput(code, {
          protocol: { ...artifactInput(code).protocol, embargoDays: 3 },
        }),
      ).artifactHash,
      createArtifactManifest(
        artifactInput(code, {
          dataSemantics: {
            datasets: [{ declaration: declaration(), developmentReadSets: [READ_SET_B] }],
          },
        }),
      ).artifactHash,
    ];
    expect(new Set([baseline.artifactHash, ...identities]).size).toBe(identities.length + 1);
    await expect(verifyArtifactCode(root, code)).rejects.toMatchObject({
      code: "INVALID_ARTIFACT_CODE",
    });
  });

  it("independently rejects reordered, tampered, unknown, and mismatched evidence", async () => {
    const root = await codeRoot("tamper");
    const code = await captureArtifactCode({
      root,
      files: ["requirements.lock", "src/factor.py"],
    });
    const otherDeclaration = declaration("artifact-fundamentals", "2");
    const manifest = createArtifactManifest(
      artifactInput(code, {
        dataSemantics: {
          datasets: [
            { declaration: otherDeclaration, developmentReadSets: [READ_SET_B] },
            { declaration: declaration(), developmentReadSets: [READ_SET_A] },
          ],
        },
      }),
    );

    const tampered = JSON.parse(JSON.stringify(manifest)) as {
      paramsLocked: { zscoreWindow: number };
    };
    tampered.paramsLocked.zscoreWindow = 999;
    expect(() => verifyArtifactManifest(tampered)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT" }),
    );

    const reordered = JSON.parse(JSON.stringify(manifest)) as {
      dataSemantics: { datasets: unknown[] };
    };
    reordered.dataSemantics.datasets.reverse();
    expect(() => verifyArtifactManifest(reordered)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT" }),
    );

    const unknown = { ...JSON.parse(JSON.stringify(manifest)), currentRoot: root };
    expect(() => verifyArtifactManifest(unknown)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT" }),
    );
    expect(() =>
      verifyArtifactManifest(manifest, {
        expectedArtifactHash: READ_SET_B,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    expect(() =>
      verifyArtifactManifest(manifest, {
        dataSemantics: {
          datasets: [{ declaration: declaration(), developmentReadSets: [READ_SET_A] }],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    expect(() =>
      verifyArtifactManifest(manifest, {
        dataSemantics: {
          datasets: [
            { declaration: otherDeclaration, developmentReadSets: [READ_SET_A] },
            { declaration: declaration(), developmentReadSets: [READ_SET_B] },
          ],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));

    const codeTamper = JSON.parse(JSON.stringify(code)) as {
      files: Array<{ byteLength: number }>;
    };
    const firstFile = codeTamper.files[0];
    if (firstFile === undefined) {
      throw new Error("artifact code fixture is empty");
    }
    firstFile.byteLength += 1;
    expect(() => verifyArtifactCodeManifest(codeTamper)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT_CODE" }),
    );
    const codeReordered = JSON.parse(JSON.stringify(code)) as { files: unknown[] };
    codeReordered.files.reverse();
    expect(() => verifyArtifactCodeManifest(codeReordered)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT_CODE" }),
    );
    expect(() => verifyArtifactManifest(manifest, { unexpected: true } as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT" }),
    );
  });

  it("rejects unsafe protocols, credentials, runtime paths, and non-canonical parameters", async () => {
    const root = await codeRoot("input-boundary");
    const code = await captureArtifactCode({
      root,
      files: ["requirements.lock", "src/factor.py"],
    });
    const invalidInputs: CreateArtifactManifestInput[] = [
      artifactInput(code, {
        protocol: { ...artifactInput(code).protocol, purgeDays: 4 },
      }),
      artifactInput(code, {
        protocol: { ...artifactInput(code).protocol, embargoDays: 0 },
      }),
      artifactInput(code, { paramsLocked: { apiKey: "must-not-enter" } }),
      artifactInput(code, { paramsLocked: { cache: "/tmp/machine-specific" } }),
      artifactInput(code, { paramsLocked: { cache: "C:\\machine-specific" } }),
      artifactInput(code, { paramsLocked: { unstable: Number.NaN } }),
      artifactInput(code, { paramsLocked: { negativeZero: -0 } }),
      artifactInput(code, { paramsLocked: { when: new Date() } }),
      artifactInput(code, {
        paramsLocked: { duplicated: 1 },
        declaredLiterals: { duplicated: 1 },
      }),
      artifactInput(code, {
        factor: {
          runtime: { id: "python", constraint: "/usr/bin/python" },
          entry: { file: "src/factor.py", callable: "compute" },
          code,
        },
      }),
      artifactInput(code, {
        factor: {
          runtime: { id: "python", constraint: ">=3.11;run-something" },
          entry: { file: "src/factor.py", callable: "compute" },
          code,
        },
      }),
      artifactInput(code, {
        factor: {
          runtime: { id: "python", constraint: ">=3.11" },
          entry: { file: "missing.py", callable: "compute" },
          code,
        },
      }),
    ];
    for (const input of invalidInputs) {
      expect(() => createArtifactManifest(input)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARTIFACT" }),
      );
    }

    const rawDeclaration = {
      dataset: "not-normalized",
      version: "1",
    } as unknown as AdapterDeclaration;
    expect(() =>
      createArtifactManifest(
        artifactInput(code, {
          dataSemantics: {
            datasets: [{ declaration: rawDeclaration, developmentReadSets: [READ_SET_A] }],
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
  });

  it("rejects unsafe, duplicate, missing, and path-leaking code capture inputs", async () => {
    const root = await codeRoot("paths");
    for (const files of [
      ["../escape.py"],
      ["/absolute.py"],
      ["src\\factor.py"],
      ["src/factor.py", "src/FACTOR.py"],
      ["CON.py"],
      [".env"],
      ["missing.py"],
    ]) {
      const failure: unknown = await captureArtifactCode({ root, files }).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: "INVALID_ARTIFACT_CODE" });
      expect(String(failure)).not.toContain(root);
    }
    await expect(
      captureArtifactCode({ root: "relative-root", files: ["src/factor.py"] }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_CODE" });
  });

  it.skipIf(process.platform === "win32")(
    "refuses symbolic links even when their target remains inside the code root",
    async () => {
      const root = await codeRoot("symlink");
      await symlink(join(root, "src/factor.py"), join(root, "linked.py"), "file");
      await expect(captureArtifactCode({ root, files: ["linked.py"] })).rejects.toMatchObject({
        code: "INVALID_ARTIFACT_CODE",
      });
    },
  );
});
