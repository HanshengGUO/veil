import { createHash } from "node:crypto";
import {
  type AdapterDeclaration,
  canonicalizeAdapterDeclaration,
  hashAdapterDeclaration,
  normalizeAdapterDeclaration,
  normalizeDecisionTime,
} from "@veilquant/contract";
import { Table, tableFromIPC, tableToIPC, type Vector, vectorFromArray } from "apache-arrow";
import { EngineConfigurationError } from "./errors.ts";
import {
  createReadSetResultIdentity,
  type ReadSetManifest,
  type ReadSetResultIdentity,
  verifyReadSetManifest,
  verifyReadSetResultIdentity,
} from "./read-set.ts";
import {
  verifyWalkForwardPlan,
  type WalkForwardPlan,
  type WalkForwardScheduleRange,
} from "./walk-forward-plan.ts";

export const WINDOW_READ_SET_FORMAT = "veil.window-read-set.v0" as const;
export const WINDOW_READ_SET_FILTER_VERSION = "veil.window-filter.v0" as const;

const WINDOW_HASH_DOMAIN = "veil.window-read-set.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface WindowReadSetManifest {
  readonly format: typeof WINDOW_READ_SET_FORMAT;
  readonly sourceReadSetId: string;
  readonly planHash: string;
  readonly foldIndex: number;
  readonly role: "train";
  readonly dataset: string;
  readonly adapterVersion: string;
  readonly declarationHash: string;
  readonly decisionTime: string;
  readonly eventTimeColumn: string;
  readonly range: WalkForwardScheduleRange;
  readonly filterVersion: typeof WINDOW_READ_SET_FILTER_VERSION;
  readonly result: ReadSetResultIdentity;
  readonly windowHash: string;
}

export interface CreateWindowReadSetInput {
  readonly sourceReadSet: ReadSetManifest;
  readonly sourceArrowIpc: Uint8Array;
  readonly declaration: AdapterDeclaration;
  readonly plan: WalkForwardPlan;
  readonly foldIndex: number;
}

export interface WindowReadSet {
  readonly manifest: WindowReadSetManifest;
  readonly arrowIpc: Uint8Array;
}

export interface WindowReadSetVerificationEvidence {
  readonly sourceReadSet: ReadSetManifest;
  readonly sourceArrowIpc: Uint8Array;
  readonly declaration: AdapterDeclaration;
  readonly plan: WalkForwardPlan;
  readonly foldIndex: number;
  readonly arrowIpc: Uint8Array;
  readonly expectedWindowHash?: string;
}

type WindowReadSetBody = Omit<WindowReadSetManifest, "windowHash">;

/** Derives the exact training rows for one fold from an independently verifiable guarded read. */
export function createWindowReadSet(input: CreateWindowReadSetInput): WindowReadSet {
  const root = exactRecord(
    input,
    ["sourceReadSet", "sourceArrowIpc", "declaration", "plan", "foldIndex"],
    "window read-set input",
  );
  const declaration = normalizedDeclaration(root.declaration);
  const plan = verifyWalkForwardPlan(root.plan);
  const foldIndex = nonnegativeInteger(root.foldIndex, "fold index");
  const fold = plan.folds[foldIndex];
  if (fold === undefined || fold.index !== foldIndex) {
    throw invalidWindow("window read-set fold index is outside the walk-forward plan");
  }
  const sourceArrowIpc = nonemptyArrow(root.sourceArrowIpc, "source Arrow IPC");
  const sourceReadSet = verifyReadSetManifest(root.sourceReadSet, {
    arrowIpc: sourceArrowIpc,
    declaration,
  });
  if (sourceReadSet.query.asOf !== fold.train.lastDecisionTime) {
    throw invalidWindow("source read-set decision time does not match the training window end");
  }
  if (
    sourceReadSet.query.dataset !== declaration.dataset ||
    sourceReadSet.query.adapterVersion !== declaration.version ||
    sourceReadSet.declarationHash !== hashAdapterDeclaration(declaration)
  ) {
    throw invalidWindow("source read-set does not match the window declaration");
  }

  const source = decodeArrow(sourceArrowIpc);
  const eventTime = source.getChild(declaration.eventTime);
  if (eventTime === null) {
    throw invalidWindow("source read-set projection omitted the declared event-time column");
  }
  const first = Date.parse(fold.train.firstDecisionTime);
  const last = Date.parse(fold.train.lastDecisionTime);
  const rows: number[] = [];
  for (let row = 0; row < source.numRows; row += 1) {
    const instant = temporalValueMillis(eventTime.get(row), declaration.eventTime, row);
    if (first <= instant && instant <= last) rows.push(row);
  }
  const derived = takeRows(source, rows);
  const arrowIpc = tableToIPC(derived, "stream");
  const body: WindowReadSetBody = {
    format: WINDOW_READ_SET_FORMAT,
    sourceReadSetId: sourceReadSet.manifestHash,
    planHash: plan.planHash,
    foldIndex,
    role: "train",
    dataset: declaration.dataset,
    adapterVersion: declaration.version,
    declarationHash: hashAdapterDeclaration(declaration),
    decisionTime: fold.train.lastDecisionTime,
    eventTimeColumn: declaration.eventTime,
    range: fold.train,
    filterVersion: WINDOW_READ_SET_FILTER_VERSION,
    result: createReadSetResultIdentity(arrowIpc),
  };
  const manifest = deepFreeze({
    ...body,
    windowHash: hashCanonical(WINDOW_HASH_DOMAIN, body),
  });
  return Object.freeze({ manifest, arrowIpc });
}

/** Replays the derivation from source Arrow evidence; a manifest hash alone is insufficient. */
export function verifyWindowReadSetManifest(
  input: unknown,
  evidenceInput: WindowReadSetVerificationEvidence,
): WindowReadSetManifest {
  const evidence = normalizeEvidence(evidenceInput);
  const manifest = normalizeManifest(input, evidence.arrowIpc);
  const body = manifestBody(manifest);
  require(hashCanonical(WINDOW_HASH_DOMAIN, body) ===
    manifest.windowHash, "window read-set hash does not match its normalized content");
  if (
    evidence.expectedWindowHash !== undefined &&
    evidence.expectedWindowHash !== manifest.windowHash
  ) {
    throw invalidWindow("window read-set differs from the expected content id");
  }

  const recreated = createWindowReadSet({
    sourceReadSet: evidence.sourceReadSet,
    sourceArrowIpc: evidence.sourceArrowIpc,
    declaration: evidence.declaration,
    plan: evidence.plan,
    foldIndex: evidence.foldIndex,
  });
  if (canonicalJson(recreated.manifest) !== canonicalJson(manifest)) {
    throw invalidWindow("window read-set does not match the replayed source derivation");
  }
  return manifest;
}

function normalizeEvidence(
  input: WindowReadSetVerificationEvidence,
): WindowReadSetVerificationEvidence {
  const evidence = exactRecord(
    input,
    [
      "sourceReadSet",
      "sourceArrowIpc",
      "declaration",
      "plan",
      "foldIndex",
      "arrowIpc",
      "expectedWindowHash",
    ],
    "window read-set verification evidence",
    true,
  );
  for (const required of [
    "sourceReadSet",
    "sourceArrowIpc",
    "declaration",
    "plan",
    "foldIndex",
    "arrowIpc",
  ]) {
    if (!Object.hasOwn(evidence, required)) {
      throw invalidWindow("window read-set verification evidence has missing fields");
    }
  }
  return Object.freeze({
    sourceReadSet: evidence.sourceReadSet as ReadSetManifest,
    sourceArrowIpc: nonemptyArrow(evidence.sourceArrowIpc, "source Arrow IPC"),
    declaration: normalizedDeclaration(evidence.declaration),
    plan: verifyWalkForwardPlan(evidence.plan),
    foldIndex: nonnegativeInteger(evidence.foldIndex, "fold index"),
    arrowIpc: nonemptyArrow(evidence.arrowIpc, "derived Arrow IPC"),
    expectedWindowHash:
      evidence.expectedWindowHash === undefined
        ? undefined
        : sha256(evidence.expectedWindowHash, "expected window hash"),
  });
}

function normalizeManifest(input: unknown, arrowIpc: Uint8Array): WindowReadSetManifest {
  const root = exactRecord(
    input,
    [
      "format",
      "sourceReadSetId",
      "planHash",
      "foldIndex",
      "role",
      "dataset",
      "adapterVersion",
      "declarationHash",
      "decisionTime",
      "eventTimeColumn",
      "range",
      "filterVersion",
      "result",
      "windowHash",
    ],
    "window read-set manifest",
  );
  if (root.format !== WINDOW_READ_SET_FORMAT) {
    throw invalidWindow("window read-set uses an unsupported format");
  }
  if (root.role !== "train") {
    throw invalidWindow("window read-set role must be train");
  }
  if (root.filterVersion !== WINDOW_READ_SET_FILTER_VERSION) {
    throw invalidWindow("window read-set uses an unsupported filter version");
  }
  return deepFreeze({
    format: WINDOW_READ_SET_FORMAT,
    sourceReadSetId: sha256(root.sourceReadSetId, "source read-set id"),
    planHash: sha256(root.planHash, "plan hash"),
    foldIndex: nonnegativeInteger(root.foldIndex, "fold index"),
    role: "train",
    dataset: portableName(root.dataset, "dataset"),
    adapterVersion: nonemptyString(root.adapterVersion, "adapter version"),
    declarationHash: sha256(root.declarationHash, "declaration hash"),
    decisionTime: canonicalTime(root.decisionTime, "decision time"),
    eventTimeColumn: nonemptyString(root.eventTimeColumn, "event-time column"),
    range: normalizeRange(root.range),
    filterVersion: WINDOW_READ_SET_FILTER_VERSION,
    result: verifyReadSetResultIdentity(root.result, arrowIpc),
    windowHash: sha256(root.windowHash, "window hash"),
  });
}

function normalizeRange(input: unknown): WalkForwardScheduleRange {
  const range = exactRecord(
    input,
    ["startIndex", "endIndexExclusive", "firstDecisionTime", "lastDecisionTime", "sessionCount"],
    "training range",
  );
  const startIndex = nonnegativeInteger(range.startIndex, "training range start index");
  const endIndexExclusive = positiveInteger(range.endIndexExclusive, "training range end index");
  const sessionCount = positiveInteger(range.sessionCount, "training range session count");
  if (endIndexExclusive - startIndex !== sessionCount) {
    throw invalidWindow("training range indexes do not match its session count");
  }
  const firstDecisionTime = canonicalTime(
    range.firstDecisionTime,
    "training range first decision time",
  );
  const lastDecisionTime = canonicalTime(
    range.lastDecisionTime,
    "training range last decision time",
  );
  if (firstDecisionTime > lastDecisionTime) {
    throw invalidWindow("training range decision times are reversed");
  }
  return Object.freeze({
    startIndex,
    endIndexExclusive,
    firstDecisionTime,
    lastDecisionTime,
    sessionCount,
  });
}

function normalizedDeclaration(input: unknown): AdapterDeclaration {
  try {
    if (!isPlainRecord(input)) throw new Error("not an object");
    const candidate = input as unknown as AdapterDeclaration;
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
    throw invalidWindow("window read-set declaration must already be normalized");
  }
}

function decodeArrow(input: Uint8Array): Table {
  try {
    return tableFromIPC(input);
  } catch {
    throw invalidWindow("source Arrow IPC is unreadable");
  }
}

function temporalValueMillis(value: unknown, column: string, row: number): number {
  let instant = Number.NaN;
  try {
    if (typeof value === "number") instant = value;
    else if (value instanceof Date) instant = value.valueOf();
    else if (typeof value === "string") instant = Date.parse(normalizeDecisionTime(value));
  } catch {
    instant = Number.NaN;
  }
  if (!Number.isFinite(instant)) {
    throw invalidWindow(
      `source row ${row} has an invalid value in event-time column ${JSON.stringify(column)}`,
    );
  }
  return instant;
}

function takeRows(table: Table, rows: readonly number[]): Table {
  try {
    const columns: Record<string, Vector> = {};
    for (let index = 0; index < table.schema.fields.length; index += 1) {
      const field = table.schema.fields[index];
      const vector = table.getChildAt(index);
      if (field === undefined || vector === null) {
        throw new Error(`missing column vector at index ${index}`);
      }
      columns[field.name] = vectorFromArray(
        rows.map((row) => vector.get(row)),
        field.type,
      );
    }
    return new Table(columns);
  } catch {
    throw invalidWindow("source Arrow types cannot be filtered into a training window");
  }
}

function manifestBody(manifest: WindowReadSetManifest): WindowReadSetBody {
  return {
    format: manifest.format,
    sourceReadSetId: manifest.sourceReadSetId,
    planHash: manifest.planHash,
    foldIndex: manifest.foldIndex,
    role: manifest.role,
    dataset: manifest.dataset,
    adapterVersion: manifest.adapterVersion,
    declarationHash: manifest.declarationHash,
    decisionTime: manifest.decisionTime,
    eventTimeColumn: manifest.eventTimeColumn,
    range: manifest.range,
    filterVersion: manifest.filterVersion,
    result: manifest.result,
  };
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw invalidWindow(`${field} must be an object`);
  const actual = Object.keys(input);
  const allowed = new Set(expectedKeys);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && expectedKeys.some((key) => !actual.includes(key)))
  ) {
    throw invalidWindow(`${field} has missing or unknown fields`);
  }
  return input;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function nonemptyArrow(input: unknown, field: string): Uint8Array {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw invalidWindow(`${field} must be non-empty bytes`);
  }
  return input;
}

function canonicalTime(input: unknown, field: string): string {
  if (typeof input !== "string") throw invalidWindow(`${field} must be a canonical UTC instant`);
  try {
    const normalized = normalizeDecisionTime(input);
    if (normalized !== input) throw new Error("not canonical");
    return normalized;
  } catch {
    throw invalidWindow(`${field} must be a canonical UTC instant`);
  }
}

function portableName(input: unknown, field: string): string {
  const value = nonemptyString(input, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw invalidWindow(`${field} must be a portable name`);
  }
  return value;
}

function nonemptyString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw invalidWindow(`${field} must be a non-empty string`);
  }
  return input;
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidWindow(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw invalidWindow(`${field} must be a positive safe integer`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidWindow(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function require(condition: boolean, message: string): void {
  if (!condition) throw invalidWindow(message);
}

function hashCanonical(domain: string, input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(input))
    .digest("hex")}`;
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return JSON.stringify(input);
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw invalidWindow("window read-set contains a non-canonical number");
    }
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => canonicalJson(value)).join(",")}]`;
  }
  if (isPlainRecord(input)) {
    return `{${Object.keys(input)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  throw invalidWindow("window read-set contains an unsupported value");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function invalidWindow(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_WINDOW_READ_SET",
    message,
    "Recreate the training window from the guarded source read-set and verified WFA plan.",
  );
}
