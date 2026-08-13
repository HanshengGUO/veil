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

export type VeilMemoryAction = "status" | "register_hypothesis" | "list_runs" | "get_run";

export interface VeilMemoryToolInput {
  readonly action: VeilMemoryAction;
  readonly hypothesis_ref?: string;
  readonly statement?: string;
  readonly idea_available_at?: string;
  readonly run_id?: string;
}

export interface VeilMemoryToolResult {
  readonly format: typeof VEIL_AGENT_TOOL_RESULT_FORMAT;
  readonly tool: typeof VEIL_MEMORY_TOOL;
  readonly ok: true;
  readonly action: VeilMemoryAction;
  readonly result: unknown;
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
    experimentCount: 0,
    note: "Stage 3 stores research runs and unverified candidates; it does not issue Experiments.",
  });
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
