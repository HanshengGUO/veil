import { createHash } from "node:crypto";
import { normalizeDecisionTime } from "@veilquant/contract";
import { EngineConfigurationError } from "./errors.ts";

export const SOURCE_MANIFEST_FORMAT = "veil.source-manifest.v0" as const;
export const COMPOSITE_SOURCE_MANIFEST_FORMAT = "veil.composite-source-manifest.v0" as const;
export const COMPOSITE_SOURCE_JOIN_VERSION = "veil.primary-membership-mask.v0" as const;

const SOURCE_MANIFEST_HASH_DOMAIN = "veil.source-manifest.v0";
const COMPOSITE_SOURCE_MANIFEST_HASH_DOMAIN = "veil.composite-source-manifest.v0";
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

export interface CompositeSourceComponentIdentity {
  readonly dataset: string;
  readonly adapterVersion: string;
  readonly declarationHash: string;
  readonly readSetId: string;
  readonly asOf: string;
  readonly resultHash: string;
  readonly arrowHash: string;
}

export interface CompositeSourceJoin {
  readonly version: typeof COMPOSITE_SOURCE_JOIN_VERSION;
  readonly primary: {
    readonly entityKey: string;
    readonly eventTime: string;
    readonly availableTime: string;
    readonly maskColumn: string;
  };
  readonly membership: {
    readonly entityKey: string;
    readonly eventTime: string;
    readonly availableTime: string;
    readonly membershipColumn: string;
  };
  readonly output: {
    readonly entityKey: string;
    readonly eventTime: string;
    readonly availableTime: string;
    readonly membershipColumn: string;
    readonly maskColumn: string;
  };
}

export interface CompositeSourceManifest {
  readonly format: typeof COMPOSITE_SOURCE_MANIFEST_FORMAT;
  readonly output: {
    readonly dataset: string;
    readonly adapterVersion: string;
    readonly declarationHash: string;
  };
  readonly primary: CompositeSourceComponentIdentity;
  readonly membership: CompositeSourceComponentIdentity;
  readonly join: CompositeSourceJoin;
  readonly audit: {
    readonly primaryRows: number;
    readonly membershipRows: number;
    readonly matchedRows: number;
    readonly eligibleRows: number;
    readonly droppedByPrimaryMask: number;
    readonly droppedByMembership: number;
    readonly unusedMembershipRows: number;
  };
  readonly result: {
    readonly schemaHash: string;
    readonly rowCount: number;
    readonly resultHash: string;
    readonly arrowHash: string;
  };
  readonly manifestHash: string;
}

export type SourceEvidenceManifest = SourceManifest | CompositeSourceManifest;

export interface SourceFingerprint {
  readonly algorithm: string;
  readonly value: string;
  readonly scope: "source-version" | "read-snapshot";
  /** Present when a file backend can enumerate exact physical source members. */
  readonly manifest?: SourceManifest;
  /** Present when a derived backend can provide replayable non-file source evidence. */
  readonly evidence?: CompositeSourceManifest;
}

type SourceManifestBody = Omit<SourceManifest, "manifestHash">;
type CompositeSourceManifestBody = Omit<CompositeSourceManifest, "manifestHash">;

export interface CreateCompositeSourceManifestInput {
  readonly output: CompositeSourceManifest["output"];
  readonly primary: CompositeSourceComponentIdentity;
  readonly membership: CompositeSourceComponentIdentity;
  readonly join: CompositeSourceJoin;
  readonly audit: CompositeSourceManifest["audit"];
  readonly result: CompositeSourceManifest["result"];
}

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

export function createCompositeSourceManifest(
  input: CreateCompositeSourceManifestInput,
): CompositeSourceManifest {
  const body = normalizeCompositeBody({
    format: COMPOSITE_SOURCE_MANIFEST_FORMAT,
    output: input.output,
    primary: input.primary,
    membership: input.membership,
    join: input.join,
    audit: input.audit,
    result: input.result,
  });
  return deepFreeze({
    ...body,
    manifestHash: hashCanonical(COMPOSITE_SOURCE_MANIFEST_HASH_DOMAIN, body),
  });
}

export function verifyCompositeSourceManifest(input: unknown): CompositeSourceManifest {
  const root = exactRecord(
    input,
    ["format", "output", "primary", "membership", "join", "audit", "result", "manifestHash"],
    "composite source manifest",
  );
  const body = normalizeCompositeBody({
    format: root.format,
    output: root.output,
    primary: root.primary,
    membership: root.membership,
    join: root.join,
    audit: root.audit,
    result: root.result,
  });
  const manifestHash = sha256(root.manifestHash, "composite source manifest hash");
  if (hashCanonical(COMPOSITE_SOURCE_MANIFEST_HASH_DOMAIN, body) !== manifestHash) {
    throw invalidManifest("composite source manifest hash does not match its evidence");
  }
  return deepFreeze({ ...body, manifestHash });
}

export function verifySourceEvidenceManifest(input: unknown): SourceEvidenceManifest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidManifest("source evidence manifest must be an object");
  }
  const format = (input as Record<string, unknown>).format;
  if (format === SOURCE_MANIFEST_FORMAT) return verifySourceManifest(input);
  if (format === COMPOSITE_SOURCE_MANIFEST_FORMAT) return verifyCompositeSourceManifest(input);
  throw invalidManifest("source evidence manifest uses an unsupported format");
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

export function sourceFingerprintFromCompositeManifest(
  input: CompositeSourceManifest,
): SourceFingerprint {
  const manifest = verifyCompositeSourceManifest(input);
  return deepFreeze({
    algorithm: "sha256",
    value: manifest.manifestHash.slice("sha256:".length),
    scope: "read-snapshot",
    evidence: manifest,
  });
}

export function sourceFingerprintMatchesManifest(
  fingerprint: Pick<SourceFingerprint, "algorithm" | "value" | "scope">,
  manifest: SourceEvidenceManifest,
): boolean {
  const expectedScope =
    manifest.format === SOURCE_MANIFEST_FORMAT ? "source-version" : "read-snapshot";
  return (
    fingerprint.algorithm === "sha256" &&
    fingerprint.scope === expectedScope &&
    fingerprint.value === manifest.manifestHash.slice("sha256:".length)
  );
}

function normalizeCompositeBody(input: unknown): CompositeSourceManifestBody {
  const root = exactRecord(
    input,
    ["format", "output", "primary", "membership", "join", "audit", "result"],
    "composite source manifest body",
  );
  if (root.format !== COMPOSITE_SOURCE_MANIFEST_FORMAT) {
    throw invalidManifest("composite source manifest uses an unsupported format");
  }
  const output = exactRecord(
    root.output,
    ["dataset", "adapterVersion", "declarationHash"],
    "composite output identity",
  );
  const audit = exactRecord(
    root.audit,
    [
      "primaryRows",
      "membershipRows",
      "matchedRows",
      "eligibleRows",
      "droppedByPrimaryMask",
      "droppedByMembership",
      "unusedMembershipRows",
    ],
    "composite source audit",
  );
  const result = exactRecord(
    root.result,
    ["schemaHash", "rowCount", "resultHash", "arrowHash"],
    "composite source result",
  );
  const normalizedAudit = {
    primaryRows: nonnegativeInteger(audit.primaryRows, "composite primary row count"),
    membershipRows: nonnegativeInteger(audit.membershipRows, "composite membership row count"),
    matchedRows: nonnegativeInteger(audit.matchedRows, "composite matched row count"),
    eligibleRows: nonnegativeInteger(audit.eligibleRows, "composite eligible row count"),
    droppedByPrimaryMask: nonnegativeInteger(
      audit.droppedByPrimaryMask,
      "composite primary-mask drop count",
    ),
    droppedByMembership: nonnegativeInteger(
      audit.droppedByMembership,
      "composite membership drop count",
    ),
    unusedMembershipRows: nonnegativeInteger(
      audit.unusedMembershipRows,
      "composite unused membership row count",
    ),
  };
  if (
    normalizedAudit.matchedRows !== normalizedAudit.primaryRows ||
    normalizedAudit.eligibleRows +
      normalizedAudit.droppedByPrimaryMask +
      normalizedAudit.droppedByMembership !==
      normalizedAudit.primaryRows ||
    normalizedAudit.unusedMembershipRows !==
      normalizedAudit.membershipRows - normalizedAudit.matchedRows
  ) {
    throw invalidManifest("composite source audit counts are inconsistent");
  }
  const normalizedResult = {
    schemaHash: sha256(result.schemaHash, "composite result schema hash"),
    rowCount: nonnegativeInteger(result.rowCount, "composite result row count"),
    resultHash: sha256(result.resultHash, "composite result hash"),
    arrowHash: sha256(result.arrowHash, "composite result Arrow hash"),
  };
  if (normalizedResult.rowCount !== normalizedAudit.primaryRows) {
    throw invalidManifest("composite result row count does not match its primary evidence");
  }
  const primary = normalizeCompositeComponent(root.primary, "primary");
  const membership = normalizeCompositeComponent(root.membership, "membership");
  if (primary.asOf !== membership.asOf) {
    throw invalidManifest("composite source components use different as-of times");
  }
  const join = normalizeCompositeJoin(root.join);
  if (
    join.output.entityKey !== join.primary.entityKey ||
    join.output.eventTime !== join.primary.eventTime
  ) {
    throw invalidManifest("composite output keys must preserve the primary source keys");
  }
  return {
    format: COMPOSITE_SOURCE_MANIFEST_FORMAT,
    output: {
      dataset: portableName(output.dataset, "composite output dataset"),
      adapterVersion: nonemptyString(output.adapterVersion, "composite output adapter version"),
      declarationHash: sha256(output.declarationHash, "composite output declaration hash"),
    },
    primary,
    membership,
    join,
    audit: normalizedAudit,
    result: normalizedResult,
  };
}

function normalizeCompositeComponent(
  input: unknown,
  role: "primary" | "membership",
): CompositeSourceComponentIdentity {
  const component = exactRecord(
    input,
    [
      "dataset",
      "adapterVersion",
      "declarationHash",
      "readSetId",
      "asOf",
      "resultHash",
      "arrowHash",
    ],
    `composite ${role} identity`,
  );
  return {
    dataset: portableName(component.dataset, `composite ${role} dataset`),
    adapterVersion: nonemptyString(component.adapterVersion, `composite ${role} adapter version`),
    declarationHash: sha256(component.declarationHash, `composite ${role} declaration hash`),
    readSetId: sha256(component.readSetId, `composite ${role} read-set id`),
    asOf: normalizedInstant(component.asOf, `composite ${role} as-of`),
    resultHash: sha256(component.resultHash, `composite ${role} result hash`),
    arrowHash: sha256(component.arrowHash, `composite ${role} Arrow hash`),
  };
}

function normalizeCompositeJoin(input: unknown): CompositeSourceJoin {
  const join = exactRecord(
    input,
    ["version", "primary", "membership", "output"],
    "composite source join",
  );
  if (join.version !== COMPOSITE_SOURCE_JOIN_VERSION) {
    throw invalidManifest("composite source join uses an unsupported version");
  }
  const primary = exactRecord(
    join.primary,
    ["entityKey", "eventTime", "availableTime", "maskColumn"],
    "composite primary join",
  );
  const membership = exactRecord(
    join.membership,
    ["entityKey", "eventTime", "availableTime", "membershipColumn"],
    "composite membership join",
  );
  const output = exactRecord(
    join.output,
    ["entityKey", "eventTime", "availableTime", "membershipColumn", "maskColumn"],
    "composite output join",
  );
  return {
    version: COMPOSITE_SOURCE_JOIN_VERSION,
    primary: {
      entityKey: columnName(primary.entityKey, "composite primary entity key"),
      eventTime: columnName(primary.eventTime, "composite primary event time"),
      availableTime: columnName(primary.availableTime, "composite primary available time"),
      maskColumn: columnName(primary.maskColumn, "composite primary mask"),
    },
    membership: {
      entityKey: columnName(membership.entityKey, "composite membership entity key"),
      eventTime: columnName(membership.eventTime, "composite membership event time"),
      availableTime: columnName(membership.availableTime, "composite membership available time"),
      membershipColumn: columnName(membership.membershipColumn, "composite membership column"),
    },
    output: {
      entityKey: columnName(output.entityKey, "composite output entity key"),
      eventTime: columnName(output.eventTime, "composite output event time"),
      availableTime: columnName(output.availableTime, "composite output available time"),
      membershipColumn: columnName(output.membershipColumn, "composite output membership column"),
      maskColumn: columnName(output.maskColumn, "composite output mask"),
    },
  };
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

function portableName(input: unknown, field: string): string {
  const value = nonemptyString(input, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw invalidManifest(`${field} must be a portable identifier`);
  }
  return value;
}

function columnName(input: unknown, field: string): string {
  const value = nonemptyString(input, field);
  if (value.trim() !== value || value.includes("\0")) {
    throw invalidManifest(`${field} must be a normalized column name`);
  }
  return value;
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidManifest(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function normalizedInstant(input: unknown, field: string): string {
  const value = nonemptyString(input, field);
  try {
    if (normalizeDecisionTime(value) !== value) throw new Error("not normalized");
  } catch {
    throw invalidManifest(`${field} must be a normalized decision time`);
  }
  return value;
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
