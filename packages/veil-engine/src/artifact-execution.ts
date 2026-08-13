import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { normalizeDecisionTime } from "@veilquant/contract";
import { tableFromIPC } from "apache-arrow";
import { type ArtifactManifest, verifyArtifactManifest } from "./artifact.ts";
import { verifyArtifactCode } from "./artifact-code.ts";
import {
  ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES,
  ARTIFACT_EXECUTION_DEFAULT_CONTROL_BYTES,
  ARTIFACT_EXECUTION_FRAME_HEADER_BYTES,
  type ArtifactExecutionRequestMetadata,
  createArtifactExecutionRequest,
  decodeArtifactExecutionResult,
  encodeArtifactExecutionRequest,
} from "./artifact-execution-protocol.ts";
import {
  type ArtifactRuntimeDescriptor,
  type ArtifactRuntimeLaunch,
  type ArtifactRuntimeRegistry,
  selectArtifactRuntimeProvider,
} from "./artifact-runtime.ts";
import { EngineConfigurationError } from "./errors.ts";
import { verifyReadSetManifest } from "./read-set.ts";

export const ARTIFACT_EXECUTION_FORMAT = "veil.artifact-execution.v0" as const;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TERMINATE_GRACE_MS = 500;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_PROCESS_ENVIRONMENT_NAMES = new Set([
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

export interface ArtifactExecutionLimits {
  readonly timeoutMs?: number;
  readonly terminateGraceMs?: number;
  readonly maxControlBytes?: number;
  readonly maxInputArrowBytes?: number;
  readonly maxOutputArrowBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface ExecuteArtifactInput {
  readonly artifact: unknown;
  /** Local original package root. It is verified and never given to the child. */
  readonly codeRoot: string;
  readonly readSet: unknown;
  /** Exact guarded Arrow associated with readSet. */
  readonly arrowIpc: Uint8Array;
  readonly runtimes: ArtifactRuntimeRegistry;
  readonly limits?: ArtifactExecutionLimits;
  readonly signal?: AbortSignal;
}

/** Internal neutral evidence envelope used by derived verification windows. */
export interface ArtifactExecutionDataEvidence {
  readonly readSetId: string;
  readonly dataset: string;
  readonly version: string;
  readonly declarationHash: string;
  readonly decisionTime: string;
  readonly inputArrowHash: string;
  readonly developmentReadSetIds: readonly string[];
}

export interface ExecuteArtifactWithEvidenceInput {
  readonly artifact: unknown;
  readonly codeRoot: string;
  readonly evidence: ArtifactExecutionDataEvidence;
  readonly arrowIpc: Uint8Array;
  readonly runtimes: ArtifactRuntimeRegistry;
  readonly limits?: ArtifactExecutionLimits;
  readonly signal?: AbortSignal;
}

export interface ArtifactExecutionResult {
  readonly format: typeof ARTIFACT_EXECUTION_FORMAT;
  readonly requestHash: string;
  readonly artifactHash: string;
  readonly readSetId: string;
  readonly decisionTime: string;
  readonly runtime: ArtifactRuntimeDescriptor;
  readonly outputArrowHash: string;
  readonly arrowIpc: Uint8Array;
  readonly diagnostics: {
    readonly stderrByteLength: number;
  };
}

interface NormalizedExecutionLimits {
  readonly timeoutMs: number;
  readonly terminateGraceMs: number;
  readonly maxControlBytes: number;
  readonly maxInputArrowBytes: number;
  readonly maxOutputArrowBytes: number;
  readonly maxStderrBytes: number;
}

interface ChildOutcome {
  readonly stdout: Uint8Array;
  readonly stderrByteLength: number;
}

type TerminationReason = "timeout" | "abort" | "output";

/**
 * Executes one artifact against one already-guarded read-set. No backend, binding, source locator,
 * credential, or development read-set capability crosses the child boundary.
 */
export async function executeArtifact(
  input: ExecuteArtifactInput,
): Promise<ArtifactExecutionResult> {
  const limits = normalizeLimits(input.limits);
  validateInputArrow(input.arrowIpc, limits, input.signal);
  const artifact = verifyArtifactManifest(input.artifact);
  const readSet = verifyReadSetManifest(input.readSet, {
    arrowIpc: input.arrowIpc,
    expectedManifestHash:
      isPlainRecord(input.readSet) && typeof input.readSet.manifestHash === "string"
        ? input.readSet.manifestHash
        : undefined,
  });
  return executeVerifiedArtifact(
    input,
    artifact,
    normalizeDataEvidence(
      {
        readSetId: readSet.manifestHash,
        dataset: readSet.query.dataset,
        version: readSet.query.adapterVersion,
        declarationHash: readSet.declarationHash,
        decisionTime: readSet.query.asOf,
        inputArrowHash: readSet.result.arrowHash,
        developmentReadSetIds: [readSet.manifestHash],
      },
      input.arrowIpc,
    ),
    limits,
  );
}

/** Engine-internal bridge for replayed window evidence; deliberately omitted from index.ts. */
export async function executeArtifactWithEvidence(
  input: ExecuteArtifactWithEvidenceInput,
): Promise<ArtifactExecutionResult> {
  const limits = normalizeLimits(input.limits);
  validateInputArrow(input.arrowIpc, limits, input.signal);
  const artifact = verifyArtifactManifest(input.artifact);
  const evidence = normalizeDataEvidence(input.evidence, input.arrowIpc);
  return executeVerifiedArtifact(input, artifact, evidence, limits);
}

async function executeVerifiedArtifact(
  input: Pick<ExecuteArtifactWithEvidenceInput, "codeRoot" | "arrowIpc" | "runtimes" | "signal">,
  artifact: ArtifactManifest,
  evidence: ArtifactExecutionDataEvidence,
  limits: NormalizedExecutionLimits,
): Promise<ArtifactExecutionResult> {
  const dataset = artifact.dataSemantics.datasets.find(
    (candidate) =>
      candidate.dataset === evidence.dataset &&
      candidate.version === evidence.version &&
      candidate.declarationHash === evidence.declarationHash,
  );
  if (dataset === undefined) {
    throw invalidExecution("execution evidence semantics are not declared by the artifact");
  }
  if (
    evidence.developmentReadSetIds.some((readSetId) =>
      dataset.developmentReadSets.includes(readSetId),
    )
  ) {
    throw invalidExecution(
      "artifact development evidence cannot be reused as a verification execution window",
    );
  }

  await verifyArtifactCode(input.codeRoot, artifact.factor.code);
  throwIfAborted(input.signal);

  // Selection occurs between original verification and copying. A provider-triggered or concurrent
  // source change is therefore caught by verification of the materialized copy below.
  const provider = selectArtifactRuntimeProvider(input.runtimes, artifact.factor.runtime);
  const temporaryRoot = await createTemporaryRoot();
  const materializedCodeRoot = join(temporaryRoot, "code");
  try {
    await materializeCode(
      input.codeRoot,
      materializedCodeRoot,
      artifact.factor.code.files.map((file) => file.logicalName),
    );
    await verifyArtifactCode(materializedCodeRoot, artifact.factor.code);
    throwIfAborted(input.signal);

    const launch = await provider.launch({
      codeRoot: materializedCodeRoot,
      runtime: artifact.factor.runtime,
      entry: artifact.factor.entry,
    });
    // The trusted provider sees the ephemeral root to prepare argv. Re-hash once more so even a
    // synchronous launch hook cannot modify code after the last verification.
    await verifyArtifactCode(materializedCodeRoot, artifact.factor.code);
    throwIfAborted(input.signal);

    const request = createArtifactExecutionRequest({
      artifactHash: artifact.artifactHash,
      codeTreeHash: artifact.factor.code.treeHash,
      runtime: provider.descriptor,
      entry: artifact.factor.entry,
      dataset: {
        dataset: dataset.dataset,
        version: dataset.version,
        declarationHash: dataset.declarationHash,
      },
      readSetId: evidence.readSetId,
      decisionTime: evidence.decisionTime,
      paramsLocked: artifact.paramsLocked,
      declaredLiterals: artifact.declaredLiterals,
      arrowIpc: input.arrowIpc,
    });
    const requestFrame = encodeArtifactExecutionRequest(request, {
      maxControlBytes: limits.maxControlBytes,
      maxArrowBytes: limits.maxInputArrowBytes,
    });
    const outcome = await runChild(
      launch,
      materializedCodeRoot,
      requestFrame,
      limits,
      input.signal,
    );
    const resultFrame = decodeArtifactExecutionResult(outcome.stdout, {
      maxControlBytes: limits.maxControlBytes,
      maxArrowBytes: limits.maxOutputArrowBytes,
    });
    requireMatchingResult(resultFrame.metadata, request.metadata);
    try {
      tableFromIPC(resultFrame.arrowIpc);
    } catch {
      throw new EngineConfigurationError(
        "INVALID_ARTIFACT_OUTPUT",
        "artifact runtime returned unreadable Arrow IPC",
        "Return a supported Arrow IPC stream or file in the v0 result frame.",
      );
    }
    const result: ArtifactExecutionResult = Object.freeze({
      format: ARTIFACT_EXECUTION_FORMAT,
      requestHash: request.metadata.requestHash,
      artifactHash: artifact.artifactHash,
      readSetId: evidence.readSetId,
      decisionTime: evidence.decisionTime,
      runtime: provider.descriptor,
      outputArrowHash: resultFrame.metadata.outputArrowHash,
      arrowIpc: Uint8Array.from(resultFrame.arrowIpc),
      diagnostics: Object.freeze({ stderrByteLength: outcome.stderrByteLength }),
    });
    await removeTemporaryRoot(temporaryRoot);
    return result;
  } catch (cause) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch {
      // Preserve the already-sanitized primary error.
    }
    throw cause;
  }
}

async function createTemporaryRoot(): Promise<string> {
  try {
    return await mkdtemp(join(tmpdir(), "veil-artifact-run-"));
  } catch {
    throw invalidExecution("artifact execution temporary state could not be created");
  }
}

async function removeTemporaryRoot(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    throw invalidExecution("artifact execution temporary state could not be removed");
  }
}

async function materializeCode(
  sourceRoot: string,
  targetRoot: string,
  logicalNames: readonly string[],
): Promise<void> {
  try {
    await mkdir(targetRoot, { recursive: false });
    for (const logicalName of logicalNames) {
      const target = join(targetRoot, ...logicalName.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(sourceRoot, ...logicalName.split("/")), target);
    }
  } catch (cause) {
    if (cause instanceof EngineConfigurationError) throw cause;
    throw invalidExecution("verified artifact code could not be materialized for execution");
  }
}

function runChild(
  launch: ArtifactRuntimeLaunch,
  codeRoot: string,
  requestFrame: Uint8Array,
  limits: NormalizedExecutionLimits,
  signal: AbortSignal | undefined,
): Promise<ChildOutcome> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.executable, [...(launch.arguments ?? [])], {
        cwd: codeRoot,
        env: createArtifactProcessEnvironment(launch.environment, codeRoot),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectPromise(executionFailed("artifact runtime could not be started"));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutByteLength = 0;
    let stderrByteLength = 0;
    let spawnFailed = false;
    let termination: TerminationReason | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const maximumStdoutBytes =
      ARTIFACT_EXECUTION_FRAME_HEADER_BYTES + limits.maxControlBytes + limits.maxOutputArrowBytes;

    const terminate = (reason: TerminationReason): void => {
      if (termination !== null) return;
      termination = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close/error path below still produces a sanitized engine error.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      }, limits.terminateGraceMs);
      killTimer.unref();
    };

    const timeout = setTimeout(() => terminate("timeout"), limits.timeoutMs);
    timeout.unref();
    const onAbort = (): void => terminate("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) terminate("abort");

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutByteLength += chunk.byteLength;
      if (stdoutByteLength > maximumStdoutBytes) {
        terminate("output");
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrByteLength += chunk.byteLength;
      if (stderrByteLength > limits.maxStderrBytes) terminate("output");
    });
    child.stdin?.on("error", () => {
      // A child may close stdin before consuming a malformed/unsupported request. Exit status wins.
    });
    child.on("error", () => {
      spawnFailed = true;
    });
    child.on("close", (code, processSignal) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);

      if (termination === "abort") {
        rejectPromise(
          new EngineConfigurationError(
            "ARTIFACT_EXECUTION_ABORTED",
            "artifact execution was cancelled",
            "Retry with a live AbortSignal if this execution is still required.",
          ),
        );
        return;
      }
      if (termination === "timeout") {
        rejectPromise(
          new EngineConfigurationError(
            "ARTIFACT_EXECUTION_TIMEOUT",
            "artifact execution exceeded its time limit",
            "Fix the factor or explicitly raise the bounded execution timeout.",
          ),
        );
        return;
      }
      if (termination === "output") {
        rejectPromise(outputLimit("artifact runtime exceeded its stdout or stderr byte limit"));
        return;
      }
      if (spawnFailed || processSignal !== null || code !== 0) {
        rejectPromise(executionFailed("artifact runtime exited without a successful result"));
        return;
      }
      let stdout: Uint8Array;
      try {
        stdout = Uint8Array.from(Buffer.concat(stdoutChunks));
      } catch {
        rejectPromise(
          outputLimit("artifact runtime output could not be buffered within its limit"),
        );
        return;
      }
      resolvePromise({
        stdout,
        stderrByteLength,
      });
    });
    try {
      child.stdin?.end(Buffer.from(requestFrame));
    } catch {
      spawnFailed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Close/error handling returns the sanitized launch failure.
      }
    }
  });
}

function requireMatchingResult(
  result: {
    readonly requestHash: string;
    readonly artifactHash: string;
    readonly readSetId: string;
  },
  request: ArtifactExecutionRequestMetadata,
): void {
  if (
    result.requestHash !== request.requestHash ||
    result.artifactHash !== request.artifactHash ||
    result.readSetId !== request.readSetId
  ) {
    throw new EngineConfigurationError(
      "INVALID_ARTIFACT_OUTPUT",
      "artifact result is not bound to the active request",
      "Echo the request, artifact, and read-set identities through the v0 result codec.",
    );
  }
}

/** Engine-internal environment builder; omitted from index.ts. */
export function createArtifactProcessEnvironment(
  providerEnvironment: Readonly<Record<string, string>> | undefined,
  codeRoot: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly hostEnvironment?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...(providerEnvironment ?? {}) };
  if ((options.platform ?? process.platform) !== "win32") return environment;

  // libuv restores a fixed set of missing Windows variables from the parent before CreateProcess.
  // Supply isolated values explicitly so PATH, TEMP, and user-profile data cannot be re-inherited.
  for (const name of Object.keys(environment)) {
    if (WINDOWS_PROCESS_ENVIRONMENT_NAMES.has(name.toUpperCase())) delete environment[name];
  }
  const hostEnvironment = options.hostEnvironment ?? process.env;
  const systemRoot =
    windowsEnvironmentValue(hostEnvironment, "SYSTEMROOT") ??
    windowsEnvironmentValue(hostEnvironment, "WINDIR");
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw executionFailed("artifact runtime could not build an isolated Windows environment");
  }
  const runtimeRoot = win32.dirname(codeRoot);
  const homeDrive = windowsVolume(runtimeRoot);
  const systemDrive = windowsVolume(systemRoot);

  return {
    ...environment,
    COMSPEC: win32.join(systemRoot, "System32", "cmd.exe"),
    HOMEDRIVE: homeDrive,
    HOMEPATH: runtimeRoot.slice(homeDrive.length) || "\\",
    LOGONSERVER: "",
    PATH: "",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SYSTEMDRIVE: systemDrive,
    SYSTEMROOT: systemRoot,
    TEMP: runtimeRoot,
    TMP: runtimeRoot,
    USERDOMAIN: "",
    USERNAME: "veil-runtime",
    USERPROFILE: runtimeRoot,
    WINDIR: systemRoot,
  };
}

function windowsEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  expectedName: string,
): string | undefined {
  const name = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === expectedName,
  );
  return name === undefined ? undefined : environment[name];
}

function windowsVolume(input: string): string {
  const root = win32.parse(input).root;
  return root.endsWith("\\") ? root.slice(0, -1) : root;
}

function validateInputArrow(
  arrowIpc: unknown,
  limits: NormalizedExecutionLimits,
  signal: AbortSignal | undefined,
): asserts arrowIpc is Uint8Array {
  throwIfAborted(signal);
  if (!(arrowIpc instanceof Uint8Array) || arrowIpc.byteLength === 0) {
    throw invalidExecution("artifact execution requires non-empty guarded Arrow IPC");
  }
  if (arrowIpc.byteLength > limits.maxInputArrowBytes) {
    throw outputLimit("artifact execution input exceeds its Arrow byte limit");
  }
}

function normalizeDataEvidence(
  input: unknown,
  arrowIpc: Uint8Array,
): ArtifactExecutionDataEvidence {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      "readSetId",
      "dataset",
      "version",
      "declarationHash",
      "decisionTime",
      "inputArrowHash",
      "developmentReadSetIds",
    ])
  ) {
    throw invalidExecution("artifact execution evidence has missing or unknown fields");
  }
  const readSetId = sha256(input.readSetId, "execution read-set id");
  if (typeof input.dataset !== "string" || !PORTABLE_ID.test(input.dataset)) {
    throw invalidExecution("artifact execution evidence dataset must be a portable name");
  }
  if (
    typeof input.version !== "string" ||
    input.version.length === 0 ||
    input.version.trim() !== input.version
  ) {
    throw invalidExecution("artifact execution evidence version must be portable text");
  }
  if (!Array.isArray(input.developmentReadSetIds) || input.developmentReadSetIds.length === 0) {
    throw invalidExecution("artifact execution evidence must retain its development lineage ids");
  }
  const developmentReadSetIds = input.developmentReadSetIds
    .map((value) => sha256(value, "development lineage id"))
    .sort(compareText);
  if (
    new Set(developmentReadSetIds).size !== developmentReadSetIds.length ||
    !developmentReadSetIds.includes(readSetId)
  ) {
    throw invalidExecution(
      "artifact execution development lineage ids must be unique and include the active read-set",
    );
  }
  let decisionTime: string;
  try {
    decisionTime = normalizeDecisionTime(input.decisionTime);
    if (decisionTime !== input.decisionTime) throw new Error("not canonical");
  } catch {
    throw invalidExecution("artifact execution decision time must be a canonical UTC instant");
  }
  const inputArrowHash = sha256(input.inputArrowHash, "execution input Arrow hash");
  if (inputArrowHash !== hashBytes(arrowIpc)) {
    throw invalidExecution("artifact execution Arrow does not match its verified evidence");
  }
  return Object.freeze({
    readSetId,
    dataset: input.dataset,
    version: input.version,
    declarationHash: sha256(input.declarationHash, "execution declaration hash"),
    decisionTime,
    inputArrowHash,
    developmentReadSetIds: Object.freeze(developmentReadSetIds),
  });
}

function normalizeLimits(input: ArtifactExecutionLimits | undefined): NormalizedExecutionLimits {
  if (
    input !== undefined &&
    (!isPlainRecord(input) ||
      !hasOnlyKeys(input, [
        "timeoutMs",
        "terminateGraceMs",
        "maxControlBytes",
        "maxInputArrowBytes",
        "maxOutputArrowBytes",
        "maxStderrBytes",
      ]))
  ) {
    throw invalidExecution("artifact execution limits contain unknown fields");
  }
  return Object.freeze({
    timeoutMs: boundedPositive(input?.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeout", MAX_TIMEOUT_MS),
    terminateGraceMs: boundedPositive(
      input?.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      "termination grace",
      30_000,
    ),
    maxControlBytes: boundedPositive(
      input?.maxControlBytes ?? ARTIFACT_EXECUTION_DEFAULT_CONTROL_BYTES,
      "control byte limit",
      ARTIFACT_EXECUTION_DEFAULT_CONTROL_BYTES,
    ),
    maxInputArrowBytes: boundedPositive(
      input?.maxInputArrowBytes ?? ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES,
      "input Arrow byte limit",
      ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES,
    ),
    maxOutputArrowBytes: boundedPositive(
      input?.maxOutputArrowBytes ?? ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES,
      "output Arrow byte limit",
      ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES,
    ),
    maxStderrBytes: boundedPositive(
      input?.maxStderrBytes ?? DEFAULT_STDERR_BYTES,
      "stderr byte limit",
      ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES,
    ),
  });
}

function boundedPositive(input: unknown, field: string, maximum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0 || input > maximum) {
    throw invalidExecution(`${field} must be a positive safe integer no greater than ${maximum}`);
  }
  return input;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new EngineConfigurationError(
      "ARTIFACT_EXECUTION_ABORTED",
      "artifact execution was cancelled",
      "Retry with a live AbortSignal if this execution is still required.",
    );
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(input).every((key) => allowed.has(key));
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(input).length === keys.length && hasOnlyKeys(input, keys);
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidExecution(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function hashBytes(input: Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidExecution(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_ARTIFACT_EXECUTION",
    message,
    "Use a verified artifact, a new guarded read-set window, and a registered runtime provider.",
  );
}

function executionFailed(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "ARTIFACT_EXECUTION_FAILED",
    message,
    "Inspect the trusted runtime's private diagnostics; executable paths and stderr are not echoed.",
  );
}

function outputLimit(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "ARTIFACT_OUTPUT_LIMIT",
    message,
    "Reduce runtime output or explicitly raise the bounded execution limit.",
  );
}
