import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ArtifactManifest,
  ArtifactRuntimeRegistry,
  BackendRegistry,
  captureArtifactCode,
  createArtifactExecutionRequest,
  createArtifactManifest,
  createArtifactRuntimeProvider,
  createSourceBinding,
  decodeArtifactExecutionRequest,
  encodeArtifactExecutionRequest,
  executeArtifact,
  type GuardedReadResult,
  type TemporalBackend,
  TemporalGuard,
} from "../src/index.ts";

const childEntrypoint = fileURLToPath(
  new URL("fixtures/artifact-runtime-child.ts", import.meta.url),
);
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const temporaryRoots: string[] = [];

let codeRoot: string;
let artifact: ArtifactManifest;
let development: GuardedReadResult;
let execution: GuardedReadResult;

afterEach(async () => {
  delete process.env.VEIL_TEST_SECRET;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(async () => {
  codeRoot = await mkdtemp(join(tmpdir(), "veil-artifact-exec-source-"));
  temporaryRoots.push(codeRoot);
  await mkdir(join(codeRoot, "src"));
  await writeFile(
    join(codeRoot, "src", "factor.mjs"),
    "export const compute = (table) => table;\n",
  );

  const declaration = normalizeAdapterDeclaration({
    dataset: "artifact-execution-prices",
    version: "1",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true },
    payload_schema: { value: "float64" },
    source: { type: "custom", locator: "logical/prices" },
  });
  const backend: TemporalBackend = {
    id: "artifact-execution-memory",
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: false,
      sourceFingerprint: "content-hash",
      readOnly: true,
    },
    accepts: (source) => source.type === "custom",
    read: async () => ({
      arrowIpc: tableToIPC(
        tableFromArrays({
          ticker: ["A", "B"],
          event_time: ["2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z"],
          available_time: ["2026-08-11T00:00:00Z", "2026-08-12T00:00:00Z"],
          value: [1, 2],
        }),
        "stream",
      ),
      sourceFingerprint: {
        algorithm: "sha256",
        value: "a".repeat(64),
        scope: "source-version",
      },
      runtime: { name: "memory", version: "test-v1" },
      pushdown: { projectionApplied: false, temporalPredicateApplied: false },
    }),
  };
  const backends = new BackendRegistry();
  backends.register(backend);
  const guard = new TemporalGuard(backends);
  const binding = createSourceBinding({
    id: "artifact-execution",
    backend: backend.id,
    secrets: { apiKey: "never-cross-child" },
  });
  [development, execution] = await Promise.all([
    guard.read(declaration, { asOf: "2026-08-11", columns: ["ticker", "value"] }, binding),
    guard.read(declaration, { asOf: "2026-08-12", columns: ["ticker", "value"] }, binding),
  ]);
  const code = await captureArtifactCode({ root: codeRoot, files: ["src/factor.mjs"] });
  artifact = createArtifactManifest({
    factor: {
      runtime: { id: "node", constraint: ">=20,<30" },
      entry: { file: "src/factor.mjs", callable: "compute" },
      code,
    },
    paramsLocked: { lookbackDays: 20, nested: { enabled: true } },
    declaredLiterals: { cutoff: 1.5 },
    trialsDeclared: 4,
    dataSemantics: {
      datasets: [{ declaration, developmentReadSets: [development.readSet.manifestHash] }],
    },
    hypothesisRef: "test.artifact-execution-v1",
    protocol: {
      mode: "expanding",
      folds: 3,
      trainDays: 252,
      oosDays: 21,
      purgeDays: 5,
      embargoDays: 2,
      holdDays: 5,
    },
    costModel: "test-bps-v1",
  });
});

function runtimes(
  mode = "success",
  hooks: { supports?: () => void; launch?: (root: string) => void } = {},
) {
  const provider = createArtifactRuntimeProvider({
    id: "node",
    implementation: { name: "node", version: process.versions.node },
    supports: (constraint) => {
      hooks.supports?.();
      return constraint === ">=20,<30";
    },
    launch: ({ codeRoot: materializedRoot }) => {
      hooks.launch?.(materializedRoot);
      return {
        executable: process.execPath,
        arguments: ["--import", tsxLoader, childEntrypoint, mode],
      };
    },
  });
  const registry = new ArtifactRuntimeRegistry();
  registry.register(provider);
  return { provider, registry };
}

function run(mode = "success", limits?: Parameters<typeof executeArtifact>[0]["limits"]) {
  return executeArtifact({
    artifact,
    codeRoot,
    readSet: execution.readSet,
    arrowIpc: execution.arrowIpc,
    runtimes: runtimes(mode).registry,
    limits,
  });
}

describe("artifact execution protocol", () => {
  it("round-trips one canonical request and rejects duplicate JSON or trailing frames", () => {
    const request = createArtifactExecutionRequest({
      artifactHash: artifact.artifactHash,
      codeTreeHash: artifact.factor.code.treeHash,
      runtime: {
        id: "node",
        implementation: { name: "node", version: process.versions.node },
      },
      entry: artifact.factor.entry,
      dataset: {
        dataset: execution.readSet.query.dataset,
        version: execution.readSet.query.adapterVersion,
        declarationHash: execution.readSet.declarationHash,
      },
      readSetId: execution.readSet.manifestHash,
      decisionTime: execution.readSet.query.asOf,
      paramsLocked: artifact.paramsLocked,
      declaredLiterals: artifact.declaredLiterals,
      arrowIpc: execution.arrowIpc,
    });
    const encoded = encodeArtifactExecutionRequest(request);
    expect(decodeArtifactExecutionRequest(encoded)).toEqual(request);

    const bytes = Buffer.from(encoded);
    const controlLength = bytes.readUInt32BE(8);
    const control = bytes.subarray(20, 20 + controlLength).toString("utf8");
    const duplicateControl = Buffer.from(
      `${control.slice(0, -1)},"requestHash":${JSON.stringify(request.metadata.requestHash)}}`,
    );
    const header = Buffer.from(bytes.subarray(0, 20));
    header.writeUInt32BE(duplicateControl.byteLength, 8);
    const duplicate = Buffer.concat([header, duplicateControl, bytes.subarray(20 + controlLength)]);
    expect(() => decodeArtifactExecutionRequest(duplicate)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT_EXECUTION" }),
    );
    expect(() => decodeArtifactExecutionRequest(Buffer.concat([bytes, Buffer.of(0)]))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT_EXECUTION" }),
    );
  });
});

describe("framed artifact subprocess", () => {
  it("executes materialized code with exact guarded Arrow, frozen metadata, and a clean environment", async () => {
    process.env.VEIL_TEST_SECRET = "developer-key";
    const result = await run("stderr-small");

    expect(result.format).toBe("veil.artifact-execution.v0");
    expect(result.artifactHash).toBe(artifact.artifactHash);
    expect(result.readSetId).toBe(execution.readSet.manifestHash);
    expect(result.decisionTime).toBe("2026-08-12T00:00:00.000Z");
    expect(result.runtime).toEqual({
      id: "node",
      implementation: { name: "node", version: process.versions.node },
    });
    expect(result.outputArrowHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.arrowIpc).toEqual(execution.arrowIpc);
    expect(tableFromIPC(result.arrowIpc).numRows).toBe(2);
    expect(result.diagnostics.stderrByteLength).toBeGreaterThan(0);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(codeRoot);
    expect(serialized).not.toContain("developer-key");
    expect(serialized).not.toContain("private runtime diagnostic");
  });

  it("keeps provider launch state opaque and selects by logical runtime constraint", async () => {
    const { provider, registry } = runtimes();
    const descriptor = {
      id: "node",
      implementation: { name: "node", version: process.versions.node },
    };
    expect(JSON.parse(JSON.stringify(provider))).toEqual(descriptor);
    expect(inspect(provider)).toBe(`ArtifactRuntimeProvider ${JSON.stringify(descriptor)}`);
    expect(registry.list()).toEqual([descriptor]);
    expect(`${JSON.stringify(provider)}\n${inspect(provider)}`).not.toContain(process.execPath);
    expect(() => registry.register(provider)).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_ARTIFACT_RUNTIME" }),
    );

    const missing = new ArtifactRuntimeRegistry();
    await expect(
      executeArtifact({
        artifact,
        codeRoot,
        readSet: execution.readSet,
        arrowIpc: execution.arrowIpc,
        runtimes: missing,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_RUNTIME_NOT_FOUND" });

    const unsupported = new ArtifactRuntimeRegistry();
    unsupported.register(
      createArtifactRuntimeProvider({
        id: "node",
        implementation: { name: "node", version: process.versions.node },
        supports: () => false,
        launch: () => ({ executable: process.execPath }),
      }),
    );
    await expect(
      executeArtifact({
        artifact,
        codeRoot,
        readSet: execution.readSet,
        arrowIpc: execution.arrowIpc,
        runtimes: unsupported,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_RUNTIME_UNSUPPORTED" });

    const unsafe = new ArtifactRuntimeRegistry();
    unsafe.register(
      createArtifactRuntimeProvider({
        id: "node",
        implementation: { name: "node", version: process.versions.node },
        supports: () => true,
        launch: () => ({
          executable: process.execPath,
          environment: { VEIL_API_KEY: "must-not-cross" },
        }),
      }),
    );
    let unsafeError: unknown;
    try {
      await executeArtifact({
        artifact,
        codeRoot,
        readSet: execution.readSet,
        arrowIpc: execution.arrowIpc,
        runtimes: unsafe,
      });
    } catch (caught) {
      unsafeError = caught;
    }
    expect(unsafeError).toMatchObject({ code: "INVALID_ARTIFACT_RUNTIME" });
    expect(String(unsafeError)).not.toContain("must-not-cross");
    expect(String(unsafeError)).not.toContain(codeRoot);
  });

  it("rejects development evidence and undeclared read-set semantics", async () => {
    await expect(
      executeArtifact({
        artifact,
        codeRoot,
        readSet: development.readSet,
        arrowIpc: development.arrowIpc,
        runtimes: runtimes().registry,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_EXECUTION" });

    const otherDeclaration = normalizeAdapterDeclaration({
      dataset: "other-artifact-dataset",
      version: "1",
      entity_key: "ticker",
      event_time: "event_time",
      available_time: "available_time",
      availability_basis: "observed",
      guarantees: { point_in_time: true },
      source: { type: "custom", locator: "logical/other" },
    });
    const otherArtifact = createArtifactManifest({
      factor: artifact.factor,
      paramsLocked: artifact.paramsLocked,
      declaredLiterals: artifact.declaredLiterals,
      trialsDeclared: artifact.trialsDeclared,
      dataSemantics: {
        datasets: [
          {
            declaration: otherDeclaration,
            developmentReadSets: [development.readSet.manifestHash],
          },
        ],
      },
      hypothesisRef: artifact.hypothesisRef,
      protocol: artifact.protocol,
      costModel: artifact.costModel,
    });
    await expect(
      executeArtifact({
        artifact: otherArtifact,
        codeRoot,
        readSet: execution.readSet,
        arrowIpc: execution.arrowIpc,
        runtimes: runtimes().registry,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_EXECUTION" });
  });

  it("fails closed when code changes after original verification or provider preparation", async () => {
    const originalMutation = runtimes("success", {
      supports: () => {
        writeFileSync(join(codeRoot, "src", "factor.mjs"), "export const compute = () => null;\n");
      },
    }).registry;
    await expect(
      executeArtifact({
        artifact,
        codeRoot,
        readSet: execution.readSet,
        arrowIpc: execution.arrowIpc,
        runtimes: originalMutation,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_CODE" });

    await writeFile(
      join(codeRoot, "src", "factor.mjs"),
      "export const compute = (table) => table;\n",
    );
    const materializedMutation = runtimes("success", {
      launch: (root) => {
        writeFileSync(join(root, "src", "factor.mjs"), "export const compute = () => null;\n");
      },
    }).registry;
    await expect(
      executeArtifact({
        artifact,
        codeRoot,
        readSet: execution.readSet,
        arrowIpc: execution.arrowIpc,
        runtimes: materializedMutation,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_CODE" });
  });

  it.each(["nonzero", "signal"])("sanitizes %s child failure", async (mode) => {
    let error: unknown;
    try {
      await run(mode);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "ARTIFACT_EXECUTION_FAILED" });
    expect(String(error)).not.toContain(codeRoot);
    expect(String(error)).not.toContain(childEntrypoint);
    expect(String(error)).not.toContain(process.execPath);
  });

  it.each([
    "malformed",
    "oversized",
    "partial",
    "trailing",
    "duplicate",
    "corrupt-arrow",
    "wrong-request",
  ])("rejects %s stdout", async (mode) => {
    await expect(run(mode)).rejects.toMatchObject({ code: "INVALID_ARTIFACT_OUTPUT" });
  });

  it.each(["stdout-flood", "stderr-flood"])("caps %s", async (mode) => {
    await expect(
      run(mode, { maxOutputArrowBytes: 1024, maxStderrBytes: 1024 }),
    ).rejects.toMatchObject({ code: "ARTIFACT_OUTPUT_LIMIT" });
  });

  it("times out and supports cancellation", async () => {
    await expect(run("timeout", { timeoutMs: 100 })).rejects.toMatchObject({
      code: "ARTIFACT_EXECUTION_TIMEOUT",
    });

    const controller = new AbortController();
    const pending = executeArtifact({
      artifact,
      codeRoot,
      readSet: execution.readSet,
      arrowIpc: execution.arrowIpc,
      runtimes: runtimes("timeout").registry,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "ARTIFACT_EXECUTION_ABORTED" });
  });
});
