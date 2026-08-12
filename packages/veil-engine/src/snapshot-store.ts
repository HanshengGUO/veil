import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import type { AdapterDeclaration } from "@veilquant/contract";
import type { SourceFingerprint } from "./backend.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  type ReadSetManifest,
  type ReadSetVerificationEvidence,
  verifyReadSetManifest,
} from "./read-set.ts";

export const READ_SET_SNAPSHOT_FORMAT = "veil.read-set-snapshot.v0" as const;
export const READ_SET_SNAPSHOT_INSPECTION_FORMAT = "veil.read-set-snapshot-inspection.v0" as const;
export const READ_SET_SNAPSHOT_RECOVERY_FORMAT = "veil.read-set-snapshot-recovery.v0" as const;

const OBJECTS_DIRECTORY = "read-set-snapshots-v0";
const QUARANTINE_DIRECTORY = "read-set-snapshot-quarantine-v0";
const MANIFEST_FILE = "manifest.json";
const ARROW_FILE = "data.arrow";
const RECOVERY_INTENT_FILE = "intent.json";
const RECOVERY_RESULT_FILE = "result.json";
const RECOVERY_OBJECT = "object";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const STORE_CONSTRUCTOR_TOKEN = Symbol("ReadSetSnapshotStore");
const RECOVERY_CONSTRUCTOR_TOKEN = Symbol("ReadSetSnapshotRecovery");
const RECOVERY_INTENT_HASH_DOMAIN = "veil.read-set-snapshot-recovery.intent.v0";
const RECOVERY_RESULT_HASH_DOMAIN = "veil.read-set-snapshot-recovery.result.v0";

export interface ReadSetSnapshotStoreInput {
  readonly root: string;
}

export interface ReadSetSnapshotReference {
  readonly format: typeof READ_SET_SNAPSHOT_FORMAT;
  readonly id: string;
  readonly rowCount: number;
  readonly resultHash: string;
  readonly arrowHash: string;
}

export interface ReadSetSnapshotWriteResult {
  readonly created: boolean;
  readonly snapshot: ReadSetSnapshotReference;
}

export interface ReadSetSnapshot {
  readonly snapshot: ReadSetSnapshotReference;
  readonly manifest: ReadSetManifest;
  readonly arrowIpc: Uint8Array;
}

export interface ReadSetSnapshotEvidence {
  readonly declaration?: AdapterDeclaration;
  readonly sourceFingerprint?: SourceFingerprint | null;
}

export type ReadSetSnapshotInspectionStatus = "valid" | "missing" | "invalid";

export interface ReadSetSnapshotInspection {
  readonly format: typeof READ_SET_SNAPSHOT_INSPECTION_FORMAT;
  readonly id: string;
  readonly status: ReadSetSnapshotInspectionStatus;
  readonly snapshot: ReadSetSnapshotReference | null;
}

export interface ReadSetSnapshotQuarantineInput {
  readonly snapshotId: string;
  readonly actor: string;
  readonly reason: string;
}

export interface ReadSetSnapshotRecoveryRecord {
  readonly format: typeof READ_SET_SNAPSHOT_RECOVERY_FORMAT;
  readonly operationId: string;
  readonly action: "quarantine";
  readonly outcome: "quarantined";
  readonly snapshotId: string;
  readonly actor: string;
  readonly reason: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly auditHash: string;
}

interface RecoveryIntent {
  readonly format: typeof READ_SET_SNAPSHOT_RECOVERY_FORMAT;
  readonly phase: "intent";
  readonly action: "quarantine";
  readonly snapshotId: string;
  readonly actor: string;
  readonly reason: string;
  readonly startedAt: string;
  readonly nonce: string;
}

type RecoveryRecordBody = Omit<ReadSetSnapshotRecoveryRecord, "auditHash">;

interface SnapshotLocation {
  readonly hex: string;
  readonly shard: string;
  readonly snapshot: string;
  readonly recoveryLock: string;
}

/** Content-addressed persistence for already-guarded Arrow evidence. */
export class ReadSetSnapshotStore {
  readonly #objectsRoot: string;

  private constructor(objectsRoot: string, token: symbol) {
    if (token !== STORE_CONSTRUCTOR_TOKEN) {
      throw invalidStore("snapshot stores must be opened through the validated factory");
    }
    this.#objectsRoot = objectsRoot;
    Object.freeze(this);
  }

  static async open(input: ReadSetSnapshotStoreInput): Promise<ReadSetSnapshotStore> {
    if (typeof input !== "object" || input === null) {
      throw invalidStore("snapshot store configuration must include an absolute root");
    }
    if (typeof input.root !== "string" || !isAbsolute(input.root)) {
      throw invalidStore("snapshot store root must be an absolute path");
    }
    const requestedRoot = resolve(input.root);
    if (requestedRoot === parse(requestedRoot).root) {
      throw invalidStore("snapshot store root cannot be a filesystem root");
    }

    try {
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const canonicalRoot = await realpath(requestedRoot);
      if (canonicalRoot === parse(canonicalRoot).root) {
        throw invalidStore("snapshot store root cannot resolve to a filesystem root");
      }
      const rootStatus = await lstat(canonicalRoot);
      if (!rootStatus.isDirectory()) {
        throw invalidStore("snapshot store root must resolve to a directory");
      }

      const objectsRoot = join(canonicalRoot, OBJECTS_DIRECTORY);
      await mkdir(objectsRoot, { recursive: true, mode: 0o700 });
      const objectsStatus = await lstat(objectsRoot);
      if (!objectsStatus.isDirectory() || objectsStatus.isSymbolicLink()) {
        throw invalidStore("snapshot object namespace must be a regular directory");
      }
      await syncDirectory(canonicalRoot);
      return new ReadSetSnapshotStore(objectsRoot, STORE_CONSTRUCTOR_TOKEN);
    } catch (cause) {
      if (cause instanceof EngineConfigurationError) {
        throw cause;
      }
      throw invalidStore("snapshot store could not be initialized");
    }
  }

  toJSON(): { readonly format: typeof READ_SET_SNAPSHOT_FORMAT } {
    return Object.freeze({ format: READ_SET_SNAPSHOT_FORMAT });
  }

  async put(
    manifestInput: ReadSetManifest,
    arrowInput: Uint8Array,
  ): Promise<ReadSetSnapshotWriteResult> {
    if (!(arrowInput instanceof Uint8Array)) {
      throw new EngineConfigurationError(
        "INVALID_READ_SET",
        "snapshot Arrow payload must be a Uint8Array",
        "Pass the exact guarded Arrow IPC bytes associated with the read-set manifest.",
      );
    }
    const arrowIpc = Uint8Array.from(arrowInput);
    const manifest = verifyReadSetManifest(manifestInput, {
      arrowIpc,
      expectedManifestHash: manifestInput.manifestHash,
    });
    const id = snapshotId(manifest.manifestHash);
    const location = this.#location(id);
    await assertRecoveryUnlocked(location);
    const existing = await this.#readIfPresent(id);
    if (existing !== null) {
      try {
        await syncDirectory(location.shard);
      } catch {
        throw invalidStore("existing snapshot durability could not be confirmed");
      }
      return writeResult(false, existing.manifest);
    }

    let temporary: string | undefined;
    try {
      await mkdir(location.shard, { recursive: true, mode: 0o700 });
      const shardStatus = await lstat(location.shard);
      if (!shardStatus.isDirectory() || shardStatus.isSymbolicLink()) {
        throw invalidStore("snapshot shard must be a regular directory");
      }
      await syncDirectory(this.#objectsRoot);

      temporary = await mkdtemp(join(location.shard, `.${location.hex}.tmp-`));
      await writeDurableFile(join(temporary, ARROW_FILE), arrowIpc);
      await writeDurableFile(
        join(temporary, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await syncDirectory(temporary);
      await assertRecoveryUnlocked(location);

      try {
        await rename(temporary, location.snapshot);
      } catch {
        const winner = await this.#readIfPresent(id);
        if (winner !== null) {
          await syncDirectory(location.shard);
          return writeResult(false, winner.manifest);
        }
        throw invalidStore("snapshot could not be atomically published");
      }

      temporary = undefined;
      await syncDirectory(location.shard);
      return writeResult(true, manifest);
    } catch (cause) {
      if (cause instanceof EngineConfigurationError) {
        throw cause;
      }
      throw invalidStore("snapshot could not be durably written");
    } finally {
      if (temporary !== undefined) {
        await removeUnpublished(temporary);
      }
    }
  }

  async read(idInput: string, evidence: ReadSetSnapshotEvidence = {}): Promise<ReadSetSnapshot> {
    const id = snapshotId(idInput);
    const snapshot = await this.#readIfPresent(id, evidence);
    if (snapshot === null) {
      throw new EngineConfigurationError(
        "SNAPSHOT_NOT_FOUND",
        "read-set snapshot is unavailable",
        "Restore the exact content-addressed snapshot; do not silently query the current source.",
      );
    }
    return snapshot;
  }

  /** Fully verifies a snapshot while returning a non-throwing state for missing/corrupt evidence. */
  async inspect(
    idInput: string,
    evidence: ReadSetSnapshotEvidence = {},
  ): Promise<ReadSetSnapshotInspection> {
    const id = snapshotId(idInput);
    try {
      const snapshot = await this.#readIfPresent(id, evidence);
      return inspection(id, snapshot === null ? "missing" : "valid", snapshot?.snapshot ?? null);
    } catch (cause) {
      if (cause instanceof EngineConfigurationError && cause.code === "INVALID_SNAPSHOT") {
        return inspection(id, "invalid", null);
      }
      throw cause;
    }
  }

  async #readIfPresent(
    id: string,
    evidence: ReadSetSnapshotEvidence = {},
  ): Promise<ReadSetSnapshot | null> {
    const location = this.#location(id);
    if (!(await snapshotShardExists(location.shard))) {
      return null;
    }
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(location.snapshot);
    } catch (cause) {
      if (isMissing(cause)) {
        return null;
      }
      throw invalidSnapshot("snapshot metadata could not be inspected");
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw invalidSnapshot("snapshot object is not a regular directory");
    }

    try {
      const entries = await readdir(location.snapshot, { withFileTypes: true });
      const names = entries.map((entry) => entry.name).sort(compareText);
      if (
        names.length !== 2 ||
        names[0] !== ARROW_FILE ||
        names[1] !== MANIFEST_FILE ||
        entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
      ) {
        throw invalidSnapshot("snapshot object has missing, unknown, or non-regular files");
      }

      const [manifestText, arrowBytes] = await Promise.all([
        readFile(join(location.snapshot, MANIFEST_FILE), "utf8"),
        readFile(join(location.snapshot, ARROW_FILE)),
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifestText);
      } catch {
        throw invalidSnapshot("snapshot manifest is not valid JSON");
      }
      const verification: ReadSetVerificationEvidence = {
        arrowIpc: arrowBytes,
        expectedManifestHash: id,
        ...(evidence.declaration === undefined ? {} : { declaration: evidence.declaration }),
        ...(Object.hasOwn(evidence, "sourceFingerprint")
          ? { sourceFingerprint: evidence.sourceFingerprint }
          : {}),
      };
      let manifest: ReadSetManifest;
      try {
        manifest = verifyReadSetManifest(parsed, verification);
      } catch {
        throw invalidSnapshot("snapshot failed read-set verification");
      }
      return Object.freeze({
        snapshot: snapshotReference(manifest),
        manifest,
        arrowIpc: Uint8Array.from(arrowBytes),
      });
    } catch (cause) {
      if (cause instanceof EngineConfigurationError) {
        throw cause;
      }
      throw invalidSnapshot("snapshot files could not be read");
    }
  }

  #location(id: string): SnapshotLocation {
    return snapshotLocation(this.#objectsRoot, id);
  }
}

/**
 * Separate operator capability for recoverable isolation of intrinsically corrupt snapshots.
 * Normal store reads and writes never create this capability or invoke it implicitly.
 */
export class ReadSetSnapshotRecovery {
  readonly #store: ReadSetSnapshotStore;
  readonly #objectsRoot: string;
  readonly #quarantineRoot: string;

  private constructor(
    store: ReadSetSnapshotStore,
    objectsRoot: string,
    quarantineRoot: string,
    token: symbol,
  ) {
    if (token !== RECOVERY_CONSTRUCTOR_TOKEN) {
      throw invalidRecovery("snapshot recovery must be opened through the validated factory");
    }
    this.#store = store;
    this.#objectsRoot = objectsRoot;
    this.#quarantineRoot = quarantineRoot;
    Object.freeze(this);
  }

  static async open(input: ReadSetSnapshotStoreInput): Promise<ReadSetSnapshotRecovery> {
    const store = await ReadSetSnapshotStore.open(input);
    try {
      const canonicalRoot = await realpath(resolve(input.root));
      const objectsRoot = join(canonicalRoot, OBJECTS_DIRECTORY);
      const quarantineRoot = join(canonicalRoot, QUARANTINE_DIRECTORY);
      await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
      const status = await lstat(quarantineRoot);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw invalidRecovery("snapshot quarantine namespace must be a regular directory");
      }
      await syncDirectory(canonicalRoot);
      return new ReadSetSnapshotRecovery(
        store,
        objectsRoot,
        quarantineRoot,
        RECOVERY_CONSTRUCTOR_TOKEN,
      );
    } catch (cause) {
      if (cause instanceof EngineConfigurationError) {
        throw cause;
      }
      throw invalidRecovery("snapshot recovery could not be initialized");
    }
  }

  toJSON(): { readonly format: typeof READ_SET_SNAPSHOT_RECOVERY_FORMAT } {
    return Object.freeze({ format: READ_SET_SNAPSHOT_RECOVERY_FORMAT });
  }

  async quarantine(input: ReadSetSnapshotQuarantineInput): Promise<ReadSetSnapshotRecoveryRecord> {
    const normalized = normalizeQuarantineInput(input);
    const location = snapshotLocation(this.#objectsRoot, normalized.snapshotId);
    await acquireRecoveryLock(location);
    try {
      const current = await this.#store.inspect(normalized.snapshotId);
      if (current.status === "missing") {
        throw new EngineConfigurationError(
          "SNAPSHOT_NOT_FOUND",
          "snapshot recovery target is unavailable",
          "Confirm the content id; no recovery action was taken.",
        );
      }
      if (current.status === "valid") {
        throw new EngineConfigurationError(
          "SNAPSHOT_RECOVERY_REFUSED",
          "snapshot recovery refuses to quarantine valid evidence",
          "Keep the verified object; quarantine is reserved for intrinsically corrupt snapshots.",
        );
      }

      const intent = Object.freeze({
        format: READ_SET_SNAPSHOT_RECOVERY_FORMAT,
        phase: "intent",
        action: "quarantine",
        snapshotId: normalized.snapshotId,
        actor: normalized.actor,
        reason: normalized.reason,
        startedAt: new Date().toISOString(),
        nonce: randomUUID(),
      } satisfies RecoveryIntent);
      const operationId = hashRecovery(RECOVERY_INTENT_HASH_DOMAIN, intent);
      const operation = await createRecoveryOperation(this.#quarantineRoot, operationId);
      await writeDurableFile(
        join(operation, RECOVERY_INTENT_FILE),
        `${JSON.stringify(intent, null, 2)}\n`,
      );
      await syncDirectory(operation);

      const confirmed = await this.#store.inspect(normalized.snapshotId);
      if (confirmed.status !== "invalid") {
        throw invalidRecovery(
          "snapshot state changed after the durable intent; no object was quarantined",
        );
      }

      try {
        await rename(location.snapshot, join(operation, RECOVERY_OBJECT));
      } catch {
        throw invalidRecovery(
          "snapshot changed before it could be quarantined; the durable intent was retained",
        );
      }
      await Promise.all([syncDirectory(location.shard), syncDirectory(operation)]);

      const body: RecoveryRecordBody = {
        format: READ_SET_SNAPSHOT_RECOVERY_FORMAT,
        operationId,
        action: "quarantine",
        outcome: "quarantined",
        snapshotId: intent.snapshotId,
        actor: intent.actor,
        reason: intent.reason,
        startedAt: intent.startedAt,
        completedAt: new Date().toISOString(),
      };
      const record = Object.freeze({
        ...body,
        auditHash: hashRecovery(RECOVERY_RESULT_HASH_DOMAIN, body),
      });
      await writeDurableFile(
        join(operation, RECOVERY_RESULT_FILE),
        `${JSON.stringify(record, null, 2)}\n`,
      );
      await syncDirectory(operation);
      return record;
    } finally {
      await releaseRecoveryLock(location);
    }
  }

  /** Re-reads and hash-verifies the durable audit record without following the quarantined object. */
  async read(operationIdInput: string): Promise<ReadSetSnapshotRecoveryRecord> {
    const operationId = recoveryId(operationIdInput);
    const operation = recoveryOperationLocation(this.#quarantineRoot, operationId);
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(operation);
    } catch (cause) {
      if (isMissing(cause)) {
        throw invalidRecovery("snapshot recovery record is unavailable");
      }
      throw invalidRecovery("snapshot recovery record could not be inspected");
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw invalidRecovery("snapshot recovery record is not a regular directory");
    }

    try {
      const entries = await readdir(operation, { withFileTypes: true });
      const names = entries.map((entry) => entry.name).sort(compareText);
      if (
        names.length !== 3 ||
        names[0] !== RECOVERY_INTENT_FILE ||
        names[1] !== RECOVERY_OBJECT ||
        names[2] !== RECOVERY_RESULT_FILE
      ) {
        throw invalidRecovery("snapshot recovery record is incomplete or has unknown files");
      }
      for (const name of [RECOVERY_INTENT_FILE, RECOVERY_RESULT_FILE]) {
        const entry = entries.find((candidate) => candidate.name === name);
        if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) {
          throw invalidRecovery("snapshot recovery audit files must be regular files");
        }
      }

      const [intentText, resultText] = await Promise.all([
        readFile(join(operation, RECOVERY_INTENT_FILE), "utf8"),
        readFile(join(operation, RECOVERY_RESULT_FILE), "utf8"),
      ]);
      const intent = normalizeRecoveryIntent(parseRecoveryJson(intentText));
      const record = normalizeRecoveryRecord(parseRecoveryJson(resultText));
      if (hashRecovery(RECOVERY_INTENT_HASH_DOMAIN, intent) !== operationId) {
        throw invalidRecovery("snapshot recovery intent hash does not match its operation id");
      }
      const { auditHash, ...body } = record;
      if (
        record.operationId !== operationId ||
        record.snapshotId !== intent.snapshotId ||
        record.actor !== intent.actor ||
        record.reason !== intent.reason ||
        record.startedAt !== intent.startedAt ||
        hashRecovery(RECOVERY_RESULT_HASH_DOMAIN, body) !== auditHash
      ) {
        throw invalidRecovery("snapshot recovery audit record failed verification");
      }
      return record;
    } catch (cause) {
      if (cause instanceof EngineConfigurationError) {
        throw cause;
      }
      throw invalidRecovery("snapshot recovery audit files could not be read");
    }
  }
}

export async function openReadSetSnapshotStore(
  input: ReadSetSnapshotStoreInput,
): Promise<ReadSetSnapshotStore> {
  return ReadSetSnapshotStore.open(input);
}

export async function openReadSetSnapshotRecovery(
  input: ReadSetSnapshotStoreInput,
): Promise<ReadSetSnapshotRecovery> {
  return ReadSetSnapshotRecovery.open(input);
}

function inspection(
  id: string,
  status: ReadSetSnapshotInspectionStatus,
  snapshot: ReadSetSnapshotReference | null,
): ReadSetSnapshotInspection {
  return Object.freeze({
    format: READ_SET_SNAPSHOT_INSPECTION_FORMAT,
    id,
    status,
    snapshot,
  });
}

function snapshotLocation(objectsRoot: string, id: string): SnapshotLocation {
  const hex = id.slice("sha256:".length);
  const shard = join(objectsRoot, hex.slice(0, 2));
  return Object.freeze({
    hex,
    shard,
    snapshot: join(shard, hex),
    recoveryLock: join(shard, `.${hex}.recovery-lock`),
  });
}

async function snapshotShardExists(shard: string): Promise<boolean> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(shard);
  } catch (cause) {
    if (isMissing(cause)) {
      return false;
    }
    throw invalidSnapshot("snapshot shard metadata could not be inspected");
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw invalidSnapshot("snapshot shard is not a regular directory");
  }
  return true;
}

async function assertRecoveryUnlocked(location: SnapshotLocation): Promise<void> {
  try {
    await lstat(location.recoveryLock);
  } catch (cause) {
    if (isMissing(cause)) {
      return;
    }
    throw invalidStore("snapshot recovery lock could not be inspected");
  }
  throw new EngineConfigurationError(
    "SNAPSHOT_RECOVERY_BUSY",
    "snapshot is undergoing an operator recovery action",
    "Wait for the explicit recovery action to finish, then retry the write.",
  );
}

async function acquireRecoveryLock(location: SnapshotLocation): Promise<void> {
  try {
    if (!(await snapshotShardExists(location.shard))) {
      throw new EngineConfigurationError(
        "SNAPSHOT_NOT_FOUND",
        "snapshot recovery target is unavailable",
        "Confirm the content id; no recovery action was taken.",
      );
    }
  } catch (cause) {
    if (cause instanceof EngineConfigurationError && cause.code === "INVALID_SNAPSHOT") {
      throw invalidRecovery("snapshot shard is unsafe and cannot be quarantined automatically");
    }
    throw cause;
  }

  let created = false;
  try {
    await mkdir(location.recoveryLock, { mode: 0o700 });
    created = true;
    await syncDirectory(location.shard);
  } catch (cause) {
    if (created) {
      await rmdir(location.recoveryLock).catch(() => undefined);
    }
    if (errorCode(cause) === "EEXIST") {
      throw new EngineConfigurationError(
        "SNAPSHOT_RECOVERY_BUSY",
        "another operator recovery action already owns this snapshot",
        "Wait for that action to complete and inspect its audit record before retrying.",
      );
    }
    if (cause instanceof EngineConfigurationError) {
      throw cause;
    }
    throw invalidRecovery("snapshot recovery lock could not be acquired");
  }
}

async function releaseRecoveryLock(location: SnapshotLocation): Promise<void> {
  try {
    const [shardStatus, lockStatus] = await Promise.all([
      lstat(location.shard),
      lstat(location.recoveryLock),
    ]);
    if (
      !shardStatus.isDirectory() ||
      shardStatus.isSymbolicLink() ||
      !lockStatus.isDirectory() ||
      lockStatus.isSymbolicLink()
    ) {
      throw new Error("unsafe recovery lock");
    }
    await rmdir(location.recoveryLock);
    await syncDirectory(location.shard);
  } catch {
    throw invalidRecovery("snapshot recovery lock could not be released");
  }
}

async function createRecoveryOperation(
  quarantineRoot: string,
  operationId: string,
): Promise<string> {
  const hex = operationId.slice("sha256:".length);
  const shard = join(quarantineRoot, hex.slice(0, 2));
  try {
    await mkdir(shard, { mode: 0o700 });
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") {
      throw invalidRecovery("snapshot quarantine shard could not be created");
    }
  }
  const shardStatus = await lstat(shard).catch(() => null);
  if (shardStatus === null || !shardStatus.isDirectory() || shardStatus.isSymbolicLink()) {
    throw invalidRecovery("snapshot quarantine shard must be a regular directory");
  }

  const operation = join(shard, hex);
  try {
    await mkdir(operation, { mode: 0o700 });
  } catch {
    throw invalidRecovery("snapshot recovery operation id already exists or cannot be created");
  }
  const operationStatus = await lstat(operation);
  if (!operationStatus.isDirectory() || operationStatus.isSymbolicLink()) {
    throw invalidRecovery("snapshot recovery operation must be a regular directory");
  }
  await Promise.all([syncDirectory(quarantineRoot), syncDirectory(shard)]);
  return operation;
}

function recoveryOperationLocation(quarantineRoot: string, operationId: string): string {
  const hex = operationId.slice("sha256:".length);
  return join(quarantineRoot, hex.slice(0, 2), hex);
}

function normalizeQuarantineInput(
  input: ReadSetSnapshotQuarantineInput,
): ReadSetSnapshotQuarantineInput {
  const record = exactRecoveryRecord(input, ["snapshotId", "actor", "reason"], "recovery input");
  return Object.freeze({
    snapshotId: recoverySnapshotId(record.snapshotId),
    actor: recoveryActor(record.actor),
    reason: recoveryReason(record.reason),
  });
}

function normalizeRecoveryIntent(input: unknown): RecoveryIntent {
  const record = exactRecoveryRecord(
    input,
    ["format", "phase", "action", "snapshotId", "actor", "reason", "startedAt", "nonce"],
    "recovery intent",
  );
  if (
    record.format !== READ_SET_SNAPSHOT_RECOVERY_FORMAT ||
    record.phase !== "intent" ||
    record.action !== "quarantine"
  ) {
    throw invalidRecovery("snapshot recovery intent uses unsupported semantics");
  }
  const nonce = recoveryString(record.nonce, "recovery nonce");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) {
    throw invalidRecovery("snapshot recovery nonce is invalid");
  }
  return Object.freeze({
    format: READ_SET_SNAPSHOT_RECOVERY_FORMAT,
    phase: "intent",
    action: "quarantine",
    snapshotId: recoverySnapshotId(record.snapshotId),
    actor: recoveryActor(record.actor),
    reason: recoveryReason(record.reason),
    startedAt: recoveryInstant(record.startedAt, "recovery start time"),
    nonce,
  });
}

function normalizeRecoveryRecord(input: unknown): ReadSetSnapshotRecoveryRecord {
  const record = exactRecoveryRecord(
    input,
    [
      "format",
      "operationId",
      "action",
      "outcome",
      "snapshotId",
      "actor",
      "reason",
      "startedAt",
      "completedAt",
      "auditHash",
    ],
    "recovery result",
  );
  if (
    record.format !== READ_SET_SNAPSHOT_RECOVERY_FORMAT ||
    record.action !== "quarantine" ||
    record.outcome !== "quarantined"
  ) {
    throw invalidRecovery("snapshot recovery result uses unsupported semantics");
  }
  const startedAt = recoveryInstant(record.startedAt, "recovery start time");
  const completedAt = recoveryInstant(record.completedAt, "recovery completion time");
  if (completedAt < startedAt) {
    throw invalidRecovery("snapshot recovery completed before it started");
  }
  return Object.freeze({
    format: READ_SET_SNAPSHOT_RECOVERY_FORMAT,
    operationId: recoveryId(record.operationId),
    action: "quarantine",
    outcome: "quarantined",
    snapshotId: recoverySnapshotId(record.snapshotId),
    actor: recoveryActor(record.actor),
    reason: recoveryReason(record.reason),
    startedAt,
    completedAt,
    auditHash: recoveryId(record.auditHash),
  });
}

function exactRecoveryRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidRecovery(`${label} must be an object`);
  }
  const record = input as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidRecovery(`${label} has missing or unknown fields`);
  }
  return record;
}

function recoverySnapshotId(input: unknown): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidRecovery("snapshot recovery requires a lowercase sha256 snapshot id");
  }
  return input;
}

function recoveryId(input: unknown): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidRecovery("snapshot recovery operation id must be a lowercase sha256 identity");
  }
  return input;
}

function recoveryActor(input: unknown): string {
  if (typeof input !== "string" || !PORTABLE_ACTOR_PATTERN.test(input)) {
    throw invalidRecovery("snapshot recovery actor must be a portable identifier");
  }
  return input;
}

function recoveryReason(input: unknown): string {
  if (typeof input !== "string") {
    throw invalidRecovery("snapshot recovery reason must be a string");
  }
  const reason = input.trim();
  if (reason.length === 0 || reason.length > 1000 || hasControlCharacters(reason)) {
    throw invalidRecovery(
      "snapshot recovery reason must be one printable line of 1-1000 characters",
    );
  }
  return reason;
}

function recoveryInstant(input: unknown, label: string): string {
  const value = recoveryString(input, label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw invalidRecovery(`${label} must be a normalized UTC timestamp`);
  }
  return value;
}

function recoveryString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw invalidRecovery(`${label} must be a non-empty string`);
  }
  return input;
}

function hasControlCharacters(input: string): boolean {
  return /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input);
}

function parseRecoveryJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw invalidRecovery("snapshot recovery audit file is not valid JSON");
  }
}

function hashRecovery(domain: string, input: unknown): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  hash.update("\0", "utf8");
  hash.update(JSON.stringify(input), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function snapshotId(value: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidSnapshot("snapshot id must be a lowercase sha256 identity");
  }
  return value;
}

function snapshotReference(manifest: ReadSetManifest): ReadSetSnapshotReference {
  return Object.freeze({
    format: READ_SET_SNAPSHOT_FORMAT,
    id: manifest.manifestHash,
    rowCount: manifest.result.rowCount,
    resultHash: manifest.result.resultHash,
    arrowHash: manifest.result.arrowHash,
  });
}

function writeResult(created: boolean, manifest: ReadSetManifest): ReadSetSnapshotWriteResult {
  return Object.freeze({ created, snapshot: snapshotReference(manifest) });
}

async function writeDurableFile(path: string, value: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeUnpublished(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // An unpublished temp directory is never a readable snapshot; later GC may remove the orphan.
  }
}

function isMissing(cause: unknown): boolean {
  return errorCode(cause) === "ENOENT";
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { readonly code?: unknown }).code)
    : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidStore(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_SNAPSHOT_STORE",
    message,
    "Use a writable, dedicated absolute directory and retry without reusing corrupt objects.",
  );
}

function invalidSnapshot(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_SNAPSHOT",
    message,
    "Restore the exact snapshot from trusted storage; do not silently rebuild it from current data.",
  );
}

function invalidRecovery(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_SNAPSHOT_RECOVERY",
    message,
    "Inspect the snapshot and durable recovery record; do not delete or overwrite evidence implicitly.",
  );
}
