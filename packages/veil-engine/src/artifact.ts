import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  type AdapterDeclaration,
  canonicalizeAdapterDeclaration,
  hashAdapterDeclaration,
  normalizeAdapterDeclaration,
} from "@veilquant/contract";
import { type ArtifactCodeManifest, verifyArtifactCodeManifest } from "./artifact-code.ts";
import { EngineConfigurationError } from "./errors.ts";

export const ARTIFACT_FORMAT = "veil.artifact.v0" as const;

const ARTIFACT_HASH_DOMAIN = "veil.artifact.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]{0,127}$/;
const CALLABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
const RUNTIME_CONSTRAINT_PATTERN = /^[A-Za-z0-9 .<>=!^~*+,_|()-]+$/;
const WINDOWS_ABSOLUTE_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const SECRET_PARAMETER_NAMES = new Set([
  "accesstoken",
  "accesskey",
  "accesskeyid",
  "apikey",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "dsn",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "secretaccesskey",
  "token",
]);

export type ArtifactParameterValue =
  | null
  | boolean
  | number
  | string
  | readonly ArtifactParameterValue[]
  | { readonly [key: string]: ArtifactParameterValue };

export interface ArtifactRuntime {
  /** Logical runtime provider id, resolved outside the portable manifest. */
  readonly id: string;
  /** A portable version constraint, never an executable path. */
  readonly constraint: string;
}

export interface ArtifactEntrypoint {
  readonly file: string;
  readonly callable: string;
}

export interface ArtifactFactor {
  readonly runtime: ArtifactRuntime;
  readonly entry: ArtifactEntrypoint;
  readonly code: ArtifactCodeManifest;
}

export interface ArtifactDatasetSemantics {
  readonly dataset: string;
  readonly version: string;
  readonly declarationHash: string;
  /** Exact exploration inputs for this declaration; window read-sets remain execution evidence. */
  readonly developmentReadSets: readonly string[];
}

export interface ArtifactDataSemantics {
  readonly datasets: readonly ArtifactDatasetSemantics[];
}

export interface CreateArtifactDatasetSemanticsInput {
  readonly declaration: AdapterDeclaration;
  readonly developmentReadSets: readonly string[];
}

export interface ArtifactProtocol {
  readonly mode: "rolling" | "expanding";
  readonly folds: number;
  /** Rolling window length, or the initial window length for expanding evaluation. */
  readonly trainDays: number;
  readonly oosDays: number;
  readonly purgeDays: number;
  readonly embargoDays: number;
  readonly holdDays: number;
}

export interface ArtifactManifest {
  readonly format: typeof ARTIFACT_FORMAT;
  readonly factor: ArtifactFactor;
  readonly paramsLocked: Readonly<Record<string, ArtifactParameterValue>>;
  readonly declaredLiterals: Readonly<Record<string, ArtifactParameterValue>>;
  /** Total explored candidates including this artifact. */
  readonly trialsDeclared: number;
  readonly dataSemantics: ArtifactDataSemantics;
  readonly hypothesisRef: string;
  readonly protocol: ArtifactProtocol;
  readonly costModel: string;
  readonly artifactHash: string;
}

export interface CreateArtifactManifestInput {
  readonly factor: ArtifactFactor;
  readonly paramsLocked: Readonly<Record<string, unknown>>;
  readonly declaredLiterals: Readonly<Record<string, unknown>>;
  readonly trialsDeclared: number;
  readonly dataSemantics: {
    readonly datasets: readonly CreateArtifactDatasetSemanticsInput[];
  };
  readonly hypothesisRef: string;
  readonly protocol: ArtifactProtocol;
  readonly costModel: string;
}

export interface ArtifactVerificationEvidence {
  readonly expectedArtifactHash?: string;
  readonly dataSemantics?: {
    readonly datasets: readonly CreateArtifactDatasetSemanticsInput[];
  };
}

type ArtifactManifestBody = Omit<ArtifactManifest, "artifactHash">;

/** Creates a portable artifact identity from captured code and independently hashed declarations. */
export function createArtifactManifest(input: CreateArtifactManifestInput): ArtifactManifest {
  const root = exactRecord(
    input,
    [
      "factor",
      "paramsLocked",
      "declaredLiterals",
      "trialsDeclared",
      "dataSemantics",
      "hypothesisRef",
      "protocol",
      "costModel",
    ],
    "artifact creation input",
  );
  const paramsLocked = normalizeParameterMap(root.paramsLocked, "locked parameter");
  const declaredLiterals = normalizeParameterMap(root.declaredLiterals, "declared literal");
  rejectParameterOverlap(paramsLocked, declaredLiterals);
  const body: ArtifactManifestBody = {
    format: ARTIFACT_FORMAT,
    factor: normalizeFactor(root.factor),
    paramsLocked,
    declaredLiterals,
    trialsDeclared: positiveInteger(root.trialsDeclared, "declared trial count"),
    dataSemantics: createDataSemantics(root.dataSemantics),
    hypothesisRef: portableReference(root.hypothesisRef, "hypothesis reference"),
    protocol: normalizeProtocol(root.protocol),
    costModel: portableReference(root.costModel, "cost model reference"),
  };
  return deepFreeze({
    ...body,
    artifactHash: hashCanonical(ARTIFACT_HASH_DOMAIN, body),
  });
}

/** Recomputes the complete identity and optionally cross-checks declaration/read-set evidence. */
export function verifyArtifactManifest(
  input: unknown,
  evidenceInput: ArtifactVerificationEvidence = {},
): ArtifactManifest {
  const root = exactRecord(
    input,
    [
      "format",
      "factor",
      "paramsLocked",
      "declaredLiterals",
      "trialsDeclared",
      "dataSemantics",
      "hypothesisRef",
      "protocol",
      "costModel",
      "artifactHash",
    ],
    "artifact manifest",
  );
  if (root.format !== ARTIFACT_FORMAT) {
    throw invalidArtifact("artifact manifest uses an unsupported format");
  }
  const paramsLocked = normalizeParameterMap(root.paramsLocked, "locked parameter");
  const declaredLiterals = normalizeParameterMap(root.declaredLiterals, "declared literal");
  rejectParameterOverlap(paramsLocked, declaredLiterals);
  const body: ArtifactManifestBody = {
    format: ARTIFACT_FORMAT,
    factor: normalizeFactor(root.factor),
    paramsLocked,
    declaredLiterals,
    trialsDeclared: positiveInteger(root.trialsDeclared, "declared trial count"),
    dataSemantics: normalizeDataSemantics(root.dataSemantics),
    hypothesisRef: portableReference(root.hypothesisRef, "hypothesis reference"),
    protocol: normalizeProtocol(root.protocol),
    costModel: portableReference(root.costModel, "cost model reference"),
  };
  const artifactHash = sha256(root.artifactHash, "artifact hash");
  if (hashCanonical(ARTIFACT_HASH_DOMAIN, body) !== artifactHash) {
    throw invalidArtifact("artifact hash does not match its normalized manifest");
  }

  const evidence = normalizeEvidence(evidenceInput);
  if (
    evidence.expectedArtifactHash !== undefined &&
    evidence.expectedArtifactHash !== artifactHash
  ) {
    throw invalidArtifact("artifact identity differs from the expected content id");
  }
  if (evidence.dataSemantics !== undefined) {
    const supplied = createDataSemantics(evidence.dataSemantics).datasets;
    if (canonicalJson(supplied) !== canonicalJson(body.dataSemantics.datasets)) {
      throw invalidArtifact("artifact data semantics differ from the supplied evidence");
    }
  }
  return deepFreeze({ ...body, artifactHash });
}

function normalizeFactor(input: unknown): ArtifactFactor {
  const factor = exactRecord(input, ["runtime", "entry", "code"], "artifact factor");
  const runtime = exactRecord(factor.runtime, ["id", "constraint"], "artifact runtime");
  const entry = exactRecord(factor.entry, ["file", "callable"], "artifact entrypoint");
  const code = verifyArtifactCodeManifest(factor.code);
  const file = portableCodePath(entry.file);
  if (!code.files.some((candidate) => candidate.logicalName === file)) {
    throw invalidArtifact("artifact entrypoint file is absent from the captured code tree");
  }
  const callable = singleLine(entry.callable, "artifact callable", 128);
  if (!CALLABLE_PATTERN.test(callable)) {
    throw invalidArtifact("artifact callable must be a portable dotted identifier");
  }
  return {
    runtime: {
      id: portableReference(runtime.id, "runtime id"),
      constraint: portableConstraint(runtime.constraint),
    },
    entry: { file, callable },
    code,
  };
}

function createDataSemantics(input: unknown): ArtifactDataSemantics {
  const data = exactRecord(input, ["datasets"], "artifact data semantics");
  if (!Array.isArray(data.datasets) || data.datasets.length === 0) {
    throw invalidArtifact("artifact data semantics require at least one adapter declaration");
  }
  return { datasets: datasetReferences(data.datasets) };
}

function normalizeDataSemantics(input: unknown): ArtifactDataSemantics {
  const data = exactRecord(input, ["datasets"], "artifact data semantics");
  if (!Array.isArray(data.datasets) || data.datasets.length === 0) {
    throw invalidArtifact("artifact data semantics require a non-empty datasets array");
  }
  const datasets = data.datasets.map((value, index) => normalizeDatasetReference(value, index));
  requireSortedDatasets(datasets);
  return { datasets };
}

function datasetReferences(input: readonly unknown[]): readonly ArtifactDatasetSemantics[] {
  const datasets = input
    .map((value, index) => {
      const dataset = exactRecord(
        value,
        ["declaration", "developmentReadSets"],
        `artifact dataset input ${index}`,
      );
      const declaration = normalizedDeclaration(dataset.declaration);
      return {
        dataset: declaration.dataset,
        version: portableVersion(declaration.version),
        declarationHash: hashAdapterDeclaration(declaration),
        developmentReadSets: normalizeReadSetIds(
          dataset.developmentReadSets,
          `artifact dataset input ${index}`,
          true,
        ),
      };
    })
    .sort(compareDatasets);
  requireSortedDatasets(datasets);
  return datasets;
}

function normalizeDatasetReference(input: unknown, index: number): ArtifactDatasetSemantics {
  const dataset = exactRecord(
    input,
    ["dataset", "version", "declarationHash", "developmentReadSets"],
    `artifact dataset ${index}`,
  );
  return {
    dataset: datasetName(dataset.dataset),
    version: portableVersion(dataset.version),
    declarationHash: sha256(dataset.declarationHash, `artifact dataset ${index} declaration hash`),
    developmentReadSets: normalizeReadSetIds(
      dataset.developmentReadSets,
      `artifact dataset ${index}`,
      false,
    ),
  };
}

function normalizedDeclaration(input: unknown): AdapterDeclaration {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("not an object");
    }
    const candidate = input as AdapterDeclaration;
    const normalized = normalizeAdapterDeclaration({
      dataset: candidate.dataset,
      version: candidate.version,
      entity_key: candidate.entityKey,
      event_time: candidate.eventTime,
      available_time: candidate.availableTime,
      availability_basis:
        candidate.availabilityBasis === null
          ? null
          : candidate.availabilityBasis.map((segment) => ({
              from: segment.from,
              until: segment.until,
              basis: segment.basis,
              source: segment.source,
              lag: segment.lag,
              rationale: segment.rationale,
            })),
      frequency: candidate.frequency,
      guarantees: {
        point_in_time: candidate.guarantees.pointInTime,
        vintage: candidate.guarantees.vintage,
        survivorship_free: candidate.guarantees.survivorshipFree,
        tradability_mask: candidate.guarantees.tradabilityMask,
      },
      provenance: {
        certified: candidate.provenance.certified,
        lineage_ref: candidate.provenance.lineageRef,
      },
      payload_schema: candidate.payloadSchema,
      source: candidate.source,
      time_semantics:
        candidate.timeSemantics === null
          ? null
          : {
              bar_labeling: candidate.timeSemantics.barLabeling,
              timestamp_basis: candidate.timeSemantics.timestampBasis,
              timezone: candidate.timeSemantics.timezone,
              latency_class: candidate.timeSemantics.latencyClass,
            },
      notes: candidate.notes,
    });
    if (canonicalizeAdapterDeclaration(normalized) !== canonicalizeAdapterDeclaration(candidate)) {
      throw new Error("not normalized");
    }
    return normalized;
  } catch {
    throw invalidArtifact("artifact datasets must be normalized adapter declarations");
  }
}

function normalizeProtocol(input: unknown): ArtifactProtocol {
  const protocol = exactRecord(
    input,
    ["mode", "folds", "trainDays", "oosDays", "purgeDays", "embargoDays", "holdDays"],
    "artifact protocol",
  );
  if (protocol.mode !== "rolling" && protocol.mode !== "expanding") {
    throw invalidArtifact("artifact protocol mode must be rolling or expanding");
  }
  const normalized: ArtifactProtocol = {
    mode: protocol.mode,
    folds: positiveInteger(protocol.folds, "protocol folds"),
    trainDays: positiveInteger(protocol.trainDays, "protocol train days"),
    oosDays: positiveInteger(protocol.oosDays, "protocol out-of-sample days"),
    purgeDays: nonnegativeInteger(protocol.purgeDays, "protocol purge days"),
    embargoDays: positiveInteger(protocol.embargoDays, "protocol embargo days"),
    holdDays: positiveInteger(protocol.holdDays, "protocol hold days"),
  };
  if (normalized.purgeDays < normalized.holdDays) {
    throw invalidArtifact("artifact purge days cannot be shorter than the holding horizon");
  }
  return normalized;
}

function normalizeParameterMap(
  input: unknown,
  label: "locked parameter" | "declared literal",
): Readonly<Record<string, ArtifactParameterValue>> {
  if (!isPlainRecord(input)) {
    throw invalidArtifact(`${label} collection must be a plain object`);
  }
  const normalized: Array<readonly [string, ArtifactParameterValue]> = [];
  for (const key of Object.keys(input).sort(compareText)) {
    if (!PARAMETER_NAME_PATTERN.test(key)) {
      throw invalidArtifact(`${label} names must be portable identifiers`);
    }
    rejectSecretName(key, label);
    normalized.push([
      key,
      normalizeParameterValue(input[key], `${label} ${JSON.stringify(key)}`, new WeakSet(), 0),
    ]);
  }
  return Object.freeze(Object.fromEntries(normalized));
}

function normalizeParameterValue(
  input: unknown,
  field: string,
  ancestors: WeakSet<object>,
  depth: number,
): ArtifactParameterValue {
  if (depth > 32) {
    throw invalidArtifact(`${field} exceeds the supported nesting depth`);
  }
  if (input === null || typeof input === "boolean") {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw invalidArtifact(`${field} must use a finite canonical JSON number`);
    }
    return input;
  }
  if (typeof input === "string") {
    const value = singleLine(input, field, 4096);
    if (
      isAbsolute(value) ||
      WINDOWS_ABSOLUTE_PATTERN.test(value) ||
      /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value) ||
      /[?&](?:password|passwd|token|api[_-]?key|secret|access[_-]?key)=/i.test(value)
    ) {
      throw invalidArtifact(`${field} contains a runtime path or inline credential`);
    }
    return value;
  }
  if (typeof input !== "object") {
    throw invalidArtifact(`${field} must be canonical JSON data`);
  }
  if (ancestors.has(input)) {
    throw invalidArtifact(`${field} contains a cyclic value`);
  }
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return Object.freeze(
        input.map((value, index) =>
          normalizeParameterValue(value, `${field}[${index}]`, ancestors, depth + 1),
        ),
      );
    }
    if (!isPlainRecord(input)) {
      throw invalidArtifact(`${field} must contain only plain JSON objects`);
    }
    const entries: Array<readonly [string, ArtifactParameterValue]> = [];
    for (const key of Object.keys(input).sort(compareText)) {
      if (!PARAMETER_NAME_PATTERN.test(key)) {
        throw invalidArtifact(`${field} contains a non-portable object key`);
      }
      rejectSecretName(key, field);
      entries.push([
        key,
        normalizeParameterValue(input[key], `${field}.${key}`, ancestors, depth + 1),
      ]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(input);
  }
}

function rejectSecretName(key: string, field: string): void {
  const folded = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (SECRET_PARAMETER_NAMES.has(folded)) {
    throw invalidArtifact(`${field} uses a credential-bearing field name`);
  }
}

function rejectParameterOverlap(
  locked: Readonly<Record<string, ArtifactParameterValue>>,
  literals: Readonly<Record<string, ArtifactParameterValue>>,
): void {
  if (Object.keys(locked).some((key) => Object.hasOwn(literals, key))) {
    throw invalidArtifact("locked parameters and declared literals must use distinct names");
  }
}

function normalizeEvidence(input: ArtifactVerificationEvidence): ArtifactVerificationEvidence {
  if (!isPlainRecord(input)) {
    throw invalidArtifact("artifact verification evidence must be a plain object");
  }
  const allowed = new Set(["expectedArtifactHash", "dataSemantics"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw invalidArtifact("artifact verification evidence has unknown fields");
  }
  const evidence = input;
  return {
    ...(Object.hasOwn(evidence, "expectedArtifactHash")
      ? { expectedArtifactHash: sha256(evidence.expectedArtifactHash, "expected artifact hash") }
      : {}),
    ...(Object.hasOwn(evidence, "dataSemantics")
      ? { dataSemantics: normalizeDataSemanticsEvidence(evidence.dataSemantics) }
      : {}),
  };
}

function normalizeDataSemanticsEvidence(
  input: unknown,
): ArtifactVerificationEvidence["dataSemantics"] {
  const data = exactRecord(input, ["datasets"], "artifact data semantics evidence");
  if (!Array.isArray(data.datasets) || data.datasets.length === 0) {
    throw invalidArtifact("artifact data semantics evidence requires a non-empty datasets array");
  }
  return { datasets: data.datasets as unknown as readonly CreateArtifactDatasetSemanticsInput[] };
}

function normalizeReadSetIds(input: unknown, field: string, sort: boolean): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidArtifact(`${field} requires at least one development read-set`);
  }
  const identities = input.map((value) => sha256(value, `${field} development read-set`));
  if (sort) {
    identities.sort(compareText);
  }
  for (let index = 1; index < identities.length; index += 1) {
    const previous = identities[index - 1];
    const current = identities[index];
    if (previous === undefined || current === undefined || compareText(previous, current) >= 0) {
      throw invalidArtifact(`${field} development read-sets must be unique and sorted`);
    }
  }
  return identities;
}

function requireSortedDatasets(datasets: readonly ArtifactDatasetSemantics[]): void {
  const caseFolded = new Set<string>();
  const readSets = new Set<string>();
  for (let index = 0; index < datasets.length; index += 1) {
    const current = datasets[index];
    const previous = datasets[index - 1];
    if (
      current === undefined ||
      (previous !== undefined && compareDatasets(previous, current) >= 0)
    ) {
      throw invalidArtifact("artifact datasets must be unique and sorted by dataset and version");
    }
    const folded = `${current.dataset}\0${current.version}`.toLowerCase();
    if (caseFolded.has(folded)) {
      throw invalidArtifact("artifact datasets must also be unique on case-insensitive systems");
    }
    caseFolded.add(folded);
    for (const readSet of current.developmentReadSets) {
      if (readSets.has(readSet)) {
        throw invalidArtifact("a development read-set cannot belong to multiple artifact datasets");
      }
      readSets.add(readSet);
    }
  }
}

function compareDatasets(left: ArtifactDatasetSemantics, right: ArtifactDatasetSemantics): number {
  return compareText(left.dataset, right.dataset) || compareText(left.version, right.version);
}

function datasetName(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input)) {
    throw invalidArtifact("artifact dataset names must be portable registry identifiers");
  }
  return input;
}

function portableVersion(input: unknown): string {
  const value = singleLine(input, "artifact dataset version", 128);
  if (value.trim() !== value || value.includes("/") || value.includes("\\")) {
    throw invalidArtifact("artifact dataset versions must be portable non-path strings");
  }
  return value;
}

function portableReference(input: unknown, field: string): string {
  if (typeof input !== "string" || !PORTABLE_ID_PATTERN.test(input)) {
    throw invalidArtifact(`${field} must be a portable identifier`);
  }
  return input;
}

function portableConstraint(input: unknown): string {
  const value = singleLine(input, "runtime constraint", 128);
  if (
    value.trim() !== value ||
    !RUNTIME_CONSTRAINT_PATTERN.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    WINDOWS_ABSOLUTE_PATTERN.test(value)
  ) {
    throw invalidArtifact("runtime constraint must be a portable version expression");
  }
  return value;
}

function portableCodePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw invalidArtifact("artifact entrypoint file must be a non-empty logical path");
  }
  return input;
}

function singleLine(input: unknown, field: string, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximum ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input)
  ) {
    throw invalidArtifact(`${field} must be one printable line of at most ${maximum} characters`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  const value = nonnegativeInteger(input, field);
  if (value === 0) {
    throw invalidArtifact(`${field} must be positive`);
  }
  return value;
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidArtifact(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidArtifact(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isPlainRecord(input)) {
    throw invalidArtifact(`${field} must be a plain object`);
  }
  const actual = Object.keys(input).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidArtifact(`${field} has missing or unknown fields`);
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
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw invalidArtifact("artifact manifest contains an unsupported canonical value");
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

function invalidArtifact(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_ARTIFACT",
    message,
    "Regenerate the artifact from stable code, normalized declarations, and portable non-secret inputs.",
  );
}
