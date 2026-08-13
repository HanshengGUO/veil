import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PiModelReference, PiProviderEnvironmentOverride } from "./model.ts";
import {
  type PiTaskProfile,
  type PiTaskRunResult,
  runBarePiTask,
  runVeilPiTask,
  scoreBareTask,
  scoreVeilTask,
} from "./pi-session.ts";
import { aggregateScores, type HonestScore, type SuiteScore, type TrapScore } from "./scoring.ts";
import { type BenchSuite, selectSuiteTasks } from "./suite.ts";
import { discoverTasks } from "./tasks.ts";

export interface BaselineFailure {
  taskId: string;
  taskKind: "trap" | "honest";
  error: string;
}

export interface ModelBaselineSummary {
  model: PiModelReference;
  suiteScore: SuiteScore;
  falseEffectClaims: number;
  completedRuns: number;
  failedRuns: number;
  trapScores: TrapScore[];
  honestScores: HonestScore[];
  failures: BaselineFailure[];
}

export interface BaselineSummary {
  schemaVersion: 1;
  profile: PiTaskProfile;
  suite: BenchSuite;
  variant: string;
  taskCount: number;
  startedAt: string;
  finishedAt: string;
  models: ModelBaselineSummary[];
}

export interface RunBaselineOptions {
  tasksDirectory: string;
  outputDirectory: string;
  suite: BenchSuite;
  variant: string;
  models: PiModelReference[];
  profile?: PiTaskProfile;
  providerOverride?: PiProviderEnvironmentOverride;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface RescoreBaselineOptions {
  tasksDirectory: string;
  runDirectory: string;
  onProgress?: (message: string) => void;
}

function ensureEmptyDirectory(path: string): void {
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`baseline output directory is not empty: ${path}`);
  }
  mkdirSync(path, { recursive: true });
}

function modelDirectory(model: PiModelReference): string {
  const identity = `${model.provider}/${model.model}/${model.thinkingLevel}`;
  const readable = `${model.provider}-${model.model}`.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  return `${readable}-${createHash("sha256").update(identity).digest("hex").slice(0, 8)}`;
}

function failedTrap(taskId: string, error: string): TrapScore {
  return {
    taskId,
    layer: "G4",
    weight: 0,
    expectedLayer: false,
    reason: `run failed before a scorable conclusion: ${error}`,
  };
}

function failedHonest(taskId: string, error: string): HonestScore {
  return { taskId, passed: false, reasons: [`run failed: ${error}`] };
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function reportCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

export function renderBaselineReport(summary: BaselineSummary): string {
  const lines = [
    summary.profile === "bare" ? "# Bare-agent baseline" : "# Veil Stage 3 evaluation",
    "",
    `Suite: **${summary.suite}** · variant: \`${summary.variant}\` · ${summary.taskCount} tasks`,
    "",
    "| Model | Safety | Perfect | Competence | False effect claims | Completed | Failed |",
    "| --- | ---: | :---: | ---: | ---: | ---: | ---: |",
  ];
  for (const model of summary.models) {
    lines.push(
      `| \`${model.model.provider}/${model.model.model}\` | ${formatNumber(model.suiteScore.safety)} | ${model.suiteScore.safetyPerfect ? "yes" : "no"} | ${formatNumber(model.suiteScore.competence)} | ${model.falseEffectClaims} | ${model.completedRuns} | ${model.failedRuns} |`,
    );
  }

  lines.push("", "## Trap attribution", "");
  for (const model of summary.models) {
    lines.push(`### ${model.model.provider}/${model.model.model}`, "");
    lines.push("| Task | Layer | Weight | Reason |", "| --- | :---: | ---: | --- |");
    for (const score of model.trapScores) {
      lines.push(
        `| ${score.taskId} | ${score.layer} | ${formatNumber(score.weight)} | ${score.reason} |`,
      );
    }
    lines.push("");
  }

  const failedRuns = summary.models.flatMap((model) =>
    model.failures.map((failure) => ({ model: model.model, failure })),
  );
  if (failedRuns.length > 0) {
    lines.push(
      "## Failed runs",
      "",
      "| Model | Task | Kind | Error |",
      "| --- | --- | --- | --- |",
    );
    for (const { model, failure } of failedRuns) {
      lines.push(
        `| \`${model.provider}/${model.model}\` | ${failure.taskId} | ${failure.taskKind} | ${reportCell(failure.error)} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "Safety and competence are separate axes. A failed run earns neither safety nor competence; it",
    "cannot make a model look safe merely by refusing or failing to finish. Raw session events and",
    "agent artifacts remain in the corresponding local run directory.",
    "",
  );
  if (summary.profile === "veil") {
    lines.push(
      "This Stage 3 evaluation is diagnostic. It scores structural promotion evidence and keeps all",
      "metrics unverified; pricing, cost, multiple-testing, and Experiment gates arrive in Stage 4.",
      "Do not present this report as a completed v0.1 release or hidden-set acceptance.",
      "",
    );
  }
  return lines.join("\n");
}

/** Run the same parameterized suite through each selected Pi profile, sequentially. */
export async function runBaseline(options: RunBaselineOptions): Promise<BaselineSummary> {
  const profile = options.profile ?? "bare";
  if (options.models.length < 1) throw new Error("baseline requires at least one model");
  if (profile === "bare" && options.suite === "full" && options.models.length < 2) {
    throw new Error("a full baseline requires at least two models");
  }
  const modelIdentities = options.models.map(
    (model) => `${model.provider}/${model.model}/${model.thinkingLevel}`,
  );
  if (new Set(modelIdentities).size !== modelIdentities.length) {
    throw new Error("baseline model references must be unique");
  }
  const outputDirectory = resolve(options.outputDirectory);
  ensureEmptyDirectory(outputDirectory);
  const tasks = selectSuiteTasks(discoverTasks(options.tasksDirectory), options.suite);
  const startedAt = new Date();
  const models: ModelBaselineSummary[] = [];
  const runTask = profile === "bare" ? runBarePiTask : runVeilPiTask;

  for (const model of options.models) {
    const trapScores: TrapScore[] = [];
    const honestScores: HonestScore[] = [];
    const failures: BaselineFailure[] = [];
    const completed: PiTaskRunResult[] = [];
    const modelOutput = join(outputDirectory, "runs", modelDirectory(model));
    let fatalModelError: string | undefined;

    for (const task of tasks) {
      options.onProgress?.(`${model.provider}/${model.model}: ${task.manifest.taskId}`);
      if (fatalModelError !== undefined) {
        failures.push({
          taskId: task.manifest.taskId,
          taskKind: task.kind,
          error: fatalModelError,
        });
        if (task.kind === "trap")
          trapScores.push(failedTrap(task.manifest.taskId, fatalModelError));
        else honestScores.push(failedHonest(task.manifest.taskId, fatalModelError));
        continue;
      }
      try {
        const result = await runTask({
          task,
          model,
          outputDirectory: join(modelOutput, task.manifest.taskId),
          providerOverride: options.providerOverride,
          variant: options.variant,
          timeoutMs: options.timeoutMs,
        });
        completed.push(result);
        if (task.kind === "trap") trapScores.push(result.score as TrapScore);
        else honestScores.push(result.score as HonestScore);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("Pi model request failed:")) fatalModelError = message;
        failures.push({ taskId: task.manifest.taskId, taskKind: task.kind, error: message });
        if (task.kind === "trap") trapScores.push(failedTrap(task.manifest.taskId, message));
        else honestScores.push(failedHonest(task.manifest.taskId, message));
      }
    }

    models.push({
      model,
      suiteScore: aggregateScores(trapScores, honestScores),
      falseEffectClaims: completed.filter(
        (run) => run.taskKind === "trap" && run.submission.conclusion === "effect",
      ).length,
      completedRuns: completed.length,
      failedRuns: failures.length,
      trapScores,
      honestScores,
      failures,
    });
  }

  const summary: BaselineSummary = {
    schemaVersion: 1,
    profile,
    suite: options.suite,
    variant: options.variant,
    taskCount: tasks.length,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    models,
  };
  writeFileSync(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outputDirectory, "REPORT.md"), renderBaselineReport(summary));
  return summary;
}

function normalizedHistoricalFailure(error: string): string {
  const temporarySubmissionPath = /\/tmp\/veil-bench-run-[^/'"\s]+\/workspace\/submission\.json/;
  if (error.includes("ENOENT") && temporarySubmissionPath.test(error)) {
    return "submission file does not exist: submission.json";
  }
  return error.replaceAll(/\/tmp\/veil-bench-run-[^/'"\s]+\/workspace\//g, "");
}

function recordedFailureError(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  return typeof value.error === "string" ? value.error : undefined;
}

/** Reapply the current deterministic scorer to an existing raw baseline without model calls. */
export function rescoreBaseline(options: RescoreBaselineOptions): BaselineSummary {
  const runDirectory = resolve(options.runDirectory);
  const summaryPath = join(runDirectory, "summary.json");
  const previous = JSON.parse(readFileSync(summaryPath, "utf8")) as BaselineSummary;
  if (
    previous.schemaVersion !== 1 ||
    (previous.profile !== "bare" && previous.profile !== "veil")
  ) {
    throw new Error("unsupported baseline summary format");
  }

  const tasks = selectSuiteTasks(discoverTasks(options.tasksDirectory), previous.suite);
  if (tasks.length !== previous.taskCount) {
    throw new Error(
      `baseline task count ${previous.taskCount} does not match current suite count ${tasks.length}`,
    );
  }

  const models: ModelBaselineSummary[] = previous.models.map((previousModel) => {
    const trapScores: TrapScore[] = [];
    const honestScores: HonestScore[] = [];
    const failures: BaselineFailure[] = [];
    const completed: PiTaskRunResult[] = [];
    const modelOutput = join(runDirectory, "runs", modelDirectory(previousModel.model));

    for (const task of tasks) {
      const taskId = task.manifest.taskId;
      options.onProgress?.(
        `${previousModel.model.provider}/${previousModel.model.model}: ${taskId}`,
      );
      const taskOutput = join(modelOutput, taskId);
      const resultPath = join(taskOutput, "result.json");
      if (existsSync(resultPath)) {
        const result = JSON.parse(readFileSync(resultPath, "utf8")) as PiTaskRunResult;
        if (result.taskId !== taskId || result.taskKind !== task.kind) {
          throw new Error(`run result identity does not match current task: ${resultPath}`);
        }
        if (result.profile !== previous.profile) {
          throw new Error(`run result profile does not match summary: ${resultPath}`);
        }
        const rescored: PiTaskRunResult = {
          ...result,
          score:
            previous.profile === "bare"
              ? scoreBareTask(task, result.submission)
              : scoreVeilTask(task, result.submission, requiredVeilEvidence(result, resultPath)),
        };
        writeFileSync(resultPath, `${JSON.stringify(rescored, null, 2)}\n`);
        completed.push(rescored);
        if (task.kind === "trap") trapScores.push(rescored.score as TrapScore);
        else honestScores.push(rescored.score as HonestScore);
        continue;
      }

      const previousFailure = previousModel.failures.find((failure) => failure.taskId === taskId);
      const errorPath = join(taskOutput, "error.json");
      const recordedError = recordedFailureError(errorPath) ?? previousFailure?.error;
      if (recordedError === undefined) {
        throw new Error(`run has neither result nor recorded failure: ${taskOutput}`);
      }
      const error = normalizedHistoricalFailure(recordedError);
      failures.push({ taskId, taskKind: task.kind, error });
      if (task.kind === "trap") trapScores.push(failedTrap(taskId, error));
      else honestScores.push(failedHonest(taskId, error));

      if (existsSync(errorPath)) {
        const failureRecord = JSON.parse(readFileSync(errorPath, "utf8")) as Record<
          string,
          unknown
        >;
        failureRecord.error = error;
        writeFileSync(errorPath, `${JSON.stringify(failureRecord, null, 2)}\n`);
      }
    }

    return {
      model: previousModel.model,
      suiteScore: aggregateScores(trapScores, honestScores),
      falseEffectClaims: completed.filter(
        (run) => run.taskKind === "trap" && run.submission.conclusion === "effect",
      ).length,
      completedRuns: completed.length,
      failedRuns: failures.length,
      trapScores,
      honestScores,
      failures,
    };
  });

  const summary: BaselineSummary = { ...previous, taskCount: tasks.length, models };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(runDirectory, "REPORT.md"), renderBaselineReport(summary));
  return summary;
}

function requiredVeilEvidence(
  result: PiTaskRunResult,
  resultPath: string,
): NonNullable<PiTaskRunResult["verificationEvidence"]> {
  if (result.verificationEvidence === undefined) {
    throw new Error(`Veil run result has no verification evidence: ${resultPath}`);
  }
  return result.verificationEvidence;
}
