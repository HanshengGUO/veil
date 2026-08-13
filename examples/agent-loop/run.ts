import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBriefEntry,
  createHypothesisEntry,
  executeVeilBacktestTool,
  executeVeilDataTool,
  loadVeilProject,
  VEIL_BRIEF_ENTRY,
  VEIL_HYPOTHESIS_ENTRY,
} from "../../packages/veil-agent/src/index.ts";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "veil-agent-loop-"));
const projectRoot = join(temporaryRoot, "project");
const schedule = Array.from({ length: 7 }, (_, index) =>
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
let clock = Date.parse("2025-12-01T00:00:00.000Z");
const appendEntry = <T>(customType: string, data: T): void => {
  clock += 1_000;
  const previous = entries.at(-1);
  entries.push(
    Object.freeze({
      type: "custom",
      id: `example-entry-${String(entries.length + 1).padStart(3, "0")}`,
      parentId: previous?.id ?? null,
      timestamp: new Date(clock).toISOString(),
      customType,
      data,
    }),
  );
};

try {
  await mkdir(join(projectRoot, ".veil"), { recursive: true });
  await cp(join(fixtureRoot, "project.yaml"), join(projectRoot, ".veil", "project.yaml"));
  await cp(join(fixtureRoot, "adapter.yaml"), join(projectRoot, "adapter.yaml"));
  await cp(join(fixtureRoot, "prices.csv"), join(projectRoot, "prices.csv"));
  await cp(join(fixtureRoot, "artifact"), join(projectRoot, "artifact"), { recursive: true });

  const brief = createBriefEntry(
    "Test whether a deterministic toy signal survives structural walk-forward verification.",
    "automatic",
  );
  appendEntry(VEIL_BRIEF_ENTRY, brief);
  const hypothesis = createHypothesisEntry({
    hypothesisRef: "example.agent-loop-v1",
    statement: "The toy factor preserves eligible current-decision rows under replay.",
    ideaAvailableAt: "2025-11-30T00:00:00.000Z",
    captureMode: "automatic",
  });
  appendEntry(VEIL_HYPOTHESIS_ENTRY, hypothesis);

  const project = await loadVeilProject(projectRoot);
  const development = await executeVeilDataTool(
    {
      dataset: "agent-loop-prices",
      mode: "panel",
      as_of: "2025-12-31T00:00:00.000Z",
      columns: ["ticker", "price"],
      output: "summary",
    },
    { project, appendEntry },
  );
  await writeFile(
    join(projectRoot, ".veil", "promotion.yaml"),
    promotionRequest(development.evidence.readSetId, schedule),
    { encoding: "utf8", mode: 0o600 },
  );

  const result = await executeVeilBacktestTool(
    { request: ".veil/promotion.yaml" },
    {
      project,
      getBranch: () => entries,
      appendEntry,
    },
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  const log = await readFile(join(projectRoot, ".veil", "research-log.md"), "utf8");
  const evidence = await readFile(join(projectRoot, result.evidenceReference), "utf8");
  if (
    !log.includes(result.researchRunId) ||
    !log.includes("not a citable Experiment") ||
    evidence.includes('"experimentId"') ||
    evidence.includes('"verdict"') ||
    evidence.includes('"metrics"')
  ) {
    throw new Error("agent-loop evidence crossed the Stage 3 claim boundary");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      researchRunId: result.researchRunId,
      structuralStatus: result.structuralStatus,
      claimStatus: result.claimStatus,
      registrationStatus: result.registrationStatus,
      artifactHash: result.artifactHash,
      contractHash: result.contractHash,
      candidateHash: result.candidateHash,
      executionCount: result.executionCount,
      requiredEvidence: result.requiredEvidence,
    })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function promotionRequest(readSetId: string, decisionSchedule: readonly string[]): string {
  const scheduleLines = decisionSchedule.map((time) => `  - ${JSON.stringify(time)}`).join("\n");
  return `format: veil.promotion-request.v0
dataset: agent-loop-prices
hypothesis_ref: example.agent-loop-v1
factor:
  code_root: artifact
  files:
    - factor.mjs
  runtime:
    id: veil-node
    constraint: ">=20.10.0,<30"
  entry:
    file: factor.mjs
    callable: compute
params_locked:
  lookback_days: 3
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
decision_schedule:
${scheduleLines}
columns:
  - ticker
  - price
cost_model: example-stage4-cost-model
`;
}
