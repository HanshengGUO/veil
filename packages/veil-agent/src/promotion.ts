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
  executeExperiment,
  executeOosPricing,
  executeStandardGateEvaluation,
  executeWalkForwardContract,
  type HypothesisRegistrationRecord,
  NullGeneratorRegistry,
  type PromotionCandidateRecord,
  type PromotionCandidateVerificationEvidence,
  QUANTILE_OOS_PRICING_METHOD,
  TemporalGuard,
  verifyPromotionCandidate,
  type WalkForwardContractResult,
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
import { loadProjectExperiment, persistProjectExperiment } from "./experiments.ts";
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
import { trialCountEvidence } from "./memory.ts";
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
  readonly status: "awaiting-pricing-and-gates" | "complete";
  readonly structuralStatus: "contract-verified";
  readonly claimStatus: "unverified" | "verified" | "degraded" | "rejected";
  readonly registrationStatus: "preregistered" | "exploratory";
  readonly artifactHash: string;
  readonly planHash: string;
  readonly contractHash: string;
  readonly candidateHash: string;
  readonly executionCount: number;
  readonly requiredEvidence: readonly ["pricing", "costs", "statistical-gates"] | readonly [];
  readonly evidenceReference: string;
  readonly researchLogReference: typeof VEIL_RESEARCH_LOG_REFERENCE;
  readonly experimentId?: string;
  readonly verdict?: "accepted" | "degraded" | "rejected";
  readonly metrics?: readonly unknown[];
  readonly gateReasons?: readonly {
    readonly gateId: string;
    readonly outcome: string;
    readonly reasonCode: string;
  }[];
  readonly experimentArchiveReference?: string;
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
  readonly stage4: {
    readonly signalColumn: string;
    readonly priceColumn: string;
    readonly marketColumns: readonly string[];
    readonly periodsPerYear: number;
    readonly portfolioKind: "long-only-quantile" | "long-short-quantile";
    readonly quantile: number;
    readonly weightColumn: string | null;
    readonly capacity: {
      readonly portfolioNav: number;
      readonly volumeColumn: string;
      readonly maximumParticipationRate: number;
    } | null;
    readonly nullGenerator: string | null;
    readonly trialBudget: number;
    readonly knowledgeCutoff: string | null;
  } | null;
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
        code: await captureArtifactCode({
          root: codeRoot,
          files: request.factor.files,
        }),
      },
      paramsLocked: request.paramsLocked,
      declaredLiterals: stage4DeclaredLiterals(request, context.project),
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
      retainExecutionEvidence: request.stage4 !== null,
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
    if (request.stage4 !== null) {
      const complete = await completeStage4({
        request,
        researchRunId: startData.runId,
        codeRoot,
        project: context.project,
        candidate,
        candidateEvidence: {
          artifact,
          plan: contract.plan,
          declaration: dataset.declaration,
          contractRecord: contract.record,
          registration,
          verification,
        },
        contract,
        getBranch: context.getBranch,
        appendEntry: context.appendEntry,
        structuralEvidenceReference: evidenceReference,
      });
      context.appendEntry(VEIL_RUN_RESULT_ENTRY, resultData);
      return complete;
    }
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

function stage4DeclaredLiterals(
  request: PromotionRequest,
  project: VeilProjectRuntime,
): Readonly<Record<string, unknown>> {
  const stage4 = request.stage4;
  if (stage4 === null) return request.declaredLiterals;
  if (
    Object.hasOwn(request.declaredLiterals, "oosPricing") ||
    Object.hasOwn(request.declaredLiterals, "gatePolicy")
  ) {
    throw invalidRequest(
      "declared_literals cannot override engine-derived Stage 4 pricing or gate identities",
      "Use the strict stage4 request block and the providers registered in .veil/project.yaml.",
    );
  }
  const costModel = project.costModels
    ?.list()
    .find((descriptor) => descriptor.reference === request.costModel);
  if (costModel === undefined) {
    throw invalidRequest(
      `Stage 4 cost model ${request.costModel} is not registered by the project`,
      "Register the logical cost model under stage4.cost_models in .veil/project.yaml.",
    );
  }
  const nullGenerator =
    stage4.nullGenerator === null
      ? null
      : project.nullGenerators
          ?.list()
          .find((descriptor) => descriptor.reference === stage4.nullGenerator);
  if (stage4.nullGenerator !== null && nullGenerator === undefined) {
    throw invalidRequest(
      `Stage 4 null generator ${stage4.nullGenerator} is not registered by the project`,
      "Register the logical generator under stage4.null_generators or set null_generator to null and accept degradation.",
    );
  }
  return Object.freeze({
    ...request.declaredLiterals,
    oosPricing: {
      pricingMethodIdentity: QUANTILE_OOS_PRICING_METHOD,
      signalColumn: stage4.signalColumn,
      priceColumn: stage4.priceColumn,
      marketColumns: stage4.marketColumns,
      periodsPerYear: stage4.periodsPerYear,
      portfolio: {
        kind: stage4.portfolioKind,
        quantile: stage4.quantile,
        weightColumn: stage4.weightColumn,
      },
      capacity: stage4.capacity,
      costModelIdentity: {
        version: costModel.version,
        implementationHash: costModel.implementationHash,
        configurationHash: costModel.configurationHash,
      },
    },
    gatePolicy: {
      policyId: "veil.standard-stage4",
      policyVersion: "0.1.0",
      trialBudget: stage4.trialBudget,
      nullGeneratorIdentity: nullGenerator ?? null,
      knowledgeCutoff: stage4.knowledgeCutoff,
    },
  });
}

async function completeStage4(input: {
  readonly request: PromotionRequest;
  readonly researchRunId: string;
  readonly codeRoot: string;
  readonly project: VeilProjectRuntime;
  readonly candidate: PromotionCandidateRecord;
  readonly candidateEvidence: PromotionCandidateVerificationEvidence;
  readonly contract: WalkForwardContractResult;
  readonly getBranch: () => readonly unknown[];
  readonly appendEntry: <T>(customType: string, data: T) => void;
  readonly structuralEvidenceReference: string;
}): Promise<VeilBacktestSuccess> {
  const stage4 = input.request.stage4;
  if (stage4 === null || input.project.costModels === undefined) {
    throw invalidRequest("Stage 4 execution is not configured");
  }
  const pricingVerification = {
    candidate: input.candidate,
    candidateEvidence: input.candidateEvidence,
  };
  const pricing = await executeOosPricing({
    candidate: input.candidate,
    candidateEvidence: input.candidateEvidence,
    contractResult: input.contract,
    costModels: input.project.costModels,
  });
  const ledger = reconstructSessionLedger(input.getBranch());
  const priorEntries = ledger.experiments.filter(
    (entry) => entry.data.hypothesisRef === input.candidate.hypothesis.hypothesisRef,
  );
  const priorArchives = await Promise.all(
    priorEntries.map((entry) => loadProjectExperiment(input.project.root, entry.data.experimentId)),
  );
  const compatible = priorArchives.filter((archive) => {
    const prior = archive.execution.pricing.record;
    return (
      canonicalJson(prior.dataset) === canonicalJson(pricing.record.dataset) &&
      canonicalJson(prior.pricingMethod) === canonicalJson(pricing.record.pricingMethod) &&
      canonicalJson(prior.costModel) === canonicalJson(pricing.record.costModel) &&
      prior.parameterLockHash !== pricing.record.parameterLockHash
    );
  });
  const parameterNeighbors = compatible.slice(-8).map((archive) => ({
    result: archive.execution.pricing,
    pricingVerification: archive.pricingVerification,
  }));
  const postCutoffArchive =
    stage4.knowledgeCutoff === null
      ? undefined
      : [...compatible]
          .reverse()
          .find((archive) =>
            archive.execution.pricing.payloads.netReturns.observations.some(
              (observation) =>
                Date.parse(observation.decisionTime) > Date.parse(stage4.knowledgeCutoff ?? ""),
            ),
          );
  const trialEvidence = trialCountEvidence(
    input.getBranch(),
    input.candidate.hypothesis.hypothesisRef,
  );
  const postCutoffValidation =
    postCutoffArchive === undefined
      ? null
      : {
          result: postCutoffArchive.execution.pricing,
          pricingVerification: postCutoffArchive.pricingVerification,
        };
  const gates = await executeStandardGateEvaluation({
    pricing,
    pricingVerification,
    trialEvidence,
    nullGenerators: input.project.nullGenerators ?? new NullGeneratorRegistry(),
    parameterNeighbors,
    ...(postCutoffValidation === null
      ? {}
      : {
          postCutoffValidation,
        }),
  });
  const nonpassing = gates.methods.filter((method) => method.outcome !== "passed");
  const issuedAt = new Date(
    Math.max(Date.now(), Date.parse(input.candidate.verification.startedAt)),
  ).toISOString();
  const execution = executeExperiment({
    pricing,
    pricingVerification,
    gates,
    issuedAt,
    rationale:
      gates.evaluation.verdict === "accepted"
        ? "The candidate passed the complete immutable Stage 4 policy."
        : `The complete Stage 4 policy produced ${gates.evaluation.verdict}.`,
    lessons:
      nonpassing.length === 0
        ? ["Preserve the exact read-set snapshot and method identities for reproduction."]
        : nonpassing.map(
            (method) =>
              `${method.gateId} reported ${method.reasonCode}; address it before another claim.`,
          ),
  });
  const persisted = await persistProjectExperiment({
    projectRoot: input.project.root,
    execution,
    pricingVerification,
    artifactCodeRoot: input.codeRoot,
    contractResult: input.contract,
    gateReplay: {
      trialEvidence,
      parameterNeighbors,
      postCutoffValidation,
    },
    getBranch: input.getBranch,
    appendEntry: (customType, data) => input.appendEntry(customType, data),
  });
  return Object.freeze({
    format: VEIL_AGENT_TOOL_RESULT_FORMAT,
    tool: VEIL_BACKTEST_TOOL,
    ok: true,
    researchRunId: input.researchRunId,
    status: "complete",
    structuralStatus: input.candidate.structuralStatus,
    claimStatus: execution.experiment.claimStatus,
    registrationStatus: input.candidate.hypothesis.registrationStatus,
    artifactHash: input.candidate.artifactHash,
    planHash: input.candidate.planHash,
    contractHash: input.candidate.contractHash,
    candidateHash: input.candidate.candidateHash,
    executionCount: input.contract.executionCount,
    requiredEvidence: Object.freeze([]) as readonly [],
    evidenceReference: input.structuralEvidenceReference,
    researchLogReference: VEIL_RESEARCH_LOG_REFERENCE,
    experimentId: execution.experiment.experimentId,
    verdict: execution.experiment.verdict,
    metrics: execution.experiment.metrics,
    gateReasons: execution.experiment.gates.map((gate) => ({
      gateId: gate.gateId,
      outcome: gate.outcome,
      reasonCode: gate.reasonCode,
    })),
    experimentArchiveReference: persisted.archiveReference,
  });
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
        "Use an already registered point-in-time, survivorship-free dataset, or preserve the C1 rejection and report the result invalid or exploratory; never edit guarantees without source evidence.",
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
      "stage4",
    ],
    "promotion request",
    true,
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
    costModel: costModelReference(root.cost_model),
    stage4: normalizeStage4Request(root.stage4),
  });
}

function normalizeStage4Request(input: unknown): PromotionRequest["stage4"] {
  if (input === undefined || input === null) return null;
  const root = exactRecord(
    input,
    [
      "signal_column",
      "price_column",
      "market_columns",
      "periods_per_year",
      "portfolio_kind",
      "quantile",
      "weight_column",
      "capacity",
      "null_generator",
      "trial_budget",
      "knowledge_cutoff",
    ],
    "Stage 4 promotion configuration",
  );
  const quantile = finiteNumber(root.quantile, "Stage 4 quantile");
  if (quantile <= 0 || quantile > 0.5) {
    throw invalidRequest("Stage 4 quantile must be greater than zero and at most 0.5");
  }
  const capacity = normalizeStage4Capacity(root.capacity);
  const marketColumns = Object.freeze(
    stringArrayAllowEmpty(root.market_columns, "Stage 4 market columns"),
  );
  if (capacity !== null && !marketColumns.includes(capacity.volumeColumn)) {
    throw invalidRequest("Stage 4 capacity volume_column must also appear in market_columns");
  }
  if (
    root.portfolio_kind !== "long-only-quantile" &&
    root.portfolio_kind !== "long-short-quantile"
  ) {
    throw invalidRequest(
      "Stage 4 portfolio_kind must be long-only-quantile or long-short-quantile",
    );
  }
  return Object.freeze({
    signalColumn: fieldName(root.signal_column, "Stage 4 signal column"),
    priceColumn: fieldName(root.price_column, "Stage 4 price column"),
    marketColumns,
    periodsPerYear: positiveInteger(root.periods_per_year, "Stage 4 periods_per_year"),
    portfolioKind: root.portfolio_kind,
    quantile,
    weightColumn:
      root.weight_column === null
        ? null
        : fieldName(root.weight_column, "Stage 4 portfolio weight column"),
    capacity,
    nullGenerator:
      root.null_generator === null
        ? null
        : portableReference(root.null_generator, "Stage 4 null-generator reference"),
    trialBudget: positiveInteger(root.trial_budget, "Stage 4 trial_budget"),
    knowledgeCutoff:
      root.knowledge_cutoff === null ? null : normalizeDecisionTime(root.knowledge_cutoff),
  });
}

function normalizeStage4Capacity(
  input: unknown,
): NonNullable<PromotionRequest["stage4"]>["capacity"] {
  if (input === null || input === undefined) return null;
  const root = exactRecord(
    input,
    ["portfolio_nav", "volume_column", "maximum_participation_rate"],
    "Stage 4 capacity configuration",
  );
  const portfolioNav = finiteNumber(root.portfolio_nav, "Stage 4 portfolio NAV");
  const maximumParticipationRate = finiteNumber(
    root.maximum_participation_rate,
    "Stage 4 maximum participation rate",
  );
  if (portfolioNav <= 0) throw invalidRequest("Stage 4 portfolio_nav must be positive");
  if (maximumParticipationRate <= 0 || maximumParticipationRate > 1) {
    throw invalidRequest(
      "Stage 4 maximum_participation_rate must be greater than zero and at most one",
    );
  }
  return Object.freeze({
    portfolioNav,
    volumeColumn: fieldName(root.volume_column, "Stage 4 volume column"),
    maximumParticipationRate,
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
    // Preserve an explicitly requested same-session protocol so the engine can reject it as C1.
    // Treating zero as a generic request-shape error would bypass the structured claim boundary.
    executionLagDays: nonNegativeInteger(root.execution_lag_days, "protocol execution_lag_days"),
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
    if (observed.has(readSetId)) continue;
    const otherDatasets = [
      ...new Set(
        ledger.dataReads
          .filter((entry) => entry.data.readSetId === readSetId)
          .map((entry) => entry.data.dataset),
      ),
    ].sort();
    if (otherDatasets.length > 0) {
      throw invalidRequest(
        `promotion development read-set is recorded for dataset ${otherDatasets.join(", ")}, not request dataset ${request.dataset}`,
        "development_read_sets may contain only readSetId values returned by veil-data for request.dataset. Keep other dataset reads exploratory or prepare a separate registered dataset before the research session.",
      );
    }
    throw invalidRequest(
      "promotion references a development read-set absent from the active session branch",
      "Read request.dataset through veil-data on this active branch and copy that call's readSetId into the request.",
    );
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
  optional = false,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest(`${label} must be an object`);
  }
  const root = input as Record<string, unknown>;
  const actual = Object.keys(root).sort();
  const expected = [...keys].sort();
  if (
    actual.some((key) => !expected.includes(key)) ||
    (!optional &&
      (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])))
  ) {
    throw invalidRequest(`${label} has missing or unknown fields`);
  }
  return root;
}

function stringArrayAllowEmpty(input: unknown, label: string): readonly string[] {
  if (!Array.isArray(input) || input.length > 64) {
    throw invalidRequest(`${label} must be an array of at most 64 values`);
  }
  const values = input.map((value) => fieldName(value, label));
  if (new Set(values).size !== values.length) throw invalidRequest(`${label} contains duplicates`);
  return Object.freeze(values);
}

function fieldName(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(input)) {
    throw invalidRequest(`${label} must be a portable field name`);
  }
  return input;
}

function finiteNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || Object.is(input, -0)) {
    throw invalidRequest(`${label} must be a canonical finite number`);
  }
  return input;
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

function costModelReference(input: unknown): string {
  if (typeof input !== "string" || !PORTABLE_REFERENCE.test(input)) {
    throw invalidRequest(
      "cost model must be a portable logical reference",
      "Use a logical id such as stage4-not-issued. Filesystem paths and locator URIs are invalid; Stage 3 records the future method reference but does not apply a cost model.",
    );
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
