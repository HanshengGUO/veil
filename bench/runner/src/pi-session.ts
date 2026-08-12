import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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
import type {
  AgentSessionEvent,
  ResourceLoader,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
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

export interface PiTaskRunResult {
  schemaVersion: 1;
  profile: "bare";
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
  score: TrapScore | HonestScore;
}

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
    const created = await pi.createAgentSession({
      cwd: workspace,
      model,
      modelRuntime,
      thinkingLevel: options.model.thinkingLevel,
      resourceLoader: isolatedResources(pi.createExtensionRuntime),
      noTools: "builtin",
      customTools: customTools as never,
      sessionManager: pi.SessionManager.inMemory(workspace),
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
    } catch (error) {
      if (modelError !== undefined) {
        throw new Error(
          `Pi model request failed: ${modelError}; terminal preflight failed: ${safeErrorMessage(error)}`,
        );
      }
      throw error;
    }
    const score = scoreBareTask(options.task, submission);
    const finishedAt = new Date();
    const agentDirectory = join(options.outputDirectory, "agent");
    copyArtifacts(workspace, agentDirectory);
    const artifactManifest = writeArtifactManifest(
      agentDirectory,
      join(options.outputDirectory, "artifact-manifest.json"),
    );
    const result: PiTaskRunResult = {
      schemaVersion: 1,
      profile: "bare",
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
