import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { VeilAgentError } from "./errors.ts";
import { projectOutputPath } from "./project.ts";

export async function writeImmutableProjectFile(input: {
  readonly projectRoot: string;
  readonly reference: string;
  readonly bytes: Uint8Array | string;
}): Promise<void> {
  const path = projectOutputPath(input.projectRoot, input.reference);
  await prepareParent(input.projectRoot, dirname(path));
  try {
    await writeFile(path, input.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw storageError("immutable project file could not be written");
    await requireSafeExistingFile(input.projectRoot, path);
    const existing = await readFile(path);
    const expected =
      typeof input.bytes === "string" ? Buffer.from(input.bytes, "utf8") : Buffer.from(input.bytes);
    if (!existing.equals(expected)) {
      throw storageError("immutable project reference already contains different bytes");
    }
  }
}

export async function appendProjectLog(input: {
  readonly projectRoot: string;
  readonly reference: string;
  readonly header: string;
  readonly entry: string;
}): Promise<void> {
  const path = projectOutputPath(input.projectRoot, input.reference);
  await prepareParent(input.projectRoot, dirname(path));
  let prefix = input.header;
  try {
    await requireSafeExistingFile(input.projectRoot, path);
    prefix = "";
  } catch (error) {
    if (!(error instanceof VeilAgentError) || error.code !== "STORE_NOT_FOUND") throw error;
  }
  try {
    await appendFile(path, `${prefix}${input.entry}`, { encoding: "utf8", mode: 0o600 });
  } catch {
    throw storageError("research log could not be appended");
  }
}

export function hashBytes(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalJson(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

function sortJson(input: unknown): unknown {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw storageError("portable evidence contains a non-canonical number");
    }
    return input;
  }
  if (Array.isArray(input)) return input.map(sortJson);
  if (typeof input === "object") {
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) throw storageError("portable evidence contains undefined");
      output[key] = sortJson(value);
    }
    return output;
  }
  throw storageError("portable evidence contains an unsupported value");
}

async function prepareParent(projectRoot: string, parent: string): Promise<void> {
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(projectRoot);
    const canonicalParent = await realpath(parent);
    if (!isWithin(canonicalRoot, canonicalParent)) {
      throw storageError("project output parent escapes through a symbolic link");
    }
  } catch (error) {
    if (error instanceof VeilAgentError) throw error;
    throw storageError("project output directory could not be prepared");
  }
}

async function requireSafeExistingFile(projectRoot: string, path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw storageError("project output reference is not a regular file");
    }
    const canonicalRoot = await realpath(projectRoot);
    const canonicalPath = await realpath(path);
    if (!isWithin(canonicalRoot, canonicalPath)) {
      throw storageError("project output file escapes through a symbolic link");
    }
  } catch (error) {
    if (error instanceof VeilAgentError) throw error;
    throw new VeilAgentError(
      "STORE_NOT_FOUND",
      "project output file does not exist",
      "Create it through Veil so its append-only boundary is preserved.",
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function storageError(message: string): VeilAgentError {
  return new VeilAgentError(
    "STORE_WRITE_FAILED",
    message,
    "Remove the conflicting local output, verify project-directory permissions, and retry.",
  );
}
