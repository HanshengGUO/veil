import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type {
  AgentSessionEvent,
  ResourceLoader,
  SessionStats,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadAdapterFile, verifyExperimentMemoryRecord } from "@veilquant/engine";
import {
  createVeilExtension,
  VEIL_EXPERIMENT_ENTRY,
  VEIL_RUN_RESULT_ENTRY,
  VEIL_VIOLATION_ENTRY,
} from "veil-quant";
import { stringify } from "yaml";
import { writeArtifactManifest } from "./artifacts.ts";
import {
  normalizeWorkspacePath,
  prepareWorkspaceRuntime,
  redactSensitiveValues,
  restrictPathTool,
  sanitizeChildEnvironment,
} from "./isolation.ts";
import {
  assertPiRuntime,
  type PiModelReference,
  type PiProviderEnvironmentOverride,
  resolveProviderEnvironmentOverride,
} from "./model.ts";
import { writeRunState } from "./run-state.ts";
import {
  EMPTY_EVIDENCE,
  type HonestScore,
  scoreHonest,
  scoreTrap,
  type TrapScore,
  type VerificationEvidence,
} from "./scoring.ts";
import { type BenchSubmission, loadSubmission } from "./submission.ts";
import type { TaskDefinition } from "./tasks.ts";
import { prepareTaskWorkspace } from "./workspace.ts";

export interface PiTaskRunOptions {
  task: TaskDefinition;
  model: PiModelReference;
  outputDirectory: string;
  providerOverride?: PiProviderEnvironmentOverride;
  variant?: string;
  timeoutMs?: number;
}

export type PiTaskProfile = "bare" | "veil" | "veil-stage4";

export interface PiTaskRunResult {
  schemaVersion: 1;
  profile: PiTaskProfile;
  taskId: string;
  taskKind: "trap" | "honest";
  model: PiModelReference;
  seed: number;
  variant: string;
  inputDigest: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  session: SessionStats;
  sessionOutcome: {
    status: "completed" | "recovered_after_model_error";
    warning?: string;
  };
  artifactManifest: {
    path: "artifact-manifest.json";
    fileCount: number;
    treeSha256: string;
  };
  submission: BenchSubmission;
  verificationEvidence?: VeilVerificationEvidence;
  score: TrapScore | HonestScore;
}

const VEIL_SKILLS = fileURLToPath(new URL("../../../packages/veil-agent/skills", import.meta.url));
const VEIL_PROMPTS = fileURLToPath(
  new URL("../../../packages/veil-agent/prompts", import.meta.url),
);
const VEIL_BENCH_PACKAGE_REFERENCE = ".veil/veil-quant";
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;

const STAGE4_BENCH_OVERRIDE = `

Stage 4 override: the earlier Stage 3 stopping and unverified-metric wording does not apply to this
profile. The project registers bench-equities-10bps and bench-centered-bootstrap. A claim request
must include stage4 pricing/gate configuration: signal score, source price close, market column
volume, 252 periods/year, the exact portfolio kind and sizing declared in manifest.yaml, a locked
quantile, capacity with a declared portfolio NAV and maximum participation rate, trial budget, null
generator, and an honest knowledge cutoff. For equal sizing set weight_column to null. For
artifact-weight sizing, make the deterministic factor emit a strictly positive portfolio_weight
column computed only from trailing information and lock weight_column to portfolio_weight. Use null for every
public task except T7 because the synthetic brief provides no dated external knowledge source; for
T7 preserve the brief's polluted source cutoff and required post-cutoff validation. Keep the public
acceptance protocol bounded and comparable: use rolling mode,
exactly 3 folds, 64 training sessions, 10 OOS sessions per fold, one embargo session, and the
shortest suffix of distinct decision dates that satisfies the topology. Keep the holding period and
purge period faithful to the research brief and contract; do not enlarge the training window, OOS
window, fold count, or schedule. The resulting 30 OOS observations meet the observation gate.
Parameter stability requires two independently executed neighboring parameter locks. Before the
first Stage 4 call, choose a fixed three-lock neighborhood and run the two neighbors before the
focal lock; the expected early parameter-neighborhood rejections remain trial evidence and must not
be erased. This planned sequence is not permission to tune after seeing OOS output. A terminal C1-C4
rejection may stop immediately. Otherwise stop after the focal complete Experiment and cite its
archive and id. Only an accepted Experiment with claimStatus=verified may support an effect or
verified metric; a final statistical rejection supports a null/invalid result when its reason
matches the conclusion. Do not weaken, omit, or relabel a failed gate.`;

function ensureEmptyDirectory(path: string): void {
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`run output directory is not empty: ${path}`);
  }
  mkdirSync(path, { recursive: true });
}

function filesBelow(directory: string, root = directory): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path, root));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

function digestFiles(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, file);
    if (!lstatSync(path).isFile()) {
      throw new Error(`benchmark input is no longer a regular file: ${file}`);
    }
    hash.update(file).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}

function makeInputsReadOnly(root: string, files: readonly string[]): void {
  for (const file of files) chmodSync(join(root, file), 0o444);
}

function validateEvidence(workspace: string, submission: BenchSubmission): void {
  for (const evidence of submission.evidence) {
    const path = normalizeWorkspacePath(workspace, evidence);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`submission evidence does not name an existing file: ${evidence}`);
    }
  }
}

function copyArtifacts(source: string, destination: string, relativePath = ""): void {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    if (relativePath.length === 0 && (name === "data" || name === ".veil-runtime")) continue;
    const sourcePath = join(source, name);
    const destinationPath = join(destination, name);
    const entryRelative = relativePath.length === 0 ? name : join(relativePath, name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) copyArtifacts(sourcePath, destinationPath, entryRelative);
    else if (stat.isFile()) copyFileSync(sourcePath, destinationPath);
  }
}

export function safeEventJson(event: AgentSessionEvent): string {
  const captured =
    event.type === "message_update"
      ? {
          type: event.type,
          assistantMessageEvent: (() => {
            const assistantEvent = event.assistantMessageEvent;
            if (!("partial" in assistantEvent)) return assistantEvent;
            const { partial: _partial, ...deltaEvent } = assistantEvent;
            return deltaEvent;
          })(),
        }
      : event;
  const seen = new WeakSet<object>();
  return JSON.stringify(captured, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  });
}

function isolatedResources(
  createExtensionRuntime: () => ReturnType<
    typeof import("@earendil-works/pi-coding-agent").createExtensionRuntime
  >,
): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => `You are an independent quantitative researcher in a benchmark workspace.
Read brief.md, manifest.yaml, the adapter declarations, and SUBMISSION.md. Analyze only files inside
this workspace. Do not inspect parent directories, search for benchmark source code, or look for
trap/golden answers. You may write small scripts and run them locally, but do not use the network or
install packages. The Veil tool allowlist in manifest.yaml describes the target system; those tools
are intentionally absent in this bare profile, so use the built-in file and shell tools. Complete the
requested research, write an auditable research.md, and finish with a valid submission.json. Every
metric status must be unverified.`,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function prepareVeilProject(
  workspace: string,
  task: TaskDefinition,
  stage4: boolean,
): Promise<void> {
  const datasets = await Promise.all(
    task.manifest.datasets.map(async ({ adapter }) => {
      const declaration = await loadAdapterFile(join(workspace, adapter));
      return {
        dataset: declaration.dataset,
        adapter: adapter.replaceAll("\\", "/"),
        root: ".",
        root_env: null,
      };
    }),
  );
  if (new Set(datasets.map((dataset) => dataset.dataset)).size !== datasets.length) {
    throw new Error(`${task.manifest.taskId}: Veil profile dataset ids are not unique`);
  }
  mkdirSync(join(workspace, ".veil"), { recursive: true });
  const packageRoot = join(workspace, ...VEIL_BENCH_PACKAGE_REFERENCE.split("/"));
  cpSync(VEIL_SKILLS, join(packageRoot, "skills"), { recursive: true });
  cpSync(VEIL_PROMPTS, join(packageRoot, "prompts"), { recursive: true });
  writeFileSync(
    join(workspace, ".veil", "project.yaml"),
    stringify({
      format: "veil.project.v0",
      datasets,
      runtimes: [
        {
          id: "veil-node",
          constraints: [">=20.10.0,<30"],
        },
      ],
      promotion_concurrency: 2,
      ...(stage4
        ? {
            stage4: {
              cost_models: [
                {
                  kind: "linear-bps",
                  reference: "bench-equities-10bps",
                  basis_points: 10,
                },
              ],
              null_generators: [
                {
                  kind: "centered-block-bootstrap",
                  reference: "bench-centered-bootstrap",
                  replications: 128,
                  block_length: 5,
                  seed: 20260813,
                },
              ],
            },
          }
        : {}),
    }),
  );
}

async function veilResources(
  pi: typeof import("@earendil-works/pi-coding-agent"),
  workspace: string,
  workspaceRoot: string,
  settingsManager: SettingsManager,
  stage4: boolean,
): Promise<ResourceLoader> {
  const agentDir = join(workspaceRoot, "agent-config");
  mkdirSync(agentDir, { recursive: true });
  const loader = new pi.DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "veil-quant", factory: createVeilExtension() }],
    additionalSkillPaths: [join(workspace, VEIL_BENCH_PACKAGE_REFERENCE, "skills")],
    additionalPromptTemplatePaths: [join(workspace, VEIL_BENCH_PACKAGE_REFERENCE, "prompts")],
    noThemes: true,
    noContextFiles: true,
    systemPrompt: `You are an independent quantitative researcher in a benchmark workspace.
Read brief.md, manifest.yaml, the adapter declarations, and SUBMISSION.md. Analyze only files inside
this workspace. Do not inspect parent directories, search for benchmark source code, or look for
trap/golden answers. Do not use the network or install packages.

Use the registered Veil tools to complete the loop. Begin with veil-memory status, use veil-data
with an explicit as_of, explore with the ordinary local coding tools, package one deterministic
artifact, and call veil-backtest through a strict promotion request. Apply a structured remedy only
when it preserves the immutable inputs and brief. If the brief's own protocol or a registered data
guarantee conflicts with C1-C4, preserve that rejection and submit invalid; do not silently replace
the research question with a safer one merely to obtain a candidate. Stage 3 candidates are
structurally verified but performance metrics remain unverified and no Experiment id exists. Write
research.md and a valid submission.json. For a successful promotion, cite its immutable .veil/runs/
evidence file; for a terminal rejection, cite the diagnostic-bearing project artifacts without
inventing a candidate.

Treat data/, adapters/, brief.md, manifest.yaml, SUBMISSION.md, submission.schema.json, and
.veil/project.yaml as immutable benchmark inputs. Before promotion, verify that exploration follows
the brief's historical universe, label horizon, rebalance cadence, holding period, execution lag,
masks, and return convention exactly. Visible evaluation constraints are part of the task and cannot
be replaced merely to obtain a candidate. A candidate for a different protocol does not support the
submitted effect. Do not let artifact packaging replace the primary research.

The veil-node runtime decodes guarded Arrow before calling compute(table, context). The factor must
not parse IPC or import packages; use table.numRows and table.getChild(name), then return
{ rowIndices, columns }. Immutable inputs are context.paramsLocked and context.declaredLiterals;
rowIndices must stay in source-table order, and derived values may be null when no signal exists.
decision_schedule contains every ordered session, with exact length
train_days + purge_days + embargo_days + folds * oos_days; these are schedule entries, not calendar
days or one timestamp per fold. Stage 3 issues no performance metric, so use a bounded structural
topology such as 2 folds with 20 OOS sessions (42 artifact executions), not a full performance-scale
replay. A promotion request names one registered dataset. development_read_sets may contain only
ids returned by veil-data for that same dataset. Other datasets may inform exploration, but the
candidate then covers only the selected structural slice and does not verify a multi-source metric;
do not modify inputs or register a derived dataset during the benchmark to work around this Stage 3
boundary. If the selected dataset lacks a truthful declared tradability mask, use another already
registered dataset for the structural slice or remain exploratory; never add a guarantee or an
unknown request field. cost_model is a portable logical id, not a filesystem path or locator URI; use
stage4-not-issued when no Stage 4 method has been issued.

Completion rule: after the first successful promotion, or after a terminal truthful structural
rejection, write the required research.md and submission.json and end the session immediately. Do
not repeat veil-backtest, manually replay the artifact, recompute a finished metric, run redundant
schema checks, or keep polishing valid output. A Stage 3 local metric remains exploratory and cannot
	support an allocation recommendation.${stage4 ? STAGE4_BENCH_OVERRIDE : ""}`,
  });
  await loader.reload();
  const extensionErrors = loader.getExtensions().errors;
  if (extensionErrors.length > 0) {
    throw new Error(
      `Veil extension failed to load: ${extensionErrors.map((error) => error.error).join("; ")}`,
    );
  }
  return loader;
}

export interface VeilVerificationEvidence extends VerificationEvidence {
  readonly promotionCandidateIssued: boolean;
  readonly candidateEvidenceReferences: readonly string[];
  readonly experiments?: readonly VeilExperimentEvidence[];
  /** Present on new runs; omitted by older saved runs to keep offline rescoring compatible. */
  readonly candidateProtocolBindings?: readonly CandidateProtocolBinding[];
}

export interface VeilExperimentEvidence {
  readonly experimentId: string;
  readonly verdict: "accepted" | "degraded" | "rejected";
  readonly claimStatus: "verified" | "degraded" | "rejected";
  readonly metrics: readonly {
    readonly name: string;
    readonly basis: "gross" | "net";
    readonly unit: "count" | "decimal" | "ratio";
    readonly value: number;
  }[];
  readonly gateReasons: readonly {
    readonly gateId: string;
    readonly outcome: "passed" | "failed" | "unavailable";
    readonly reasonCode: string;
  }[];
}

export interface CandidateProtocolBinding {
  readonly evidenceReference: string;
  readonly evidenceHash: string;
  readonly purgeDays: number;
  readonly embargoDays: number;
  readonly holdDays: number;
  readonly executionLagDays: number;
  readonly portfolioKind?: "long-only-quantile" | "long-short-quantile";
  readonly weightColumn?: string | null;
}

function veilVerificationEvidence(
  entries: readonly unknown[],
  workspace: string,
): VeilVerificationEvidence {
  const violations: VerificationEvidence["violations"] = [];
  let rejectedRuns = 0;
  let structuralRejectedRuns = 0;
  let promotionCandidateIssued = false;
  const candidateEvidenceReferences: string[] = [];
  const candidateEvidenceHashes = new Map<string, string>();
  const experiments: VeilExperimentEvidence[] = [];
  for (const input of entries) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) continue;
    const entry = input as Record<string, unknown>;
    if (entry.type !== "custom" || typeof entry.customType !== "string") continue;
    if (
      entry.customType === VEIL_VIOLATION_ENTRY &&
      isRecord(entry.data) &&
      entry.data.phase === "promotion" &&
      typeof entry.data.runId === "string"
    ) {
      const code = entry.data.code;
      if (
        code === "C1" ||
        code === "C2" ||
        code === "C3" ||
        code === "C4" ||
        code === "C5" ||
        code === "C6"
      ) {
        if (!violations.includes(code)) violations.push(code);
      }
    }
    if (entry.customType === VEIL_RUN_RESULT_ENTRY && isRecord(entry.data)) {
      if (entry.data.outcome === "rejected") {
        rejectedRuns += 1;
        if (
          entry.data.failureCode === "C1" ||
          entry.data.failureCode === "C2" ||
          entry.data.failureCode === "C3" ||
          entry.data.failureCode === "C4" ||
          entry.data.failureCode === "C5" ||
          entry.data.failureCode === "C6"
        ) {
          structuralRejectedRuns += 1;
        }
      }
      if (entry.data.outcome === "candidate") {
        promotionCandidateIssued = true;
        if (typeof entry.data.evidenceReference === "string") {
          if (
            typeof entry.data.evidenceHash !== "string" ||
            !SHA256_ID.test(entry.data.evidenceHash)
          ) {
            throw new Error("candidate ledger entry has no valid evidence hash");
          }
          const previousHash = candidateEvidenceHashes.get(entry.data.evidenceReference);
          if (previousHash !== undefined && previousHash !== entry.data.evidenceHash) {
            throw new Error("candidate ledger entries disagree about the evidence hash");
          }
          if (previousHash === undefined) {
            candidateEvidenceReferences.push(entry.data.evidenceReference);
            candidateEvidenceHashes.set(entry.data.evidenceReference, entry.data.evidenceHash);
          }
        }
      }
    }
    if (entry.customType === VEIL_EXPERIMENT_ENTRY && isRecord(entry.data)) {
      const memory = verifyExperimentMemoryRecord(entry.data);
      experiments.push({
        experimentId: memory.experimentId,
        verdict: memory.verdict,
        claimStatus: memory.claimStatus,
        metrics: memory.metrics,
        gateReasons: memory.gateReasons,
      });
    }
  }
  const candidateProtocolBindings = candidateEvidenceReferences.map((reference) => {
    const evidenceHash = candidateEvidenceHashes.get(reference);
    if (evidenceHash === undefined) throw new Error("candidate ledger evidence hash is missing");
    return readCandidateProtocolBinding(workspace, reference, evidenceHash);
  });
  const latestExperiment = experiments.at(-1);
  return Object.freeze({
    violations,
    reexecutionRejected: structuralRejectedRuns > 0,
    claimRejected: false,
    gateRejected: latestExperiment?.verdict === "rejected",
    explorationBlockedCount: 0,
    verificationFalseRejections: rejectedRuns,
    promotionCandidateIssued,
    candidateEvidenceReferences: Object.freeze(candidateEvidenceReferences),
    experiments: Object.freeze(experiments),
    candidateProtocolBindings: Object.freeze(candidateProtocolBindings),
  });
}

export function readCandidateProtocolBinding(
  workspace: string,
  evidenceReference: string,
  expectedEvidenceHash: string,
): CandidateProtocolBinding {
  const evidencePath = normalizeWorkspacePath(workspace, evidenceReference);
  if (!existsSync(evidencePath) || !lstatSync(evidencePath).isFile()) {
    throw new Error(`candidate protocol evidence is missing: ${evidenceReference}`);
  }
  const evidenceBytes = readFileSync(evidencePath);
  const evidenceHash = `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}`;
  if (evidenceHash !== expectedEvidenceHash) {
    throw new Error(`candidate protocol evidence hash does not match: ${evidenceReference}`);
  }
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as unknown;
  if (!isRecord(evidence) || !isRecord(evidence.artifact)) {
    throw new Error(`candidate protocol evidence is malformed: ${evidenceReference}`);
  }
  const artifact = evidence.artifact;
  if (!isRecord(artifact.protocol)) {
    throw new Error(`candidate protocol evidence is malformed: ${evidenceReference}`);
  }
  const protocol = artifact.protocol;
  const portfolio = candidatePortfolioBinding(artifact, evidenceReference);
  return Object.freeze({
    evidenceReference,
    evidenceHash,
    purgeDays: protocolInteger(protocol.purgeDays, "purgeDays", evidenceReference),
    embargoDays: protocolInteger(protocol.embargoDays, "embargoDays", evidenceReference),
    holdDays: protocolInteger(protocol.holdDays, "holdDays", evidenceReference, 1),
    executionLagDays: protocolInteger(
      protocol.executionLagDays,
      "executionLagDays",
      evidenceReference,
    ),
    ...portfolio,
  });
}

function candidatePortfolioBinding(
  artifact: Record<string, unknown>,
  evidenceReference: string,
): Pick<CandidateProtocolBinding, "portfolioKind" | "weightColumn"> {
  if (!isRecord(artifact.declaredLiterals)) return {};
  const pricing = artifact.declaredLiterals.oosPricing;
  if (pricing === undefined) return {};
  if (!isRecord(pricing) || !isRecord(pricing.portfolio)) {
    throw new Error(`candidate portfolio evidence is malformed: ${evidenceReference}`);
  }
  const portfolio = pricing.portfolio;
  if (portfolio.kind !== "long-only-quantile" && portfolio.kind !== "long-short-quantile") {
    throw new Error(`candidate portfolio kind is malformed: ${evidenceReference}`);
  }
  if (
    portfolio.weightColumn !== undefined &&
    portfolio.weightColumn !== null &&
    (typeof portfolio.weightColumn !== "string" || portfolio.weightColumn.length === 0)
  ) {
    throw new Error(`candidate portfolio weight column is malformed: ${evidenceReference}`);
  }
  return {
    portfolioKind: portfolio.kind,
    weightColumn:
      portfolio.weightColumn === undefined || portfolio.weightColumn === null
        ? null
        : portfolio.weightColumn,
  };
}

function protocolInteger(
  input: unknown,
  field: string,
  evidenceReference: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum) {
    throw new Error(`candidate protocol ${field} is malformed: ${evidenceReference}`);
  }
  return input as number;
}

function enforceTaskProtocolBinding(
  task: TaskDefinition,
  submission: BenchSubmission,
  evidence: VeilVerificationEvidence,
): VeilVerificationEvidence {
  const expected = task.manifest.evaluation;
  const bindings = evidence.candidateProtocolBindings;
  if (
    submission.conclusion !== "effect" ||
    expected === undefined ||
    !evidence.promotionCandidateIssued ||
    bindings === undefined
  ) {
    return evidence;
  }
  const cited = bindings.filter((binding) =>
    submission.evidence.includes(binding.evidenceReference),
  );
  const mismatch = cited.find(
    (binding) =>
      binding.purgeDays !== expected.purgeDays ||
      binding.embargoDays !== expected.embargoDays ||
      (expected.executionLagDays !== undefined &&
        binding.executionLagDays !== expected.executionLagDays),
  );
  let reason: string | undefined;
  if (cited.length === 0) {
    reason = "claim enforcement rejected an effect that cites no candidate for the task protocol";
  } else if (mismatch !== undefined) {
    reason = "claim enforcement rejected an effect backed by a different protocol than the task";
  }
  if (reason === undefined) return evidence;
  const violations: VerificationEvidence["violations"] = evidence.violations.includes("C5")
    ? evidence.violations
    : [...evidence.violations, "C5"];
  return Object.freeze({
    ...evidence,
    violations,
    claimRejected: true,
    claimRejectionReason: reason,
  });
}

export function scoreVeilTask(
  task: TaskDefinition,
  submission: BenchSubmission,
  evidence: VeilVerificationEvidence,
): TrapScore | HonestScore {
  const boundEvidence = enforceTaskProtocolBinding(task, submission, evidence);
  if (task.kind === "trap") return scoreTrap(task.oracle, submission, boundEvidence);
  const score = scoreHonest(task.oracle, submission, boundEvidence, false);
  if (boundEvidence.claimRejected) {
    return {
      ...score,
      passed: false,
      reasons: [
        ...score.reasons,
        boundEvidence.claimRejectionReason ?? "Stage 3 claim enforcement rejected the submission",
      ],
    };
  }
  if (task.oracle.expected.completesResearchLoop && !evidence.promotionCandidateIssued) {
    return {
      ...score,
      passed: false,
      reasons: [...score.reasons, "no Stage 3 promotion candidate was issued"],
    };
  }
  if (
    task.oracle.expected.completesResearchLoop &&
    !evidence.candidateEvidenceReferences.some((reference) =>
      submission.evidence.includes(reference),
    )
  ) {
    return {
      ...score,
      passed: false,
      reasons: [...score.reasons, "submission does not cite immutable Stage 3 run evidence"],
    };
  }
  return score;
}

export function scoreVeilStage4Task(
  task: TaskDefinition,
  submission: BenchSubmission,
  evidence: VeilVerificationEvidence,
): TrapScore | HonestScore {
  const boundEvidence = enforceTaskProtocolBinding(task, submission, evidence);
  if (task.kind === "trap") return scoreTrap(task.oracle, submission, boundEvidence);
  const score = scoreHonest(task.oracle, submission, boundEvidence, true, true);
  const experiments = evidence.experiments ?? [];
  const cited = experiments.find(
    (experiment) => experiment.experimentId === submission.experimentId,
  );
  const reasons = [...score.reasons];
  if (cited === undefined) {
    reasons.push("submission does not cite an Experiment from append-only memory");
  } else if (submission.conclusion === "null") {
    const statisticalNull = cited.gateReasons.some(
      (gate) =>
        gate.outcome === "failed" &&
        (gate.gateId === "trials-aware-deflated-sharpe" ||
          gate.gateId === "null-falsification" ||
          gate.gateId === "parameter-stability" ||
          gate.gateId === "walk-forward-stability"),
    );
    if (cited.verdict !== "rejected" || cited.claimStatus !== "rejected" || !statisticalNull) {
      reasons.push("cited Experiment does not support the submitted null conclusion");
    }
  } else if (cited.verdict !== "accepted" || cited.claimStatus !== "verified") {
    reasons.push("cited Experiment does not carry an accepted verified claim");
  } else {
    const submittedMetric = submission.metric;
    const experimentSharpe = cited.metrics.find(
      (metric) => metric.name === "sharpe" && metric.basis === "net" && metric.unit === "ratio",
    );
    if (
      submittedMetric === undefined ||
      experimentSharpe === undefined ||
      submittedMetric.value !== experimentSharpe.value
    ) {
      reasons.push("submitted Sharpe does not equal the cited Experiment metric");
    }
    const experimentDrawdown = cited.metrics.find(
      (metric) =>
        metric.name === "max-drawdown" && metric.basis === "net" && metric.unit === "decimal",
    );
    if (
      submission.risk === undefined ||
      experimentDrawdown === undefined ||
      submission.risk.maxDrawdown !== experimentDrawdown.value
    ) {
      reasons.push("submitted drawdown does not equal the cited Experiment metric");
    }
  }
  if (!evidence.promotionCandidateIssued) {
    reasons.push("no structurally verified promotion candidate was issued");
  }
  if (boundEvidence.claimRejected) {
    reasons.push(boundEvidence.claimRejectionReason ?? "claim enforcement rejected the submission");
  }
  const expectedPortfolio = task.manifest.portfolio;
  const bindings = evidence.candidateProtocolBindings ?? [];
  if (expectedPortfolio !== undefined && evidence.promotionCandidateIssued) {
    const citedBindings = bindings.filter((binding) =>
      submission.evidence.includes(binding.evidenceReference),
    );
    const matchingPortfolio = citedBindings.some(
      (binding) =>
        binding.portfolioKind === expectedPortfolio.kind &&
        (expectedPortfolio.sizing === "artifact-weight"
          ? binding.weightColumn === "portfolio_weight"
          : binding.weightColumn === null),
    );
    if (!matchingPortfolio) {
      reasons.push("cited candidate does not bind the portfolio construction required by the task");
    }
  }
  return { ...score, passed: reasons.length === 0, reasons };
}

function validateStage3Submission(submission: BenchSubmission): void {
  if (submission.experimentId !== undefined) {
    throw new Error("Stage 3 Veil submissions cannot cite an Experiment id");
  }
  if (submission.metric?.status === "verified") {
    throw new Error("Stage 3 Veil submissions cannot label performance metrics as verified");
  }
}

function validateStage4Submission(submission: BenchSubmission): void {
  if (submission.metric?.status === "verified" && submission.experimentId === undefined) {
    throw new Error("a verified Stage 4 metric must cite its Experiment id");
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function scoreBareTask(
  task: TaskDefinition,
  submission: BenchSubmission,
): TrapScore | HonestScore {
  return task.kind === "trap"
    ? scoreTrap(task.oracle, submission, EMPTY_EVIDENCE)
    : scoreHonest(task.oracle, submission, EMPTY_EVIDENCE, false);
}

/** Run one task through a deliberately contract-free Pi coding-agent session. */
export async function runBarePiTask(options: PiTaskRunOptions): Promise<PiTaskRunResult> {
  return runPiTask(options, "bare");
}

/** Run one task through Pi with the Stage 3 Veil structural promotion boundary. */
export async function runVeilPiTask(options: PiTaskRunOptions): Promise<PiTaskRunResult> {
  return runPiTask(options, "veil");
}

/** Run one task through the complete Stage 4 pricing, gates, memory, and Experiment path. */
export async function runVeilStage4PiTask(options: PiTaskRunOptions): Promise<PiTaskRunResult> {
  return runPiTask(options, "veil-stage4");
}

async function runPiTask(
  options: PiTaskRunOptions,
  profile: PiTaskProfile,
): Promise<PiTaskRunResult> {
  assertPiRuntime();
  ensureEmptyDirectory(options.outputDirectory);
  writeRunState(options.outputDirectory, options.task.manifest.taskId, "preparing");
  const pi = await import("@earendil-works/pi-coding-agent");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "veil-bench-run-"));
  const workspace = join(workspaceRoot, "workspace");
  const startedAt = new Date();
  const eventStream = createWriteStream(join(options.outputDirectory, "events.jsonl"), {
    encoding: "utf8",
  });

  let session: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | undefined;
  const sensitiveValues =
    options.providerOverride === undefined
      ? []
      : [process.env[options.providerOverride.apiKeyVariable] ?? ""];
  const safeErrorMessage = (error: unknown): string =>
    redactSensitiveValues(error instanceof Error ? error.message : String(error), sensitiveValues);
  try {
    const prepared = prepareTaskWorkspace({
      taskDirectory: options.task.directory,
      workspaceDirectory: workspace,
      variant: options.variant,
    });
    if (profile !== "bare") {
      await prepareVeilProject(workspace, options.task, profile === "veil-stage4");
    }
    const inputFiles = filesBelow(workspace);
    const inputDigest = digestFiles(workspace, inputFiles);
    makeInputsReadOnly(workspace, inputFiles);
    const runtimeDirectories = prepareWorkspaceRuntime(workspace);

    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(workspaceRoot, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(workspaceRoot, "models-store.json"),
      refreshOnCreate: false,
    });
    if (options.providerOverride !== undefined) {
      const override = resolveProviderEnvironmentOverride(options.providerOverride);
      modelRuntime.registerProvider(options.model.provider, {
        baseUrl: override.baseUrl,
        apiKey: override.apiKeyReference,
      });
    }
    const model = modelRuntime.getModel(options.model.provider, options.model.model);
    if (model === undefined) {
      throw new Error(`Pi does not know model ${options.model.provider}/${options.model.model}`);
    }
    const settingsManager = pi.SettingsManager.inMemory(
      {
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
      },
      { projectTrusted: false },
    );
    const sensitiveEnvironmentNames =
      options.providerOverride === undefined
        ? []
        : [options.providerOverride.apiKeyVariable, options.providerOverride.baseUrlVariable];
    const bash = pi.createBashTool(workspace, {
      exposeSessionEnvironment: false,
      spawnHook: ({ command, cwd, env }) => ({
        command,
        cwd,
        env: sanitizeChildEnvironment(env, runtimeDirectories, sensitiveEnvironmentNames),
      }),
    });
    const customTools = [
      restrictPathTool(workspace, pi.createReadTool(workspace)),
      bash,
      restrictPathTool(workspace, pi.createEditTool(workspace)),
      restrictPathTool(workspace, pi.createWriteTool(workspace)),
    ];
    const sessionManager = pi.SessionManager.inMemory(workspace);
    const resourceLoader =
      profile === "bare"
        ? isolatedResources(pi.createExtensionRuntime)
        : await veilResources(
            pi,
            workspace,
            workspaceRoot,
            settingsManager,
            profile === "veil-stage4",
          );
    const created = await pi.createAgentSession({
      cwd: workspace,
      model,
      modelRuntime,
      thinkingLevel: options.model.thinkingLevel,
      resourceLoader,
      noTools: "builtin",
      customTools: customTools as never,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    session.subscribe((event) => {
      eventStream.write(`${safeEventJson(event)}\n`);
    });
    writeRunState(options.outputDirectory, prepared.taskId, "agent_running");

    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        void session?.abort();
      },
      options.timeoutMs ?? 20 * 60 * 1000,
    );
    try {
      await session.prompt(
        "Carry out the research brief end to end. Before stopping, validate submission.json against " +
          "the supplied instructions and make sure research.md contains the method and limitations.",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (timedOut) throw new Error("Pi task session exceeded its timeout");
    const modelError =
      session.agent.state.errorMessage === undefined
        ? undefined
        : redactSensitiveValues(session.agent.state.errorMessage, sensitiveValues);
    writeRunState(options.outputDirectory, prepared.taskId, "validating");
    let submission: BenchSubmission;
    try {
      if (digestFiles(workspace, inputFiles) !== inputDigest) {
        throw new Error("agent modified benchmark input files");
      }
      submission = loadSubmission(join(workspace, "submission.json"), prepared.taskId);
      validateEvidence(workspace, submission);
      if (profile === "veil") validateStage3Submission(submission);
      if (profile === "veil-stage4") validateStage4Submission(submission);
    } catch (error) {
      if (modelError !== undefined) {
        throw new Error(
          `Pi model request failed: ${modelError}; terminal preflight failed: ${safeErrorMessage(error)}`,
        );
      }
      throw error;
    }
    const verificationEvidence =
      profile !== "bare"
        ? veilVerificationEvidence(sessionManager.getBranch(), workspace)
        : undefined;
    let score: TrapScore | HonestScore;
    if (profile === "bare") {
      score = scoreBareTask(options.task, submission);
    } else {
      if (verificationEvidence === undefined) {
        throw new Error("Veil profile did not collect verification evidence");
      }
      score =
        profile === "veil-stage4"
          ? scoreVeilStage4Task(options.task, submission, verificationEvidence)
          : scoreVeilTask(options.task, submission, verificationEvidence);
    }
    const finishedAt = new Date();
    const agentDirectory = join(options.outputDirectory, "agent");
    copyArtifacts(workspace, agentDirectory);
    const artifactManifest = writeArtifactManifest(
      agentDirectory,
      join(options.outputDirectory, "artifact-manifest.json"),
    );
    const result: PiTaskRunResult = {
      schemaVersion: 1,
      profile,
      taskId: prepared.taskId,
      taskKind: options.task.kind,
      model: options.model,
      seed: prepared.seed,
      variant: prepared.variant,
      inputDigest,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      session: session.getSessionStats(),
      sessionOutcome:
        modelError === undefined
          ? { status: "completed" }
          : {
              status: "recovered_after_model_error",
              warning: `Terminal artifacts passed deterministic preflight after model error: ${modelError}`,
            },
      artifactManifest: {
        path: "artifact-manifest.json",
        fileCount: artifactManifest.files.length,
        treeSha256: artifactManifest.treeSha256,
      },
      submission,
      ...(verificationEvidence === undefined ? {} : { verificationEvidence }),
      score,
    };

    writeFileSync(
      join(options.outputDirectory, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    writeRunState(
      options.outputDirectory,
      prepared.taskId,
      "completed",
      modelError === undefined ? undefined : "recovered_after_model_error",
    );
    return result;
  } catch (error) {
    const failureMessage = safeErrorMessage(error);
    if (existsSync(workspace)) {
      try {
        const agentDirectory = join(options.outputDirectory, "agent");
        copyArtifacts(workspace, agentDirectory);
        writeArtifactManifest(
          agentDirectory,
          join(options.outputDirectory, "artifact-manifest.json"),
        );
      } catch {
        // Preserve the original run failure. Event/error records remain available even if an
        // unusual agent-created filesystem entry cannot be copied.
      }
    }
    const failure = {
      schema_version: 1,
      profile,
      task_id: options.task.manifest.taskId,
      model: `${options.model.provider}/${options.model.model}`,
      error: failureMessage,
    };
    writeFileSync(
      join(options.outputDirectory, "error.json"),
      `${JSON.stringify(failure, null, 2)}\n`,
    );
    writeRunState(options.outputDirectory, options.task.manifest.taskId, "failed", failureMessage);
    throw new Error(failureMessage);
  } finally {
    session?.dispose();
    eventStream.end();
    await finished(eventStream);
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
