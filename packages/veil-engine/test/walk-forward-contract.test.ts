import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AdapterDeclaration, normalizeAdapterDeclaration } from "@veilquant/contract";
import { type Table, tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ArtifactManifest,
  type ArtifactProtocol,
  ArtifactRuntimeRegistry,
  BackendRegistry,
  captureArtifactCode,
  createArtifactManifest,
  createArtifactRuntimeProvider,
  createSourceBinding,
  executeWalkForwardContract,
  type GuardedReadResult,
  type TemporalBackend,
  TemporalGuard,
  verifyWalkForwardContractRecord,
} from "../src/index.ts";

const childEntrypoint = fileURLToPath(
  new URL("fixtures/artifact-runtime-child.ts", import.meta.url),
);
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const roots: string[] = [];
const schedule = Array.from({ length: 7 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);
const protocol: ArtifactProtocol = {
  mode: "rolling",
  folds: 2,
  trainDays: 3,
  oosDays: 1,
  purgeDays: 1,
  embargoDays: 1,
  holdDays: 1,
};

let codeRoot: string;
let adapter: ReturnType<typeof declaration>;
let artifact: ArtifactManifest;
let development: GuardedReadResult;
let primary: ReturnType<typeof backendHarness>;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(async () => {
  codeRoot = await mkdtemp(join(tmpdir(), "veil-contract-source-"));
  roots.push(codeRoot);
  await mkdir(join(codeRoot, "src"));
  await writeFile(
    join(codeRoot, "src", "factor.mjs"),
    "export const compute = (table) => table;\n",
  );
  adapter = declaration();
  primary = backendHarness("contract-memory-a", sourceTable());
  development = await primary.guard.read(
    adapter,
    { asOf: "2025-12-31", columns: ["ticker", "value"] },
    primary.binding,
  );
  artifact = await buildArtifact(adapter, development.readSet.manifestHash);
});

function declaration(mask: string | null = "tradable") {
  return normalizeAdapterDeclaration({
    dataset: "contract-prices",
    version: "2026-08-12",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true, tradability_mask: mask },
    payload_schema: { value: "float64" },
    source: { type: "custom", locator: "logical/contract-prices" },
  });
}

function sourceTable(mask?: readonly (boolean | null)[]): Table {
  const eventTime = schedule.flatMap((time) => [time, time]);
  return tableFromArrays({
    ticker: schedule.flatMap(() => ["AAA", "BBB"]),
    event_time: eventTime,
    available_time: eventTime,
    tradable: mask ?? schedule.flatMap((_, index) => [true, index !== 5]),
    value: eventTime.map((_, index) => index + 1),
  });
}

function backendHarness(id: string, table: Table) {
  let reads = 0;
  const backend: TemporalBackend = {
    id,
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: false,
      sourceFingerprint: "content-hash",
      readOnly: true,
    },
    accepts: (source) => source.type === "custom",
    read: async () => {
      reads += 1;
      return {
        arrowIpc: tableToIPC(table, "stream"),
        sourceFingerprint: {
          algorithm: "sha256",
          value: "c".repeat(64),
          scope: "source-version",
        },
        runtime: { name: "memory", version: `${id}-v1` },
        pushdown: { projectionApplied: false, temporalPredicateApplied: false },
      };
    },
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  return {
    guard: new TemporalGuard(registry),
    binding: createSourceBinding({
      id,
      backend: id,
      secrets: { credential: `${id}-private` },
    }),
    reads: () => reads,
  };
}

async function buildArtifact(
  selectedAdapter: AdapterDeclaration,
  developmentReadSetId: string,
): Promise<ArtifactManifest> {
  const code = await captureArtifactCode({ root: codeRoot, files: ["src/factor.mjs"] });
  return createArtifactManifest({
    factor: {
      runtime: { id: "node", constraint: ">=20,<30" },
      entry: { file: "src/factor.mjs", callable: "compute" },
      code,
    },
    paramsLocked: { lookbackDays: 20 },
    declaredLiterals: { cutoff: 1.5 },
    trialsDeclared: 4,
    dataSemantics: {
      datasets: [{ declaration: selectedAdapter, developmentReadSets: [developmentReadSetId] }],
    },
    hypothesisRef: "test.contract-v1",
    protocol,
    costModel: "test-bps-v1",
  });
}

function runtimes(mode: string | ((launch: number) => string) = "success") {
  let launches = 0;
  const registry = new ArtifactRuntimeRegistry();
  registry.register(
    createArtifactRuntimeProvider({
      id: "node",
      implementation: { name: "node", version: process.versions.node },
      supports: (constraint) => constraint === ">=20,<30",
      launch: () => {
        launches += 1;
        const childMode = typeof mode === "string" ? mode : mode(launches);
        return {
          executable: process.execPath,
          arguments: ["--import", tsxLoader, childEntrypoint, childMode],
        };
      },
    }),
  );
  return { registry, launches: () => launches };
}

function run(
  selectedArtifact = artifact,
  selectedAdapter: AdapterDeclaration = adapter,
  source = primary,
  runtime = runtimes().registry,
  selectedSchedule: readonly string[] = schedule,
) {
  return executeWalkForwardContract({
    artifact: selectedArtifact,
    codeRoot,
    decisionSchedule: selectedSchedule,
    declaration: selectedAdapter,
    guard: source.guard,
    binding: source.binding,
    runtimes: runtime,
    columns: ["ticker", "value"],
  });
}

describe("walk-forward contract verification", () => {
  it("issues deterministic complete C1-C4 evidence while admitting only current OOS rows", async () => {
    const first = await run();
    const second = await run();

    expect(first.record.status).toBe("contract-verified");
    expect(first.record.invariants).toEqual(["C1", "C2", "C3", "C4"]);
    expect(first.record).toEqual(second.record);
    expect(first.executions).toHaveLength(4);
    expect(
      first.executions.map((entry) => [entry.record.role, entry.record.decisionIndex]),
    ).toEqual([
      ["train", 2],
      ["out-of-sample", 5],
      ["train", 3],
      ["out-of-sample", 6],
    ]);
    expect(first.executions.map((entry) => entry.admitted.result.rowCount)).toEqual([6, 1, 6, 2]);
    expect(first.executions.map((entry) => entry.source.readSet.query.asOf)).toEqual([
      schedule[2],
      schedule[5],
      schedule[3],
      schedule[6],
    ]);
    expect(first.executions[0]?.source.readSet.query.projection).toEqual([
      "ticker",
      "value",
      "event_time",
      "tradable",
    ]);
    expect(
      first.executions
        .filter((entry) => entry.record.role === "out-of-sample")
        .map((entry) => tableFromIPC(entry.admitted.arrowIpc).getChild("event_time")?.toArray()),
    ).toEqual([[schedule[5]], [schedule[6], schedule[6]]]);
    expect(first.executions[1]?.view.manifest.audit.droppedUntradableRows).toBe(1);
    expect(first.executions[1]?.view.manifest.audit.decisionRows).toBe(1);
    const firstOosView = tableFromIPC(first.executions[1]?.view.arrowIpc ?? new Uint8Array());
    const firstOosEntities = firstOosView.getChild("ticker");
    const firstOosTimes = firstOosView.getChild("event_time");
    expect(
      Array.from({ length: firstOosView.numRows }, (_, row) => [
        firstOosEntities?.get(row),
        firstOosTimes?.get(row),
      ]).filter(([, eventTime]) => eventTime === schedule[5]),
    ).toEqual([["AAA", schedule[5]]]);
    expect(new Set(first.record.executions.map((entry) => entry.parameterLockHash))).toEqual(
      new Set([first.parameterLockHash]),
    );

    expect(
      verifyWalkForwardContractRecord(JSON.parse(JSON.stringify(first.record)), {
        artifact,
        plan: first.plan,
        declaration: adapter,
        expectedHash: first.record.contractHash,
      }),
    ).toEqual(first.record);
    const serialized = JSON.stringify(first.record);
    expect(serialized).not.toContain(codeRoot);
    expect(serialized).not.toContain(primary.binding.id);
    expect(serialized).not.toContain("private");
    for (const absent of [
      "metrics",
      "prices",
      "returns",
      "gates",
      "verdict",
      "stderr",
      "duration",
    ]) {
      expect(serialized).not.toContain(`"${absent}"`);
    }
  });

  it("fails C4 before I/O or child launch when no tradability mask is declared", async () => {
    const unmasked = declaration(null);
    const unmaskedSource = backendHarness("contract-unmasked", sourceTable());
    const read = await unmaskedSource.guard.read(
      unmasked,
      { asOf: "2025-12-31", columns: ["ticker", "value"] },
      unmaskedSource.binding,
    );
    const unmaskedArtifact = await buildArtifact(unmasked, read.readSet.manifestHash);
    const runtime = runtimes();
    const readsBefore = unmaskedSource.reads();

    await expect(
      run(unmaskedArtifact, unmasked, unmaskedSource, runtime.registry),
    ).rejects.toMatchObject({ invariant: "C4" });
    expect(unmaskedSource.reads()).toBe(readsBefore);
    expect(runtime.launches()).toBe(0);
  });

  it("fails C4 before child launch for an omitted or non-boolean mask", async () => {
    const missing = backendHarness(
      "contract-missing-mask",
      tableFromArrays({
        ticker: ["AAA"],
        event_time: [schedule[0]],
        available_time: [schedule[0]],
        value: [1],
      }),
    );
    const missingRuntime = runtimes();
    await expect(run(artifact, adapter, missing, missingRuntime.registry)).rejects.toMatchObject({
      invariant: "C4",
    });
    expect(missingRuntime.launches()).toBe(0);

    const invalidMask = schedule.flatMap((_, index) => [true, index === 1 ? null : true]);
    const invalid = backendHarness("contract-null-mask", sourceTable(invalidMask));
    const invalidRuntime = runtimes();
    await expect(run(artifact, adapter, invalid, invalidRuntime.registry)).rejects.toMatchObject({
      invariant: "C4",
    });
    expect(invalidRuntime.launches()).toBe(0);
  });

  it("rejects child output that reintroduces a masked row or a future row", async () => {
    const reintroduced = runtimes((launch) => (launch === 2 ? "untradable-row" : "success"));
    await expect(run(artifact, adapter, primary, reintroduced.registry)).rejects.toMatchObject({
      invariant: "C4",
    });
    expect(reintroduced.launches()).toBe(2);

    const future = runtimes((launch) => (launch === 2 ? "future-row" : "success"));
    await expect(run(artifact, adapter, primary, future.registry)).rejects.toMatchObject({
      invariant: "C1",
    });
    expect(future.launches()).toBe(2);
  });

  it("returns no contract record after a partial run and maps invalid topology to C2", async () => {
    const partial = runtimes((launch) => (launch === 2 ? "nonzero" : "success"));
    await expect(run(artifact, adapter, primary, partial.registry)).rejects.toMatchObject({
      code: "ARTIFACT_EXECUTION_FAILED",
    });
    expect(partial.launches()).toBe(2);

    const invalid = runtimes();
    const readsBefore = primary.reads();
    await expect(
      run(artifact, adapter, primary, invalid.registry, schedule.slice(0, -1)),
    ).rejects.toMatchObject({ invariant: "C2" });
    expect(primary.reads()).toBe(readsBefore);
    expect(invalid.launches()).toBe(0);
  });

  it("reports C2/C3/C4 when serialized contract structure drifts", async () => {
    const result = await run();
    const parameterDrift = JSON.parse(JSON.stringify(result.record)) as {
      executions: Array<{ parameterLockHash: string }>;
    };
    const first = parameterDrift.executions[0];
    if (first === undefined) throw new Error("test execution missing");
    first.parameterLockHash = `sha256:${"0".repeat(64)}`;
    expect(() =>
      verifyWalkForwardContractRecord(parameterDrift, {
        artifact,
        plan: result.plan,
        declaration: adapter,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C3" }));

    const partial = JSON.parse(JSON.stringify(result.record)) as { executions: unknown[] };
    partial.executions.pop();
    expect(() =>
      verifyWalkForwardContractRecord(partial, {
        artifact,
        plan: result.plan,
        declaration: adapter,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C2" }));

    const maskDrift = JSON.parse(JSON.stringify(result.record)) as {
      executions: Array<{ maskAudit: { inputRows: number } }>;
    };
    const masked = maskDrift.executions[0];
    if (masked === undefined) throw new Error("test execution missing");
    masked.maskAudit.inputRows += 1;
    expect(() =>
      verifyWalkForwardContractRecord(maskDrift, {
        artifact,
        plan: result.plan,
        declaration: adapter,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C4" }));
  });

  it("remains backend-neutral while retaining opaque source lineage", async () => {
    const replacement = backendHarness("contract-memory-b", sourceTable());
    const first = await run();
    const second = await run(artifact, adapter, replacement);

    expect(second.executions.map((entry) => entry.admitted.result.rowCount)).toEqual([6, 1, 6, 2]);
    expect(second.record.contractHash).not.toBe(first.record.contractHash);
    expect(second.record.executions[0]?.sourceReadSetId).not.toBe(
      first.record.executions[0]?.sourceReadSetId,
    );
    const serialized = JSON.stringify(second.record);
    expect(serialized).not.toContain("contract-memory-a");
    expect(serialized).not.toContain("contract-memory-b");
    expect(serialized).not.toContain("credential");
  });
});
