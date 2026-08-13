import { readFile } from "node:fs/promises";
import {
  type AdapterDeclaration,
  ContractViolation,
  deriveDataSemantics,
  normalizeDecisionTime,
} from "@veilquant/contract";
import {
  captureArtifactCode,
  createArtifactManifest,
  createPromotionCandidate,
  executeWalkForwardContract,
  type HypothesisRegistrationRecord,
  type PromotionCandidateRecord,
  TemporalGuard,
  verifyPromotionCandidate,
} from "@veilquant/engine";
import { parseDocument } from "yaml";
import {
  VEIL_AGENT_TOOL_RESULT_FORMAT,
  VEIL_BACKTEST_TOOL,
  VEIL_PROMOTION_REQUEST_FORMAT,
  VEIL_RESEARCH_LOG_REFERENCE,
  VEIL_RUN_EVIDENCE_FORMAT,
  VEIL_RUN_RESULT_ENTRY,
  VEIL_VERIFICATION_START_ENTRY,
  VEIL_VIOLATION_ENTRY,
} from "./constants.ts";
import { describeVeilError, type PublicVeilError, VeilAgentError } from "./errors.ts";
import {
  candidateSummary,
  createVerificationStartEntry,
  findVerificationStart,
  hypothesisRegistrationFromEntry,
  latestHypothesis,
  type RunResultEntryData,
  reconstructSessionLedger,
  type VerificationStartEntryData,
  type ViolationEntryData,
} from "./ledger.ts";
import { existingProjectPath, projectReference, type VeilProjectRuntime } from "./project.ts";
import {
  appendProjectLog,
  canonicalJson,
  hashBytes,
  writeImmutableProjectFile,
} from "./storage.ts";

const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

export interface VeilBacktestToolInput {
  readonly request: string;
}

export interface VeilBacktestSuccess {
  readonly format: typeof VEIL_AGENT_TOOL_RESULT_FORMAT;
  readonly tool: typeof VEIL_BACKTEST_TOOL;
  readonly ok: true;
  readonly researchRunId: string;
  readonly status: "awaiting-pricing-and-gates";
  readonly structuralStatus: "contract-verified";
  readonly claimStatus: "unverified";
  readonly registrationStatus: "preregistered" | "exploratory";
  readonly artifactHash: string;
  readonly planHash: string;
  readonly contractHash: string;
  readonly candidateHash: string;
  readonly executionCount: number;
  readonly requiredEvidence: readonly ["pricing", "costs", "statistical-gates"];
  readonly evidenceReference: string;
  readonly researchLogReference: typeof VEIL_RESEARCH_LOG_REFERENCE;
}

export interface VeilBacktestFailure extends PublicVeilError {
  readonly format: typeof VEIL_AGENT_TOOL_RESULT_FORMAT;
  readonly tool: typeof VEIL_BACKTEST_TOOL;
  readonly researchRunId: string;
}

export type VeilBacktestToolResult = VeilBacktestSuccess | VeilBacktestFailure;

interface PromotionRequest {
  readonly format: typeof VEIL_PROMOTION_REQUEST_FORMAT;
  readonly dataset: string;
  readonly hypothesisRef: string;
  readonly factor: {
    readonly codeRootReference: string;
    readonly files: readonly string[];
    readonly runtime: { readonly id: string; readonly constraint: string };
    readonly entry: { readonly file: string; readonly callable: string };
  };
  readonly paramsLocked: Readonly<Record<string, unknown>>;
  readonly declaredLiterals: Readonly<Record<string, unknown>>;
  readonly trialsDeclared: number;
  readonly developmentReadSets: readonly string[];
  readonly protocol: {
    readonly mode: "rolling" | "expanding";
    readonly folds: number;
    readonly trainDays: number;
    readonly oosDays: number;
    readonly purgeDays: number;
    readonly embargoDays: number;
    readonly holdDays: number;
    readonly executionLagDays: number;
  };
  readonly decisionSchedule: readonly string[];
  readonly columns: readonly string[] | undefined;
  readonly costModel: string;
}

interface RunEvidence {
  readonly format: typeof VEIL_RUN_EVIDENCE_FORMAT;
  readonly researchRunId: string;
  readonly requestReference: string;
  readonly declaration: AdapterDeclaration;
  readonly artifact: unknown;
  readonly plan: unknown;
  readonly contractRecord: unknown;
  readonly registration: HypothesisRegistrationRecord | null;
  readonly verification: {
    readonly startedAt: string;
    readonly sourceReference: string;
  };
  readonly candidate: PromotionCandidateRecord;
}

export async function executeVeilBacktestTool(
  input: VeilBacktestToolInput,
  context: {
    readonly project: VeilProjectRuntime;
    readonly getBranch: () => readonly unknown[];
    readonly appendEntry: <T>(customType: string, data: T) => void;
    readonly signal?: AbortSignal;
  },
): Promise<VeilBacktestToolResult> {
  validateBacktestInput(input);
  const requestReference = projectReference(input.request);
  const requestPath = await existingProjectPath(context.project.root, requestReference, "file");
  const request = await loadPromotionRequest(requestPath);
  const dataset = context.project.datasets.get(request.dataset);
  if (dataset === undefined)
    throw invalidRequest("promotion dataset is not registered by the project");
  const startData = createVerificationStartEntry({
    requestReference,
    hypothesisRef: request.hypothesisRef,
  });
  context.appendEntry(VEIL_VERIFICATION_START_ENTRY, startData);

  try {
    const started = findVerificationStart(
      reconstructSessionLedger(context.getBranch()),
      startData.runId,
    );
    assertPromotionDataSemantics(dataset.declaration);
    const codeRoot = await existingProjectPath(
      context.project.root,
      request.factor.codeRootReference,
      "directory",
    );
    const before = reconstructSessionLedger(context.getBranch());
    requireObservedDevelopmentReads(before, request);
    const registration = admissibleRegistration(
      reconstructSessionLedger(context.getBranch()),
      request.hypothesisRef,
      started.timestamp,
    );
    const artifact = createArtifactManifest({
      factor: {
        runtime: request.factor.runtime,
        entry: request.factor.entry,
        code: await captureArtifactCode({ root: codeRoot, files: request.factor.files }),
      },
      paramsLocked: request.paramsLocked,
      declaredLiterals: request.declaredLiterals,
      trialsDeclared: request.trialsDeclared,
      dataSemantics: {
        datasets: [
          {
            declaration: dataset.declaration,
            developmentReadSets: request.developmentReadSets,
          },
        ],
      },
      hypothesisRef: request.hypothesisRef,
      protocol: request.protocol,
      costModel: request.costModel,
    });
    const verification = Object.freeze({
      startedAt: started.timestamp,
      sourceReference: portableReference(`pi-entry:${started.id}`, "verification source reference"),
    });
    const contract = await executeWalkForwardContract({
      artifact,
      codeRoot,
      decisionSchedule: request.decisionSchedule,
      declaration: dataset.declaration,
      guard: new TemporalGuard(context.project.backends),
      binding: dataset.binding,
      runtimes: context.project.runtimes,
      ...(request.columns === undefined ? {} : { columns: request.columns }),
      concurrency: context.project.promotionConcurrency,
      retainExecutionEvidence: false,
      signal: context.signal,
    });
    const candidate = createPromotionCandidate({
      artifact,
      plan: contract.plan,
      declaration: dataset.declaration,
      contractRecord: contract.record,
      verification,
      registration,
    });
    verifyPromotionCandidate(candidate, {
      artifact,
      plan: contract.plan,
      declaration: dataset.declaration,
      contractRecord: contract.record,
      registration,
      verification,
      expectedCandidateHash: candidate.candidateHash,
    });

    const evidence: RunEvidence = Object.freeze({
      format: VEIL_RUN_EVIDENCE_FORMAT,
      researchRunId: startData.runId,
      requestReference,
      declaration: dataset.declaration,
      artifact,
      plan: contract.plan,
      contractRecord: contract.record,
      registration,
      verification,
      candidate,
    });
    assertUnverifiedEvidence(evidence);
    const evidenceJson = `${canonicalJson(evidence)}\n`;
    const evidenceHash = hashBytes(evidenceJson);
    const evidenceReference = `.veil/runs/${evidenceHash.slice("sha256:".length)}.json`;
    await writeImmutableProjectFile({
      projectRoot: context.project.root,
      reference: evidenceReference,
      bytes: evidenceJson,
    });
    await appendProjectLog({
      projectRoot: context.project.root,
      reference: VEIL_RESEARCH_LOG_REFERENCE,
      header: researchLogHeader(),
      entry: successfulLogEntry(startData, candidate, evidenceReference),
    });
    const resultData: RunResultEntryData = Object.freeze({
      format: VEIL_RUN_RESULT_ENTRY,
      runId: startData.runId,
      outcome: "candidate",
      candidate: candidateSummary(candidate),
      failureCode: null,
      evidenceReference,
      evidenceHash,
      researchLogReference: VEIL_RESEARCH_LOG_REFERENCE,
    });
    context.appendEntry(VEIL_RUN_RESULT_ENTRY, resultData);
    return Object.freeze({
      format: VEIL_AGENT_TOOL_RESULT_FORMAT,
      tool: VEIL_BACKTEST_TOOL,
      ok: true,
      researchRunId: startData.runId,
      status: candidate.status,
      structuralStatus: candidate.structuralStatus,
      claimStatus: candidate.claimStatus,
      registrationStatus: candidate.hypothesis.registrationStatus,
      artifactHash: candidate.artifactHash,
      planHash: candidate.planHash,
      contractHash: candidate.contractHash,
      candidateHash: candidate.candidateHash,
      executionCount: contract.executionCount,
      requiredEvidence: candidate.requiredEvidence,
      evidenceReference,
      researchLogReference: VEIL_RESEARCH_LOG_REFERENCE,
    });
  } catch (error) {
    return recordRejectedRun(error, startData, context);
  }
}

function validateBacktestInput(input: VeilBacktestToolInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest("veil-backtest input must be an object");
  }
  if (
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, "request") ||
    typeof input.request !== "string" ||
    input.request.trim().length === 0
  ) {
    throw invalidRequest("veil-backtest input requires only a non-empty request reference");
  }
}

export function assertPromotionDataSemantics(declaration: AdapterDeclaration): void {
  const degradations = deriveDataSemantics(declaration).degradations.filter(
    (degradation) =>
      degradation === "PIT_UNSAFE" ||
      degradation === "POINT_IN_TIME_UNVERIFIED" ||
      degradation === "PIT_DEGRADED_ASSUMED" ||
      degradation === "SURVIVORSHIP_BIASED" ||
      degradation === "SURVIVORSHIP_UNKNOWN",
  );
  if (degradations.length === 0) return;
  throw new ContractViolation(
    "C1",
    `promotion cannot use critical data degradations: ${degradations.join(", ")}`,
    {
      dataset: declaration.dataset,
      context: { degradations: degradations.join(",") },
      remedy:
        "Register a point-in-time, survivorship-free dataset declaration or keep the result exploratory.",
    },
  );
}

async function recordRejectedRun(
  error: unknown,
  start: VerificationStartEntryData,
  context: {
    readonly project: VeilProjectRuntime;
    readonly appendEntry: <T>(customType: string, data: T) => void;
  },
): Promise<VeilBacktestFailure> {
  const failure = describeVeilError(error);
  const violation: ViolationEntryData = Object.freeze({
    format: VEIL_VIOLATION_ENTRY,
    phase: "promotion",
    code: portableDiagnosticCode(failure.code),
    message: failure.message,
    remedy: failure.remedy,
    toolName: VEIL_BACKTEST_TOOL,
    runId: start.runId,
  });
  context.appendEntry(VEIL_VIOLATION_ENTRY, violation);
  try {
    await appendProjectLog({
      projectRoot: context.project.root,
      reference: VEIL_RESEARCH_LOG_REFERENCE,
      header: researchLogHeader(),
      entry: rejectedLogEntry(start, failure),
    });
  } catch (logError) {
    const logFailure = describeVeilError(logError);
    context.appendEntry(
      VEIL_VIOLATION_ENTRY,
      Object.freeze({
        format: VEIL_VIOLATION_ENTRY,
        phase: "promotion",
        code: portableDiagnosticCode(logFailure.code),
        message: logFailure.message,
        remedy: logFailure.remedy,
        toolName: VEIL_BACKTEST_TOOL,
        runId: start.runId,
      }) satisfies ViolationEntryData,
    );
  }
  const result: RunResultEntryData = Object.freeze({
    format: VEIL_RUN_RESULT_ENTRY,
    runId: start.runId,
    outcome: "rejected",
    candidate: null,
    failureCode: portableDiagnosticCode(failure.code),
    evidenceReference: null,
    evidenceHash: null,
    researchLogReference: VEIL_RESEARCH_LOG_REFERENCE,
  });
  context.appendEntry(VEIL_RUN_RESULT_ENTRY, result);
  return Object.freeze({
    ...failure,
    format: VEIL_AGENT_TOOL_RESULT_FORMAT,
    tool: VEIL_BACKTEST_TOOL,
    researchRunId: start.runId,
  });
}

async function loadPromotionRequest(path: string): Promise<PromotionRequest> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw invalidRequest("promotion request could not be read");
  }
  let input: unknown;
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error("invalid promotion YAML");
    }
    input = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw invalidRequest("promotion request is not valid strict YAML");
  }
  const root = exactRecord(
    input,
    [
      "format",
      "dataset",
      "hypothesis_ref",
      "factor",
      "params_locked",
      "declared_literals",
      "trials_declared",
      "development_read_sets",
      "protocol",
      "decision_schedule",
      "columns",
      "cost_model",
    ],
    "promotion request",
  );
  if (root.format !== VEIL_PROMOTION_REQUEST_FORMAT) {
    throw invalidRequest("promotion request uses an unsupported format");
  }
  const factor = exactRecord(root.factor, ["code_root", "files", "runtime", "entry"], "factor");
  const runtime = exactRecord(factor.runtime, ["id", "constraint"], "factor runtime");
  const entry = exactRecord(factor.entry, ["file", "callable"], "factor entry");
  const protocol = normalizeProtocol(root.protocol);
  const developmentReadSets = sha256Array(root.development_read_sets, "development read sets");
  const decisionSchedule = timeArray(root.decision_schedule, "decision schedule");
  const columns = root.columns === null ? undefined : stringArray(root.columns, "factor columns");
  return Object.freeze({
    format: VEIL_PROMOTION_REQUEST_FORMAT,
    dataset: portableReference(root.dataset, "dataset"),
    hypothesisRef: portableReference(root.hypothesis_ref, "hypothesis reference"),
    factor: Object.freeze({
      codeRootReference: projectReference(factor.code_root),
      files: Object.freeze(
        stringArray(factor.files, "factor files").map((file) => projectReference(file)),
      ),
      runtime: Object.freeze({
        id: portableReference(runtime.id, "runtime id"),
        constraint: boundedText(runtime.constraint, "runtime constraint", 128),
      }),
      entry: Object.freeze({
        file: projectReference(entry.file),
        callable: portableReference(entry.callable, "factor callable"),
      }),
    }),
    paramsLocked: plainParameterMap(root.params_locked, "locked parameters"),
    declaredLiterals: plainParameterMap(root.declared_literals, "declared literals"),
    trialsDeclared: positiveInteger(root.trials_declared, "trials_declared"),
    developmentReadSets,
    protocol,
    decisionSchedule,
    columns,
    costModel: portableReference(root.cost_model, "cost model"),
  });
}

function normalizeProtocol(input: unknown): PromotionRequest["protocol"] {
  const root = exactRecord(
    input,
    [
      "mode",
      "folds",
      "train_days",
      "oos_days",
      "purge_days",
      "embargo_days",
      "hold_days",
      "execution_lag_days",
    ],
    "promotion protocol",
  );
  if (root.mode !== "rolling" && root.mode !== "expanding") {
    throw invalidRequest("promotion protocol mode must be rolling or expanding");
  }
  return Object.freeze({
    mode: root.mode,
    folds: positiveInteger(root.folds, "protocol folds"),
    trainDays: positiveInteger(root.train_days, "protocol train_days"),
    oosDays: positiveInteger(root.oos_days, "protocol oos_days"),
    purgeDays: nonNegativeInteger(root.purge_days, "protocol purge_days"),
    embargoDays: nonNegativeInteger(root.embargo_days, "protocol embargo_days"),
    holdDays: positiveInteger(root.hold_days, "protocol hold_days"),
    executionLagDays: positiveInteger(root.execution_lag_days, "protocol execution_lag_days"),
  });
}

function requireObservedDevelopmentReads(
  ledger: ReturnType<typeof reconstructSessionLedger>,
  request: PromotionRequest,
): void {
  const observed = new Set(
    ledger.dataReads
      .filter((entry) => entry.data.dataset === request.dataset)
      .map((entry) => entry.data.readSetId),
  );
  for (const readSetId of request.developmentReadSets) {
    if (!observed.has(readSetId)) {
      throw invalidRequest(
        "promotion references a development read-set absent from the active session branch",
        "Read the dataset through veil-data in this branch and copy its readSetId into the request.",
      );
    }
  }
}

function admissibleRegistration(
  ledger: ReturnType<typeof reconstructSessionLedger>,
  hypothesisRef: string,
  verificationStartedAt: string,
): HypothesisRegistrationRecord | null {
  const hypothesis = latestHypothesis(ledger, hypothesisRef);
  if (
    hypothesis === null ||
    Date.parse(hypothesis.timestamp) >= Date.parse(verificationStartedAt)
  ) {
    return null;
  }
  return hypothesisRegistrationFromEntry(hypothesis);
}

function assertUnverifiedEvidence(evidence: RunEvidence): void {
  if (
    evidence.candidate.claimStatus !== "unverified" ||
    evidence.candidate.status !== "awaiting-pricing-and-gates"
  ) {
    throw new VeilAgentError(
      "INVALID_CANDIDATE",
      "Stage 3 run evidence attempted to claim a verified result",
      "Keep pricing, metrics, statistical gates, verdicts, and Experiment issuance in Stage 4.",
    );
  }
  const forbidden = new Set([
    "experimentId",
    "experiment_id",
    "metric",
    "metrics",
    "price",
    "prices",
    "return",
    "returns",
    "gates",
    "verdict",
  ]);
  for (const layer of [evidence, evidence.candidate]) {
    for (const key of Object.keys(layer)) {
      if (!forbidden.has(key)) continue;
      throw new VeilAgentError(
        "INVALID_CANDIDATE",
        `Stage 3 run evidence contains forbidden claim field ${key}`,
        "Persist only structural contract evidence and an unverified promotion candidate.",
      );
    }
  }
}

function researchLogHeader(): string {
  return (
    "# Veil research log\n\n" +
    "> Append-only Stage 3 log. Entries are research runs, not Experiments. A successful entry is\n" +
    "> structurally contract-verified but remains unverified until Stage 4 pricing, costs, and\n" +
    "> statistical gates issue an Experiment.\n\n"
  );
}

function successfulLogEntry(
  start: VerificationStartEntryData,
  candidate: PromotionCandidateRecord,
  evidenceReference: string,
): string {
  return (
    `## Research run ${start.runId}\n\n` +
    `- Hypothesis: \`${start.hypothesisRef}\`\n` +
    `- Request: \`${start.requestReference}\`\n` +
    `- Structural status: \`${candidate.structuralStatus}\`\n` +
    `- Claim status: \`${candidate.claimStatus}\`\n` +
    `- Registration: \`${candidate.hypothesis.registrationStatus}\`\n` +
    `- Artifact: \`${candidate.artifactHash}\`\n` +
    `- Plan: \`${candidate.planHash}\`\n` +
    `- Contract: \`${candidate.contractHash}\`\n` +
    `- Candidate: \`${candidate.candidateHash}\`\n` +
    `- Evidence: \`${evidenceReference}\`\n` +
    "- Required next evidence: pricing, costs, statistical gates\n\n" +
    "This run is not a citable Experiment and carries no verified performance claim.\n\n"
  );
}

function rejectedLogEntry(start: VerificationStartEntryData, failure: PublicVeilError): string {
  return (
    `## Rejected research run ${start.runId}\n\n` +
    `- Hypothesis: \`${start.hypothesisRef}\`\n` +
    `- Request: \`${start.requestReference}\`\n` +
    `- Failure: \`${portableDiagnosticCode(failure.code)}\`\n` +
    `- Message: ${singleLine(failure.message)}\n` +
    `- Remedy: ${singleLine(failure.remedy)}\n\n` +
    "No promotion candidate or Experiment was issued.\n\n"
  );
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest(`${label} must be an object`);
  }
  const root = input as Record<string, unknown>;
  const actual = Object.keys(root).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidRequest(`${label} has missing or unknown fields`);
  }
  return root;
}

function plainParameterMap(input: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest(`${label} must be an object`);
  }
  canonicalJson(input);
  return Object.freeze({ ...(input as Record<string, unknown>) });
}

function stringArray(input: unknown, label: string): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRequest(`${label} must contain at least one value`);
  }
  const values = input.map((value) => boundedText(value, label, 1024));
  if (new Set(values).size !== values.length) throw invalidRequest(`${label} contains duplicates`);
  return Object.freeze(values);
}

function sha256Array(input: unknown, label: string): readonly string[] {
  const values = stringArray(input, label);
  for (const value of values) {
    if (!SHA256_ID.test(value))
      throw invalidRequest(`${label} contains an invalid sha256 identity`);
  }
  return values;
}

function timeArray(input: unknown, label: string): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRequest(`${label} must contain at least one decision time`);
  }
  return Object.freeze(input.map((value) => normalizeDecisionTime(value)));
}

function boundedText(input: unknown, label: string, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum ||
    input.trim() !== input ||
    input.includes("\0")
  ) {
    throw invalidRequest(`${label} must be bounded non-empty text`);
  }
  return input;
}

function portableReference(input: unknown, label: string): string {
  if (typeof input !== "string" || !PORTABLE_REFERENCE.test(input)) {
    throw invalidRequest(`${label} is not a portable reference`);
  }
  return input;
}

function positiveInteger(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
    throw invalidRequest(`${label} must be a positive integer`);
  }
  return input;
}

function nonNegativeInteger(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidRequest(`${label} must be a non-negative integer`);
  }
  return input;
}

function portableDiagnosticCode(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
  return normalized.length === 0 ? "UNKNOWN" : normalized;
}

function singleLine(input: string): string {
  return input
    .replace(/[\r\n]+/gu, " ")
    .replace(/`/gu, "'")
    .trim();
}

function invalidRequest(
  message: string,
  remedy = "Correct the strict veil.promotion-request.v0 file and retry veil-backtest.",
): VeilAgentError {
  return new VeilAgentError("INVALID_PROMOTION_REQUEST", message, remedy);
}
