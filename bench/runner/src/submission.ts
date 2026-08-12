import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export type SubmissionConclusion = "effect" | "null" | "invalid";
export type SubmissionMetricStatus = "unverified" | "verified";
export type SubmissionInvariant = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";

export interface BenchSubmission {
  schemaVersion: 1;
  taskId: string;
  conclusion: SubmissionConclusion;
  experimentId?: string;
  metric?: {
    name: string;
    value: number;
    status: SubmissionMetricStatus;
    experimentId?: string;
  };
  risk?: {
    maxDrawdown: number;
  };
  invalidity?: {
    invariant?: SubmissionInvariant;
    reason: string;
  };
  evidence: string[];
  limitations: string[];
}

export const SUBMISSION_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://veilquant.ai/schemas/bench-submission-v1.json",
  title: "Veil-bench submission",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "task_id", "conclusion", "evidence", "limitations"],
  properties: {
    schema_version: { const: 1 },
    task_id: { type: "string", minLength: 1 },
    conclusion: { enum: ["effect", "null", "invalid"] },
    experiment_id: { type: "string", minLength: 1 },
    metric: {
      type: "object",
      additionalProperties: false,
      required: ["name", "value", "status"],
      properties: {
        name: { type: "string", minLength: 1 },
        value: { type: "number" },
        status: { enum: ["unverified", "verified"] },
        experiment_id: { type: "string", minLength: 1 },
      },
    },
    risk: {
      type: "object",
      additionalProperties: false,
      required: ["max_drawdown"],
      properties: {
        max_drawdown: { type: "number", minimum: -1, maximum: 0 },
      },
    },
    invalidity: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: {
        invariant: { enum: ["C1", "C2", "C3", "C4", "C5", "C6"] },
        reason: { type: "string", minLength: 1 },
      },
    },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
    limitations: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
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

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function textArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => text(entry, `${path}[${index}]`));
}

const CONCLUSIONS = new Set<SubmissionConclusion>(["effect", "null", "invalid"]);
const STATUSES = new Set<SubmissionMetricStatus>(["unverified", "verified"]);
const INVARIANTS = new Set<SubmissionInvariant>(["C1", "C2", "C3", "C4", "C5", "C6"]);

export function parseSubmission(input: unknown, expectedTaskId?: string): BenchSubmission {
  const root = record(input, "submission");
  exactKeys(
    root,
    [
      "schema_version",
      "task_id",
      "conclusion",
      "experiment_id",
      "metric",
      "risk",
      "invalidity",
      "evidence",
      "limitations",
    ],
    "submission",
  );
  if (root.schema_version !== 1) throw new Error("schema_version must be 1");
  const taskId = text(root.task_id, "task_id");
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
    throw new Error(`submission task_id ${taskId} does not match ${expectedTaskId}`);
  }

  const conclusion = text(root.conclusion, "conclusion") as SubmissionConclusion;
  if (!CONCLUSIONS.has(conclusion)) throw new Error(`unsupported conclusion: ${conclusion}`);

  let metric: BenchSubmission["metric"];
  if (root.metric !== undefined) {
    const source = record(root.metric, "metric");
    exactKeys(source, ["name", "value", "status", "experiment_id"], "metric");
    const value = source.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("metric.value must be a finite number");
    }
    const status = text(source.status, "metric.status") as SubmissionMetricStatus;
    if (!STATUSES.has(status)) throw new Error(`unsupported metric status: ${status}`);
    const experimentId =
      source.experiment_id === undefined
        ? undefined
        : text(source.experiment_id, "metric.experiment_id");
    metric = { name: text(source.name, "metric.name"), value, status, experimentId };
  }

  const rootExperimentId =
    root.experiment_id === undefined ? undefined : text(root.experiment_id, "experiment_id");
  if (
    rootExperimentId !== undefined &&
    metric?.experimentId !== undefined &&
    rootExperimentId !== metric.experimentId
  ) {
    throw new Error("experiment_id and metric.experiment_id must match when both are present");
  }
  const experimentId = rootExperimentId ?? metric?.experimentId;
  if (metric?.status === "verified" && experimentId === undefined) {
    throw new Error("a verified metric requires experiment_id");
  }

  let risk: BenchSubmission["risk"];
  if (root.risk !== undefined) {
    const source = record(root.risk, "risk");
    exactKeys(source, ["max_drawdown"], "risk");
    const maxDrawdown = source.max_drawdown;
    if (
      typeof maxDrawdown !== "number" ||
      !Number.isFinite(maxDrawdown) ||
      maxDrawdown < -1 ||
      maxDrawdown > 0
    ) {
      throw new Error("risk.max_drawdown must be a finite number between -1 and 0");
    }
    risk = { maxDrawdown };
  }

  let invalidity: BenchSubmission["invalidity"];
  if (root.invalidity !== undefined) {
    const source = record(root.invalidity, "invalidity");
    exactKeys(source, ["invariant", "reason"], "invalidity");
    const invariant =
      source.invariant === undefined
        ? undefined
        : (text(source.invariant, "invalidity.invariant") as SubmissionInvariant);
    if (invariant !== undefined && !INVARIANTS.has(invariant)) {
      throw new Error(`unsupported invariant: ${invariant}`);
    }
    invalidity = { invariant, reason: text(source.reason, "invalidity.reason") };
  }

  if (conclusion === "effect" && metric === undefined) {
    throw new Error("an effect conclusion requires a metric");
  }
  if (conclusion === "invalid" && invalidity === undefined) {
    throw new Error("an invalid conclusion requires invalidity.reason");
  }

  return {
    schemaVersion: 1,
    taskId,
    conclusion,
    experimentId,
    metric,
    risk,
    invalidity,
    evidence: textArray(root.evidence, "evidence"),
    limitations: textArray(root.limitations, "limitations"),
  };
}

export function loadSubmission(path: string, expectedTaskId?: string): BenchSubmission {
  if (!existsSync(path)) {
    throw new Error(`submission file does not exist: ${basename(path)}`);
  }
  return parseSubmission(JSON.parse(readFileSync(path, "utf8")), expectedTaskId);
}
