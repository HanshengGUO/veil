import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeDecisionTime } from "@veilquant/contract";
import type {
  ArtifactCodeFile,
  ExperimentExecutionResult,
  ExperimentExecutionVerificationEvidence,
  ExperimentMemoryRecord,
  ExperimentReproductionRecord,
  PricingEvidenceVerificationEvidence,
  ReadSetSnapshot,
  TrialCountEvidence,
  VerifyOosPricingResultInput,
  WalkForwardContractResult,
} from "@veilquant/engine";
import {
  createExperimentMemoryRecord,
  executeExperiment,
  executeOosPricing,
  executeStandardGateEvaluation,
  openReadSetSnapshotStore,
  replayWalkForwardContract,
  reproduceExperiment,
  verifyArtifactCode,
  verifyArtifactManifest,
  verifyExperimentExecution,
} from "@veilquant/engine";
import {
  VEIL_EXPERIMENT_ARCHIVE_FORMAT,
  VEIL_EXPERIMENT_ENTRY,
  VEIL_RESEARCH_LOG_REFERENCE,
} from "./constants.ts";
import { VeilAgentError } from "./errors.ts";
import { reconstructSessionLedger } from "./ledger.ts";
import {
  existingProjectPath,
  projectOutputPath,
  projectReference,
  type VeilProjectRuntime,
} from "./project.ts";
import {
  appendProjectLog,
  canonicalJson,
  hashBytes,
  writeImmutableProjectFile,
} from "./storage.ts";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const VEIL_READ_SET_TOMBSTONE_FORMAT = "veil.read-set-tombstone.v0" as const;

export interface ExperimentArchive {
  readonly format: typeof VEIL_EXPERIMENT_ARCHIVE_FORMAT;
  readonly execution: ExperimentExecutionResult;
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
  readonly readSetSnapshotIds: readonly string[];
  readonly artifactFiles: readonly ExperimentArtifactFile[];
  readonly gateReplay: ExperimentGateReplayEvidence;
  readonly archiveHash: string;
}

export interface ExperimentArtifactFile {
  readonly logicalName: string;
  readonly contentBase64: string;
}

export interface ExperimentGateReplayEvidence {
  readonly trialEvidence: TrialCountEvidence;
  readonly parameterNeighbors: readonly VerifyOosPricingResultInput[];
  readonly postCutoffValidation: VerifyOosPricingResultInput | null;
}

export interface ProjectReadSetTombstone {
  readonly format: typeof VEIL_READ_SET_TOMBSTONE_FORMAT;
  readonly snapshotId: string;
  readonly deletedAt: string;
  readonly reason: string;
  readonly actor: string;
  readonly tombstoneHash: string;
}

export interface PersistProjectExperimentInput {
  readonly projectRoot: string;
  readonly execution: ExperimentExecutionResult;
  readonly pricingVerification: PricingEvidenceVerificationEvidence;
  readonly artifactCodeRoot: string;
  readonly contractResult: WalkForwardContractResult;
  readonly gateReplay: ExperimentGateReplayEvidence;
  readonly getBranch: () => readonly unknown[];
  readonly appendEntry: (
    customType: typeof VEIL_EXPERIMENT_ENTRY,
    data: ExperimentMemoryRecord,
  ) => void;
}

export interface PersistProjectExperimentResult {
  readonly experimentId: string;
  readonly archiveReference: string;
  readonly memory: ExperimentMemoryRecord;
  readonly created: boolean;
}

/** Writes one immutable archive and appends its compact record to the active Pi branch. */
export async function persistProjectExperiment(
  input: PersistProjectExperimentInput,
): Promise<PersistProjectExperimentResult> {
  const memory = createExperimentMemoryRecord(input.execution);
  const verified = verifyExperimentExecution(input.execution, {
    pricingVerification: input.pricingVerification,
    expectedExperimentId: memory.experimentId,
  });
  const artifact = verifyArtifactManifest(input.pricingVerification.candidateEvidence.artifact, {
    expectedArtifactHash: verified.experiment.artifactHash,
  });
  await verifyArtifactCode(input.artifactCodeRoot, artifact.factor.code);
  const artifactFiles = await captureArtifactFiles(
    input.artifactCodeRoot,
    artifact.factor.code.files,
  );
  if (
    input.contractResult.executionEvidence !== "retained" ||
    input.contractResult.record.contractHash !== verified.experiment.contractHash ||
    input.contractResult.executions.length !== input.contractResult.executionCount
  ) {
    throw archiveError("Experiment persistence requires the exact retained contract execution");
  }
  const snapshotStore = await openReadSetSnapshotStore({
    root: projectOutputPath(input.projectRoot, ".veil/snapshots"),
  });
  const readSetSnapshotIds: string[] = [];
  for (const contractExecution of input.contractResult.executions) {
    const written = await snapshotStore.put(
      contractExecution.source.readSet,
      contractExecution.source.arrowIpc,
    );
    readSetSnapshotIds.push(written.snapshot.id);
  }
  const normalizedSnapshotIds = normalizeHashes(
    [...new Set(readSetSnapshotIds)],
    "read-set snapshot id",
  );
  const gateReplay = normalizeGateReplay(input.gateReplay);
  const body = Object.freeze({
    format: VEIL_EXPERIMENT_ARCHIVE_FORMAT,
    execution: verified,
    pricingVerification: input.pricingVerification,
    readSetSnapshotIds: normalizedSnapshotIds,
    artifactFiles,
    gateReplay,
  });
  const archiveHash = contentHash(VEIL_EXPERIMENT_ARCHIVE_FORMAT, body);
  const archive: ExperimentArchive = Object.freeze({ ...body, archiveHash });
  const archiveReference = archiveReferenceFor(memory.experimentId);
  await writeImmutableProjectFile({
    projectRoot: input.projectRoot,
    reference: archiveReference,
    bytes: `${canonicalJson(archive)}\n`,
  });
  const ledger = reconstructSessionLedger(input.getBranch());
  const existing = ledger.experiments.find(
    (entry) => entry.data.experimentId === memory.experimentId,
  );
  if (existing !== undefined) {
    if (existing.data.memoryHash !== memory.memoryHash) {
      throw archiveError("active branch already maps this Experiment id to different memory");
    }
    return Object.freeze({
      experimentId: memory.experimentId,
      archiveReference,
      memory,
      created: false,
    });
  }
  input.appendEntry(VEIL_EXPERIMENT_ENTRY, memory);
  await appendProjectLog({
    projectRoot: input.projectRoot,
    reference: VEIL_RESEARCH_LOG_REFERENCE,
    header: "# Veil research log\n\n",
    entry: experimentLog(memory, archiveReference),
  });
  return Object.freeze({
    experimentId: memory.experimentId,
    archiveReference,
    memory,
    created: true,
  });
}

/** Loads and independently verifies the portable archive for an Experiment id. */
export async function loadProjectExperiment(
  projectRoot: string,
  experimentIdInput: string,
): Promise<ExperimentArchive> {
  const experimentId = sha256(experimentIdInput, "Experiment id");
  const reference = archiveReferenceFor(experimentId);
  const path = await existingProjectPath(projectRoot, reference, "file");
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw archiveError("Experiment archive is not readable canonical JSON");
  }
  const root = exactRecord(
    input,
    [
      "format",
      "execution",
      "pricingVerification",
      "readSetSnapshotIds",
      "artifactFiles",
      "gateReplay",
      "archiveHash",
    ],
    "Experiment archive",
  );
  if (root.format !== VEIL_EXPERIMENT_ARCHIVE_FORMAT) {
    throw archiveError("Experiment archive uses an unsupported format");
  }
  const readSetSnapshotIds = normalizeHashes(root.readSetSnapshotIds, "read-set snapshot id");
  const artifactFiles = normalizeArtifactFiles(root.artifactFiles);
  const gateReplay = normalizeGateReplay(root.gateReplay as ExperimentGateReplayEvidence);
  const body = Object.freeze({
    format: VEIL_EXPERIMENT_ARCHIVE_FORMAT,
    execution: root.execution,
    pricingVerification: root.pricingVerification as PricingEvidenceVerificationEvidence,
    readSetSnapshotIds,
    artifactFiles,
    gateReplay,
  });
  const archiveHash = sha256(root.archiveHash, "Experiment archive hash");
  if (contentHash(VEIL_EXPERIMENT_ARCHIVE_FORMAT, body) !== archiveHash) {
    throw archiveError("Experiment archive hash does not match its content");
  }
  const execution = verifyExperimentExecution(root.execution, {
    pricingVerification: body.pricingVerification,
    expectedExperimentId: experimentId,
  });
  const artifact = verifyArtifactManifest(body.pricingVerification.candidateEvidence.artifact, {
    expectedArtifactHash: execution.experiment.artifactHash,
  });
  verifyArtifactFiles(artifactFiles, artifact.factor.code.files);
  return Object.freeze({ ...body, execution, archiveHash });
}

/** Re-executes the archived artifact, pricing, and gates from exact local snapshots. */
export async function reproduceProjectExperiment(input: {
  readonly project: VeilProjectRuntime;
  readonly experimentId: string;
  readonly signal?: AbortSignal;
}): Promise<ExperimentReproductionRecord> {
  const archive = await loadProjectExperiment(input.project.root, input.experimentId);
  if (input.project.costModels === undefined || input.project.nullGenerators === undefined) {
    throw archiveError("project Stage 4 providers are unavailable");
  }
  const verification: ExperimentExecutionVerificationEvidence = {
    pricingVerification: archive.pricingVerification,
    expectedExperimentId: archive.execution.experiment.experimentId,
  };
  const snapshotStore = await openReadSetSnapshotStore({
    root: projectOutputPath(input.project.root, ".veil/snapshots"),
  });
  const declaration = archive.pricingVerification.candidateEvidence.declaration;
  const snapshots: ReadSetSnapshot[] = [];
  for (const snapshotId of archive.readSetSnapshotIds) {
    try {
      snapshots.push(await snapshotStore.read(snapshotId, { declaration }));
    } catch (error) {
      const tombstone = await loadProjectReadSetTombstone(input.project.root, snapshotId);
      if (tombstone !== null) {
        throw new VeilAgentError(
          "READ_SET_UNAVAILABLE",
          "read set unavailable: retention deletion",
          `Preserve tombstone ${tombstone.tombstoneHash} and treat the result as attested rather than reproducible.`,
        );
      }
      throw unavailableReadSet(error);
    }
  }
  const codeRoot = await materializeArtifactFiles(archive.artifactFiles);
  try {
    const contractResult = await replayWalkForwardContract({
      artifact: archive.pricingVerification.candidateEvidence.artifact,
      codeRoot,
      plan: archive.pricingVerification.candidateEvidence.plan,
      declaration,
      expectedContractRecord: archive.pricingVerification.candidateEvidence.contractRecord,
      sourceSnapshots: snapshots.map((snapshot) => ({
        readSet: snapshot.manifest,
        arrowIpc: snapshot.arrowIpc,
      })),
      runtimes: input.project.runtimes,
      concurrency: input.project.promotionConcurrency,
      signal: input.signal,
    });
    const pricing = await executeOosPricing({
      candidate: archive.pricingVerification.candidate,
      candidateEvidence: archive.pricingVerification.candidateEvidence,
      contractResult,
      costModels: input.project.costModels,
    });
    const gates = await executeStandardGateEvaluation({
      pricing,
      pricingVerification: archive.pricingVerification,
      trialEvidence: archive.gateReplay.trialEvidence,
      nullGenerators: input.project.nullGenerators,
      parameterNeighbors: archive.gateReplay.parameterNeighbors,
      ...(archive.gateReplay.postCutoffValidation === null
        ? {}
        : {
            postCutoffValidation: archive.gateReplay.postCutoffValidation,
          }),
    });
    const evaporation = archive.execution.experiment.evaporation;
    const rerun = executeExperiment({
      pricing,
      pricingVerification: archive.pricingVerification,
      gates,
      issuedAt: archive.execution.experiment.issuedAt,
      rationale: archive.execution.experiment.rationale,
      lessons: archive.execution.experiment.lessons,
      ...(evaporation === null
        ? {}
        : {
            explorationMetric: {
              ...evaporation.metric,
              value: evaporation.exploration.value,
            },
          }),
    });
    return reproduceExperiment({
      expected: archive.execution,
      verification,
      readSet: { status: "available", tombstoneHash: null, reason: null },
      rerun: () => rerun,
    });
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
}

/** Records an immutable operator tombstone; snapshot deletion remains an external retention policy. */
export async function recordProjectReadSetRetentionDeletion(input: {
  readonly projectRoot: string;
  readonly snapshotId: string;
  readonly deletedAt: string;
  readonly reason: string;
  readonly actor: string;
}): Promise<ProjectReadSetTombstone> {
  const snapshotId = sha256(input.snapshotId, "read-set snapshot id");
  const deletedAt = canonicalTime(input.deletedAt, "retention deletion time");
  const reason = boundedText(input.reason, "retention deletion reason", 1024);
  const actor = portableText(input.actor, "retention deletion actor");
  const body = Object.freeze({
    format: VEIL_READ_SET_TOMBSTONE_FORMAT,
    snapshotId,
    deletedAt,
    reason,
    actor,
  });
  const tombstone = Object.freeze({
    ...body,
    tombstoneHash: contentHash(VEIL_READ_SET_TOMBSTONE_FORMAT, body),
  });
  await writeImmutableProjectFile({
    projectRoot: input.projectRoot,
    reference: tombstoneReferenceFor(snapshotId),
    bytes: `${canonicalJson(tombstone)}\n`,
  });
  return tombstone;
}

async function loadProjectReadSetTombstone(
  projectRoot: string,
  snapshotId: string,
): Promise<ProjectReadSetTombstone | null> {
  let source: string;
  try {
    source = await readFile(
      projectOutputPath(projectRoot, tombstoneReferenceFor(snapshotId)),
      "utf8",
    );
  } catch {
    return null;
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    throw archiveError("read-set retention tombstone is not readable JSON");
  }
  const root = exactRecord(
    input,
    ["format", "snapshotId", "deletedAt", "reason", "actor", "tombstoneHash"],
    "read-set retention tombstone",
  );
  if (root.format !== VEIL_READ_SET_TOMBSTONE_FORMAT || root.snapshotId !== snapshotId) {
    throw archiveError("read-set retention tombstone does not match the missing snapshot");
  }
  const body = Object.freeze({
    format: VEIL_READ_SET_TOMBSTONE_FORMAT,
    snapshotId,
    deletedAt: canonicalTime(root.deletedAt, "retention deletion time"),
    reason: boundedText(root.reason, "retention deletion reason", 1024),
    actor: portableText(root.actor, "retention deletion actor"),
  });
  const tombstoneHash = sha256(root.tombstoneHash, "read-set tombstone hash");
  if (contentHash(VEIL_READ_SET_TOMBSTONE_FORMAT, body) !== tombstoneHash) {
    throw archiveError("read-set retention tombstone hash does not match its content");
  }
  return Object.freeze({ ...body, tombstoneHash });
}

function tombstoneReferenceFor(snapshotId: string): string {
  return projectReference(`.veil/read-set-tombstones/${snapshotId.slice("sha256:".length)}.json`);
}

function archiveReferenceFor(experimentId: string): string {
  return projectReference(`.veil/experiments/${experimentId.slice("sha256:".length)}.json`);
}

async function captureArtifactFiles(
  root: string,
  expected: readonly ArtifactCodeFile[],
): Promise<readonly ExperimentArtifactFile[]> {
  const files: ExperimentArtifactFile[] = [];
  for (const file of expected) {
    const bytes = await readFile(join(root, ...file.logicalName.split("/")));
    if (bytes.byteLength !== file.byteLength || hashBytes(bytes) !== file.contentHash) {
      throw archiveError("artifact code changed while its Experiment was archived");
    }
    files.push(
      Object.freeze({
        logicalName: file.logicalName,
        contentBase64: bytes.toString("base64"),
      }),
    );
  }
  return Object.freeze(files);
}

function normalizeArtifactFiles(input: unknown): readonly ExperimentArtifactFile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10_000) {
    throw archiveError("artifactFiles must be a non-empty bounded array");
  }
  const files = input.map((value) => {
    const root = exactRecord(value, ["logicalName", "contentBase64"], "Experiment artifact file");
    if (
      typeof root.logicalName !== "string" ||
      root.logicalName.length === 0 ||
      root.logicalName.includes("\\") ||
      root.logicalName.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw archiveError("Experiment artifact file name is not portable");
    }
    if (typeof root.contentBase64 !== "string") {
      throw archiveError("Experiment artifact file content is not base64 text");
    }
    const decoded = Buffer.from(root.contentBase64, "base64");
    if (decoded.toString("base64") !== root.contentBase64) {
      throw archiveError("Experiment artifact file content is not canonical base64");
    }
    return Object.freeze({
      logicalName: root.logicalName,
      contentBase64: root.contentBase64,
    });
  });
  const names = files.map((file) => file.logicalName);
  if (names.some((name, index) => index > 0 && compareText(names[index - 1] ?? "", name) >= 0)) {
    throw archiveError("Experiment artifact files must be unique and sorted");
  }
  return Object.freeze(files);
}

function verifyArtifactFiles(
  files: readonly ExperimentArtifactFile[],
  expected: readonly ArtifactCodeFile[],
): void {
  if (files.length !== expected.length) {
    throw archiveError("Experiment artifact files do not cover the code manifest");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const file = files[index];
    const identity = expected[index];
    if (file === undefined || identity === undefined || file.logicalName !== identity.logicalName) {
      throw archiveError("Experiment artifact file names differ from the code manifest");
    }
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (bytes.byteLength !== identity.byteLength || hashBytes(bytes) !== identity.contentHash) {
      throw archiveError("Experiment artifact file bytes differ from the code manifest");
    }
  }
}

function normalizeGateReplay(input: ExperimentGateReplayEvidence): ExperimentGateReplayEvidence {
  const root = exactRecord(
    input,
    ["trialEvidence", "parameterNeighbors", "postCutoffValidation"],
    "Experiment gate replay evidence",
  );
  const trial = exactRecord(
    root.trialEvidence,
    ["sessionLedgerHash", "sessionAttemptIds", "memorySnapshotHash", "familyExperimentIds"],
    "Experiment trial replay evidence",
  );
  if (!Array.isArray(trial.sessionAttemptIds) || !Array.isArray(trial.familyExperimentIds)) {
    throw archiveError("Experiment trial replay evidence requires attempt and family arrays");
  }
  const trialEvidence: TrialCountEvidence = Object.freeze({
    sessionLedgerHash: sha256(trial.sessionLedgerHash, "session ledger hash"),
    sessionAttemptIds: Object.freeze(
      trial.sessionAttemptIds.map((value) => portableText(value, "session attempt id")),
    ),
    memorySnapshotHash: sha256(trial.memorySnapshotHash, "memory snapshot hash"),
    familyExperimentIds: normalizeHashesAllowEmpty(
      trial.familyExperimentIds,
      "family Experiment id",
    ),
  });
  if (!Array.isArray(root.parameterNeighbors) || root.parameterNeighbors.length > 64) {
    throw archiveError("Experiment gate replay has too many parameter neighbors");
  }
  canonicalJson(root.parameterNeighbors);
  if (root.postCutoffValidation !== null) canonicalJson(root.postCutoffValidation);
  return Object.freeze({
    trialEvidence,
    parameterNeighbors: Object.freeze(root.parameterNeighbors as VerifyOosPricingResultInput[]),
    postCutoffValidation: root.postCutoffValidation as VerifyOosPricingResultInput | null,
  });
}

async function materializeArtifactFiles(files: readonly ExperimentArtifactFile[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "veil-experiment-replay-"));
  try {
    for (const file of files) {
      const path = join(root, ...file.logicalName.split("/"));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.from(file.contentBase64, "base64"), {
        flag: "wx",
        mode: 0o600,
      });
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function unavailableReadSet(_error: unknown): VeilAgentError {
  return new VeilAgentError(
    "READ_SET_UNAVAILABLE",
    "read set unavailable: the archived snapshot is missing or invalid",
    "Restore the exact snapshot or retain the deletion tombstone; never substitute current data.",
  );
}

function experimentLog(memory: ExperimentMemoryRecord, archiveReference: string): string {
  const gates = memory.gateReasons
    .filter((gate) => gate.outcome !== "passed")
    .map((gate) => `${gate.gateId}:${gate.reasonCode}`)
    .join(", ");
  return (
    `## Experiment ${memory.experimentId}\n\n` +
    `- Hypothesis: \`${memory.hypothesisRef}\`\n` +
    `- Verdict: \`${memory.verdict}\`\n` +
    `- Claim status: \`${memory.claimStatus}\`\n` +
    `- Effective trials: \`${memory.effectiveTrials}\`\n` +
    `- Non-passing gates: ${gates || "none"}\n` +
    `- Archive: \`${archiveReference}\`\n\n`
  );
}

function normalizeHashes(input: unknown, field: string): readonly string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100_000) {
    throw archiveError(`${field}s must be a non-empty bounded array`);
  }
  const values = input.map((value) => sha256(value, field)).sort(compareText);
  if (new Set(values).size !== values.length) throw archiveError(`${field}s contain duplicates`);
  return Object.freeze(values);
}

function normalizeHashesAllowEmpty(input: unknown, field: string): readonly string[] {
  if (!Array.isArray(input) || input.length > 100_000) {
    throw archiveError(`${field}s must be a bounded array`);
  }
  const values = input.map((value) => sha256(value, field)).sort(compareText);
  if (new Set(values).size !== values.length) {
    throw archiveError(`${field}s contain duplicates`);
  }
  return Object.freeze(values);
}

function portableText(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(input)) {
    throw archiveError(`${field} is not a portable identifier`);
  }
  return input;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw archiveError(`${field} must be an object`);
  }
  const root = input as Record<string, unknown>;
  const actual = Object.keys(root).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw archiveError(`${field} has missing or unknown fields`);
  }
  return root;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw archiveError(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function canonicalTime(input: unknown, field: string): string {
  if (typeof input !== "string") throw archiveError(`${field} must be a canonical UTC instant`);
  try {
    const normalized = normalizeDecisionTime(input);
    if (normalized !== input) throw new Error("not canonical");
    return normalized;
  } catch {
    throw archiveError(`${field} must be a canonical UTC instant`);
  }
}

function boundedText(input: unknown, field: string, maximum: number): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.length > maximum) {
    throw archiveError(`${field} must be non-empty bounded text`);
  }
  return input;
}

function contentHash(domain: string, input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(input))
    .digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function archiveError(message: string): VeilAgentError {
  return new VeilAgentError(
    "INVALID_EXPERIMENT_ARCHIVE",
    message,
    "Restore the immutable content-addressed archive or rerun the trusted Stage 4 workflow.",
  );
}
