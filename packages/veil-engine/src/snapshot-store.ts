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

const OBJECTS_DIRECTORY = "read-set-snapshots-v0";
const MANIFEST_FILE = "manifest.json";
const ARROW_FILE = "data.arrow";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STORE_CONSTRUCTOR_TOKEN = Symbol("ReadSetSnapshotStore");

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

  async #readIfPresent(
    id: string,
    evidence: ReadSetSnapshotEvidence = {},
  ): Promise<ReadSetSnapshot | null> {
    const location = this.#location(id);
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

  #location(id: string): {
    readonly hex: string;
    readonly shard: string;
    readonly snapshot: string;
  } {
    const hex = id.slice("sha256:".length);
    const shard = join(this.#objectsRoot, hex.slice(0, 2));
    return Object.freeze({ hex, shard, snapshot: join(shard, hex) });
  }
}

export async function openReadSetSnapshotStore(
  input: ReadSetSnapshotStoreInput,
): Promise<ReadSetSnapshotStore> {
  return ReadSetSnapshotStore.open(input);
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
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  );
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
