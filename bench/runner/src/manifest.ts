import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parse } from "yaml";

export interface TaskManifest {
  taskId: string;
  universe: {
    source: string;
    size: number;
  };
  period: {
    researchStart: string;
    researchEnd: string;
  };
  label: {
    horizonDays: number;
    definition: string;
  };
  evaluation?: {
    purgeDays: number;
    embargoDays: number;
    rebalanceEveryDays: number;
    executionLagDays?: number;
  };
  portfolio?: {
    kind: "long-only-quantile" | "long-short-quantile";
    sizing: "equal" | "artifact-weight";
  };
  datasets: Array<{ adapter: string }>;
  tools: {
    allowed: string[];
  };
  dataGeneration: {
    script: string;
    seeds: number[];
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${path} contains unsupported fields: ${unexpected.join(", ")}`);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a string`);
  return value;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function relativePath(value: unknown, path: string): string {
  const parsed = string(value, path);
  const parts = parsed.replaceAll("\\", "/").split("/");
  if (isAbsolute(parsed) || parts.includes("..")) {
    throw new Error(`${path} must stay inside the task directory`);
  }
  return parsed;
}

function isoDate(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) throw new Error(`${path} must be YYYY-MM-DD`);
  return parsed;
}

export function parseTaskManifest(input: unknown): TaskManifest {
  const root = record(input, "manifest");
  const universe = record(root.universe, "universe");
  const period = record(root.period, "period");
  const label = record(root.label, "label");
  const tools = record(root.tools, "tools");
  const generation = record(root.data_generation, "data_generation");
  const evaluation =
    root.evaluation === undefined ? undefined : record(root.evaluation, "evaluation");
  const portfolio = root.portfolio === undefined ? undefined : record(root.portfolio, "portfolio");
  exactKeys(
    root,
    [
      "task_id",
      "universe",
      "period",
      "label",
      "evaluation",
      "portfolio",
      "datasets",
      "tools",
      "data_generation",
    ],
    "manifest",
  );
  exactKeys(universe, ["source", "size"], "universe");
  exactKeys(period, ["research_start", "research_end"], "period");
  exactKeys(label, ["horizon_days", "definition"], "label");
  exactKeys(tools, ["allowed"], "tools");
  exactKeys(generation, ["script", "seeds"], "data_generation");
  if (evaluation !== undefined) {
    exactKeys(
      evaluation,
      ["purge_days", "embargo_days", "rebalance_every_days", "execution_lag_days"],
      "evaluation",
    );
  }
  if (portfolio !== undefined) exactKeys(portfolio, ["kind", "sizing"], "portfolio");

  if (!Array.isArray(root.datasets) || root.datasets.length === 0) {
    throw new Error("datasets must be a non-empty sequence");
  }
  const datasets = root.datasets.map((value, index) => {
    const dataset = record(value, `datasets[${index}]`);
    exactKeys(dataset, ["adapter"], `datasets[${index}]`);
    return { adapter: relativePath(dataset.adapter, `datasets[${index}].adapter`) };
  });

  if (!Array.isArray(tools.allowed) || tools.allowed.length === 0) {
    throw new Error("tools.allowed must be a non-empty sequence");
  }
  const allowed = tools.allowed.map((value, index) => string(value, `tools.allowed[${index}]`));

  if (!Array.isArray(generation.seeds) || generation.seeds.length === 0) {
    throw new Error("data_generation.seeds must be a non-empty sequence");
  }
  const seeds = generation.seeds.map((value, index) =>
    integer(value, `data_generation.seeds[${index}]`, 0),
  );
  if (seeds.some((seed) => seed > 0xffff_ffff)) {
    throw new Error("data_generation seeds must be unsigned 32-bit integers");
  }
  if (new Set(seeds).size !== seeds.length) throw new Error("data_generation seeds must be unique");

  const researchStart = isoDate(period.research_start, "period.research_start");
  const researchEnd = isoDate(period.research_end, "period.research_end");
  if (researchStart > researchEnd) throw new Error("research period ends before it starts");

  const normalized: TaskManifest = {
    taskId: string(root.task_id, "task_id"),
    universe: {
      source: relativePath(universe.source, "universe.source"),
      size: integer(universe.size, "universe.size", 1),
    },
    period: { researchStart, researchEnd },
    label: {
      horizonDays: integer(label.horizon_days, "label.horizon_days", 1),
      definition: string(label.definition, "label.definition"),
    },
    datasets,
    tools: { allowed },
    dataGeneration: {
      script: relativePath(generation.script, "data_generation.script"),
      seeds,
    },
  };
  if (evaluation !== undefined) {
    const executionLagDays =
      evaluation.execution_lag_days === undefined
        ? undefined
        : integer(evaluation.execution_lag_days, "evaluation.execution_lag_days", 0);
    normalized.evaluation = {
      purgeDays: integer(evaluation.purge_days, "evaluation.purge_days", 0),
      embargoDays: integer(evaluation.embargo_days, "evaluation.embargo_days", 0),
      rebalanceEveryDays: integer(
        evaluation.rebalance_every_days,
        "evaluation.rebalance_every_days",
        1,
      ),
      ...(executionLagDays === undefined ? {} : { executionLagDays }),
    };
  }
  if (portfolio !== undefined) {
    if (portfolio.kind !== "long-only-quantile" && portfolio.kind !== "long-short-quantile") {
      throw new Error("portfolio.kind must be long-only-quantile or long-short-quantile");
    }
    if (portfolio.sizing !== "equal" && portfolio.sizing !== "artifact-weight") {
      throw new Error("portfolio.sizing must be equal or artifact-weight");
    }
    normalized.portfolio = { kind: portfolio.kind, sizing: portfolio.sizing };
  }
  return normalized;
}

export function loadTaskManifest(path: string): TaskManifest {
  return parseTaskManifest(parse(readFileSync(path, "utf8")));
}
