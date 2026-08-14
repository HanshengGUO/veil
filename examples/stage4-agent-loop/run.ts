import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBriefEntry,
  createHypothesisEntry,
  executeVeilBacktestTool,
  executeVeilDataTool,
  loadProjectExperiment,
  loadVeilProject,
  reproduceProjectExperiment,
  VEIL_BRIEF_ENTRY,
  VEIL_EXPERIMENT_ENTRY,
  VEIL_HYPOTHESIS_ENTRY,
} from "../../packages/veil-agent/src/index.ts";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "veil-stage4-agent-loop-"));
const projectRoot = join(temporaryRoot, "project");
const schedule = Array.from({ length: 35 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);

interface SessionEntry {
  readonly type: "custom";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly customType: string;
  readonly data: unknown;
}

const entries: SessionEntry[] = [];
let clock = Date.now() - 1_000;
const appendEntry = <T>(customType: string, data: T): void => {
  clock = Math.max(Date.now(), clock + 1);
  const previous = entries.at(-1);
  entries.push(
    Object.freeze({
      type: "custom",
      id: `stage4-entry-${String(entries.length + 1).padStart(3, "0")}`,
      parentId: previous?.id ?? null,
      timestamp: new Date(clock).toISOString(),
      customType,
      data,
    }),
  );
};

try {
  await mkdir(join(projectRoot, ".veil"), { recursive: true });
  await mkdir(join(projectRoot, "artifact"), { recursive: true });
  await cp(join(fixtureRoot, "factor.mjs"), join(projectRoot, "artifact", "factor.mjs"));
  await writeFile(join(projectRoot, ".veil", "project.yaml"), projectConfiguration());
  await writeFile(join(projectRoot, "adapter.yaml"), adapterDeclaration());
  await writeFile(join(projectRoot, "prices.csv"), pricesCsv());

  appendEntry(
    VEIL_BRIEF_ENTRY,
    createBriefEntry(
      "Verify a cross-sectional trend family through the complete Stage 4 claim path.",
      "explicit",
    ),
  );
  appendEntry(
    VEIL_HYPOTHESIS_ENTRY,
    createHypothesisEntry({
      hypothesisRef: "example.stage4-agent-loop-v1",
      statement:
        "The strongest cross-sectional price trend remains positive out of sample after costs.",
      ideaAvailableAt: "2025-11-01T00:00:00.000Z",
      captureMode: "explicit",
    }),
  );

  const project = await loadVeilProject(projectRoot);
  const development = await executeVeilDataTool(
    {
      dataset: "stage4-agent-prices",
      mode: "panel",
      as_of: schedule.at(-1) ?? "2026-02-04T00:00:00.000Z",
      columns: ["ticker", "price"],
      output: "summary",
    },
    { project, appendEntry },
  );

  const results = [];
  for (const lookbackDays of [3, 4, 5]) {
    const reference = `.veil/promotion-${lookbackDays}.yaml`;
    await writeFile(
      join(projectRoot, reference),
      promotionRequest(development.evidence.readSetId, schedule, lookbackDays),
    );
    const result = await executeVeilBacktestTool(
      { request: reference },
      { project, getBranch: () => entries, appendEntry },
    );
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    results.push(result);
  }

  const [first, second, accepted] = results;
  if (
    first?.verdict !== "rejected" ||
    second?.verdict !== "rejected" ||
    accepted?.verdict !== "accepted" ||
    accepted.claimStatus !== "verified" ||
    accepted.experimentId === undefined
  ) {
    throw new Error(`unexpected Stage 4 family verdicts: ${JSON.stringify(results)}`);
  }
  const budgetReference = ".veil/promotion-budget.yaml";
  await writeFile(
    join(projectRoot, budgetReference),
    promotionRequest(development.evidence.readSetId, schedule, 6, {
      trialBudget: 3,
      knowledgeCutoff: "2025-12-31T00:00:00.000Z",
    }),
  );
  const budgetRejection = await executeVeilBacktestTool(
    { request: budgetReference },
    { project, getBranch: () => entries, appendEntry },
  );
  const contaminationReference = ".veil/promotion-contamination.yaml";
  await writeFile(
    join(projectRoot, contaminationReference),
    promotionRequest(development.evidence.readSetId, schedule, 7, {
      trialBudget: 16,
      knowledgeCutoff: "2027-01-01T00:00:00.000Z",
    }),
  );
  const contaminationRejection = await executeVeilBacktestTool(
    { request: contaminationReference },
    { project, getBranch: () => entries, appendEntry },
  );
  if (
    !budgetRejection.ok ||
    budgetRejection.verdict !== "rejected" ||
    !budgetRejection.gateReasons?.some((gate) => gate.reasonCode === "trial-budget-exhausted") ||
    !contaminationRejection.ok ||
    contaminationRejection.verdict !== "rejected" ||
    !contaminationRejection.gateReasons?.some(
      (gate) => gate.reasonCode === "post-cutoff-validation-required",
    )
  ) {
    throw new Error("Stage 4 trial-budget or knowledge-contamination gate did not reject");
  }
  const reproduction = await reproduceProjectExperiment({
    project,
    experimentId: accepted.experimentId,
  });
  const archive = await loadProjectExperiment(projectRoot, accepted.experimentId);
  const experimentEntries = entries.filter((entry) => entry.customType === VEIL_EXPERIMENT_ENTRY);
  const log = await readFile(join(projectRoot, ".veil", "research-log.md"), "utf8");
  if (
    reproduction.status !== "matched" ||
    experimentEntries.length !== 5 ||
    !log.includes(accepted.experimentId)
  ) {
    throw new Error("Stage 4 archive, memory, or reproduction acceptance failed");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      verdicts: results.map((result) => result.verdict),
      claimStatus: accepted.claimStatus,
      experimentId: accepted.experimentId,
      gateReasons: accepted.gateReasons,
      archivedSnapshots: archive.readSetSnapshotIds.length,
      memoryExperiments: experimentEntries.length,
      reproductionStatus: reproduction.status,
      trialBudgetRejection: budgetRejection.gateReasons,
      knowledgeContaminationRejection: contaminationRejection.gateReasons,
    })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function projectConfiguration(): string {
  return `format: veil.project.v0
datasets:
  - dataset: stage4-agent-prices
    adapter: adapter.yaml
    root: .
    root_env: null
runtimes:
  - id: veil-node
    constraints: [">=20.10.0,<30"]
promotion_concurrency: 6
stage4:
  cost_models:
    - kind: linear-bps
      reference: stage4-equities-10bps
      basis_points: 10
  null_generators:
    - kind: centered-block-bootstrap
      reference: stage4-centered-bootstrap
      replications: 128
      block_length: 5
      seed: 20260813
`;
}

function adapterDeclaration(): string {
  return `dataset: stage4-agent-prices
version: "2026-08-13"
entity_key: ticker
event_time: event_time
available_time: available_time
availability_basis: observed
frequency: 1d
guarantees:
  point_in_time: true
  survivorship_free: true
  tradability_mask: tradable
payload_schema:
  price: float64
  volume: float64
source:
  type: csv
  locator: prices.csv
`;
}

function pricesCsv(): string {
  const entities = ["AAA", "BBB", "CCC", "DDD"] as const;
  const rows = ["ticker,event_time,available_time,tradable,price,volume"];
  for (let day = 0; day < schedule.length; day += 1) {
    const time = schedule[day]?.slice(0, 10);
    if (time === undefined) throw new Error("missing generated session");
    const prices = [100 * 1.012 ** day, 100 * 0.997 ** day, 100 * 1.002 ** day, 100 * 1.001 ** day];
    for (let index = 0; index < entities.length; index += 1) {
      rows.push(`${entities[index]},${time},${time},true,${prices[index]},10000000`);
    }
  }
  return `${rows.join("\n")}\n`;
}

function promotionRequest(
  readSetId: string,
  decisionSchedule: readonly string[],
  lookbackDays: number,
  overrides: {
    readonly trialBudget: number;
    readonly knowledgeCutoff: string;
  } = {
    trialBudget: 16,
    knowledgeCutoff: "2025-12-31T00:00:00.000Z",
  },
): string {
  const scheduleLines = decisionSchedule.map((time) => `  - ${JSON.stringify(time)}`).join("\n");
  return `format: veil.promotion-request.v0
dataset: stage4-agent-prices
hypothesis_ref: example.stage4-agent-loop-v1
factor:
  code_root: artifact
  files: [factor.mjs]
  runtime: { id: veil-node, constraint: ">=20.10.0,<30" }
  entry: { file: factor.mjs, callable: compute }
params_locked:
  lookback_days: ${lookbackDays}
declared_literals: {}
trials_declared: 3
development_read_sets:
  - ${readSetId}
protocol:
  mode: rolling
  folds: 3
  train_days: 3
  oos_days: 10
  purge_days: 1
  embargo_days: 1
  hold_days: 1
  execution_lag_days: 1
decision_schedule:
${scheduleLines}
columns: [ticker, price, volume]
cost_model: stage4-equities-10bps
stage4:
  signal_column: score
  price_column: price
  market_columns: [volume]
  periods_per_year: 252
  portfolio_kind: long-short-quantile
  quantile: 0.25
  weight_column: null
  capacity:
    portfolio_nav: 1000000
    volume_column: volume
    maximum_participation_rate: 0.05
  null_generator: stage4-centered-bootstrap
  trial_budget: ${overrides.trialBudget}
  knowledge_cutoff: ${JSON.stringify(overrides.knowledgeCutoff)}
`;
}
