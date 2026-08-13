import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ContractViolation, deriveDataSemantics } from "@veilquant/contract";
import { loadAdapterFile } from "@veilquant/engine";
import {
  assertPromotionDataSemantics,
  createVeilExtension,
  VEIL_ADVISORY_ENTRY,
  VEIL_BACKTEST_TOOL,
  VEIL_BRIEF_ENTRY,
  VEIL_DATA_TOOL,
  VEIL_HYPOTHESIS_ENTRY,
  VEIL_MEMORY_TOOL,
} from "../../../packages/veil-agent/src/index.ts";
import {
  type Stage2BenchAcceptanceReport,
  verifyStage2BenchAcceptance,
} from "./stage2-acceptance.ts";
import { discoverTasks } from "./tasks.ts";

const execFileAsync = promisify(execFile);
const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));

export interface Stage3ExtensionAcceptance {
  readonly tools: readonly ["veil-data", "veil-backtest", "veil-memory"];
  readonly commands: readonly ["veil-brief", "veil-hypothesis", "veil-promote", "veil-reproduce"];
  readonly automaticEntries: readonly ["veil.brief.v0", "veil.hypothesis.v0"];
  readonly missingAsOfBlockedBy: "C1";
  readonly explorationBuiltInBlockedCount: 0;
  readonly advisory: {
    readonly appended: true;
    readonly blocked: false;
  };
}

export interface Stage3AgentLoopAcceptance {
  readonly structuralStatus: "contract-verified";
  readonly claimStatus: "unverified";
  readonly registrationStatus: "preregistered";
  readonly executionCount: number;
  readonly requiredEvidence: readonly ["pricing", "costs", "statistical-gates"];
}

export interface Stage3BenchAcceptanceReport {
  readonly stage2: Stage2BenchAcceptanceReport;
  readonly extension: Stage3ExtensionAcceptance;
  readonly agentLoop: Stage3AgentLoopAcceptance;
  readonly promotionDataRejections: readonly [
    {
      readonly taskId: "T3_missing_availability";
      readonly degradation: "PIT_UNSAFE";
      readonly invariant: "C1";
    },
    {
      readonly taskId: "T4_survivorship";
      readonly degradation: "SURVIVORSHIP_BIASED";
      readonly invariant: "C1";
    },
  ];
  readonly deferredPublicTraps: readonly [
    "T6_multiple_testing",
    "T11_period_selection",
    "T12_cost_illusion",
  ];
  readonly deferredPlannedTraps: readonly ["T7_knowledge_pollution"];
  readonly hiddenSetRun: false;
  readonly modelCompetenceScored: false;
  readonly externalUserRun: false;
}

export interface VerifyStage3BenchAcceptanceOptions {
  readonly tasksDirectory: string;
  readonly repositoryRoot?: string;
}

/**
 * Deterministic Stage 3 preflight. This proves extension wiring and structural enforcement without
 * pretending that a model run, hidden-set score, or external-user trial happened.
 */
export async function verifyStage3BenchAcceptance(
  options: VerifyStage3BenchAcceptanceOptions,
): Promise<Stage3BenchAcceptanceReport> {
  const repositoryRoot = resolve(options.repositoryRoot ?? ".");
  const [stage2, extension, agentLoop, promotionDataRejections] = await Promise.all([
    verifyStage2BenchAcceptance({ tasksDirectory: options.tasksDirectory }),
    verifyExtensionSurface(),
    verifyAgentLoop(repositoryRoot),
    verifyCriticalPromotionData(options.tasksDirectory),
  ]);
  if (stage2.explorationBlockedCount !== 0) {
    throw new Error("Stage 3 inherited a Stage 2 exploration block");
  }
  return Object.freeze({
    stage2,
    extension,
    agentLoop,
    promotionDataRejections,
    deferredPublicTraps: Object.freeze([
      "T6_multiple_testing",
      "T11_period_selection",
      "T12_cost_illusion",
    ] as const),
    deferredPlannedTraps: Object.freeze(["T7_knowledge_pollution"] as const),
    hiddenSetRun: false,
    modelCompetenceScored: false,
    externalUserRun: false,
  });
}

async function verifyCriticalPromotionData(
  tasksDirectory: string,
): Promise<Stage3BenchAcceptanceReport["promotionDataRejections"]> {
  const tasks = discoverTasks(tasksDirectory);
  const specs = [
    {
      taskId: "T3_missing_availability" as const,
      degradation: "PIT_UNSAFE" as const,
    },
    {
      taskId: "T4_survivorship" as const,
      degradation: "SURVIVORSHIP_BIASED" as const,
    },
  ];
  for (const spec of specs) {
    const task = tasks.find((candidate) => candidate.manifest.taskId === spec.taskId);
    if (task === undefined) throw new Error(`${spec.taskId}: Stage 3 task is absent`);
    const declarations = await Promise.all(
      task.manifest.datasets.map(({ adapter }) =>
        loadAdapterFile(resolve(task.directory, adapter)),
      ),
    );
    const declaration = declarations.find((candidate) =>
      deriveDataSemantics(candidate).degradations.includes(spec.degradation),
    );
    if (declaration === undefined) {
      throw new Error(`${spec.taskId}: expected critical data degradation is absent`);
    }
    try {
      assertPromotionDataSemantics(declaration);
    } catch (error) {
      if (error instanceof ContractViolation && error.invariant === "C1") {
        continue;
      }
      throw error;
    }
    throw new Error(`${spec.taskId}: critical data degradation reached promotion`);
  }
  return Object.freeze([
    Object.freeze({
      taskId: "T3_missing_availability",
      degradation: "PIT_UNSAFE",
      invariant: "C1",
    }),
    Object.freeze({
      taskId: "T4_survivorship",
      degradation: "SURVIVORSHIP_BIASED",
      invariant: "C1",
    }),
  ] as const);
}

interface FakeSessionEntry {
  readonly type: "custom";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly customType: string;
  readonly data: unknown;
}

type FakeHandler = (event: Record<string, unknown>, context: FakeContext) => unknown;

interface FakeContext {
  readonly cwd: string;
  readonly sessionManager: { readonly getBranch: () => readonly FakeSessionEntry[] };
  readonly ui: { readonly setStatus: (key: string, value: string | undefined) => void };
}

async function verifyExtensionSurface(): Promise<Stage3ExtensionAcceptance> {
  const tools: string[] = [];
  const commands: string[] = [];
  const handlers = new Map<string, FakeHandler[]>();
  const entries: FakeSessionEntry[] = [];
  let timestamp = Date.parse("2026-08-13T00:00:00.000Z");
  const appendEntry = (customType: string, data: unknown): void => {
    timestamp += 1_000;
    const previous = entries.at(-1);
    entries.push({
      type: "custom",
      id: `stage3-entry-${entries.length + 1}`,
      parentId: previous?.id ?? null,
      timestamp: new Date(timestamp).toISOString(),
      customType,
      data,
    });
  };
  const fakePi = {
    registerTool: (definition: { readonly name: string }) => tools.push(definition.name),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string, handler: FakeHandler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    appendEntry,
  };
  createVeilExtension({ now: () => new Date("2026-08-13T00:00:00.000Z") })(
    fakePi as unknown as ExtensionAPI,
  );

  requireExact(tools, [VEIL_DATA_TOOL, VEIL_BACKTEST_TOOL, VEIL_MEMORY_TOOL], "tools");
  requireExact(
    commands,
    ["veil-brief", "veil-hypothesis", "veil-promote", "veil-reproduce"],
    "commands",
  );
  const context: FakeContext = {
    cwd: "/stage3/model-free-project",
    sessionManager: { getBranch: () => entries },
    ui: { setStatus: () => {} },
  };
  const beforeAgentStart = requiredHandler(handlers, "before_agent_start");
  await beforeAgentStart(
    {
      type: "before_agent_start",
      prompt: "Study an explicit point-in-time hypothesis.",
      systemPrompt: "base",
      systemPromptOptions: {},
    },
    context,
  );
  requireExact(
    entries.slice(0, 2).map((entry) => entry.customType),
    [VEIL_BRIEF_ENTRY, VEIL_HYPOTHESIS_ENTRY],
    "automatic session entries",
  );

  const toolCall = requiredHandler(handlers, "tool_call");
  const missingResult = await toolCall(
    { type: "tool_call", toolCallId: "missing-as-of", toolName: VEIL_DATA_TOOL, input: {} },
    context,
  );
  const missingRecord = record(missingResult, "missing as_of interception");
  if (missingRecord.block !== true || !String(missingRecord.reason).includes("C1")) {
    throw new Error("veil-data missing as_of did not fail safe as C1");
  }
  const builtInResult = await toolCall(
    {
      type: "tool_call",
      toolCallId: "exploration-bash",
      toolName: "bash",
      input: { command: "analyze locally" },
    },
    context,
  );
  if (builtInResult !== undefined) throw new Error("exploration built-in was intercepted");

  const toolResult = requiredHandler(handlers, "tool_result");
  const advisoryResult = await toolResult(
    {
      type: "tool_result",
      toolCallId: "future-code",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "candidate = values.shift(-1)" }],
      details: undefined,
      isError: false,
    },
    context,
  );
  const advisoryRecord = record(advisoryResult, "advisory interception");
  if (advisoryRecord.isError === true) throw new Error("exploration advisory became an error");
  if (!entries.some((entry) => entry.customType === VEIL_ADVISORY_ENTRY)) {
    throw new Error("exploration advisory was not audited");
  }

  return Object.freeze({
    tools: Object.freeze([VEIL_DATA_TOOL, VEIL_BACKTEST_TOOL, VEIL_MEMORY_TOOL] as const),
    commands: Object.freeze([
      "veil-brief",
      "veil-hypothesis",
      "veil-promote",
      "veil-reproduce",
    ] as const),
    automaticEntries: Object.freeze([VEIL_BRIEF_ENTRY, VEIL_HYPOTHESIS_ENTRY] as const),
    missingAsOfBlockedBy: "C1",
    explorationBuiltInBlockedCount: 0,
    advisory: Object.freeze({ appended: true, blocked: false }),
  });
}

async function verifyAgentLoop(repositoryRoot: string): Promise<Stage3AgentLoopAcceptance> {
  const entrypoint = resolve(repositoryRoot, "examples/agent-loop/run.ts");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", TSX_LOADER, entrypoint],
    {
      cwd: repositoryRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (stderr.trim().length > 0) throw new Error("agent-loop cold example wrote to stderr");
  const report = record(JSON.parse(stdout.trim()), "agent-loop report");
  if (
    report.ok !== true ||
    report.structuralStatus !== "contract-verified" ||
    report.claimStatus !== "unverified" ||
    report.registrationStatus !== "preregistered" ||
    !Number.isSafeInteger(report.executionCount) ||
    (report.executionCount as number) <= 0 ||
    JSON.stringify(report.requiredEvidence) !==
      JSON.stringify(["pricing", "costs", "statistical-gates"])
  ) {
    throw new Error("agent-loop cold example did not preserve the Stage 3 boundary");
  }
  if (/\/(?:home|Users|tmp)\/|[A-Za-z]:[\\/]/u.test(stdout)) {
    throw new Error("agent-loop report exposed a machine path");
  }
  return Object.freeze({
    structuralStatus: "contract-verified",
    claimStatus: "unverified",
    registrationStatus: "preregistered",
    executionCount: report.executionCount as number,
    requiredEvidence: Object.freeze(["pricing", "costs", "statistical-gates"] as const),
  });
}

function requiredHandler(
  handlers: ReadonlyMap<string, readonly FakeHandler[]>,
  name: string,
): FakeHandler {
  const registered = handlers.get(name);
  if (registered === undefined || registered.length !== 1 || registered[0] === undefined) {
    throw new Error(`expected exactly one ${name} handler`);
  }
  return registered[0];
}

function requireExact(actual: readonly string[], expected: readonly string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Stage 3 ${label} differ from the frozen surface`);
  }
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}
