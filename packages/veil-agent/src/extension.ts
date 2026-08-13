import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { ContractViolation, normalizeDecisionTime } from "@veilquant/contract";
import { Type } from "typebox";
import { detectExplorationAdvisory } from "./advisory.ts";
import {
  VEIL_ADVISORY_ENTRY,
  VEIL_AGENT_TOOL_RESULT_FORMAT,
  VEIL_BACKTEST_TOOL,
  VEIL_BRIEF_ENTRY,
  VEIL_DATA_TOOL,
  VEIL_HYPOTHESIS_ENTRY,
  VEIL_MEMORY_TOOL,
  VEIL_VIOLATION_ENTRY,
} from "./constants.ts";
import { executeVeilDataTool } from "./data.ts";
import { describeVeilError, type PublicVeilError, VeilAgentError } from "./errors.ts";
import {
  type AdvisoryEntryData,
  type BriefEntryData,
  createBriefEntry,
  createHypothesisEntry,
  type HypothesisEntryData,
  reconstructSessionLedger,
  type ViolationEntryData,
} from "./ledger.ts";
import { executeVeilMemoryTool } from "./memory.ts";
import { loadVeilProject, projectReference, type VeilProjectLoader } from "./project.ts";
import { executeVeilBacktestTool } from "./promotion.ts";

const DATA_PARAMETERS = Type.Object(
  {
    dataset: Type.String({ description: "Dataset id from .veil/project.yaml" }),
    mode: Type.Union([Type.Literal("point"), Type.Literal("panel")], {
      description: "point is guarded; panel is explicitly exploration-grade",
    }),
    as_of: Type.String({ description: "Required ISO-8601 decision time; never defaults to now" }),
    columns: Type.Optional(
      Type.Array(Type.String(), { minItems: 1, description: "Optional projected columns" }),
    ),
    output: Type.Union([Type.Literal("summary"), Type.Literal("arrow")], {
      description: "arrow explicitly writes a project-relative guarded view",
    }),
  },
  { additionalProperties: false },
);

const BACKTEST_PARAMETERS = Type.Object(
  {
    request: Type.String({
      description: "Project-relative veil.promotion-request.v0 YAML file",
    }),
  },
  { additionalProperties: false },
);

const MEMORY_PARAMETERS = Type.Object(
  {
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("register_hypothesis"),
      Type.Literal("list_runs"),
      Type.Literal("get_run"),
    ]),
    hypothesis_ref: Type.Optional(Type.String()),
    statement: Type.Optional(Type.String()),
    idea_available_at: Type.Optional(Type.String()),
    run_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const VEIL_TURN_INSTRUCTIONS = `Veil keeps exploration free and enforces claims at promotion.
- Use veil-data with an explicit as_of for guarded reads; panel exports remain exploration-grade.
- Treat numbers produced by ordinary shell or code exploration as unverified.
- Use veil-backtest for promotion. A Stage 3 success is a contract-verified, unverified candidate,
  not an Experiment; pricing, costs, and statistical gates remain required.`;

export interface VeilExtensionOptions {
  readonly projectLoader?: VeilProjectLoader;
  readonly now?: () => Date;
}

export function createVeilExtension(options: VeilExtensionOptions = {}): ExtensionFactory {
  const projectLoader = options.projectLoader ?? loadVeilProject;
  const now = options.now ?? (() => new Date());
  return (pi: ExtensionAPI): void => registerVeilExtension(pi, projectLoader, now);
}

export default function veilExtension(pi: ExtensionAPI): void {
  registerVeilExtension(pi, loadVeilProject, () => new Date());
}

function registerVeilExtension(
  pi: ExtensionAPI,
  projectLoader: VeilProjectLoader,
  now: () => Date,
): void {
  pi.registerTool({
    name: VEIL_DATA_TOOL,
    label: "Veil Data",
    description:
      "Read a registered dataset through Veil's mandatory point-in-time guard. as_of is required. " +
      "Panel exports are exploration-grade and never count as promotion evidence by themselves.",
    promptSnippet: "Read point-in-time data with an explicit decision time",
    promptGuidelines: [
      "Use veil-data instead of inventing point-in-time filtering when a project dataset is registered.",
      "Request output=arrow only when a durable local exploration view is needed.",
    ],
    parameters: DATA_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        const project = await projectLoader(ctx.cwd);
        const details = await executeVeilDataTool(params, {
          project,
          appendEntry: (type, data) => pi.appendEntry(type, data),
        });
        return toolResult(details);
      } catch (error) {
        const failure = toolFailure(VEIL_DATA_TOOL, error);
        appendViolation(pi, "data", VEIL_DATA_TOOL, failure);
        return toolResult(failure);
      } finally {
        updateVeilStatus(ctx);
      }
    },
  });

  pi.registerTool({
    name: VEIL_BACKTEST_TOOL,
    label: "Veil Backtest",
    description:
      "The only promotion entry point. It captures an artifact, performs fresh walk-forward " +
      "C1-C4 execution, applies C6 chronology, and returns an unverified promotion candidate.",
    promptSnippet: "Promote an artifact through structural walk-forward verification",
    promptGuidelines: [
      "Do not describe a veil-backtest success as an Experiment or verified performance result.",
      "Fix a structured rejection; never replace the promotion result with an exploratory metric.",
    ],
    parameters: BACKTEST_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        const project = await projectLoader(ctx.cwd);
        const details = await executeVeilBacktestTool(params, {
          project,
          getBranch: () => ctx.sessionManager.getBranch(),
          appendEntry: (type, data) => pi.appendEntry(type, data),
          signal,
        });
        return toolResult(details);
      } catch (error) {
        const failure = toolFailure(VEIL_BACKTEST_TOOL, error);
        appendViolation(pi, "promotion", VEIL_BACKTEST_TOOL, failure);
        return toolResult(failure);
      } finally {
        updateVeilStatus(ctx);
      }
    },
  });

  pi.registerTool({
    name: VEIL_MEMORY_TOOL,
    label: "Veil Memory",
    description:
      "Register a hypothesis or inspect the active branch's append-only research-run ledger. " +
      "Stage 3 stores no Experiment verdicts and performs no automatic memory injection.",
    promptSnippet: "Register hypotheses and inspect Veil research-run state",
    parameters: MEMORY_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        const details = executeVeilMemoryTool(params, {
          getBranch: () => ctx.sessionManager.getBranch(),
          appendEntry: (type, data) => pi.appendEntry(type, data),
          now,
        });
        return toolResult(details);
      } catch (error) {
        const failure = toolFailure(VEIL_MEMORY_TOOL, error);
        appendViolation(pi, "ledger", VEIL_MEMORY_TOOL, failure);
        return toolResult(failure);
      } finally {
        updateVeilStatus(ctx);
      }
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    try {
      const ledger = reconstructSessionLedger(ctx.sessionManager.getBranch());
      const capturedAt = now().toISOString();
      if (ledger.briefs.length === 0) {
        const brief = createBriefEntry(event.prompt, "automatic");
        pi.appendEntry(VEIL_BRIEF_ENTRY, brief);
      }
      if (ledger.hypotheses.length === 0) {
        const hypothesis = createHypothesisEntry({
          statement: event.prompt,
          ideaAvailableAt: capturedAt,
          captureMode: "automatic",
        });
        pi.appendEntry(VEIL_HYPOTHESIS_ENTRY, hypothesis);
      }
      updateVeilStatus(ctx);
      return { systemPrompt: `${event.systemPrompt}\n\n${VEIL_TURN_INSTRUCTIONS}` };
    } catch (error) {
      const failure = describeVeilError(error);
      return {
        systemPrompt:
          `${event.systemPrompt}\n\n${VEIL_TURN_INSTRUCTIONS}\n` +
          `Veil ledger warning: ${failure.code}. Preregistration cannot be trusted; promotion must ` +
          "either reject the damaged ledger or remain explicitly exploratory.",
      };
    }
  });

  pi.on("session_start", (_event, ctx) => {
    updateVeilStatus(ctx);
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === VEIL_DATA_TOOL) {
      try {
        const asOf = event.input.as_of;
        if (typeof asOf !== "string" || asOf.trim().length === 0) {
          throw new ContractViolation("C1", "veil-data requires an explicit as_of decision time", {
            remedy: "Pass as_of as an ISO-8601 date or timestamp; Veil never defaults it to now.",
          });
        }
        event.input.as_of = normalizeDecisionTime(asOf);
      } catch (error) {
        const failure = describeVeilError(error);
        appendViolation(pi, "tool-call", VEIL_DATA_TOOL, failure);
        return { block: true, reason: `${failure.message} Remedy: ${failure.remedy}` };
      }
    }
    if (event.toolName === VEIL_BACKTEST_TOOL) {
      try {
        event.input.request = projectReference(event.input.request);
      } catch (error) {
        const failure = describeVeilError(error);
        appendViolation(pi, "tool-call", VEIL_BACKTEST_TOOL, failure);
        return { block: true, reason: `${failure.message} Remedy: ${failure.remedy}` };
      }
    }
  });

  pi.on("tool_result", (event) => toolResultInterception(pi, event));

  registerCommands(pi, now);
}

function registerCommands(pi: ExtensionAPI, now: () => Date): void {
  pi.registerCommand("veil-brief", {
    description: "Record a research brief on the active session branch",
    handler: async (args, ctx) => {
      const statement =
        args.trim().length > 0
          ? args.trim()
          : ctx.hasUI
            ? await ctx.ui.editor(
                "Veil research brief",
                "Question:\nUniverse:\nHorizon:\nConstraints:",
              )
            : undefined;
      if (statement === undefined || statement.trim().length === 0) {
        ctx.ui.notify("Pass the brief after /veil-brief or use interactive mode.", "warning");
        return;
      }
      const entry: BriefEntryData = createBriefEntry(statement, "explicit");
      pi.appendEntry(VEIL_BRIEF_ENTRY, entry);
      updateVeilStatus(ctx);
      ctx.ui.notify(`Recorded brief ${entry.briefRef}.`, "info");
    },
  });

  pi.registerCommand("veil-hypothesis", {
    description: "Strictly register: /veil-hypothesis <reference> :: <statement>",
    handler: async (args, ctx) => {
      const separator = args.indexOf("::");
      if (separator < 1 || args.slice(separator + 2).trim().length === 0) {
        ctx.ui.notify(
          "Use /veil-hypothesis <reference> :: <specific falsifiable statement>.",
          "warning",
        );
        return;
      }
      try {
        const details = executeVeilMemoryTool(
          {
            action: "register_hypothesis",
            hypothesis_ref: args.slice(0, separator).trim(),
            statement: args.slice(separator + 2).trim(),
            idea_available_at: now().toISOString(),
          },
          {
            getBranch: () => ctx.sessionManager.getBranch(),
            appendEntry: (type: typeof VEIL_HYPOTHESIS_ENTRY, data: HypothesisEntryData) =>
              pi.appendEntry(type, data),
            now,
          },
        );
        updateVeilStatus(ctx);
        ctx.ui.notify(`Hypothesis registered: ${JSON.stringify(details.result)}`, "info");
      } catch (error) {
        const failure = describeVeilError(error);
        ctx.ui.notify(`${failure.code}: ${failure.message}`, "error");
      }
    },
  });

  pi.registerCommand("veil-promote", {
    description: "Ask the agent to promote a veil.promotion-request.v0 file",
    handler: async (args, ctx) => {
      const request = args.trim().length === 0 ? ".veil/promotion.yaml" : args.trim();
      try {
        const reference = projectReference(request);
        pi.sendUserMessage(
          `Promote the artifact described by ${reference} with veil-backtest. ` +
            "Report the structured result exactly. Do not call it an Experiment or claim verified performance.",
        );
      } catch (error) {
        const failure = describeVeilError(error);
        ctx.ui.notify(`${failure.code}: ${failure.message}`, "error");
      }
    },
  });

  pi.registerCommand("veil-reproduce", {
    description:
      "Structurally replay a Stage 3 research run (metric reproduction arrives in Stage 4)",
    handler: async (args, ctx) => {
      if (args.trim().length === 0) {
        ctx.ui.notify("Use /veil-reproduce <researchRunId>.", "warning");
        return;
      }
      pi.sendUserMessage(
        `Structurally reproduce research run ${args.trim()}. First use veil-memory get_run to recover ` +
          "its requestReference, then rerun that request with veil-backtest. Compare artifact, plan, " +
          "and contract hashes. Verify each candidate independently; candidate hashes normally differ " +
          "because each one binds its own verification-start entry. This is not metric-level Experiment reproduction.",
      );
    },
  });
}

function toolResultInterception(pi: ExtensionAPI, event: ToolResultEvent) {
  const details = event.details;
  const failed =
    typeof details === "object" &&
    details !== null &&
    "format" in details &&
    (details as { readonly format?: unknown }).format === VEIL_AGENT_TOOL_RESULT_FORMAT &&
    "ok" in details &&
    (details as { readonly ok?: unknown }).ok === false;
  if (
    event.toolName === VEIL_DATA_TOOL ||
    event.toolName === VEIL_BACKTEST_TOOL ||
    event.toolName === VEIL_MEMORY_TOOL
  ) {
    return failed ? { isError: true } : undefined;
  }
  const text = event.content
    .filter(
      (part): part is Extract<(typeof event.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  const advisory = detectExplorationAdvisory(text);
  if (advisory === null) return failed ? { isError: true } : undefined;
  const data: AdvisoryEntryData = Object.freeze({
    format: VEIL_ADVISORY_ENTRY,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    codes: advisory.codes,
  });
  pi.appendEntry(VEIL_ADVISORY_ENTRY, data);
  return {
    content: [...event.content, { type: "text" as const, text: advisory.text }],
    ...(failed ? { isError: true } : {}),
  };
}

function toolResult<T>(details: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function toolFailure(
  tool: string,
  error: unknown,
): PublicVeilError & {
  readonly format: typeof VEIL_AGENT_TOOL_RESULT_FORMAT;
  readonly tool: string;
} {
  return Object.freeze({
    ...describeVeilError(error),
    format: VEIL_AGENT_TOOL_RESULT_FORMAT,
    tool,
  });
}

function appendViolation(
  pi: ExtensionAPI,
  phase: ViolationEntryData["phase"],
  toolName: string,
  failure: PublicVeilError,
): void {
  const data: ViolationEntryData = Object.freeze({
    format: VEIL_VIOLATION_ENTRY,
    phase,
    code: diagnosticCode(failure.code),
    message: failure.message,
    remedy: failure.remedy,
    toolName,
    runId: null,
  });
  pi.appendEntry(VEIL_VIOLATION_ENTRY, data);
}

function diagnosticCode(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
  return normalized.length === 0 ? "UNKNOWN" : normalized;
}

function updateVeilStatus(context: {
  readonly sessionManager: { readonly getBranch: () => readonly unknown[] };
  readonly ui: { readonly setStatus: (key: string, text: string | undefined) => void };
}): void {
  try {
    const ledger = reconstructSessionLedger(context.sessionManager.getBranch());
    context.ui.setStatus(
      "veil",
      `Veil: ${ledger.hypotheses.length} hypotheses, ${ledger.runResults.length} runs`,
    );
  } catch {
    context.ui.setStatus("veil", "Veil: ledger needs attention");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new VeilAgentError(
      "OPERATION_ABORTED",
      "Veil operation was aborted",
      "Start a new tool call when you are ready to retry.",
    );
  }
}
