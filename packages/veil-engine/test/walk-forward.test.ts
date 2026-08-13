import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
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
  executeWalkForwardWindows,
  type GuardedReadResult,
  type TemporalBackend,
  TemporalGuard,
  verifyWalkForwardRunRecord,
  verifyWalkForwardWindowExecutionRecord,
} from "../src/index.ts";

const childEntrypoint = fileURLToPath(
  new URL("fixtures/artifact-runtime-child.ts", import.meta.url),
);
const tsxImportUrl = import.meta.resolve("tsx");
const roots: string[] = [];

let codeRoot: string;
let adapter: ReturnType<typeof normalizeAdapterDeclaration>;
let artifact: ArtifactManifest;
let development: GuardedReadResult;
let primary: ReturnType<typeof backendHarness>;

const schedule = Array.from({ length: 7 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);

const rollingProtocol: ArtifactProtocol = {
  mode: "rolling",
  folds: 2,
  trainDays: 3,
  oosDays: 1,
  purgeDays: 1,
  embargoDays: 1,
  holdDays: 1,
  executionLagDays: 1,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(async () => {
  codeRoot = await mkdtemp(join(tmpdir(), "veil-wfa-source-"));
  roots.push(codeRoot);
  await mkdir(join(codeRoot, "src"));
  await writeFile(
    join(codeRoot, "src", "factor.mjs"),
    "export const compute = (table) => table;\n",
  );
  adapter = normalizeAdapterDeclaration({
    dataset: "wfa-prices",
    version: "2026-08-12",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true },
    payload_schema: { value: "float64" },
    source: { type: "custom", locator: "logical/wfa-prices" },
  });
  primary = backendHarness("wfa-memory-a", sourceTable());
  development = await primary.guard.read(
    adapter,
    { asOf: "2025-12-31", columns: ["ticker", "value"] },
    primary.binding,
  );
  artifact = await buildArtifact(rollingProtocol);
});

function sourceTable(times?: readonly string[]) {
  const eventTimes = times ?? [
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
    "2026-01-03T00:00:00.000Z",
    "2026-01-04T00:00:00.000Z",
  ];
  return tableFromArrays({
    ticker: eventTimes.map(() => "AAA"),
    event_time: eventTimes,
    available_time: eventTimes,
    value: eventTimes.map((_, index) => index + 1),
  });
}

function backendHarness(id: string, table: ReturnType<typeof sourceTable>) {
  const backend: TemporalBackend = {
    id,
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: false,
      sourceFingerprint: "content-hash",
      readOnly: true,
    },
    accepts: (source) => source.type === "custom",
    read: async () => ({
      arrowIpc: tableToIPC(table, "stream"),
      sourceFingerprint: {
        algorithm: "sha256",
        value: "b".repeat(64),
        scope: "source-version",
      },
      runtime: { name: "memory", version: `${id}-v1` },
      pushdown: { projectionApplied: false, temporalPredicateApplied: false },
    }),
  };
  const backends = new BackendRegistry();
  backends.register(backend);
  return {
    guard: new TemporalGuard(backends),
    binding: createSourceBinding({
      id,
      backend: id,
      secrets: { credential: `${id}-private` },
    }),
  };
}

async function buildArtifact(protocol: ArtifactProtocol): Promise<ArtifactManifest> {
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
      datasets: [{ declaration: adapter, developmentReadSets: [development.readSet.manifestHash] }],
    },
    hypothesisRef: "test.wfa-v1",
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
          arguments: ["--import", tsxImportUrl, childEntrypoint, childMode],
        };
      },
    }),
  );
  return { registry, launches: () => launches };
}

function run(
  selectedArtifact = artifact,
  source = primary,
  selectedRuntimes = runtimes().registry,
) {
  return executeWalkForwardWindows({
    artifact: selectedArtifact,
    codeRoot,
    decisionSchedule: schedule,
    declaration: adapter,
    guard: source.guard,
    binding: source.binding,
    runtimes: selectedRuntimes,
    columns: ["ticker", "value"],
  });
}

describe("walk-forward window execution", () => {
  it("executes every rolling training fold and issues a deterministic non-verdict record", async () => {
    const first = await run();
    const second = await run();

    expect(first.record.status).toBe("executed");
    expect(first.record.runHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.record).toEqual(second.record);
    expect(first.windows).toHaveLength(2);
    expect(first.windows.map((window) => window.window.manifest.result.rowCount)).toEqual([3, 3]);
    expect(first.windows.map((window) => window.record.foldIndex)).toEqual([0, 1]);
    expect(first.windows[0]?.record.boundaries).toEqual(first.plan.folds[0]);
    expect(first.windows[0]?.execution.readSetId).toBe(
      first.windows[0]?.window.manifest.windowHash,
    );
    expect(first.windows[0]?.execution.arrowIpc).toEqual(first.windows[0]?.window.arrowIpc);
    expect(first.windows[0]?.source.readSet.query.projection).toEqual([
      "ticker",
      "value",
      "event_time",
    ]);
    expect(
      tableFromIPC(first.windows[1]?.window.arrowIpc ?? new Uint8Array())
        .getChild("event_time")
        ?.toArray(),
    ).toEqual(["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z", "2026-01-04T00:00:00.000Z"]);

    const verified = verifyWalkForwardRunRecord(JSON.parse(JSON.stringify(first.record)), {
      artifact,
      plan: first.plan,
      expectedHash: first.record.runHash,
    });
    expect(verified).toEqual(first.record);
    expect(
      verifyWalkForwardWindowExecutionRecord(first.record.windows[0], {
        artifact,
        plan: first.plan,
      }),
    ).toEqual(first.record.windows[0]);

    const serialized = JSON.stringify(first.record);
    expect(serialized).not.toContain(codeRoot);
    expect(serialized).not.toContain(primary.binding.id);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("stderr");
    expect(serialized).not.toContain("duration");
    expect(serialized).not.toContain('"verified"');
  });

  it("supports expanding windows without changing purge, embargo, or OOS topology", async () => {
    const expandingArtifact = await buildArtifact({ ...rollingProtocol, mode: "expanding" });
    const result = await run(expandingArtifact);

    expect(result.windows.map((window) => window.window.manifest.result.rowCount)).toEqual([3, 4]);
    expect(result.plan.folds.map((fold) => fold.train.startIndex)).toEqual([0, 0]);
    expect(result.plan.folds.map((fold) => fold.outOfSample.startIndex)).toEqual([5, 6]);
  });

  it("is backend-neutral while retaining backend-specific evidence lineage", async () => {
    const replacement = backendHarness("wfa-memory-b", sourceTable());
    const fromPrimary = await run();
    const fromReplacement = await run(artifact, replacement);

    expect(fromReplacement.windows.map((window) => window.window.manifest.result.rowCount)).toEqual(
      [3, 3],
    );
    expect(fromReplacement.record.runHash).not.toBe(fromPrimary.record.runHash);
    expect(fromReplacement.record.windows[0]?.sourceReadSetId).not.toBe(
      fromPrimary.record.windows[0]?.sourceReadSetId,
    );
    const serialized = JSON.stringify(fromReplacement.record);
    expect(serialized).not.toContain("wfa-memory-a");
    expect(serialized).not.toContain("wfa-memory-b");
    expect(serialized).not.toContain("credential");
  });

  it("fails before child launch on an empty training window", async () => {
    const empty = backendHarness("wfa-memory-empty", sourceTable(["2025-12-01T00:00:00.000Z"]));
    const runtime = runtimes();

    await expect(run(artifact, empty, runtime.registry)).rejects.toMatchObject({
      code: "EMPTY_VERIFICATION_WINDOW",
    });
    expect(runtime.launches()).toBe(0);
  });

  it("fails before child launch when an artifact declares multiple datasets", async () => {
    const other = normalizeAdapterDeclaration({
      dataset: "wfa-other",
      version: "1",
      entity_key: "ticker",
      event_time: "event_time",
      available_time: "available_time",
      availability_basis: "observed",
      guarantees: { point_in_time: true },
      source: { type: "custom", locator: "logical/other" },
    });
    const multiple = createArtifactManifest({
      factor: artifact.factor,
      paramsLocked: artifact.paramsLocked,
      declaredLiterals: artifact.declaredLiterals,
      trialsDeclared: artifact.trialsDeclared,
      dataSemantics: {
        datasets: [
          { declaration: adapter, developmentReadSets: [development.readSet.manifestHash] },
          {
            declaration: other,
            developmentReadSets: [`sha256:${"d".repeat(64)}`],
          },
        ],
      },
      hypothesisRef: artifact.hypothesisRef,
      protocol: artifact.protocol,
      costModel: artifact.costModel,
    });
    const runtime = runtimes();

    await expect(run(multiple, primary, runtime.registry)).rejects.toMatchObject({
      code: "INVALID_WALK_FORWARD_EXECUTION",
    });
    expect(runtime.launches()).toBe(0);
  });

  it("does not return a run record when a later fold fails", async () => {
    const runtime = runtimes((launch) => (launch === 2 ? "nonzero" : "success"));

    await expect(run(artifact, primary, runtime.registry)).rejects.toMatchObject({
      code: "ARTIFACT_EXECUTION_FAILED",
    });
    expect(runtime.launches()).toBe(2);
  });

  it("rejects record tampering and development evidence reuse", async () => {
    const result = await run();
    const tampered = JSON.parse(JSON.stringify(result.record)) as {
      windows: Array<{ requestHash: string }>;
    };
    const first = tampered.windows[0];
    if (first === undefined) throw new Error("test window missing");
    first.requestHash = `sha256:${"0".repeat(64)}`;
    expect(() =>
      verifyWalkForwardRunRecord(tampered, { artifact, plan: result.plan }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WALK_FORWARD_EXECUTION" }));

    const foldZeroSource = await primary.guard.read(
      adapter,
      {
        asOf: result.plan.folds[0]?.train.lastDecisionTime ?? "",
        columns: ["ticker", "value", "event_time"],
      },
      primary.binding,
    );
    const contaminated = createArtifactManifest({
      factor: artifact.factor,
      paramsLocked: artifact.paramsLocked,
      declaredLiterals: artifact.declaredLiterals,
      trialsDeclared: artifact.trialsDeclared,
      dataSemantics: {
        datasets: [
          { declaration: adapter, developmentReadSets: [foldZeroSource.readSet.manifestHash] },
        ],
      },
      hypothesisRef: artifact.hypothesisRef,
      protocol: artifact.protocol,
      costModel: artifact.costModel,
    });
    await expect(run(contaminated)).rejects.toMatchObject({
      code: "INVALID_ARTIFACT_EXECUTION",
    });
  });
});
