import { createHash } from "node:crypto";
import {
  type ArtifactDatasetSemantics,
  type ArtifactManifest,
  verifyArtifactManifest,
} from "./artifact.ts";
import { ARTIFACT_EXECUTION_FORMAT, type ArtifactExecutionResult } from "./artifact-execution.ts";
import type { ArtifactRuntimeDescriptor } from "./artifact-runtime.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  verifyWalkForwardPlan,
  type WalkForwardFold,
  type WalkForwardPlan,
} from "./walk-forward-plan.ts";
import type { WindowReadSetManifest } from "./window-read-set.ts";

export const WALK_FORWARD_WINDOW_EXECUTION_FORMAT =
  "veil.walk-forward-window-execution.v0" as const;
export const WALK_FORWARD_RUN_FORMAT = "veil.walk-forward-run.v0" as const;

const WINDOW_EXECUTION_HASH_DOMAIN = "veil.walk-forward-window-execution.v0";
const RUN_HASH_DOMAIN = "veil.walk-forward-run.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface WalkForwardWindowExecutionRecord {
  readonly format: typeof WALK_FORWARD_WINDOW_EXECUTION_FORMAT;
  /** Execution succeeded, but Stage 2C-3 does not issue verified OOS metrics. */
  readonly status: "executed";
  readonly artifactHash: string;
  readonly planHash: string;
  readonly foldIndex: number;
  readonly role: "train";
  readonly boundaries: WalkForwardFold;
  readonly sourceReadSetId: string;
  readonly windowReadSetId: string;
  readonly requestHash: string;
  readonly decisionTime: string;
  readonly runtime: ArtifactRuntimeDescriptor;
  readonly inputArrowHash: string;
  readonly outputArrowHash: string;
  readonly executionHash: string;
}

export interface WalkForwardRunRecord {
  readonly format: typeof WALK_FORWARD_RUN_FORMAT;
  readonly status: "executed";
  readonly artifactHash: string;
  readonly planHash: string;
  readonly dataset: {
    readonly dataset: string;
    readonly version: string;
    readonly declarationHash: string;
  };
  readonly windows: readonly WalkForwardWindowExecutionRecord[];
  readonly runHash: string;
}

export interface WalkForwardRecordVerificationEvidence {
  readonly artifact: unknown;
  readonly plan: unknown;
  readonly expectedHash?: string;
}

type WindowExecutionBody = Omit<WalkForwardWindowExecutionRecord, "executionHash">;
type RunBody = Omit<WalkForwardRunRecord, "runHash">;

interface CreateWindowExecutionRecordInput {
  readonly artifact: ArtifactManifest;
  readonly plan: WalkForwardPlan;
  readonly windowReadSet: WindowReadSetManifest;
  readonly execution: ArtifactExecutionResult;
}

interface CreateRunRecordInput {
  readonly artifact: ArtifactManifest;
  readonly plan: WalkForwardPlan;
  readonly windows: readonly WalkForwardWindowExecutionRecord[];
}

/** Internal issuer used only after source derivation and child execution both succeed. */
export function createWalkForwardWindowExecutionRecord(
  input: CreateWindowExecutionRecordInput,
): WalkForwardWindowExecutionRecord {
  const artifact = verifyArtifactManifest(input.artifact);
  const plan = verifyWalkForwardPlan(input.plan);
  const dataset = singleDataset(artifact);
  requireProtocolMatch(artifact, plan);
  const window = input.windowReadSet;
  const execution = input.execution;
  const fold = plan.folds[window.foldIndex];
  if (fold === undefined) throw invalidRecord("window fold is absent from the WFA plan");
  if (
    window.planHash !== plan.planHash ||
    window.dataset !== dataset.dataset ||
    window.adapterVersion !== dataset.version ||
    window.declarationHash !== dataset.declarationHash ||
    canonicalJson(window.range) !== canonicalJson(fold.train)
  ) {
    throw invalidRecord("derived window evidence does not match the artifact and WFA plan");
  }
  if (
    execution.format !== ARTIFACT_EXECUTION_FORMAT ||
    execution.artifactHash !== artifact.artifactHash ||
    execution.readSetId !== window.windowHash ||
    execution.decisionTime !== window.decisionTime
  ) {
    throw invalidRecord("artifact execution does not match the derived training window");
  }
  const body: WindowExecutionBody = {
    format: WALK_FORWARD_WINDOW_EXECUTION_FORMAT,
    status: "executed",
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    foldIndex: window.foldIndex,
    role: "train",
    boundaries: fold,
    sourceReadSetId: window.sourceReadSetId,
    windowReadSetId: window.windowHash,
    requestHash: execution.requestHash,
    decisionTime: window.decisionTime,
    runtime: execution.runtime,
    inputArrowHash: window.result.arrowHash,
    outputArrowHash: execution.outputArrowHash,
  };
  return deepFreeze({
    ...body,
    executionHash: hashCanonical(WINDOW_EXECUTION_HASH_DOMAIN, body),
  });
}

/** Internal issuer; fold records are sorted before hashing so completion order is irrelevant. */
export function createWalkForwardRunRecord(input: CreateRunRecordInput): WalkForwardRunRecord {
  const artifact = verifyArtifactManifest(input.artifact);
  const plan = verifyWalkForwardPlan(input.plan);
  const dataset = singleDataset(artifact);
  requireProtocolMatch(artifact, plan);
  if (!Array.isArray(input.windows)) {
    throw invalidRecord("walk-forward run windows must be an array");
  }
  if (input.windows.length !== plan.folds.length) {
    throw invalidRecord("walk-forward run must contain one successful execution per fold");
  }
  const windows = [...input.windows]
    .map((window) => normalizeWindowRecord(window, artifact, plan, dataset))
    .sort((left, right) => left.foldIndex - right.foldIndex);
  requireCompleteWindows(windows, plan);
  const body: RunBody = {
    format: WALK_FORWARD_RUN_FORMAT,
    status: "executed",
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    dataset: datasetIdentity(dataset),
    windows: Object.freeze(windows),
  };
  return deepFreeze({ ...body, runHash: hashCanonical(RUN_HASH_DOMAIN, body) });
}

export function verifyWalkForwardWindowExecutionRecord(
  input: unknown,
  evidenceInput: WalkForwardRecordVerificationEvidence,
): WalkForwardWindowExecutionRecord {
  const evidence = normalizeEvidence(evidenceInput, "window execution");
  const dataset = singleDataset(evidence.artifact);
  requireProtocolMatch(evidence.artifact, evidence.plan);
  const record = normalizeWindowRecord(input, evidence.artifact, evidence.plan, dataset);
  if (evidence.expectedHash !== undefined && evidence.expectedHash !== record.executionHash) {
    throw invalidRecord("window execution differs from the expected content id");
  }
  return record;
}

export function verifyWalkForwardRunRecord(
  input: unknown,
  evidenceInput: WalkForwardRecordVerificationEvidence,
): WalkForwardRunRecord {
  const evidence = normalizeEvidence(evidenceInput, "run");
  const artifact = evidence.artifact;
  const plan = evidence.plan;
  const dataset = singleDataset(artifact);
  requireProtocolMatch(artifact, plan);
  const root = exactRecord(
    input,
    ["format", "status", "artifactHash", "planHash", "dataset", "windows", "runHash"],
    "walk-forward run record",
  );
  if (root.format !== WALK_FORWARD_RUN_FORMAT || root.status !== "executed") {
    throw invalidRecord("walk-forward run uses an unsupported format or status");
  }
  if (root.artifactHash !== artifact.artifactHash || root.planHash !== plan.planHash) {
    throw invalidRecord("walk-forward run does not match its artifact and plan evidence");
  }
  if (canonicalJson(root.dataset) !== canonicalJson(datasetIdentity(dataset))) {
    throw invalidRecord("walk-forward run dataset does not match its artifact");
  }
  if (!Array.isArray(root.windows)) {
    throw invalidRecord("walk-forward run windows must be an array");
  }
  if (root.windows.length !== plan.folds.length) {
    throw invalidRecord("walk-forward run must contain one successful execution per fold");
  }
  const windows = root.windows.map((window) =>
    normalizeWindowRecord(window, artifact, plan, dataset),
  );
  requireCompleteWindows(windows, plan);
  const body: RunBody = {
    format: WALK_FORWARD_RUN_FORMAT,
    status: "executed",
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    dataset: datasetIdentity(dataset),
    windows: Object.freeze(windows),
  };
  const runHash = sha256(root.runHash, "run hash");
  if (hashCanonical(RUN_HASH_DOMAIN, body) !== runHash) {
    throw invalidRecord("walk-forward run hash does not match its normalized content");
  }
  if (evidence.expectedHash !== undefined && evidence.expectedHash !== runHash) {
    throw invalidRecord("walk-forward run differs from the expected content id");
  }
  return deepFreeze({ ...body, runHash });
}

function normalizeWindowRecord(
  input: unknown,
  artifact: ArtifactManifest,
  plan: WalkForwardPlan,
  dataset: ArtifactDatasetSemantics,
): WalkForwardWindowExecutionRecord {
  const root = exactRecord(
    input,
    [
      "format",
      "status",
      "artifactHash",
      "planHash",
      "foldIndex",
      "role",
      "boundaries",
      "sourceReadSetId",
      "windowReadSetId",
      "requestHash",
      "decisionTime",
      "runtime",
      "inputArrowHash",
      "outputArrowHash",
      "executionHash",
    ],
    "walk-forward window execution record",
  );
  if (
    root.format !== WALK_FORWARD_WINDOW_EXECUTION_FORMAT ||
    root.status !== "executed" ||
    root.role !== "train"
  ) {
    throw invalidRecord("window execution uses an unsupported format, status, or role");
  }
  if (root.artifactHash !== artifact.artifactHash || root.planHash !== plan.planHash) {
    throw invalidRecord("window execution does not match its artifact and plan evidence");
  }
  const foldIndex = nonnegativeInteger(root.foldIndex, "fold index");
  const fold = plan.folds[foldIndex];
  if (fold === undefined || canonicalJson(root.boundaries) !== canonicalJson(fold)) {
    throw invalidRecord("window execution boundaries do not match the WFA fold");
  }
  if (root.decisionTime !== fold.train.lastDecisionTime) {
    throw invalidRecord("window execution decision time does not match the training cutoff");
  }
  const sourceReadSetId = sha256(root.sourceReadSetId, "source read-set id");
  const windowReadSetId = sha256(root.windowReadSetId, "window read-set id");
  if (
    dataset.developmentReadSets.includes(sourceReadSetId) ||
    dataset.developmentReadSets.includes(windowReadSetId)
  ) {
    throw invalidRecord("window execution reuses artifact development evidence");
  }
  const body: WindowExecutionBody = {
    format: WALK_FORWARD_WINDOW_EXECUTION_FORMAT,
    status: "executed",
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    foldIndex,
    role: "train",
    boundaries: fold,
    sourceReadSetId,
    windowReadSetId,
    requestHash: sha256(root.requestHash, "request hash"),
    decisionTime: fold.train.lastDecisionTime,
    runtime: normalizeRuntime(root.runtime),
    inputArrowHash: sha256(root.inputArrowHash, "input Arrow hash"),
    outputArrowHash: sha256(root.outputArrowHash, "output Arrow hash"),
  };
  const executionHash = sha256(root.executionHash, "window execution hash");
  if (hashCanonical(WINDOW_EXECUTION_HASH_DOMAIN, body) !== executionHash) {
    throw invalidRecord("window execution hash does not match its normalized content");
  }
  return deepFreeze({ ...body, executionHash });
}

function requireCompleteWindows(
  windows: readonly WalkForwardWindowExecutionRecord[],
  plan: WalkForwardPlan,
): void {
  if (windows.length !== plan.folds.length) {
    throw invalidRecord("walk-forward run must contain one successful execution per fold");
  }
  const sourceIds = new Set<string>();
  const windowIds = new Set<string>();
  const executionIds = new Set<string>();
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (window === undefined || window.foldIndex !== index) {
      throw invalidRecord("walk-forward run windows must be ordered by unique fold index");
    }
    if (
      sourceIds.has(window.sourceReadSetId) ||
      windowIds.has(window.windowReadSetId) ||
      executionIds.has(window.executionHash)
    ) {
      throw invalidRecord("each WFA fold must use distinct source, window, and execution evidence");
    }
    sourceIds.add(window.sourceReadSetId);
    windowIds.add(window.windowReadSetId);
    executionIds.add(window.executionHash);
  }
}

function normalizeEvidence(
  input: WalkForwardRecordVerificationEvidence,
  kind: string,
): {
  readonly artifact: ArtifactManifest;
  readonly plan: WalkForwardPlan;
  readonly expectedHash?: string;
} {
  const root = exactRecord(
    input,
    ["artifact", "plan", "expectedHash"],
    `${kind} verification evidence`,
    true,
  );
  if (!Object.hasOwn(root, "artifact") || !Object.hasOwn(root, "plan")) {
    throw invalidRecord(`${kind} verification requires artifact and plan evidence`);
  }
  return Object.freeze({
    artifact: verifyArtifactManifest(root.artifact),
    plan: verifyWalkForwardPlan(root.plan),
    ...(root.expectedHash === undefined
      ? {}
      : { expectedHash: sha256(root.expectedHash, `expected ${kind} hash`) }),
  });
}

function singleDataset(artifact: ArtifactManifest): ArtifactDatasetSemantics {
  const dataset = artifact.dataSemantics.datasets[0];
  if (artifact.dataSemantics.datasets.length !== 1 || dataset === undefined) {
    throw invalidRecord("Stage 2C-3 walk-forward execution requires exactly one artifact dataset");
  }
  return dataset;
}

function datasetIdentity(dataset: ArtifactDatasetSemantics): WalkForwardRunRecord["dataset"] {
  return Object.freeze({
    dataset: dataset.dataset,
    version: dataset.version,
    declarationHash: dataset.declarationHash,
  });
}

function requireProtocolMatch(artifact: ArtifactManifest, plan: WalkForwardPlan): void {
  if (canonicalJson(artifact.protocol) !== canonicalJson(plan.protocol)) {
    throw invalidRecord("walk-forward plan protocol does not match the artifact");
  }
}

function normalizeRuntime(input: unknown): ArtifactRuntimeDescriptor {
  const root = exactRecord(input, ["id", "implementation"], "window runtime");
  const implementation = exactRecord(
    root.implementation,
    ["name", "version"],
    "window runtime implementation",
  );
  const id = portableId(root.id, "window runtime id");
  const name = portableId(implementation.name, "window runtime implementation name");
  const version = portableText(implementation.version, "window runtime implementation version");
  return Object.freeze({ id, implementation: Object.freeze({ name, version }) });
}

function portableId(input: unknown, field: string): string {
  if (typeof input !== "string" || !PORTABLE_ID.test(input)) {
    throw invalidRecord(`${field} must be a portable identifier`);
  }
  return input;
}

function portableText(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 128 ||
    input.trim() !== input ||
    input.includes("/") ||
    input.includes("\\") ||
    [...input].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw invalidRecord(`${field} must be portable text`);
  }
  return input;
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw invalidRecord(`${field} must be an object`);
  const actual = Object.keys(input);
  const allowed = new Set(expectedKeys);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && expectedKeys.some((key) => !actual.includes(key)))
  ) {
    throw invalidRecord(`${field} has missing or unknown fields`);
  }
  return input;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidRecord(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidRecord(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function hashCanonical(domain: string, input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(input))
    .digest("hex")}`;
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return JSON.stringify(input);
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw invalidRecord("walk-forward record contains a non-canonical number");
    }
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => canonicalJson(value)).join(",")}]`;
  }
  if (isPlainRecord(input)) {
    return `{${Object.keys(input)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  throw invalidRecord("walk-forward record contains an unsupported value");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function invalidRecord(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_WALK_FORWARD_EXECUTION",
    message,
    "Re-run every WFA fold from the verified artifact, plan, and derived window evidence.",
  );
}
