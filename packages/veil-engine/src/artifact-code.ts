import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { EngineConfigurationError } from "./errors.ts";

export const ARTIFACT_CODE_FORMAT = "veil.artifact-code.v0" as const;

const ARTIFACT_CODE_HASH_DOMAIN = "veil.artifact-code.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const WINDOWS_FORBIDDEN_PUNCTUATION = '<>:"|?*';
const WINDOWS_RESERVED_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const SENSITIVE_CODE_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
]);

export interface ArtifactCodeCaptureInput {
  /** Local-only absolute directory. It is never serialized or hashed. */
  readonly root: string;
  /** Explicit portable root-relative files that form the executable package. */
  readonly files: readonly string[];
}

export interface ArtifactCodeFile {
  readonly logicalName: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface ArtifactCodeManifest {
  readonly format: typeof ARTIFACT_CODE_FORMAT;
  readonly files: readonly ArtifactCodeFile[];
  readonly treeHash: string;
}

type ArtifactCodeManifestBody = Omit<ArtifactCodeManifest, "treeHash">;

/** Captures one stable, explicit code set without putting its local root into the identity. */
export async function captureArtifactCode(
  input: ArtifactCodeCaptureInput,
): Promise<ArtifactCodeManifest> {
  const record = exactRecord(input, ["root", "files"], "artifact code capture input");
  const root = await resolveCodeRoot(record.root);
  const files = normalizeLogicalNames(record.files);

  let before: ArtifactCodeManifest;
  try {
    before = await captureOnce(root, files);
  } catch (cause) {
    if (cause instanceof EngineConfigurationError) {
      throw cause;
    }
    throw invalidCode("artifact code files could not be read beneath the package root");
  }

  let after: ArtifactCodeManifest;
  try {
    after = await captureOnce(root, files);
  } catch {
    throw codeChanged();
  }
  if (before.treeHash !== after.treeHash) {
    throw codeChanged();
  }
  return before;
}

/** Verifies ordering, paths, file identities, and the aggregate code-tree hash. */
export function verifyArtifactCodeManifest(input: unknown): ArtifactCodeManifest {
  const root = exactRecord(input, ["format", "files", "treeHash"], "artifact code manifest");
  if (root.format !== ARTIFACT_CODE_FORMAT) {
    throw invalidCode("artifact code manifest uses an unsupported format");
  }
  if (!Array.isArray(root.files) || root.files.length === 0) {
    throw invalidCode("artifact code manifest requires a non-empty files array");
  }
  const files = root.files.map((file, index) => normalizeManifestFile(file, index));
  requireSortedUnique(files.map((file) => file.logicalName));
  const treeHash = sha256(root.treeHash, "artifact code tree hash");
  const body: ArtifactCodeManifestBody = { format: ARTIFACT_CODE_FORMAT, files };
  if (hashCanonical(ARTIFACT_CODE_HASH_DOMAIN, body) !== treeHash) {
    throw invalidCode("artifact code tree hash does not match its file manifest");
  }
  return deepFreeze({ ...body, treeHash });
}

/** Re-hashes the declared files from another checkout and compares them to the portable manifest. */
export async function verifyArtifactCode(
  root: string,
  input: unknown,
): Promise<ArtifactCodeManifest> {
  const expected = verifyArtifactCodeManifest(input);
  const actual = await captureArtifactCode({
    root,
    files: expected.files.map((file) => file.logicalName),
  });
  if (actual.treeHash !== expected.treeHash) {
    throw invalidCode("artifact code bytes differ from the declared content identity");
  }
  return expected;
}

async function captureOnce(
  root: string,
  logicalNames: readonly string[],
): Promise<ArtifactCodeManifest> {
  const files: ArtifactCodeFile[] = [];
  for (const logicalName of logicalNames) {
    const path = await resolveCodeFile(root, logicalName);
    const identity = await hashFile(path);
    const finalStatus = await lstat(path);
    if (!finalStatus.isFile() || finalStatus.isSymbolicLink()) {
      throw codeChanged();
    }
    files.push({ logicalName, ...identity });
  }
  const body: ArtifactCodeManifestBody = { format: ARTIFACT_CODE_FORMAT, files };
  return deepFreeze({
    ...body,
    treeHash: hashCanonical(ARTIFACT_CODE_HASH_DOMAIN, body),
  });
}

async function resolveCodeRoot(input: unknown): Promise<string> {
  if (typeof input !== "string" || !isAbsolute(input)) {
    throw invalidCode("artifact code root must be an absolute path");
  }
  const requested = resolve(input);
  if (requested === parse(requested).root) {
    throw invalidCode("artifact code root cannot be a filesystem root");
  }
  try {
    const canonical = await realpath(requested);
    if (canonical === parse(canonical).root || !(await lstat(canonical)).isDirectory()) {
      throw invalidCode("artifact code root must resolve to a dedicated directory");
    }
    return canonical;
  } catch (cause) {
    if (cause instanceof EngineConfigurationError) {
      throw cause;
    }
    throw invalidCode("artifact code root does not resolve to a readable directory");
  }
}

function normalizeLogicalNames(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidCode("artifact code capture requires at least one explicit file");
  }
  const files = input.map((value) => logicalName(value)).sort(compareText);
  requireSortedUnique(files);
  return Object.freeze(files);
}

function normalizeManifestFile(input: unknown, index: number): ArtifactCodeFile {
  const file = exactRecord(
    input,
    ["logicalName", "byteLength", "contentHash"],
    `artifact code file ${index}`,
  );
  if (
    typeof file.byteLength !== "number" ||
    !Number.isSafeInteger(file.byteLength) ||
    file.byteLength < 0
  ) {
    throw invalidCode(`artifact code file ${index} byte length is invalid`);
  }
  return {
    logicalName: logicalName(file.logicalName),
    byteLength: file.byteLength,
    contentHash: sha256(file.contentHash, `artifact code file ${index} content hash`),
  };
}

function logicalName(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 1024) {
    throw invalidCode("artifact code file names must be non-empty portable paths");
  }
  const segments = input.split("/");
  if (
    input.trim() !== input ||
    input.includes("\\") ||
    isAbsolute(input) ||
    WINDOWS_DRIVE_PATTERN.test(input) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 255 ||
        segment === "." ||
        segment === ".." ||
        hasWindowsForbiddenCharacter(segment) ||
        WINDOWS_RESERVED_PATTERN.test(segment) ||
        /[ .]$/u.test(segment),
    )
  ) {
    throw invalidCode("artifact code file names must be portable normalized root-relative paths");
  }
  const basename = segments.at(-1)?.toLowerCase();
  if (
    basename === undefined ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    SENSITIVE_CODE_FILE_NAMES.has(basename)
  ) {
    throw invalidCode("artifact code packages cannot include known credential-bearing files");
  }
  return input;
}

function hasWindowsForbiddenCharacter(input: string): boolean {
  return [...input].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || WINDOWS_FORBIDDEN_PUNCTUATION.includes(character);
  });
}

function requireSortedUnique(files: readonly string[]): void {
  const caseFolded = new Set<string>();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const previous = files[index - 1];
    if (file === undefined || (previous !== undefined && compareText(previous, file) >= 0)) {
      throw invalidCode("artifact code files must have unique names sorted by logical path");
    }
    const folded = file.toLowerCase();
    if (caseFolded.has(folded)) {
      throw invalidCode("artifact code file names must also be unique on case-insensitive systems");
    }
    caseFolded.add(folded);
  }
}

async function resolveCodeFile(root: string, logicalName: string): Promise<string> {
  const segments = logicalName.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      throw invalidCode("artifact code path could not be resolved");
    }
    current = join(current, segment);
    const status = await lstat(current);
    if (status.isSymbolicLink()) {
      throw invalidCode("artifact code packages cannot contain symbolic links");
    }
    const final = index === segments.length - 1;
    if ((final && !status.isFile()) || (!final && !status.isDirectory())) {
      throw invalidCode("artifact code members must resolve to regular files");
    }
  }
  const canonical = await realpath(current);
  const relation = relative(root, canonical);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw invalidCode("artifact code member resolves outside its package root");
  }
  return canonical;
}

async function hashFile(path: string): Promise<{ byteLength: number; contentHash: string }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    byteLength += bytes.byteLength;
    if (!Number.isSafeInteger(byteLength)) {
      throw invalidCode("artifact code file exceeds the supported byte length");
    }
    hash.update(bytes);
  }
  return { byteLength, contentHash: `sha256:${hash.digest("hex")}` };
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidCode(`${field} must be an object`);
  }
  const record = input as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidCode(`${field} has missing or unknown fields`);
  }
  return record;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidCode(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function hashCanonical(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw invalidCode("artifact code manifest contains an unsupported canonical value");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidCode(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_ARTIFACT_CODE",
    message,
    "Use explicit regular files beneath one dedicated root and regenerate the content manifest.",
  );
}

function codeChanged(): EngineConfigurationError {
  return new EngineConfigurationError(
    "ARTIFACT_CODE_CHANGED",
    "artifact code membership or content changed while its identity was being captured",
    "Retry from a stable checkout or immutable source tree before packaging the artifact.",
  );
}
