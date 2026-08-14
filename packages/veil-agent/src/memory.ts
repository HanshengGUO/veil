import { createHash } from "node:crypto";
import type { TrialCountEvidence } from "@veilquant/engine";
import {
  VEIL_AGENT_TOOL_RESULT_FORMAT,
  VEIL_HYPOTHESIS_ENTRY,
  VEIL_MEMORY_TOOL,
} from "./constants.ts";
import { VeilAgentError } from "./errors.ts";
import {
  createHypothesisEntry,
  type HypothesisEntryData,
  latestHypothesis,
  type RunCandidateSummary,
  reconstructSessionLedger,
} from "./ledger.ts";

export type VeilMemoryAction =
  | "status"
  | "register_hypothesis"
  | "list_runs"
  | "get_run"
  | "list_experiments"
  | "get_experiment"
  | "family"
  | "trial_evidence";

export interface VeilMemoryToolInput {
  readonly action: VeilMemoryAction;
  readonly hypothesis_ref?: string;
  readonly statement?: string;
  readonly idea_available_at?: string;
  readonly run_id?: string;
  readonly experiment_id?: string;
}

export interface VeilMemoryToolResult {
  readonly format: typeof VEIL_AGENT_TOOL_RESULT_FORMAT;
  readonly tool: typeof VEIL_MEMORY_TOOL;
  readonly ok: true;
  readonly action: VeilMemoryAction;
  readonly result: unknown;
}

/** Compact, bounded retrieval injected before the next turn for the active hypothesis family. */
export function experimentMemoryContext(entries: readonly unknown[]): string | null {
  const ledger = reconstructSessionLedger(entries);
  const hypothesisRef = ledger.hypotheses.at(-1)?.data.hypothesisRef;
  if (hypothesisRef === undefined) return null;
  const experiments = ledger.experiments
    .filter((entry) => entry.data.hypothesisRef === hypothesisRef)
    .slice(-5);
  if (experiments.length === 0) return null;
  const lines = experiments.map((entry) => {
    const failed = entry.data.gateReasons
      .filter((gate) => gate.outcome !== "passed")
      .map((gate) => `${gate.gateId}:${gate.reasonCode}`)
      .join(",");
    return `- ${entry.data.experimentId} ${entry.data.verdict}; gates=${failed || "all-passed"}; lessons=${entry.data.lessons.join(" | ") || "none"}`;
  });
  return (
    `Veil Experiment memory for hypothesis ${hypothesisRef} (latest ${experiments.length}):\n` +
    `${lines.join("\n")}\n` +
    "Count these family Experiments in trial_evidence and address prior gate reasons before another claim."
  );
}

export function trialCountEvidence(
  entries: readonly unknown[],
  hypothesisRef: string,
): TrialCountEvidence {
  return trialEvidence(reconstructSessionLedger(entries), hypothesisRef);
}

export function executeVeilMemoryTool(
  input: VeilMemoryToolInput,
  context: {
    readonly getBranch: () => readonly unknown[];
    readonly appendEntry: (
      customType: typeof VEIL_HYPOTHESIS_ENTRY,
      data: HypothesisEntryData,
    ) => void;
    readonly now?: () => Date;
  },
): VeilMemoryToolResult {
  validateMemoryInput(input);
  switch (input.action) {
    case "status":
      return result(input.action, sessionStatus(reconstructSessionLedger(context.getBranch())));
    case "register_hypothesis":
      return result(input.action, registerHypothesis(input, context));
    case "list_runs":
      return result(input.action, runList(reconstructSessionLedger(context.getBranch())));
    case "get_run":
      return result(
        input.action,
        getRun(reconstructSessionLedger(context.getBranch()), required(input.run_id, "run_id")),
      );
    case "list_experiments":
      return result(input.action, experimentList(reconstructSessionLedger(context.getBranch())));
    case "get_experiment":
      return result(
        input.action,
        getExperiment(
          reconstructSessionLedger(context.getBranch()),
          required(input.experiment_id, "experiment_id"),
        ),
      );
    case "family":
      return result(
        input.action,
        researchFamily(reconstructSessionLedger(context.getBranch()), input.hypothesis_ref),
      );
    case "trial_evidence":
      return result(
        input.action,
        trialEvidence(
          reconstructSessionLedger(context.getBranch()),
          required(input.hypothesis_ref, "hypothesis_ref"),
        ),
      );
  }
}

function validateMemoryInput(input: VeilMemoryToolInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidMemory("veil-memory input must be an object");
  }
  const allowedByAction: Record<VeilMemoryAction, ReadonlySet<string>> = {
    status: new Set(["action"]),
    register_hypothesis: new Set(["action", "hypothesis_ref", "statement", "idea_available_at"]),
    list_runs: new Set(["action"]),
    get_run: new Set(["action", "run_id"]),
    list_experiments: new Set(["action"]),
    get_experiment: new Set(["action", "experiment_id"]),
    family: new Set(["action", "hypothesis_ref"]),
    trial_evidence: new Set(["action", "hypothesis_ref"]),
  };
  const allowed = allowedByAction[input.action];
  if (allowed === undefined) throw invalidMemory("veil-memory action is unsupported");
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw invalidMemory("veil-memory input contains fields unused by the selected action");
  }
}

function registerHypothesis(
  input: VeilMemoryToolInput,
  context: {
    readonly getBranch: () => readonly unknown[];
    readonly appendEntry: (
      customType: typeof VEIL_HYPOTHESIS_ENTRY,
      data: HypothesisEntryData,
    ) => void;
    readonly now?: () => Date;
  },
): unknown {
  const current = reconstructSessionLedger(context.getBranch());
  const hypothesisRef = required(input.hypothesis_ref, "hypothesis_ref");
  const statement = required(input.statement, "statement");
  const existing = latestHypothesis(current, hypothesisRef);
  if (existing !== null) {
    if (existing.data.statement !== statement.trim()) {
      throw new VeilAgentError(
        "DUPLICATE_HYPOTHESIS_REF",
        "hypothesis_ref already names a different statement on this session branch",
        "Choose a new hypothesis_ref for a materially changed idea.",
      );
    }
    return Object.freeze({
      hypothesisRef: existing.data.hypothesisRef,
      statement: existing.data.statement,
      registeredAt: existing.timestamp,
      captureMode: existing.data.captureMode,
      created: false,
    });
  }
  const now = (context.now ?? (() => new Date()))();
  const ideaAvailableAt = input.idea_available_at ?? now.toISOString();
  const ideaAvailableMilliseconds = Date.parse(ideaAvailableAt);
  if (!Number.isFinite(ideaAvailableMilliseconds) || ideaAvailableMilliseconds > now.getTime()) {
    throw invalidMemory("idea_available_at must be a valid time no later than registration");
  }
  const entry = createHypothesisEntry({
    hypothesisRef,
    statement,
    ideaAvailableAt,
    captureMode: "explicit",
  });
  context.appendEntry(VEIL_HYPOTHESIS_ENTRY, entry);
  const durable = latestHypothesis(
    reconstructSessionLedger(context.getBranch()),
    entry.hypothesisRef,
  );
  if (durable === null) {
    throw new VeilAgentError(
      "SESSION_WRITE_FAILED",
      "hypothesis entry was not visible on the active session branch",
      "Retry in a persistent Pi session before starting verification.",
    );
  }
  return Object.freeze({
    hypothesisRef: durable.data.hypothesisRef,
    statement: durable.data.statement,
    registeredAt: durable.timestamp,
    captureMode: durable.data.captureMode,
    created: true,
  });
}

function sessionStatus(ledger: ReturnType<typeof reconstructSessionLedger>): unknown {
  const brief = ledger.briefs.at(-1);
  const hypothesis = ledger.hypotheses.at(-1);
  return Object.freeze({
    scope: "active-session-branch",
    brief:
      brief === undefined
        ? null
        : Object.freeze({
            briefRef: brief.data.briefRef,
            statement: brief.data.statement,
            registeredAt: brief.timestamp,
            captureMode: brief.data.captureMode,
          }),
    currentHypothesis:
      hypothesis === undefined
        ? null
        : Object.freeze({
            hypothesisRef: hypothesis.data.hypothesisRef,
            statement: hypothesis.data.statement,
            registeredAt: hypothesis.timestamp,
            captureMode: hypothesis.data.captureMode,
          }),
    counts: Object.freeze({
      hypotheses: ledger.hypotheses.length,
      dataReads: ledger.dataReads.length,
      verificationStarts: ledger.verificationStarts.length,
      completedRuns: ledger.runResults.length,
      violations: ledger.violations.length,
      advisories: ledger.advisories.length,
    }),
    experimentCount: ledger.experiments.length,
    note:
      ledger.experiments.length === 0
        ? "No Stage 4 Experiment has been recorded on this branch."
        : "Stage 4 Experiments are append-only; retrieve them before planning another family trial.",
  });
}

function experimentList(ledger: ReturnType<typeof reconstructSessionLedger>): unknown {
  return Object.freeze(
    ledger.experiments.slice(-20).map((entry) =>
      Object.freeze({
        experimentId: entry.data.experimentId,
        timestamp: entry.timestamp,
        hypothesisRef: entry.data.hypothesisRef,
        verdict: entry.data.verdict,
        claimStatus: entry.data.claimStatus,
        gateReasons: entry.data.gateReasons,
      }),
    ),
  );
}

function getExperiment(
  ledger: ReturnType<typeof reconstructSessionLedger>,
  experimentId: string,
): unknown {
  const entry = ledger.experiments.find(
    (candidate) => candidate.data.experimentId === experimentId,
  );
  if (entry === undefined) {
    throw new VeilAgentError(
      "EXPERIMENT_NOT_FOUND",
      "Experiment is absent from the active session branch",
      "Use veil-memory list_experiments or inspect the appropriate Pi fork.",
    );
  }
  return Object.freeze({ timestamp: entry.timestamp, ...entry.data });
}

function researchFamily(
  ledger: ReturnType<typeof reconstructSessionLedger>,
  hypothesisRefInput?: string,
): unknown {
  const hypothesisRef = hypothesisRefInput?.trim() || ledger.hypotheses.at(-1)?.data.hypothesisRef;
  if (hypothesisRef === undefined) {
    throw invalidMemory("family requires a hypothesis_ref when the branch has no hypothesis");
  }
  const starts = ledger.verificationStarts.filter(
    (entry) => entry.data.hypothesisRef === hypothesisRef,
  );
  const runIds = new Set(starts.map((entry) => entry.data.runId));
  return Object.freeze({
    scope: "active-session-fork-lineage",
    hypothesisRef,
    hypotheses: Object.freeze(
      ledger.hypotheses
        .filter((entry) => entry.data.hypothesisRef === hypothesisRef)
        .map((entry) => ({
          entryId: entry.id,
          timestamp: entry.timestamp,
          statement: entry.data.statement,
        })),
    ),
    runs: Object.freeze(
      ledger.runResults
        .filter((entry) => runIds.has(entry.data.runId))
        .map((entry) => ({
          runId: entry.data.runId,
          timestamp: entry.timestamp,
          outcome: entry.data.outcome,
        })),
    ),
    experiments: Object.freeze(
      ledger.experiments
        .filter((entry) => entry.data.hypothesisRef === hypothesisRef)
        .map((entry) => ({
          experimentId: entry.data.experimentId,
          timestamp: entry.timestamp,
          verdict: entry.data.verdict,
          lessons: entry.data.lessons,
        })),
    ),
  });
}

function trialEvidence(
  ledger: ReturnType<typeof reconstructSessionLedger>,
  hypothesisRef: string,
): TrialCountEvidence {
  const starts = ledger.verificationStarts
    .filter((entry) => entry.data.hypothesisRef === hypothesisRef)
    .sort((left, right) => compareText(left.data.runId, right.data.runId));
  const experiments = ledger.experiments
    .filter((entry) => entry.data.hypothesisRef === hypothesisRef)
    .sort((left, right) => compareText(left.data.experimentId, right.data.experimentId));
  return Object.freeze({
    sessionLedgerHash: contentHash(
      "veil.session-trial-ledger.v0",
      starts.map((entry) => ({
        entryId: entry.id,
        timestamp: entry.timestamp,
        runId: entry.data.runId,
      })),
    ),
    sessionAttemptIds: Object.freeze(starts.map((entry) => entry.data.runId)),
    memorySnapshotHash: contentHash(
      "veil.experiment-family-snapshot.v0",
      experiments.map((entry) => ({
        experimentId: entry.data.experimentId,
        memoryHash: entry.data.memoryHash,
      })),
    ),
    familyExperimentIds: Object.freeze(experiments.map((entry) => entry.data.experimentId)),
  });
}

function contentHash(domain: string, input: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update("\0").update(JSON.stringify(input)).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runList(ledger: ReturnType<typeof reconstructSessionLedger>): unknown {
  return Object.freeze(
    ledger.runResults.slice(-20).map((entry) =>
      Object.freeze({
        researchRunId: entry.data.runId,
        timestamp: entry.timestamp,
        outcome: entry.data.outcome,
        candidate: entry.data.candidate,
        failureCode: entry.data.failureCode,
      }),
    ),
  );
}

function getRun(
  ledger: ReturnType<typeof reconstructSessionLedger>,
  runId: string,
): {
  readonly researchRunId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly hypothesisRef: string;
  readonly requestReference: string;
  readonly outcome: "candidate" | "rejected";
  readonly candidate: RunCandidateSummary | null;
  readonly failureCode: string | null;
  readonly evidenceReference: string | null;
  readonly researchLogReference: string;
} {
  const resultEntry = ledger.runResults.find((entry) => entry.data.runId === runId);
  const startEntry = ledger.verificationStarts.find((entry) => entry.data.runId === runId);
  if (resultEntry === undefined || startEntry === undefined) {
    throw new VeilAgentError(
      "RUN_NOT_FOUND",
      "research run is absent or incomplete on the active session branch",
      "Use veil-memory list_runs and select a completed researchRunId from this branch.",
    );
  }
  return Object.freeze({
    researchRunId: runId,
    startedAt: startEntry.timestamp,
    completedAt: resultEntry.timestamp,
    hypothesisRef: startEntry.data.hypothesisRef,
    requestReference: startEntry.data.requestReference,
    outcome: resultEntry.data.outcome,
    candidate: resultEntry.data.candidate,
    failureCode: resultEntry.data.failureCode,
    evidenceReference: resultEntry.data.evidenceReference,
    researchLogReference: resultEntry.data.researchLogReference,
  });
}

function result(action: VeilMemoryAction, value: unknown): VeilMemoryToolResult {
  return Object.freeze({
    format: VEIL_AGENT_TOOL_RESULT_FORMAT,
    tool: VEIL_MEMORY_TOOL,
    ok: true,
    action,
    result: value,
  });
}

function required(input: string | undefined, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new VeilAgentError(
      "INVALID_MEMORY_REQUEST",
      `${field} is required for this veil-memory action`,
      "Supply only the fields named by the selected memory action.",
    );
  }
  return input.trim();
}

function invalidMemory(message: string): VeilAgentError {
  return new VeilAgentError(
    "INVALID_MEMORY_REQUEST",
    message,
    "Supply only the fields named by the selected veil-memory action.",
  );
}
