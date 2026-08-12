import { createHash } from "node:crypto";
import { EngineConfigurationError } from "./errors.ts";

export const SOURCE_MANIFEST_FORMAT = "veil.source-manifest.v0" as const;

const SOURCE_MANIFEST_HASH_DOMAIN = "veil.source-manifest.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

export interface SourceManifestFile {
  /** Portable path relative to the binding root, always using forward slashes. */
  readonly logicalName: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface SourceManifest {
  readonly format: typeof SOURCE_MANIFEST_FORMAT;
  readonly files: readonly SourceManifestFile[];
  readonly manifestHash: string;
}

export interface SourceFingerprint {
  readonly algorithm: string;
  readonly value: string;
  readonly scope: "source-version" | "read-snapshot";
  /** Present when the backend can enumerate exact physical source members. */
  readonly manifest?: SourceManifest;
}

type SourceManifestBody = Omit<SourceManifest, "manifestHash">;

export function createSourceManifest(filesInput: readonly SourceManifestFile[]): SourceManifest {
  if (!Array.isArray(filesInput) || filesInput.length === 0) {
    throw invalidManifest("source manifest requires at least one file");
  }
  const files = filesInput.map((file, index) => normalizeFile(file, index)).sort(compareFiles);
  requireSortedUnique(files);
  const body: SourceManifestBody = {
    format: SOURCE_MANIFEST_FORMAT,
    files,
  };
  return deepFreeze({
    ...body,
    manifestHash: hashCanonical(SOURCE_MANIFEST_HASH_DOMAIN, body),
  });
}

export function verifySourceManifest(input: unknown): SourceManifest {
  const root = exactRecord(input, ["format", "files", "manifestHash"], "source manifest");
  if (root.format !== SOURCE_MANIFEST_FORMAT) {
    throw invalidManifest("source manifest uses an unsupported format");
  }
  if (!Array.isArray(root.files) || root.files.length === 0) {
    throw invalidManifest("source manifest requires a non-empty files array");
  }
  const files = root.files.map((file, index) => normalizeFile(file, index));
  requireSortedUnique(files);
  const manifestHash = sha256(root.manifestHash, "source manifest hash");
  const body: SourceManifestBody = {
    format: SOURCE_MANIFEST_FORMAT,
    files,
  };
  if (hashCanonical(SOURCE_MANIFEST_HASH_DOMAIN, body) !== manifestHash) {
    throw invalidManifest("source manifest hash does not match its files");
  }
  return deepFreeze({ ...body, manifestHash });
}

export function sourceFingerprintFromManifest(input: SourceManifest): SourceFingerprint {
  const manifest = verifySourceManifest(input);
  return deepFreeze({
    algorithm: "sha256",
    value: manifest.manifestHash.slice("sha256:".length),
    scope: "source-version",
    manifest,
  });
}

export function sourceFingerprintMatchesManifest(
  fingerprint: Pick<SourceFingerprint, "algorithm" | "value" | "scope">,
  manifest: SourceManifest,
): boolean {
  return (
    fingerprint.algorithm === "sha256" &&
    fingerprint.scope === "source-version" &&
    fingerprint.value === manifest.manifestHash.slice("sha256:".length)
  );
}

function normalizeFile(input: unknown, index: number): SourceManifestFile {
  const file = exactRecord(
    input,
    ["logicalName", "byteLength", "contentHash"],
    `source manifest file ${index}`,
  );
  const logicalName = nonemptyString(
    file.logicalName,
    `source manifest file ${index} logical name`,
  );
  validateLogicalName(logicalName);
  if (
    typeof file.byteLength !== "number" ||
    !Number.isSafeInteger(file.byteLength) ||
    file.byteLength < 0
  ) {
    throw invalidManifest(`source manifest file ${index} byte length is invalid`);
  }
  return {
    logicalName,
    byteLength: file.byteLength,
    contentHash: sha256(file.contentHash, `source manifest file ${index} content hash`),
  };
}

function validateLogicalName(value: string): void {
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    WINDOWS_DRIVE_PATTERN.test(value) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw invalidManifest("source manifest logical names must be portable root-relative paths");
  }
}

function requireSortedUnique(files: readonly SourceManifestFile[]): void {
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareText(previous.logicalName, current.logicalName) >= 0
    ) {
      throw invalidManifest("source manifest files must have unique names sorted by logical name");
    }
  }
}

function compareFiles(left: SourceManifestFile, right: SourceManifestFile): number {
  return compareText(left.logicalName, right.logicalName);
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidManifest(`${field} must be an object`);
  }
  const record = input as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidManifest(`${field} has missing or unknown fields`);
  }
  return record;
}

function nonemptyString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw invalidManifest(`${field} must be a non-empty string`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  const value = nonemptyString(input, field);
  if (!SHA256_PATTERN.test(value)) {
    throw invalidManifest(`${field} must be a lowercase sha256 identity`);
  }
  return value;
}

function hashCanonical(domain: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
  return `sha256:${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw invalidManifest("source manifest contains an unsupported canonical value");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function invalidManifest(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_SOURCE_MANIFEST",
    message,
    "Regenerate the manifest from stable root-relative names and exact source bytes.",
  );
}
