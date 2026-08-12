import { createHash } from "node:crypto";
import {
  type AdapterDeclaration,
  ContractViolation,
  hashAdapterDeclaration,
} from "@veilquant/contract";
import {
  type ArtifactDatasetSemantics,
  type ArtifactManifest,
  verifyArtifactManifest,
} from "./artifact.ts";
import { ARTIFACT_EXECUTION_FORMAT, type ArtifactExecutionResult } from "./artifact-execution.ts";
import type { ArtifactRuntimeDescriptor } from "./artifact-runtime.ts";
import { EngineConfigurationError } from "./errors.ts";
import type { ReadSetResultIdentity } from "./read-set.ts";
import type { VerificationViewManifest } from "./verification-view.ts";
import { verifyWalkForwardPlan, type WalkForwardPlan } from "./walk-forward-plan.ts";

export const PARAMETER_LOCK_FORMAT = "veil.parameter-lock.v0" as const;
export const WALK_FORWARD_CONTRACT_EXECUTION_FORMAT =
  "veil.walk-forward-contract-execution.v0" as const;
export const WALK_FORWARD_CONTRACT_FORMAT = "veil.walk-forward-contract.v0" as const;

const PARAMETER_LOCK_HASH_DOMAIN = "veil.parameter-lock.v0";
const EXECUTION_HASH_DOMAIN = "veil.walk-forward-contract-execution.v0";
const CONTRACT_HASH_DOMAIN = "veil.walk-forward-contract.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTRACT_INVARIANTS = Object.freeze(["C1", "C2", "C3", "C4"] as const);

export interface WalkForwardContractExecutionRecord {
  readonly format: typeof WALK_FORWARD_CONTRACT_EXECUTION_FORMAT;
  readonly status: "contract-checked";
  readonly artifactHash: string;
  readonly planHash: string;
  readonly parameterLockHash: string;
  readonly foldIndex: number;
  readonly role: "train" | "out-of-sample";
  readonly decisionIndex: number;
  readonly decisionTime: string;
  readonly sourceReadSetId: string;
  readonly viewHash: string;
  readonly maskColumn: string;
  readonly maskAudit: {
    readonly sourceRows: number;
    readonly historyRows: number;
    readonly droppedOutsideHistoryRows: number;
    readonly droppedUntradableRows: number;
    readonly inputRows: number;
    readonly decisionRows: number;
  };
  readonly requestHash: string;
  readonly runtime: ArtifactRuntimeDescriptor;
  readonly inputArrowHash: string;
  readonly outputArrowHash: string;
  readonly admittedOutputArrowHash: string;
  readonly admittedOutputRows: number;
  readonly executionHash: string;
}

export interface WalkForwardContractRecord {
  readonly format: typeof WALK_FORWARD_CONTRACT_FORMAT;
  /** Structural contract checks passed; this is not a priced experiment or citable metric. */
  readonly status: "contract-verified";
  readonly invariants: readonly ["C1", "C2", "C3", "C4"];
  readonly artifactHash: string;
  readonly planHash: string;
  readonly parameterLockHash: string;
  readonly dataset: {
    readonly dataset: string;
    readonly version: string;
    readonly declarationHash: string;
    readonly maskColumn: string;
  };
  readonly executions: readonly WalkForwardContractExecutionRecord[];
  readonly contractHash: string;
}

export interface WalkForwardContractRecordVerificationEvidence {
  readonly artifact: unknown;
  readonly plan: unknown;
  readonly declaration: AdapterDeclaration;
  readonly expectedHash?: string;
}

interface CreateContractExecutionRecordInput {
  readonly artifact: ArtifactManifest;
  readonly plan: WalkForwardPlan;
  readonly view: VerificationViewManifest;
  readonly execution: ArtifactExecutionResult;
  readonly admittedOutput: ReadSetResultIdentity;
}

interface CreateContractRecordInput {
  readonly artifact: ArtifactManifest;
  readonly plan: WalkForwardPlan;
  readonly declaration: AdapterDeclaration;
  readonly executions: readonly WalkForwardContractExecutionRecord[];
}

type ExecutionBody = Omit<WalkForwardContractExecutionRecord, "executionHash">;
type ContractBody = Omit<WalkForwardContractRecord, "contractHash">;

/** Internal issuer: called only after mask-first input and child-output admission succeed. */
export function createWalkForwardContractExecutionRecord(
  input: CreateContractExecutionRecordInput,
): WalkForwardContractExecutionRecord {
  const artifact = verifyArtifactManifest(input.artifact);
  const plan = verifyWalkForwardPlan(input.plan);
  const dataset = singleDataset(artifact);
  requireProtocolMatch(artifact, plan);
  const view = input.view;
  const fold = plan.folds[view.foldIndex];
  if (
    fold === undefined ||
    view.planHash !== plan.planHash ||
    view.dataset !== dataset.dataset ||
    view.adapterVersion !== dataset.version ||
    view.declarationHash !== dataset.declarationHash ||
    plan.decisionSchedule[view.decisionIndex] !== view.decisionTime
  ) {
    throw c2("verification view is outside the artifact's declared WFA topology");
  }
  requireRoleDecision(view.role, view.decisionIndex, view.foldIndex, plan);
  if (
    input.execution.format !== ARTIFACT_EXECUTION_FORMAT ||
    input.execution.artifactHash !== artifact.artifactHash ||
    input.execution.readSetId !== view.viewHash ||
    input.execution.decisionTime !== view.decisionTime
  ) {
    throw invalidContract("artifact execution does not match its verification view");
  }
  const body: ExecutionBody = {
    format: WALK_FORWARD_CONTRACT_EXECUTION_FORMAT,
    status: "contract-checked",
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    parameterLockHash: parameterLockHashForArtifact(artifact),
    foldIndex: view.foldIndex,
    role: view.role,
    decisionIndex: view.decisionIndex,
    decisionTime: view.decisionTime,
    sourceReadSetId: view.sourceReadSetId,
    viewHash: view.viewHash,
    maskColumn: view.maskColumn,
    maskAudit: Object.freeze({
      sourceRows: view.audit.sourceRows,
      historyRows: view.audit.historyRows,
      droppedOutsideHistoryRows: view.audit.droppedOutsideHistoryRows,
      droppedUntradableRows: view.audit.droppedUntradableRows,
      inputRows: view.audit.outputRows,
      decisionRows: view.audit.decisionRows,
    }),
    requestHash: input.execution.requestHash,
    runtime: input.execution.runtime,
    inputArrowHash: view.result.arrowHash,
    outputArrowHash: input.execution.outputArrowHash,
    admittedOutputArrowHash: input.admittedOutput.arrowHash,
    admittedOutputRows: input.admittedOutput.rowCount,
  };
  return deepFreeze({
    ...body,
    executionHash: hashCanonical(EXECUTION_HASH_DOMAIN, body),
  });
}

/** Internal issuer: no record is created until the complete train + OOS topology is present. */
export function createWalkForwardContractRecord(
  input: CreateContractRecordInput,
): WalkForwardContractRecord {
  const artifact = verifyArtifactManifest(input.artifact);
  const plan = verifyWalkForwardPlan(input.plan);
  const dataset = singleDataset(artifact);
  const maskColumn = requireDeclaration(dataset, input.declaration);
  requireProtocolMatch(artifact, plan);
  if (!Array.isArray(input.executions)) {
    throw c2("walk-forward contract executions must be an array");
  }
  const executions = [...input.executions]
    .map((execution) => normalizeExecution(execution, artifact, plan, maskColumn))
    .sort(compareExecutions);
  requireCompleteExecutions(executions, plan);
  const body: ContractBody = {
    format: WALK_FORWARD_CONTRACT_FORMAT,
    status: "contract-verified",
    invariants: CONTRACT_INVARIANTS,
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    parameterLockHash: parameterLockHashForArtifact(artifact),
    dataset: datasetIdentity(dataset, maskColumn),
    executions: Object.freeze(executions),
  };
  return deepFreeze({ ...body, contractHash: hashCanonical(CONTRACT_HASH_DOMAIN, body) });
}

export function verifyWalkForwardContractRecord(
  input: unknown,
  evidenceInput: WalkForwardContractRecordVerificationEvidence,
): WalkForwardContractRecord {
  const evidence = normalizeEvidence(evidenceInput);
  const { artifact, plan, declaration } = evidence;
  const dataset = singleDataset(artifact);
  const maskColumn = requireDeclaration(dataset, declaration);
  requireProtocolMatch(artifact, plan);
  const root = exactRecord(
    input,
    [
      "format",
      "status",
      "invariants",
      "artifactHash",
      "planHash",
      "parameterLockHash",
      "dataset",
      "executions",
      "contractHash",
    ],
    "walk-forward contract record",
  );
  if (root.format !== WALK_FORWARD_CONTRACT_FORMAT || root.status !== "contract-verified") {
    throw invalidContract("walk-forward contract uses an unsupported format or status");
  }
  if (root.artifactHash !== artifact.artifactHash) {
    throw c3("walk-forward contract artifact identity changed across verification");
  }
  if (root.planHash !== plan.planHash) {
    throw c2("walk-forward contract plan identity changed across verification");
  }
  if (root.parameterLockHash !== parameterLockHashForArtifact(artifact)) {
    throw c3("walk-forward contract parameter lock does not match the artifact");
  }
  if (canonicalJson(root.invariants) !== canonicalJson(CONTRACT_INVARIANTS)) {
    throw invalidContract("walk-forward contract invariant set is not canonical");
  }
  if (canonicalJson(root.dataset) !== canonicalJson(datasetIdentity(dataset, maskColumn))) {
    throw c4("walk-forward contract dataset or mask identity changed");
  }
  if (!Array.isArray(root.executions)) {
    throw c2("walk-forward contract executions must be an array");
  }
  const executions = root.executions.map((execution) =>
    normalizeExecution(execution, artifact, plan, maskColumn),
  );
  requireCompleteExecutions(executions, plan);
  const body: ContractBody = {
    format: WALK_FORWARD_CONTRACT_FORMAT,
    status: "contract-verified",
    invariants: CONTRACT_INVARIANTS,
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    parameterLockHash: parameterLockHashForArtifact(artifact),
    dataset: datasetIdentity(dataset, maskColumn),
    executions: Object.freeze(executions),
  };
  const contractHash = sha256(root.contractHash, "contract hash");
  if (hashCanonical(CONTRACT_HASH_DOMAIN, body) !== contractHash) {
    throw invalidContract("walk-forward contract hash does not match its normalized content");
  }
  if (evidence.expectedHash !== undefined && evidence.expectedHash !== contractHash) {
    throw invalidContract("walk-forward contract differs from the expected content id");
  }
  return deepFreeze({ ...body, contractHash });
}

export function parameterLockHashForArtifact(input: ArtifactManifest): string {
  const artifact = verifyArtifactManifest(input);
  return hashCanonical(PARAMETER_LOCK_HASH_DOMAIN, {
    format: PARAMETER_LOCK_FORMAT,
    artifactHash: artifact.artifactHash,
    paramsLocked: artifact.paramsLocked,
    declaredLiterals: artifact.declaredLiterals,
  });
}

function normalizeExecution(
  input: unknown,
  artifact: ArtifactManifest,
  plan: WalkForwardPlan,
  maskColumn: string,
): WalkForwardContractExecutionRecord {
  const root = exactRecord(
    input,
    [
      "format",
      "status",
      "artifactHash",
      "planHash",
      "parameterLockHash",
      "foldIndex",
      "role",
      "decisionIndex",
      "decisionTime",
      "sourceReadSetId",
      "viewHash",
      "maskColumn",
      "maskAudit",
      "requestHash",
      "runtime",
      "inputArrowHash",
      "outputArrowHash",
      "admittedOutputArrowHash",
      "admittedOutputRows",
      "executionHash",
    ],
    "walk-forward contract execution",
  );
  if (
    root.format !== WALK_FORWARD_CONTRACT_EXECUTION_FORMAT ||
    root.status !== "contract-checked"
  ) {
    throw invalidContract("contract execution uses an unsupported format or status");
  }
  if (root.artifactHash !== artifact.artifactHash) {
    throw c3("artifact identity changed between walk-forward executions");
  }
  if (root.parameterLockHash !== parameterLockHashForArtifact(artifact)) {
    throw c3("locked parameters or declared literals changed between executions");
  }
  if (root.planHash !== plan.planHash) {
    throw c2("execution plan identity changed within the walk-forward contract");
  }
  if (root.maskColumn !== maskColumn) {
    throw c4("execution used a different tradability mask column");
  }
  const foldIndex = nonnegativeInteger(root.foldIndex, "fold index");
  const role = executionRole(root.role);
  const decisionIndex = nonnegativeInteger(root.decisionIndex, "decision index");
  requireRoleDecision(role, decisionIndex, foldIndex, plan);
  const decisionTime = plan.decisionSchedule[decisionIndex];
  if (decisionTime === undefined || root.decisionTime !== decisionTime) {
    throw c2("execution decision time is outside the declared WFA topology");
  }
  const body: ExecutionBody = {
    format: WALK_FORWARD_CONTRACT_EXECUTION_FORMAT,
    status: "contract-checked",
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    parameterLockHash: parameterLockHashForArtifact(artifact),
    foldIndex,
    role,
    decisionIndex,
    decisionTime,
    sourceReadSetId: sha256(root.sourceReadSetId, "source read-set id"),
    viewHash: sha256(root.viewHash, "verification view hash"),
    maskColumn,
    maskAudit: normalizeMaskAudit(root.maskAudit),
    requestHash: sha256(root.requestHash, "request hash"),
    runtime: normalizeRuntime(root.runtime),
    inputArrowHash: sha256(root.inputArrowHash, "input Arrow hash"),
    outputArrowHash: sha256(root.outputArrowHash, "output Arrow hash"),
    admittedOutputArrowHash: sha256(root.admittedOutputArrowHash, "admitted output Arrow hash"),
    admittedOutputRows: nonnegativeInteger(root.admittedOutputRows, "admitted output row count"),
  };
  const executionHash = sha256(root.executionHash, "contract execution hash");
  if (hashCanonical(EXECUTION_HASH_DOMAIN, body) !== executionHash) {
    throw invalidContract("contract execution hash does not match its normalized content");
  }
  return deepFreeze({ ...body, executionHash });
}

function normalizeMaskAudit(input: unknown): WalkForwardContractExecutionRecord["maskAudit"] {
  const root = exactRecord(
    input,
    [
      "sourceRows",
      "historyRows",
      "droppedOutsideHistoryRows",
      "droppedUntradableRows",
      "inputRows",
      "decisionRows",
    ],
    "contract execution mask audit",
  );
  const audit = {
    sourceRows: nonnegativeInteger(root.sourceRows, "source row count"),
    historyRows: nonnegativeInteger(root.historyRows, "history row count"),
    droppedOutsideHistoryRows: nonnegativeInteger(
      root.droppedOutsideHistoryRows,
      "outside-history row count",
    ),
    droppedUntradableRows: nonnegativeInteger(root.droppedUntradableRows, "untradable row count"),
    inputRows: nonnegativeInteger(root.inputRows, "mask-filtered input row count"),
    decisionRows: nonnegativeInteger(root.decisionRows, "decision row count"),
  };
  if (
    audit.sourceRows !== audit.historyRows + audit.droppedOutsideHistoryRows ||
    audit.historyRows !== audit.inputRows + audit.droppedUntradableRows ||
    audit.decisionRows > audit.inputRows
  ) {
    throw c4("contract execution contains inconsistent mask-first audit counts");
  }
  return Object.freeze(audit);
}

function requireCompleteExecutions(
  executions: readonly WalkForwardContractExecutionRecord[],
  plan: WalkForwardPlan,
): void {
  const expected = expectedExecutions(plan);
  if (executions.length !== expected.length) {
    throw c2("walk-forward contract is missing a train or OOS decision execution");
  }
  const sourceIds = new Set<string>();
  const viewIds = new Set<string>();
  const requestIds = new Set<string>();
  const executionIds = new Set<string>();
  for (let index = 0; index < expected.length; index += 1) {
    const actual = executions[index];
    const wanted = expected[index];
    if (
      actual === undefined ||
      wanted === undefined ||
      actual.foldIndex !== wanted.foldIndex ||
      actual.role !== wanted.role ||
      actual.decisionIndex !== wanted.decisionIndex
    ) {
      throw c2("walk-forward contract executions do not cover the exact ordered WFA topology");
    }
    if (
      sourceIds.has(actual.sourceReadSetId) ||
      viewIds.has(actual.viewHash) ||
      requestIds.has(actual.requestHash) ||
      executionIds.has(actual.executionHash)
    ) {
      throw c2("each WFA decision must use distinct source, view, request, and execution evidence");
    }
    sourceIds.add(actual.sourceReadSetId);
    viewIds.add(actual.viewHash);
    requestIds.add(actual.requestHash);
    executionIds.add(actual.executionHash);
  }
}

function expectedExecutions(plan: WalkForwardPlan): Array<{
  readonly foldIndex: number;
  readonly role: "train" | "out-of-sample";
  readonly decisionIndex: number;
}> {
  return plan.folds.flatMap((fold) => [
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
  ]);
}

function requireRoleDecision(
  role: "train" | "out-of-sample",
  decisionIndex: number,
  foldIndex: number,
  plan: WalkForwardPlan,
): void {
  const fold = plan.folds[foldIndex];
  if (fold === undefined) throw c2("execution fold is outside the WFA plan");
  if (role === "train" && decisionIndex !== fold.train.endIndexExclusive - 1) {
    throw c2("training execution must occur at the fold's training cutoff");
  }
  if (
    role === "out-of-sample" &&
    (decisionIndex < fold.outOfSample.startIndex ||
      decisionIndex >= fold.outOfSample.endIndexExclusive)
  ) {
    throw c2("OOS execution is outside its fold's declared decision range");
  }
}

function compareExecutions(
  left: WalkForwardContractExecutionRecord,
  right: WalkForwardContractExecutionRecord,
): number {
  if (left.foldIndex !== right.foldIndex) return left.foldIndex - right.foldIndex;
  if (left.role !== right.role) return left.role === "train" ? -1 : 1;
  return left.decisionIndex - right.decisionIndex;
}

function normalizeEvidence(input: WalkForwardContractRecordVerificationEvidence): {
  readonly artifact: ArtifactManifest;
  readonly plan: WalkForwardPlan;
  readonly declaration: AdapterDeclaration;
  readonly expectedHash?: string;
} {
  const root = exactRecord(
    input,
    ["artifact", "plan", "declaration", "expectedHash"],
    "walk-forward contract verification evidence",
    true,
  );
  for (const field of ["artifact", "plan", "declaration"]) {
    if (!Object.hasOwn(root, field)) {
      throw invalidContract("contract verification requires artifact, plan, and declaration");
    }
  }
  const declaration = root.declaration;
  if (!isPlainRecord(declaration)) {
    throw invalidContract("contract verification declaration must be normalized");
  }
  return Object.freeze({
    artifact: verifyArtifactManifest(root.artifact),
    plan: verifyWalkForwardPlan(root.plan),
    declaration: declaration as unknown as AdapterDeclaration,
    ...(root.expectedHash === undefined
      ? {}
      : { expectedHash: sha256(root.expectedHash, "expected contract hash") }),
  });
}

function singleDataset(artifact: ArtifactManifest): ArtifactDatasetSemantics {
  const dataset = artifact.dataSemantics.datasets[0];
  if (artifact.dataSemantics.datasets.length !== 1 || dataset === undefined) {
    throw c2("walk-forward contract verification requires exactly one artifact dataset");
  }
  return dataset;
}

function requireDeclaration(
  dataset: ArtifactDatasetSemantics,
  declaration: AdapterDeclaration,
): string {
  let declarationHash: string;
  try {
    declarationHash = hashAdapterDeclaration(declaration);
  } catch {
    throw invalidContract("contract declaration is not normalized");
  }
  if (
    declaration.dataset !== dataset.dataset ||
    declaration.version !== dataset.version ||
    declarationHash !== dataset.declarationHash
  ) {
    throw c4("contract declaration differs from the artifact's dataset semantics");
  }
  const maskColumn = declaration.guarantees.tradabilityMask;
  if (maskColumn === null) {
    throw c4("walk-forward verification requires a declared tradability mask");
  }
  return maskColumn;
}

function datasetIdentity(
  dataset: ArtifactDatasetSemantics,
  maskColumn: string,
): WalkForwardContractRecord["dataset"] {
  return Object.freeze({
    dataset: dataset.dataset,
    version: dataset.version,
    declarationHash: dataset.declarationHash,
    maskColumn,
  });
}

function requireProtocolMatch(artifact: ArtifactManifest, plan: WalkForwardPlan): void {
  if (canonicalJson(artifact.protocol) !== canonicalJson(plan.protocol)) {
    throw c2("walk-forward plan protocol does not match the artifact");
  }
}

function executionRole(input: unknown): "train" | "out-of-sample" {
  if (input !== "train" && input !== "out-of-sample") {
    throw c2("contract execution role must be train or out-of-sample");
  }
  return input;
}

function normalizeRuntime(input: unknown): ArtifactRuntimeDescriptor {
  const root = exactRecord(input, ["id", "implementation"], "contract runtime");
  const implementation = exactRecord(
    root.implementation,
    ["name", "version"],
    "contract runtime implementation",
  );
  return Object.freeze({
    id: portableId(root.id, "runtime id"),
    implementation: Object.freeze({
      name: portableId(implementation.name, "runtime implementation name"),
      version: portableText(implementation.version, "runtime implementation version"),
    }),
  });
}

function portableId(input: unknown, field: string): string {
  if (typeof input !== "string" || !PORTABLE_ID.test(input)) {
    throw invalidContract(`${field} must be a portable identifier`);
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
    input.includes("\\")
  ) {
    throw invalidContract(`${field} must be portable text`);
  }
  return input;
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw invalidContract(`${field} must be an object`);
  const actual = Object.keys(input);
  const allowed = new Set(expectedKeys);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && expectedKeys.some((key) => !actual.includes(key)))
  ) {
    throw invalidContract(`${field} has missing or unknown fields`);
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
    throw invalidContract(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidContract(`${field} must be a lowercase sha256 identity`);
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
      throw invalidContract("walk-forward contract contains a non-canonical number");
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
  throw invalidContract("walk-forward contract contains an unsupported value");
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

function c2(message: string): ContractViolation {
  return new ContractViolation("C2", message, {
    remedy:
      "Re-run the exact rolling or expanding plan with every declared train and OOS decision.",
  });
}

function c3(message: string): ContractViolation {
  return new ContractViolation("C3", message, {
    remedy: "Use one verified artifact and its immutable parameter lock for the complete run.",
  });
}

function c4(message: string): ContractViolation {
  return new ContractViolation("C4", message, {
    remedy: "Apply the artifact declaration's tradability mask before factor execution.",
  });
}

function invalidContract(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_WALK_FORWARD_CONTRACT",
    message,
    "Re-run contract verification from the artifact, plan, declaration, and guarded evidence.",
  );
}
