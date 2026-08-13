import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeVeilBacktestTool,
  VEIL_BRIEF_ENTRY,
  VEIL_DATA_READ_ENTRY,
  VEIL_RUN_RESULT_ENTRY,
  VEIL_VERIFICATION_START_ENTRY,
  VEIL_VIOLATION_ENTRY,
  type VeilProjectRuntime,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("veil-backtest promotion preflight", () => {
  it("rejects unsupported core input fields before resolving project state", async () => {
    await expect(
      executeVeilBacktestTool({ request: ".veil/promotion.yaml", ignored: true } as never, {
        project: {} as never,
        getBranch: () => [],
        appendEntry: () => {},
      }),
    ).rejects.toThrow(/requires only a non-empty request reference/);
  });

  it("terminates a started run when the active Veil ledger is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "veil-agent-corrupt-promotion-"));
    roots.push(root);
    await mkdir(join(root, ".veil"), { recursive: true });
    await writeFile(join(root, ".veil", "promotion.yaml"), promotionRequest());

    const declaration = normalizeAdapterDeclaration({
      dataset: "biased-prices",
      version: "1",
      entity_key: "ticker",
      event_time: "date",
      available_time: "date",
      availability_basis: "observed",
      guarantees: {
        point_in_time: true,
        survivorship_free: false,
        tradability_mask: "tradable",
      },
      source: { type: "csv", locator: "prices.csv" },
    });
    const project = {
      root,
      projectReference: ".veil/project.yaml",
      datasets: new Map([
        [declaration.dataset, { dataset: declaration.dataset, declaration, binding: {} as never }],
      ]),
      backends: {} as never,
      runtimes: {} as never,
      promotionConcurrency: 1,
    } satisfies VeilProjectRuntime;
    const entries: Array<{
      readonly type: "custom";
      readonly id: string;
      readonly parentId: string | null;
      readonly timestamp: string;
      readonly customType: string;
      readonly data: unknown;
    }> = [
      {
        type: "custom",
        id: "corrupt-entry",
        parentId: null,
        timestamp: "2026-08-13T00:00:00.000Z",
        customType: VEIL_BRIEF_ENTRY,
        data: { format: VEIL_BRIEF_ENTRY },
      },
    ];
    const appendEntry = <T>(customType: string, data: T): void => {
      const previous = entries.at(-1);
      entries.push({
        type: "custom",
        id: `entry-${entries.length + 1}`,
        parentId: previous?.id ?? null,
        timestamp: new Date(Date.UTC(2026, 7, 13, 0, 0, entries.length)).toISOString(),
        customType,
        data,
      });
    };

    const result = await executeVeilBacktestTool(
      { request: ".veil/promotion.yaml" },
      { project, getBranch: () => entries, appendEntry },
    );

    expect(result).toMatchObject({ ok: false, code: "CORRUPT_SESSION_LEDGER" });
    expect(entries.slice(-3).map((entry) => entry.customType)).toEqual([
      VEIL_VERIFICATION_START_ENTRY,
      VEIL_VIOLATION_ENTRY,
      VEIL_RUN_RESULT_ENTRY,
    ]);
  });

  it("names a development read-set's actual dataset instead of suggesting a redundant read", async () => {
    const root = await mkdtemp(join(tmpdir(), "veil-agent-cross-dataset-promotion-"));
    roots.push(root);
    await mkdir(join(root, ".veil"), { recursive: true });
    await mkdir(join(root, "artifact"), { recursive: true });
    const readSetId = `sha256:${"1".repeat(64)}`;
    await writeFile(
      join(root, ".veil", "promotion.yaml"),
      promotionRequest("safe-prices", readSetId),
    );

    const declaration = normalizeAdapterDeclaration({
      dataset: "safe-prices",
      version: "1",
      entity_key: "ticker",
      event_time: "date",
      available_time: "date",
      availability_basis: "observed",
      guarantees: {
        point_in_time: true,
        survivorship_free: true,
        tradability_mask: "tradable",
      },
      source: { type: "csv", locator: "prices.csv" },
    });
    const project = {
      root,
      projectReference: ".veil/project.yaml",
      datasets: new Map([
        [declaration.dataset, { dataset: declaration.dataset, declaration, binding: {} as never }],
      ]),
      backends: {} as never,
      runtimes: {} as never,
      promotionConcurrency: 1,
    } satisfies VeilProjectRuntime;
    const entries: Array<{
      readonly type: "custom";
      readonly id: string;
      readonly parentId: string | null;
      readonly timestamp: string;
      readonly customType: string;
      readonly data: unknown;
    }> = [
      {
        type: "custom",
        id: "other-dataset-read",
        parentId: null,
        timestamp: "2026-08-13T00:00:00.000Z",
        customType: VEIL_DATA_READ_ENTRY,
        data: {
          format: VEIL_DATA_READ_ENTRY,
          dataset: "fundamentals",
          adapterVersion: "1",
          mode: "point",
          grade: "guarded",
          asOf: "2026-08-12T00:00:00.000Z",
          readSetId,
          resultHash: `sha256:${"2".repeat(64)}`,
          arrowHash: `sha256:${"3".repeat(64)}`,
          exportReference: null,
        },
      },
    ];
    const appendEntry = <T>(customType: string, data: T): void => {
      const previous = entries.at(-1);
      entries.push({
        type: "custom",
        id: `entry-${entries.length + 1}`,
        parentId: previous?.id ?? null,
        timestamp: new Date(Date.UTC(2026, 7, 13, 0, 0, entries.length)).toISOString(),
        customType,
        data,
      });
    };

    const result = await executeVeilBacktestTool(
      { request: ".veil/promotion.yaml" },
      { project, getBranch: () => entries, appendEntry },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_PROMOTION_REQUEST",
      message:
        "[INVALID_PROMOTION_REQUEST] promotion development read-set is recorded for dataset fundamentals, not request dataset safe-prices",
      remedy:
        "development_read_sets may contain only readSetId values returned by veil-data for request.dataset. Keep other dataset reads exploratory or prepare a separate registered dataset before the research session.",
    });
  });

  it("explains that a cost model reference is a logical id rather than a path", async () => {
    const root = await mkdtemp(join(tmpdir(), "veil-agent-cost-reference-promotion-"));
    roots.push(root);
    await mkdir(join(root, ".veil"), { recursive: true });
    await writeFile(
      join(root, ".veil", "promotion.yaml"),
      promotionRequest("biased-prices", `sha256:${"0".repeat(64)}`, ".veil/costs/flat_10bps.yaml"),
    );

    await expect(
      executeVeilBacktestTool(
        { request: ".veil/promotion.yaml" },
        {
          project: { root } as never,
          getBranch: () => [],
          appendEntry: () => {},
        },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PROMOTION_REQUEST",
      message: "[INVALID_PROMOTION_REQUEST] cost model must be a portable logical reference",
      remedy:
        "Use a logical id such as stage4-not-issued. Filesystem paths and locator URIs are invalid; Stage 3 records the future method reference but does not apply a cost model.",
    });
  });

  it("records a terminal C1 rejection for known survivorship-biased data", async () => {
    const root = await mkdtemp(join(tmpdir(), "veil-agent-promotion-"));
    roots.push(root);
    await mkdir(join(root, ".veil"), { recursive: true });
    await writeFile(join(root, ".veil", "promotion.yaml"), promotionRequest());

    const declaration = normalizeAdapterDeclaration({
      dataset: "biased-prices",
      version: "1",
      entity_key: "ticker",
      event_time: "date",
      available_time: "date",
      availability_basis: "observed",
      guarantees: {
        point_in_time: true,
        survivorship_free: false,
        tradability_mask: "tradable",
      },
      source: { type: "csv", locator: "prices.csv" },
    });
    const project = {
      root,
      projectReference: ".veil/project.yaml",
      datasets: new Map([
        [declaration.dataset, { dataset: declaration.dataset, declaration, binding: {} as never }],
      ]),
      backends: {} as never,
      runtimes: {} as never,
      promotionConcurrency: 1,
    } satisfies VeilProjectRuntime;
    const entries: Array<{
      readonly type: "custom";
      readonly id: string;
      readonly parentId: string | null;
      readonly timestamp: string;
      readonly customType: string;
      readonly data: unknown;
    }> = [];
    const appendEntry = <T>(customType: string, data: T): void => {
      const previous = entries.at(-1);
      entries.push({
        type: "custom",
        id: `entry-${entries.length + 1}`,
        parentId: previous?.id ?? null,
        timestamp: new Date(Date.UTC(2026, 7, 13, 0, 0, entries.length)).toISOString(),
        customType,
        data,
      });
    };

    const result = await executeVeilBacktestTool(
      { request: ".veil/promotion.yaml" },
      { project, getBranch: () => entries, appendEntry },
    );

    expect(result).toMatchObject({ ok: false, code: "C1", invariant: "C1" });
    expect(entries.map((entry) => entry.customType)).toEqual([
      VEIL_VERIFICATION_START_ENTRY,
      VEIL_VIOLATION_ENTRY,
      VEIL_RUN_RESULT_ENTRY,
    ]);
    expect(await readFile(join(root, ".veil", "research-log.md"), "utf8")).toContain(
      "No promotion candidate or Experiment was issued.",
    );
  });

  it("preserves zero execution lag until the engine records a terminal C1 rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "veil-agent-same-session-promotion-"));
    roots.push(root);
    await mkdir(join(root, ".veil"), { recursive: true });
    await mkdir(join(root, "artifact"), { recursive: true });
    const readSetId = `sha256:${"4".repeat(64)}`;
    await writeFile(
      join(root, ".veil", "promotion.yaml"),
      promotionRequest("safe-prices", readSetId).replace(
        "execution_lag_days: 1",
        "execution_lag_days: 0",
      ),
    );
    await writeFile(
      join(root, "artifact", "factor.mjs"),
      "export function compute() { return { rowIndices: [], columns: {} }; }\n",
    );

    const declaration = normalizeAdapterDeclaration({
      dataset: "safe-prices",
      version: "1",
      entity_key: "ticker",
      event_time: "date",
      available_time: "date",
      availability_basis: "observed",
      guarantees: {
        point_in_time: true,
        survivorship_free: true,
        tradability_mask: "tradable",
      },
      source: { type: "csv", locator: "prices.csv" },
    });
    const project = {
      root,
      projectReference: ".veil/project.yaml",
      datasets: new Map([
        [declaration.dataset, { dataset: declaration.dataset, declaration, binding: {} as never }],
      ]),
      backends: {} as never,
      runtimes: {} as never,
      promotionConcurrency: 1,
    } satisfies VeilProjectRuntime;
    const entries: Array<{
      readonly type: "custom";
      readonly id: string;
      readonly parentId: string | null;
      readonly timestamp: string;
      readonly customType: string;
      readonly data: unknown;
    }> = [
      {
        type: "custom",
        id: "same-session-read",
        parentId: null,
        timestamp: "2026-08-13T00:00:00.000Z",
        customType: VEIL_DATA_READ_ENTRY,
        data: {
          format: VEIL_DATA_READ_ENTRY,
          dataset: "safe-prices",
          adapterVersion: "1",
          mode: "point",
          grade: "guarded",
          asOf: "2026-08-12T00:00:00.000Z",
          readSetId,
          resultHash: `sha256:${"5".repeat(64)}`,
          arrowHash: `sha256:${"6".repeat(64)}`,
          exportReference: null,
        },
      },
    ];
    const appendEntry = <T>(customType: string, data: T): void => {
      const previous = entries.at(-1);
      entries.push({
        type: "custom",
        id: `entry-${entries.length + 1}`,
        parentId: previous?.id ?? null,
        timestamp: new Date(Date.UTC(2026, 7, 13, 0, 0, entries.length)).toISOString(),
        customType,
        data,
      });
    };

    const result = await executeVeilBacktestTool(
      { request: ".veil/promotion.yaml" },
      { project, getBranch: () => entries, appendEntry },
    );

    expect(result).toMatchObject({ ok: false, code: "C1", invariant: "C1" });
    expect(entries.slice(-3).map((entry) => entry.customType)).toEqual([
      VEIL_VERIFICATION_START_ENTRY,
      VEIL_VIOLATION_ENTRY,
      VEIL_RUN_RESULT_ENTRY,
    ]);
  });
});

function promotionRequest(
  dataset = "biased-prices",
  readSetId = `sha256:${"0".repeat(64)}`,
  costModel = "stage4-placeholder",
): string {
  return `format: veil.promotion-request.v0
dataset: ${dataset}
hypothesis_ref: biased-v1
factor:
  code_root: artifact
  files: [factor.mjs]
  runtime: { id: veil-node, constraint: ">=20.10.0,<30" }
  entry: { file: factor.mjs, callable: compute }
params_locked: {}
declared_literals: {}
trials_declared: 1
development_read_sets:
  - ${readSetId}
protocol:
  mode: rolling
  folds: 2
  train_days: 3
  oos_days: 1
  purge_days: 1
  embargo_days: 1
  hold_days: 1
  execution_lag_days: 1
decision_schedule: ["2026-01-01T00:00:00.000Z"]
columns: [ticker]
cost_model: ${costModel}
`;
}
