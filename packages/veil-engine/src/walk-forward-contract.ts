import { Buffer } from "node:buffer";
import {
  type AdapterDeclaration,
  ContractViolation,
  hashAdapterDeclaration,
  normalizeDecisionTime,
} from "@veilquant/contract";
import { Table, tableFromIPC, tableToIPC, type Vector, vectorFromArray } from "apache-arrow";
import { type ArtifactManifest, verifyArtifactManifest } from "./artifact.ts";
import {
  type ArtifactExecutionLimits,
  type ArtifactExecutionResult,
  executeArtifactWithEvidence,
} from "./artifact-execution.ts";
import { ArtifactRuntimeRegistry } from "./artifact-runtime.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  createReadSetResultIdentity,
  type ReadSetManifest,
  type ReadSetResultIdentity,
} from "./read-set.ts";
import { SourceBinding } from "./source-binding.ts";
import { readSetIdentityCacheForGuard, TemporalGuard } from "./temporal-guard.ts";
import {
  createVerificationViewWithIdentityCache,
  type VerificationView,
  type VerificationViewRole,
} from "./verification-view.ts";
import {
  createWalkForwardContractExecutionRecord,
  createWalkForwardContractRecord,
  parameterLockHashForArtifact,
  type WalkForwardContractExecutionRecord,
  type WalkForwardContractRecord,
} from "./walk-forward-contract-record.ts";
import { createWalkForwardPlan, type WalkForwardPlan } from "./walk-forward-plan.ts";

export interface ExecuteWalkForwardContractInput {
  readonly artifact: unknown;
  /** Original local package root; verified and materialized separately for every decision. */
  readonly codeRoot: string;
  readonly decisionSchedule: readonly string[];
  readonly declaration: AdapterDeclaration;
  readonly guard: TemporalGuard;
  readonly binding: SourceBinding;
  readonly runtimes: ArtifactRuntimeRegistry;
  /** Optional factor projection; entity, event-time, and declared mask are always retained. */
  readonly columns?: readonly string[];
  readonly limits?: ArtifactExecutionLimits;
  readonly signal?: AbortSignal;
  /** Bounded independent decision executions. Defaults to 1 and never changes record order. */
  readonly concurrency?: number;
  /** Set false for large runs that need records but not every intermediate Arrow payload. */
  readonly retainExecutionEvidence?: boolean;
}

export interface WalkForwardContractExecution {
  readonly source: {
    readonly readSet: ReadSetManifest;
    readonly arrowIpc: Uint8Array;
  };
  readonly view: VerificationView;
  readonly execution: ArtifactExecutionResult;
  readonly admitted: {
    readonly result: ReadSetResultIdentity;
    readonly arrowIpc: Uint8Array;
  };
  readonly record: WalkForwardContractExecutionRecord;
}

export interface WalkForwardContractResult {
  readonly plan: WalkForwardPlan;
  readonly parameterLockHash: string;
  readonly executionCount: number;
  readonly executionEvidence: "retained" | "discarded";
  readonly executions: readonly WalkForwardContractExecution[];
  /** C1-C4 structural evidence only; pricing, metrics, gates, and experiment verdict are absent. */
  readonly record: WalkForwardContractRecord;
}

interface DecisionExecution {
  readonly foldIndex: number;
  readonly role: VerificationViewRole;
  readonly decisionIndex: number;
}

interface AdmittedArtifactOutput {
  readonly arrowIpc: Uint8Array;
  readonly result: ReadSetResultIdentity;
}

/** Runs one fresh PIT + mask-first child invocation at every train cutoff and OOS decision time. */
export async function executeWalkForwardContract(
  input: ExecuteWalkForwardContractInput,
): Promise<WalkForwardContractResult> {
  validateInput(input);
  throwIfAborted(input.signal);
  const artifact = verifyArtifactManifest(input.artifact);
  const dataset = singleDataset(artifact);
  const maskColumn = requireDeclaration(dataset, input.declaration);
  const plan = contractPlan(artifact, input.decisionSchedule);
  const columns = verificationColumns(input.columns, input.declaration, maskColumn);
  const parameterLockHash = parameterLockHashForArtifact(artifact);
  const decisions = decisionExecutions(plan);
  const concurrency = input.concurrency ?? 1;
  const retainExecutionEvidence = input.retainExecutionEvidence ?? true;
  const outcomes = await mapWithConcurrency(decisions, concurrency, async (decision) => {
    throwIfAborted(input.signal);
    const decisionTime = plan.decisionSchedule[decision.decisionIndex];
    if (decisionTime === undefined) {
      throw c2("walk-forward decision is outside the normalized schedule");
    }
    const source = await input.guard.read(
      input.declaration,
      columns === undefined ? { asOf: decisionTime } : { asOf: decisionTime, columns },
      input.binding,
    );
    const view = createVerificationViewWithIdentityCache(
      {
        sourceReadSet: source.readSet,
        sourceArrowIpc: source.arrowIpc,
        declaration: input.declaration,
        plan,
        foldIndex: decision.foldIndex,
        role: decision.role,
        decisionIndex: decision.decisionIndex,
      },
      readSetIdentityCacheForGuard(input.guard),
    );
    if (decision.role === "train" && view.manifest.result.rowCount === 0) {
      throw new ContractViolation("C2", "walk-forward fold has no mask-eligible training rows", {
        dataset: `${input.declaration.dataset}@${input.declaration.version}`,
        asOf: decisionTime,
        context: { foldIndex: decision.foldIndex },
        remedy: "Supply PIT data with at least one tradable row in every training range.",
      });
    }
    const execution = await executeArtifactWithEvidence({
      artifact,
      codeRoot: input.codeRoot,
      evidence: {
        readSetId: view.manifest.viewHash,
        dataset: view.manifest.dataset,
        version: view.manifest.adapterVersion,
        declarationHash: view.manifest.declarationHash,
        decisionTime: view.manifest.decisionTime,
        inputArrowHash: view.manifest.result.arrowHash,
        developmentReadSetIds: [view.manifest.sourceReadSetId, view.manifest.viewHash],
      },
      arrowIpc: view.arrowIpc,
      runtimes: input.runtimes,
      limits: input.limits,
      signal: input.signal,
    });
    const admitted = admitArtifactOutput({
      inputArrowIpc: view.arrowIpc,
      outputArrowIpc: execution.arrowIpc,
      declaration: input.declaration,
      decisionTime,
      role: decision.role,
    });
    const record = createWalkForwardContractExecutionRecord({
      artifact,
      plan,
      view: view.manifest,
      execution,
      admittedOutput: admitted.result,
    });
    if (record.parameterLockHash !== parameterLockHash) {
      throw c3("parameter lock changed during walk-forward execution");
    }
    const retained = retainExecutionEvidence
      ? Object.freeze({
          source: Object.freeze({ readSet: source.readSet, arrowIpc: source.arrowIpc }),
          view,
          execution,
          admitted: Object.freeze(admitted),
          record,
        })
      : null;
    return Object.freeze({
      record,
      retained,
    });
  });
  const executions = outcomes.flatMap((outcome) =>
    outcome.retained === null ? [] : [outcome.retained],
  );

  const record = createWalkForwardContractRecord({
    artifact,
    plan,
    declaration: input.declaration,
    executions: outcomes.map((outcome) => outcome.record),
  });
  return Object.freeze({
    plan,
    parameterLockHash,
    executionCount: decisions.length,
    executionEvidence: retainExecutionEvidence ? "retained" : "discarded",
    executions: Object.freeze(executions),
    record,
  });
}

function admitArtifactOutput(input: {
  readonly inputArrowIpc: Uint8Array;
  readonly outputArrowIpc: Uint8Array;
  readonly declaration: AdapterDeclaration;
  readonly decisionTime: string;
  readonly role: VerificationViewRole;
}): AdmittedArtifactOutput {
  const source = decodeArrow(input.inputArrowIpc, "verification input");
  const output = decodeArrow(input.outputArrowIpc, "artifact output");
  requireUniqueColumns(output);
  const sourceEntity = requiredVector(
    source,
    input.declaration.entityKey,
    input.declaration,
    input.decisionTime,
    "C4",
    "verification input",
  );
  const sourceEvent = requiredVector(
    source,
    input.declaration.eventTime,
    input.declaration,
    input.decisionTime,
    "C1",
    "verification input",
  );
  const outputEntity = requiredVector(
    output,
    input.declaration.entityKey,
    input.declaration,
    input.decisionTime,
    "C4",
    "artifact output",
  );
  const outputEvent = requiredVector(
    output,
    input.declaration.eventTime,
    input.declaration,
    input.decisionTime,
    "C1",
    "artifact output",
  );
  const allowed = new Map<string, number>();
  for (let row = 0; row < source.numRows; row += 1) {
    const pair = rowIdentity(
      sourceEntity.get(row),
      sourceEvent.get(row),
      input.declaration,
      input.decisionTime,
      row,
      "verification input",
    );
    allowed.set(pair.key, (allowed.get(pair.key) ?? 0) + 1);
  }

  const decisionMillis = Date.parse(input.decisionTime);
  const admittedRows: number[] = [];
  for (let row = 0; row < output.numRows; row += 1) {
    const pair = rowIdentity(
      outputEntity.get(row),
      outputEvent.get(row),
      input.declaration,
      input.decisionTime,
      row,
      "artifact output",
    );
    if (pair.eventMillis > decisionMillis) {
      throw new ContractViolation("C1", "artifact output contains a future event-time row", {
        dataset: `${input.declaration.dataset}@${input.declaration.version}`,
        asOf: input.decisionTime,
        context: { column: input.declaration.eventTime, row },
        remedy: "Form signals only from rows present in the decision-time verification view.",
      });
    }
    const remaining = allowed.get(pair.key) ?? 0;
    if (remaining === 0) {
      throw new ContractViolation(
        "C4",
        "artifact output reintroduced an entity/event row absent from the mask-first input",
        {
          dataset: `${input.declaration.dataset}@${input.declaration.version}`,
          asOf: input.decisionTime,
          context: { row },
          remedy: "Emit signals only for entity/event rows supplied by the masked view.",
        },
      );
    }
    allowed.set(pair.key, remaining - 1);
    if (input.role === "train" || pair.eventMillis === decisionMillis) {
      admittedRows.push(row);
    }
  }
  const admittedTable = takeRows(output, admittedRows);
  const arrowIpc = tableToIPC(admittedTable, "stream");
  return Object.freeze({ arrowIpc, result: createReadSetResultIdentity(arrowIpc) });
}

function rowIdentity(
  entity: unknown,
  eventTime: unknown,
  declaration: AdapterDeclaration,
  asOf: string,
  row: number,
  origin: string,
): { readonly key: string; readonly eventMillis: number } {
  const eventMillis = eventTimeMillis(eventTime, declaration, asOf, row, origin);
  return Object.freeze({
    key: JSON.stringify([entityKey(entity, declaration, asOf, row, origin), eventMillis]),
    eventMillis,
  });
}

function entityKey(
  input: unknown,
  declaration: AdapterDeclaration,
  asOf: string,
  row: number,
  origin: string,
): string {
  if (typeof input === "string") return `string:${input}`;
  if (typeof input === "boolean") return `boolean:${input}`;
  if (typeof input === "bigint") return `bigint:${input.toString()}`;
  if (typeof input === "number" && Number.isFinite(input) && !Object.is(input, -0)) {
    return `number:${input}`;
  }
  if (input instanceof Date && Number.isFinite(input.valueOf())) {
    return `date:${input.valueOf()}`;
  }
  if (input instanceof Uint8Array) return `bytes:${Buffer.from(input).toString("base64")}`;
  throw new ContractViolation("C4", `${origin} contains an invalid entity key`, {
    dataset: `${declaration.dataset}@${declaration.version}`,
    asOf,
    context: { column: declaration.entityKey, row },
    remedy: "Use non-null scalar entity keys in verification inputs and artifact outputs.",
  });
}

function eventTimeMillis(
  input: unknown,
  declaration: AdapterDeclaration,
  asOf: string,
  row: number,
  origin: string,
): number {
  let instant = Number.NaN;
  try {
    if (typeof input === "number") instant = input;
    else if (input instanceof Date) instant = input.valueOf();
    else if (typeof input === "string") instant = Date.parse(normalizeDecisionTime(input));
  } catch {
    instant = Number.NaN;
  }
  if (Number.isFinite(instant)) return instant;
  throw new ContractViolation("C1", `${origin} contains an invalid event-time value`, {
    dataset: `${declaration.dataset}@${declaration.version}`,
    asOf,
    context: { column: declaration.eventTime, row },
    remedy: "Use ISO-8601 or Arrow timestamp milliseconds for every event-time value.",
  });
}

function requiredVector(
  table: Table,
  column: string,
  declaration: AdapterDeclaration,
  asOf: string,
  invariant: "C1" | "C4",
  origin: string,
): Vector {
  const vector = table.getChild(column);
  if (vector !== null) return vector;
  throw new ContractViolation(invariant, `${origin} omitted required column ${column}`, {
    dataset: `${declaration.dataset}@${declaration.version}`,
    asOf,
    context: { column },
    remedy: "Retain entity and event-time keys through factor output admission.",
  });
}

function decodeArrow(input: Uint8Array, origin: string): Table {
  try {
    return tableFromIPC(input);
  } catch {
    throw new EngineConfigurationError(
      "INVALID_ARTIFACT_OUTPUT",
      `${origin} is unreadable Arrow IPC`,
      "Return a supported Arrow IPC stream or file.",
    );
  }
}

function requireUniqueColumns(table: Table): void {
  const names = table.schema.fields.map((field) => field.name);
  if (names.some((name, index) => names.indexOf(name) !== index)) {
    throw new EngineConfigurationError(
      "INVALID_ARTIFACT_OUTPUT",
      "artifact output contains duplicate column names",
      "Return one uniquely named Arrow field per output column.",
    );
  }
}

function takeRows(table: Table, rows: readonly number[]): Table {
  try {
    const columns: Record<string, Vector> = {};
    for (let index = 0; index < table.schema.fields.length; index += 1) {
      const field = table.schema.fields[index];
      const vector = table.getChildAt(index);
      if (field === undefined || vector === null) throw new Error("missing column vector");
      columns[field.name] = vectorFromArray(
        rows.map((row) => vector.get(row)),
        field.type,
      );
    }
    return new Table(columns);
  } catch {
    throw new EngineConfigurationError(
      "INVALID_ARTIFACT_OUTPUT",
      "artifact output types cannot be sliced into the admitted decision view",
      "Return Arrow types supported by the canonical output admission layer.",
    );
  }
}

function decisionExecutions(plan: WalkForwardPlan): readonly DecisionExecution[] {
  return Object.freeze(
    plan.folds.flatMap((fold) => [
      {
        foldIndex: fold.index,
        role: "train" as const,
        decisionIndex: fold.train.endIndexExclusive - 1,
      },
      ...Array.from({ length: fold.outOfSample.sessionCount }, (_, offset) => ({
        foldIndex: fold.index,
        role: "out-of-sample" as const,
        decisionIndex: fold.outOfSample.startIndex + offset,
      })),
    ]),
  );
}

function contractPlan(
  artifact: ArtifactManifest,
  decisionSchedule: readonly string[],
): WalkForwardPlan {
  try {
    return createWalkForwardPlan({ protocol: artifact.protocol, decisionSchedule });
  } catch (cause) {
    if (cause instanceof EngineConfigurationError && cause.code === "INVALID_WALK_FORWARD_PLAN") {
      const reason = cause.message.replace(/^\[INVALID_WALK_FORWARD_PLAN\]\s*/u, "");
      throw new ContractViolation("C2", `walk-forward topology is invalid: ${reason}`, {
        context: { reason },
        remedy:
          "Use the artifact's rolling or expanding protocol and supply every required UTC session.",
      });
    }
    throw cause;
  }
}

function singleDataset(
  artifact: ArtifactManifest,
): ArtifactManifest["dataSemantics"]["datasets"][0] {
  const dataset = artifact.dataSemantics.datasets[0];
  if (artifact.dataSemantics.datasets.length !== 1 || dataset === undefined) {
    throw c2("walk-forward contract verification requires exactly one artifact dataset");
  }
  return dataset;
}

function requireDeclaration(
  dataset: ArtifactManifest["dataSemantics"]["datasets"][0],
  declaration: AdapterDeclaration,
): string {
  let declarationHash: string;
  try {
    declarationHash = hashAdapterDeclaration(declaration);
  } catch {
    throw invalidContract("walk-forward declaration is not normalized");
  }
  if (
    declaration.dataset !== dataset.dataset ||
    declaration.version !== dataset.version ||
    declarationHash !== dataset.declarationHash
  ) {
    throw invalidContract("walk-forward declaration is not the artifact's declared dataset");
  }
  const maskColumn = declaration.guarantees.tradabilityMask;
  if (maskColumn === null) {
    throw new ContractViolation("C4", "verification requires a declared tradability mask", {
      dataset: `${declaration.dataset}@${declaration.version}`,
      remedy:
        "Use a registered dataset whose adapter already declares a truthful guarantees.tradability_mask, or keep the result exploratory; never add a guarantee without source evidence.",
    });
  }
  return maskColumn;
}

function verificationColumns(
  input: readonly string[] | undefined,
  declaration: AdapterDeclaration,
  maskColumn: string,
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
    throw invalidContract("verification projection must contain unique non-empty column names");
  }
  return Object.freeze([
    ...input,
    ...[declaration.entityKey, declaration.eventTime, maskColumn].filter(
      (column) => !input.includes(column),
    ),
  ]);
}

function validateInput(input: ExecuteWalkForwardContractInput): void {
  if (!isPlainRecord(input)) throw invalidContract("walk-forward contract input must be an object");
  const required = [
    "artifact",
    "codeRoot",
    "decisionSchedule",
    "declaration",
    "guard",
    "binding",
    "runtimes",
  ];
  const allowed = new Set([
    ...required,
    "columns",
    "limits",
    "signal",
    "concurrency",
    "retainExecutionEvidence",
  ]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(input, key))
  ) {
    throw invalidContract("walk-forward contract input has missing or unknown fields");
  }
  if (
    typeof input.codeRoot !== "string" ||
    input.codeRoot.length === 0 ||
    !Array.isArray(input.decisionSchedule) ||
    !(input.guard instanceof TemporalGuard) ||
    !(input.binding instanceof SourceBinding) ||
    !(input.runtimes instanceof ArtifactRuntimeRegistry)
  ) {
    throw invalidContract("walk-forward contract input contains an invalid engine capability");
  }
  if (
    (input.concurrency !== undefined &&
      (!Number.isSafeInteger(input.concurrency) ||
        input.concurrency < 1 ||
        input.concurrency > 32)) ||
    (input.retainExecutionEvidence !== undefined &&
      typeof input.retainExecutionEvidence !== "boolean")
  ) {
    throw invalidContract(
      "walk-forward contract concurrency must be 1-32 and evidence retention must be boolean",
    );
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  let failed = false;
  const failures: unknown[] = [];
  const run = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) return;
      try {
        results[index] = await worker(value);
      } catch (error) {
        failed = true;
        failures.push(error);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
  if (failures.length > 0) throw failures[0];
  return Object.freeze(results);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new EngineConfigurationError(
      "ARTIFACT_EXECUTION_ABORTED",
      "walk-forward contract execution was cancelled",
      "Retry with a live AbortSignal if this run is still required.",
    );
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function c2(message: string): ContractViolation {
  return new ContractViolation("C2", message, {
    remedy: "Run every train cutoff and OOS decision from one declared walk-forward plan.",
  });
}

function c3(message: string): ContractViolation {
  return new ContractViolation("C3", message, {
    remedy: "Use the same immutable artifact parameters and literals for every decision.",
  });
}

function invalidContract(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_WALK_FORWARD_CONTRACT",
    message,
    "Use one declared dataset, an explicit UTC schedule, and engine-created capabilities.",
  );
}
