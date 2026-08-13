import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeVeilBacktestTool,
  VEIL_BRIEF_ENTRY,
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
});

function promotionRequest(): string {
  return `format: veil.promotion-request.v0
dataset: biased-prices
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
  - sha256:0000000000000000000000000000000000000000000000000000000000000000
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
cost_model: stage4-placeholder
`;
}
