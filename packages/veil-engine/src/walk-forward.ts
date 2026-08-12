import { type AdapterDeclaration, hashAdapterDeclaration } from "@veilquant/contract";
import { type ArtifactManifest, verifyArtifactManifest } from "./artifact.ts";
import {
  type ArtifactExecutionLimits,
  type ArtifactExecutionResult,
  executeArtifactWithEvidence,
} from "./artifact-execution.ts";
import { ArtifactRuntimeRegistry } from "./artifact-runtime.ts";
import { EngineConfigurationError } from "./errors.ts";
import type { ReadSetManifest } from "./read-set.ts";
import { SourceBinding } from "./source-binding.ts";
import { TemporalGuard } from "./temporal-guard.ts";
import { createWalkForwardPlan, type WalkForwardPlan } from "./walk-forward-plan.ts";
import {
  createWalkForwardRunRecord,
  createWalkForwardWindowExecutionRecord,
  type WalkForwardRunRecord,
  type WalkForwardWindowExecutionRecord,
} from "./walk-forward-record.ts";
import { createWindowReadSet, type WindowReadSet } from "./window-read-set.ts";

export interface ExecuteWalkForwardWindowsInput {
  readonly artifact: unknown;
  /** Original local package root; verified and materialized separately for every fold. */
  readonly codeRoot: string;
  readonly decisionSchedule: readonly string[];
  readonly declaration: AdapterDeclaration;
  readonly guard: TemporalGuard;
  readonly binding: SourceBinding;
  readonly runtimes: ArtifactRuntimeRegistry;
  /** Optional factor projection. The declared event-time column is always retained as evidence. */
  readonly columns?: readonly string[];
  readonly limits?: ArtifactExecutionLimits;
  readonly signal?: AbortSignal;
}

export interface WalkForwardWindowExecution {
  readonly source: {
    readonly readSet: ReadSetManifest;
    readonly arrowIpc: Uint8Array;
  };
  readonly window: WindowReadSet;
  readonly execution: ArtifactExecutionResult;
  readonly record: WalkForwardWindowExecutionRecord;
}

export interface WalkForwardWindowsResult {
  readonly plan: WalkForwardPlan;
  readonly windows: readonly WalkForwardWindowExecution[];
  readonly record: WalkForwardRunRecord;
}

/**
 * Executes each derived training window. This Stage 2C-3 surface intentionally issues no OOS
 * metric or verified verdict; mask-first evaluation and pricing are added by Stage 2C-4.
 */
export async function executeWalkForwardWindows(
  input: ExecuteWalkForwardWindowsInput,
): Promise<WalkForwardWindowsResult> {
  validateInput(input);
  throwIfAborted(input.signal);
  const artifact = verifyArtifactManifest(input.artifact);
  const dataset = singleDataset(artifact);
  requireDeclaration(dataset, input.declaration);
  const plan = createWalkForwardPlan({
    protocol: artifact.protocol,
    decisionSchedule: input.decisionSchedule,
  });
  const columns = windowColumns(input.columns, input.declaration.eventTime);
  const windows: WalkForwardWindowExecution[] = [];

  for (const fold of plan.folds) {
    throwIfAborted(input.signal);
    const source = await input.guard.read(
      input.declaration,
      columns === undefined
        ? { asOf: fold.train.lastDecisionTime }
        : { asOf: fold.train.lastDecisionTime, columns },
      input.binding,
    );
    const window = createWindowReadSet({
      sourceReadSet: source.readSet,
      sourceArrowIpc: source.arrowIpc,
      declaration: input.declaration,
      plan,
      foldIndex: fold.index,
    });
    if (window.manifest.result.rowCount === 0) {
      throw new EngineConfigurationError(
        "EMPTY_VERIFICATION_WINDOW",
        `walk-forward fold ${fold.index} has no training rows`,
        "Supply data covering every declared training range or correct the decision schedule.",
      );
    }
    const execution = await executeArtifactWithEvidence({
      artifact,
      codeRoot: input.codeRoot,
      evidence: {
        readSetId: window.manifest.windowHash,
        dataset: window.manifest.dataset,
        version: window.manifest.adapterVersion,
        declarationHash: window.manifest.declarationHash,
        decisionTime: window.manifest.decisionTime,
        inputArrowHash: window.manifest.result.arrowHash,
        developmentReadSetIds: [window.manifest.sourceReadSetId, window.manifest.windowHash],
      },
      arrowIpc: window.arrowIpc,
      runtimes: input.runtimes,
      limits: input.limits,
      signal: input.signal,
    });
    const record = createWalkForwardWindowExecutionRecord({
      artifact,
      plan,
      windowReadSet: window.manifest,
      execution,
    });
    windows.push(
      Object.freeze({
        source: Object.freeze({ readSet: source.readSet, arrowIpc: source.arrowIpc }),
        window,
        execution,
        record,
      }),
    );
  }

  const record = createWalkForwardRunRecord({
    artifact,
    plan,
    windows: windows.map((window) => window.record),
  });
  return Object.freeze({ plan, windows: Object.freeze(windows), record });
}

function validateInput(input: ExecuteWalkForwardWindowsInput): void {
  if (!isPlainRecord(input)) throw invalidExecution("walk-forward input must be an object");
  const required = [
    "artifact",
    "codeRoot",
    "decisionSchedule",
    "declaration",
    "guard",
    "binding",
    "runtimes",
  ];
  const allowed = new Set([...required, "columns", "limits", "signal"]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(input, key))
  ) {
    throw invalidExecution("walk-forward input has missing or unknown fields");
  }
  if (
    typeof input.codeRoot !== "string" ||
    input.codeRoot.length === 0 ||
    !Array.isArray(input.decisionSchedule) ||
    !(input.guard instanceof TemporalGuard) ||
    !(input.binding instanceof SourceBinding) ||
    !(input.runtimes instanceof ArtifactRuntimeRegistry)
  ) {
    throw invalidExecution("walk-forward input contains an invalid engine capability");
  }
}

function singleDataset(
  artifact: ArtifactManifest,
): ArtifactManifest["dataSemantics"]["datasets"][0] {
  const dataset = artifact.dataSemantics.datasets[0];
  if (artifact.dataSemantics.datasets.length !== 1 || dataset === undefined) {
    throw invalidExecution("Stage 2C-3 walk-forward execution requires exactly one dataset");
  }
  return dataset;
}

function requireDeclaration(
  dataset: ArtifactManifest["dataSemantics"]["datasets"][0],
  declaration: AdapterDeclaration,
): void {
  if (!isPlainRecord(declaration)) {
    throw invalidExecution("walk-forward declaration is not a normalized adapter declaration");
  }
  let declarationHash: string;
  try {
    declarationHash = hashAdapterDeclaration(declaration);
  } catch {
    throw invalidExecution("walk-forward declaration is not a normalized adapter declaration");
  }
  if (
    declaration.dataset !== dataset.dataset ||
    declaration.version !== dataset.version ||
    declarationHash !== dataset.declarationHash
  ) {
    throw invalidExecution("walk-forward declaration is not the artifact's declared dataset");
  }
}

function windowColumns(
  input: readonly string[] | undefined,
  eventTimeColumn: string,
): readonly string[] | undefined {
  if (input === undefined) return undefined;
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.some(
      (column) => typeof column !== "string" || column.length === 0 || column.trim() !== column,
    ) ||
    new Set(input).size !== input.length
  ) {
    throw invalidExecution("walk-forward projection must contain unique non-empty column names");
  }
  return Object.freeze(input.includes(eventTimeColumn) ? [...input] : [...input, eventTimeColumn]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new EngineConfigurationError(
      "ARTIFACT_EXECUTION_ABORTED",
      "walk-forward execution was cancelled",
      "Retry with a live AbortSignal if this run is still required.",
    );
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function invalidExecution(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_WALK_FORWARD_EXECUTION",
    message,
    "Use one declared dataset, an explicit UTC schedule, and engine-created guard capabilities.",
  );
}
