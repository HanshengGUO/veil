import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { EMPTY_EVIDENCE, scoreTrap, type TrapScore } from "./scoring.ts";
import type { BenchSubmission } from "./submission.ts";
import { discoverTasks } from "./tasks.ts";

const execFileAsync = promisify(execFile);
const TSX_IMPORT_URL = import.meta.resolve("tsx");

export interface Stage4AgentAcceptance {
  readonly verdicts: readonly ["rejected", "rejected", "accepted"];
  readonly claimStatus: "verified";
  readonly experimentId: string;
  readonly archivedSnapshots: number;
  readonly memoryExperiments: 5;
  readonly reproductionStatus: "matched";
}

export interface Stage4GateAttribution {
  readonly taskId: "T6_multiple_testing" | "T7_knowledge_pollution";
  readonly layer: "G2";
  readonly reasonCode: "trial-budget-exhausted" | "post-cutoff-validation-required";
  readonly expectedLayer: true;
}

export interface Stage4BenchAcceptanceReport {
  readonly publicTaskCount: 15;
  readonly agentLoop: Stage4AgentAcceptance;
  readonly gateAttribution: readonly [Stage4GateAttribution, Stage4GateAttribution];
  readonly capacityGatePassed: true;
  readonly externalPluginAuthorRun: false;
  readonly hiddenSetRun: false;
  readonly modelCompetenceScored: false;
}

export interface VerifyStage4BenchAcceptanceOptions {
  readonly tasksDirectory: string;
  readonly repositoryRoot?: string;
  readonly runAgentLoop?: () => Promise<unknown>;
}

/** Deterministic Stage 4 acceptance; model, hidden, and external-user claims remain explicit. */
export async function verifyStage4BenchAcceptance(
  options: VerifyStage4BenchAcceptanceOptions,
): Promise<Stage4BenchAcceptanceReport> {
  const repositoryRoot = resolve(options.repositoryRoot ?? ".");
  const tasks = discoverTasks(options.tasksDirectory);
  if (tasks.length !== 15) throw new Error("Stage 4 public task catalog must contain 15 tasks");
  const raw = await (options.runAgentLoop ?? (() => runAgentLoop(repositoryRoot)))();
  const agent = record(raw, "Stage 4 agent-loop result");
  const verdicts = stringArray(agent.verdicts, "agent-loop verdicts");
  if (verdicts.join(",") !== "rejected,rejected,accepted") {
    throw new Error("Stage 4 parameter-family chronology did not reject, reject, then accept");
  }
  if (
    agent.claimStatus !== "verified" ||
    agent.reproductionStatus !== "matched" ||
    agent.memoryExperiments !== 5 ||
    !Number.isSafeInteger(agent.archivedSnapshots) ||
    (agent.archivedSnapshots as number) < 1 ||
    typeof agent.experimentId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(agent.experimentId)
  ) {
    throw new Error("Stage 4 Experiment archive or reproduction acceptance is incomplete");
  }
  const acceptedGates = gateReasons(agent.gateReasons, "accepted gate reasons");
  if (acceptedGates.get("capacity-sensitivity") !== "capacity-stress-passed") {
    throw new Error("Stage 4 clean path did not pass the capacity gate");
  }
  const budgetReasons = gateReasons(agent.trialBudgetRejection, "trial-budget rejection");
  const contaminationReasons = gateReasons(
    agent.knowledgeContaminationRejection,
    "knowledge-contamination rejection",
  );
  const attributions = [
    gateAttribution(tasks, "T6_multiple_testing", budgetReasons, "trial-budget-exhausted"),
    gateAttribution(
      tasks,
      "T7_knowledge_pollution",
      contaminationReasons,
      "post-cutoff-validation-required",
    ),
  ] as const;
  return Object.freeze({
    publicTaskCount: 15,
    agentLoop: Object.freeze({
      verdicts: Object.freeze(["rejected", "rejected", "accepted"] as const),
      claimStatus: "verified",
      experimentId: agent.experimentId,
      archivedSnapshots: agent.archivedSnapshots as number,
      memoryExperiments: 5,
      reproductionStatus: "matched",
    }),
    gateAttribution: Object.freeze(attributions),
    capacityGatePassed: true,
    externalPluginAuthorRun: false,
    hiddenSetRun: false,
    modelCompetenceScored: false,
  });
}

async function runAgentLoop(repositoryRoot: string): Promise<unknown> {
  const result = await execFileAsync(
    process.execPath,
    ["--import", TSX_IMPORT_URL, resolve(repositoryRoot, "examples/stage4-agent-loop/run.ts")],
    { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const line = result.stdout.trim().split(/\r?\n/u).at(-1);
  if (line === undefined) throw new Error("Stage 4 agent-loop emitted no acceptance record");
  return JSON.parse(line) as unknown;
}

function gateAttribution(
  tasks: ReturnType<typeof discoverTasks>,
  taskId: Stage4GateAttribution["taskId"],
  reasons: ReadonlyMap<string, string>,
  reasonCode: Stage4GateAttribution["reasonCode"],
): Stage4GateAttribution {
  if (![...reasons.values()].includes(reasonCode)) {
    throw new Error(`${taskId}: expected Stage 4 gate reason ${reasonCode} is absent`);
  }
  const task = tasks.find((candidate) => candidate.manifest.taskId === taskId);
  if (task === undefined || task.kind !== "trap") throw new Error(`${taskId}: trap is absent`);
  const submission: BenchSubmission = {
    schemaVersion: 1,
    taskId,
    conclusion: "effect",
    metric: { name: "sharpe", value: 2, status: "unverified" },
    evidence: [],
    limitations: [],
  };
  const score: TrapScore = scoreTrap(task.oracle, submission, {
    ...EMPTY_EVIDENCE,
    gateRejected: true,
  });
  if (score.layer !== "G2" || !score.expectedLayer) {
    throw new Error(`${taskId}: gate rejection was not attributed to expected G2`);
  }
  return Object.freeze({ taskId, layer: "G2", reasonCode, expectedLayer: true });
}

function gateReasons(input: unknown, field: string): ReadonlyMap<string, string> {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${field} must contain gate records`);
  }
  const output = new Map<string, string>();
  for (const value of input) {
    const item = record(value, field);
    if (typeof item.gateId !== "string" || typeof item.reasonCode !== "string") {
      throw new Error(`${field} contains a malformed gate record`);
    }
    output.set(item.gateId, item.reasonCode);
  }
  return output;
}

function record(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object`);
  }
  return input as Record<string, unknown>;
}

function stringArray(input: unknown, field: string): readonly string[] {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return input as string[];
}
