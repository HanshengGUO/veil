import { createHash } from "node:crypto";
import {
  type AdapterDeclaration,
  ContractViolation,
  canonicalizeAdapterDeclaration,
  hashAdapterDeclaration,
  normalizeAdapterDeclaration,
  normalizeDecisionTime,
} from "@veilquant/contract";
import { Table, tableFromIPC, tableToIPC, type Vector, vectorFromArray } from "apache-arrow";
import { EngineConfigurationError } from "./errors.ts";
import {
  createReadSetResultIdentity,
  createSelectedReadSetResultIdentity,
  type ReadSetIdentityCache,
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

export const VERIFICATION_VIEW_FORMAT = "veil.verification-view.v0" as const;
export const VERIFICATION_VIEW_FILTER_VERSION = "veil.history-mask-filter.v0" as const;

const VIEW_HASH_DOMAIN = "veil.verification-view.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type VerificationViewRole = "train" | "out-of-sample";

export interface VerificationViewAudit {
  readonly sourceRows: number;
  readonly historyRows: number;
  readonly droppedOutsideHistoryRows: number;
  readonly droppedUntradableRows: number;
  readonly outputRows: number;
  readonly decisionRows: number;
}

export interface VerificationViewManifest {
  readonly format: typeof VERIFICATION_VIEW_FORMAT;
  readonly sourceReadSetId: string;
  readonly planHash: string;
  readonly foldIndex: number;
  readonly role: VerificationViewRole;
  readonly decisionIndex: number;
  readonly decisionTime: string;
  readonly dataset: string;
  readonly adapterVersion: string;
  readonly declarationHash: string;
  readonly entityKey: string;
  readonly eventTimeColumn: string;
  readonly maskColumn: string;
  readonly history: WalkForwardScheduleRange;
  readonly filterVersion: typeof VERIFICATION_VIEW_FILTER_VERSION;
  readonly audit: VerificationViewAudit;
  readonly result: ReadSetResultIdentity;
  readonly viewHash: string;
}

export interface CreateVerificationViewInput {
  readonly sourceReadSet: ReadSetManifest;
  readonly sourceArrowIpc: Uint8Array;
  readonly declaration: AdapterDeclaration;
  readonly plan: WalkForwardPlan;
  readonly foldIndex: number;
  readonly role: VerificationViewRole;
  readonly decisionIndex: number;
}

export interface VerificationView {
  readonly manifest: VerificationViewManifest;
  readonly arrowIpc: Uint8Array;
}

export interface VerificationViewEvidence extends CreateVerificationViewInput {
  readonly arrowIpc: Uint8Array;
  readonly expectedViewHash?: string;
}

type VerificationViewBody = Omit<VerificationViewManifest, "viewHash">;

/** Applies the fold history boundary and declared tradability mask before factor code can run. */
export function createVerificationView(input: CreateVerificationViewInput): VerificationView {
  return createVerificationViewInternal(input);
}

/** Internal contract fast path; intentionally omitted from the package entrypoint. */
export function createVerificationViewWithIdentityCache(
  input: CreateVerificationViewInput,
  identityCache: ReadSetIdentityCache,
): VerificationView {
  return createVerificationViewInternal(input, identityCache);
}

function createVerificationViewInternal(
  input: CreateVerificationViewInput,
  identityCache?: ReadSetIdentityCache,
): VerificationView {
  const root = exactRecord(
    input,
    [
      "sourceReadSet",
      "sourceArrowIpc",
      "declaration",
      "plan",
      "foldIndex",
      "role",
      "decisionIndex",
    ],
    "verification view input",
  );
  const declaration = normalizedDeclaration(root.declaration);
  const maskColumn = declaration.guarantees.tradabilityMask;
  if (maskColumn === null) throw missingMask(declaration);
  const plan = verifyWalkForwardPlan(root.plan);
  const foldIndex = nonnegativeInteger(root.foldIndex, "fold index");
  const fold = plan.folds[foldIndex];
  if (fold === undefined || fold.index !== foldIndex) {
    throw invalidView("verification fold index is outside the WFA plan");
  }
  const role = verificationRole(root.role);
  const decisionIndex = nonnegativeInteger(root.decisionIndex, "decision index");
  requireDecisionIndex(role, decisionIndex, fold.train, fold.outOfSample);
  const decisionTime = plan.decisionSchedule[decisionIndex];
  if (decisionTime === undefined) {
    throw invalidView("verification decision index is outside the WFA schedule");
  }
  const history = historyRange(plan, fold.train.startIndex, decisionIndex);
  const sourceArrowIpc = nonemptyArrow(root.sourceArrowIpc, "source Arrow IPC");
  const sourceReadSet = verifyReadSetManifest(
    root.sourceReadSet,
    {
      arrowIpc: sourceArrowIpc,
      declaration,
    },
    identityCache,
  );
  if (sourceReadSet.query.asOf !== decisionTime) {
    throw invalidView("source read-set decision time does not match the verification decision");
  }
  if (
    sourceReadSet.query.dataset !== declaration.dataset ||
    sourceReadSet.query.adapterVersion !== declaration.version ||
    sourceReadSet.declarationHash !== hashAdapterDeclaration(declaration)
  ) {
    throw invalidView("source read-set does not match the verification declaration");
  }

  const source = decodeArrow(sourceArrowIpc);
  const eventTime = requiredColumn(source, declaration.eventTime, declaration, decisionTime, "C1");
  const mask = requiredColumn(source, maskColumn, declaration, decisionTime, "C4");
  const entity = requiredColumn(source, declaration.entityKey, declaration, decisionTime, "C4");
  const first = Date.parse(history.firstDecisionTime);
  const last = Date.parse(history.lastDecisionTime);
  const rows: number[] = [];
  let historyRows = 0;
  let droppedUntradableRows = 0;
  let decisionRows = 0;
  for (let row = 0; row < source.numRows; row += 1) {
    const instant = eventTimeMillis(
      eventTime.get(row),
      declaration,
      decisionTime,
      declaration.eventTime,
      row,
    );
    if (instant < first || instant > last) continue;
    historyRows += 1;
    const tradable = mask.get(row);
    if (typeof tradable !== "boolean") {
      throw new ContractViolation("C4", "tradability mask contains a non-boolean value", {
        dataset: `${declaration.dataset}@${declaration.version}`,
        asOf: decisionTime,
        context: { column: maskColumn, row },
        remedy: "Normalize every in-window mask value to true or false before verification.",
      });
    }
    if (!tradable) {
      droppedUntradableRows += 1;
      continue;
    }
    requireEntityValue(entity.get(row), declaration, decisionTime, row);
    rows.push(row);
    if (instant === last) decisionRows += 1;
  }
  const table = takeRows(source, rows);
  const arrowIpc = tableToIPC(table, "stream");
  const audit: VerificationViewAudit = Object.freeze({
    sourceRows: source.numRows,
    historyRows,
    droppedOutsideHistoryRows: source.numRows - historyRows,
    droppedUntradableRows,
    outputRows: rows.length,
    decisionRows,
  });
  const body: VerificationViewBody = {
    format: VERIFICATION_VIEW_FORMAT,
    sourceReadSetId: sourceReadSet.manifestHash,
    planHash: plan.planHash,
    foldIndex,
    role,
    decisionIndex,
    decisionTime,
    dataset: declaration.dataset,
    adapterVersion: declaration.version,
    declarationHash: hashAdapterDeclaration(declaration),
    entityKey: declaration.entityKey,
    eventTimeColumn: declaration.eventTime,
    maskColumn,
    history,
    filterVersion: VERIFICATION_VIEW_FILTER_VERSION,
    audit,
    result:
      identityCache === undefined
        ? createReadSetResultIdentity(arrowIpc)
        : createSelectedReadSetResultIdentity(sourceArrowIpc, table, arrowIpc, rows, identityCache),
  };
  const manifest = deepFreeze({ ...body, viewHash: hashCanonical(VIEW_HASH_DOMAIN, body) });
  return Object.freeze({ manifest, arrowIpc });
}

/** Replays both history and mask filtering from the guarded source Arrow. */
export function verifyVerificationView(
  input: unknown,
  evidenceInput: VerificationViewEvidence,
): VerificationViewManifest {
  const evidence = normalizeEvidence(evidenceInput);
  const manifest = normalizeManifest(input, evidence.arrowIpc);
  if (hashCanonical(VIEW_HASH_DOMAIN, manifestBody(manifest)) !== manifest.viewHash) {
    throw invalidView("verification view hash does not match its normalized content");
  }
  if (evidence.expectedViewHash !== undefined && evidence.expectedViewHash !== manifest.viewHash) {
    throw invalidView("verification view differs from the expected content id");
  }
  const recreated = createVerificationView({
    sourceReadSet: evidence.sourceReadSet,
    sourceArrowIpc: evidence.sourceArrowIpc,
    declaration: evidence.declaration,
    plan: evidence.plan,
    foldIndex: evidence.foldIndex,
    role: evidence.role,
    decisionIndex: evidence.decisionIndex,
  });
  if (canonicalJson(recreated.manifest) !== canonicalJson(manifest)) {
    throw invalidView("verification view does not match the replayed source derivation");
  }
  return manifest;
}

function normalizeEvidence(input: VerificationViewEvidence): VerificationViewEvidence {
  const root = exactRecord(
    input,
    [
      "sourceReadSet",
      "sourceArrowIpc",
      "declaration",
      "plan",
      "foldIndex",
      "role",
      "decisionIndex",
      "arrowIpc",
      "expectedViewHash",
    ],
    "verification view evidence",
    true,
  );
  for (const required of [
    "sourceReadSet",
    "sourceArrowIpc",
    "declaration",
    "plan",
    "foldIndex",
    "role",
    "decisionIndex",
    "arrowIpc",
  ]) {
    if (!Object.hasOwn(root, required)) {
      throw invalidView("verification view evidence has missing fields");
    }
  }
  return Object.freeze({
    sourceReadSet: root.sourceReadSet as ReadSetManifest,
    sourceArrowIpc: nonemptyArrow(root.sourceArrowIpc, "source Arrow IPC"),
    declaration: normalizedDeclaration(root.declaration),
    plan: verifyWalkForwardPlan(root.plan),
    foldIndex: nonnegativeInteger(root.foldIndex, "fold index"),
    role: verificationRole(root.role),
    decisionIndex: nonnegativeInteger(root.decisionIndex, "decision index"),
    arrowIpc: nonemptyArrow(root.arrowIpc, "verification Arrow IPC"),
    expectedViewHash:
      root.expectedViewHash === undefined
        ? undefined
        : sha256(root.expectedViewHash, "expected view hash"),
  });
}

function normalizeManifest(input: unknown, arrowIpc: Uint8Array): VerificationViewManifest {
  const root = exactRecord(
    input,
    [
      "format",
      "sourceReadSetId",
      "planHash",
      "foldIndex",
      "role",
      "decisionIndex",
      "decisionTime",
      "dataset",
      "adapterVersion",
      "declarationHash",
      "entityKey",
      "eventTimeColumn",
      "maskColumn",
      "history",
      "filterVersion",
      "audit",
      "result",
      "viewHash",
    ],
    "verification view manifest",
  );
  if (root.format !== VERIFICATION_VIEW_FORMAT) {
    throw invalidView("verification view uses an unsupported format");
  }
  if (root.filterVersion !== VERIFICATION_VIEW_FILTER_VERSION) {
    throw invalidView("verification view uses an unsupported filter version");
  }
  return deepFreeze({
    format: VERIFICATION_VIEW_FORMAT,
    sourceReadSetId: sha256(root.sourceReadSetId, "source read-set id"),
    planHash: sha256(root.planHash, "plan hash"),
    foldIndex: nonnegativeInteger(root.foldIndex, "fold index"),
    role: verificationRole(root.role),
    decisionIndex: nonnegativeInteger(root.decisionIndex, "decision index"),
    decisionTime: canonicalTime(root.decisionTime, "decision time"),
    dataset: portableName(root.dataset, "dataset"),
    adapterVersion: nonemptyString(root.adapterVersion, "adapter version"),
    declarationHash: sha256(root.declarationHash, "declaration hash"),
    entityKey: nonemptyString(root.entityKey, "entity key"),
    eventTimeColumn: nonemptyString(root.eventTimeColumn, "event-time column"),
    maskColumn: nonemptyString(root.maskColumn, "mask column"),
    history: normalizeRange(root.history),
    filterVersion: VERIFICATION_VIEW_FILTER_VERSION,
    audit: normalizeAudit(root.audit),
    result: verifyReadSetResultIdentity(root.result, arrowIpc),
    viewHash: sha256(root.viewHash, "view hash"),
  });
}

function normalizeAudit(input: unknown): VerificationViewAudit {
  const audit = exactRecord(
    input,
    [
      "sourceRows",
      "historyRows",
      "droppedOutsideHistoryRows",
      "droppedUntradableRows",
      "outputRows",
      "decisionRows",
    ],
    "verification view audit",
  );
  const normalized: VerificationViewAudit = {
    sourceRows: nonnegativeInteger(audit.sourceRows, "source row count"),
    historyRows: nonnegativeInteger(audit.historyRows, "history row count"),
    droppedOutsideHistoryRows: nonnegativeInteger(
      audit.droppedOutsideHistoryRows,
      "outside-history row count",
    ),
    droppedUntradableRows: nonnegativeInteger(audit.droppedUntradableRows, "untradable row count"),
    outputRows: nonnegativeInteger(audit.outputRows, "output row count"),
    decisionRows: nonnegativeInteger(audit.decisionRows, "decision row count"),
  };
  if (
    normalized.sourceRows !== normalized.historyRows + normalized.droppedOutsideHistoryRows ||
    normalized.historyRows !== normalized.outputRows + normalized.droppedUntradableRows ||
    normalized.decisionRows > normalized.outputRows
  ) {
    throw invalidView("verification view audit counts are inconsistent");
  }
  return Object.freeze(normalized);
}

function historyRange(
  plan: WalkForwardPlan,
  startIndex: number,
  decisionIndex: number,
): WalkForwardScheduleRange {
  const firstDecisionTime = plan.decisionSchedule[startIndex];
  const lastDecisionTime = plan.decisionSchedule[decisionIndex];
  if (
    firstDecisionTime === undefined ||
    lastDecisionTime === undefined ||
    decisionIndex < startIndex
  ) {
    throw invalidView("verification history is outside the WFA schedule");
  }
  return Object.freeze({
    startIndex,
    endIndexExclusive: decisionIndex + 1,
    firstDecisionTime,
    lastDecisionTime,
    sessionCount: decisionIndex + 1 - startIndex,
  });
}

function requireDecisionIndex(
  role: VerificationViewRole,
  decisionIndex: number,
  train: WalkForwardScheduleRange,
  outOfSample: WalkForwardScheduleRange,
): void {
  if (role === "train" && decisionIndex !== train.endIndexExclusive - 1) {
    throw invalidView("training verification must run at the training range end");
  }
  if (
    role === "out-of-sample" &&
    (decisionIndex < outOfSample.startIndex || decisionIndex >= outOfSample.endIndexExclusive)
  ) {
    throw invalidView("OOS verification decision is outside the fold's OOS range");
  }
}

function normalizeRange(input: unknown): WalkForwardScheduleRange {
  const range = exactRecord(
    input,
    ["startIndex", "endIndexExclusive", "firstDecisionTime", "lastDecisionTime", "sessionCount"],
    "verification history range",
  );
  const startIndex = nonnegativeInteger(range.startIndex, "history start index");
  const endIndexExclusive = positiveInteger(range.endIndexExclusive, "history end index");
  const sessionCount = positiveInteger(range.sessionCount, "history session count");
  if (endIndexExclusive - startIndex !== sessionCount) {
    throw invalidView("verification history indexes do not match its session count");
  }
  const firstDecisionTime = canonicalTime(range.firstDecisionTime, "history first decision time");
  const lastDecisionTime = canonicalTime(range.lastDecisionTime, "history last decision time");
  if (firstDecisionTime > lastDecisionTime) {
    throw invalidView("verification history decision times are reversed");
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
    throw invalidView("verification declaration must already be normalized");
  }
}

function decodeArrow(input: Uint8Array): Table {
  try {
    return tableFromIPC(input);
  } catch {
    throw invalidView("source Arrow IPC is unreadable");
  }
}

function requiredColumn(
  table: Table,
  column: string,
  declaration: AdapterDeclaration,
  asOf: string,
  invariant: "C1" | "C4",
): Vector {
  const vector = table.getChild(column);
  if (vector !== null) return vector;
  throw new ContractViolation(invariant, `verification view is missing required column ${column}`, {
    dataset: `${declaration.dataset}@${declaration.version}`,
    asOf,
    context: { column },
    remedy: "Retain the declared entity, event-time, and tradability-mask columns.",
  });
}

function eventTimeMillis(
  value: unknown,
  declaration: AdapterDeclaration,
  asOf: string,
  column: string,
  row: number,
): number {
  let instant = Number.NaN;
  try {
    if (typeof value === "number") instant = value;
    else if (value instanceof Date) instant = value.valueOf();
    else if (typeof value === "string") instant = Date.parse(normalizeDecisionTime(value));
  } catch {
    instant = Number.NaN;
  }
  if (Number.isFinite(instant)) return instant;
  throw new ContractViolation("C1", "verification row has an invalid event-time value", {
    dataset: `${declaration.dataset}@${declaration.version}`,
    asOf,
    context: { column, row },
    remedy: "Normalize event time to ISO-8601 or Arrow timestamp milliseconds.",
  });
}

function requireEntityValue(
  value: unknown,
  declaration: AdapterDeclaration,
  asOf: string,
  row: number,
): void {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) ||
    (value instanceof Date && Number.isFinite(value.valueOf())) ||
    value instanceof Uint8Array
  ) {
    return;
  }
  throw new ContractViolation("C4", "verification row has an invalid entity key", {
    dataset: `${declaration.dataset}@${declaration.version}`,
    asOf,
    context: { column: declaration.entityKey, row },
    remedy: "Normalize every mask-eligible entity key to a non-null scalar value.",
  });
}

function takeRows(table: Table, rows: readonly number[]): Table {
  try {
    const columns: Record<string, Vector> = {};
    for (let index = 0; index < table.schema.fields.length; index += 1) {
      const field = table.schema.fields[index];
      const vector = table.getChildAt(index);
      if (field === undefined || vector === null) throw new Error("missing column vector");
      columns[field.name] = vectorFromArray(
        rows.map((row) => vector.get(row)),
        field.type,
      );
    }
    return new Table(columns);
  } catch {
    throw invalidView("source Arrow types cannot be filtered into a verification view");
  }
}

function missingMask(declaration: AdapterDeclaration): ContractViolation {
  return new ContractViolation("C4", "verification requires a declared tradability mask", {
    dataset: `${declaration.dataset}@${declaration.version}`,
    remedy: "Declare guarantees.tradability_mask before requesting strategy verification.",
  });
}

function manifestBody(manifest: VerificationViewManifest): VerificationViewBody {
  const { viewHash: _viewHash, ...body } = manifest;
  return body;
}

function verificationRole(input: unknown): VerificationViewRole {
  if (input !== "train" && input !== "out-of-sample") {
    throw invalidView("verification view role must be train or out-of-sample");
  }
  return input;
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw invalidView(`${field} must be an object`);
  const actual = Object.keys(input);
  const allowed = new Set(expectedKeys);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && expectedKeys.some((key) => !actual.includes(key)))
  ) {
    throw invalidView(`${field} has missing or unknown fields`);
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
    throw invalidView(`${field} must be non-empty bytes`);
  }
  return input;
}

function portableName(input: unknown, field: string): string {
  const value = nonemptyString(input, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw invalidView(`${field} must be a portable name`);
  }
  return value;
}

function nonemptyString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw invalidView(`${field} must be a non-empty string`);
  }
  return input;
}

function canonicalTime(input: unknown, field: string): string {
  if (typeof input !== "string") throw invalidView(`${field} must be a canonical UTC instant`);
  try {
    const normalized = normalizeDecisionTime(input);
    if (normalized !== input) throw new Error("not canonical");
    return normalized;
  } catch {
    throw invalidView(`${field} must be a canonical UTC instant`);
  }
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidView(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw invalidView(`${field} must be a positive safe integer`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidView(`${field} must be a lowercase sha256 identity`);
  }
  return input;
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
      throw invalidView("verification view contains a non-canonical number");
    }
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map((value) => canonicalJson(value)).join(",")}]`;
  if (isPlainRecord(input)) {
    return `{${Object.keys(input)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  throw invalidView("verification view contains an unsupported value");
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

function invalidView(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_VERIFICATION_VIEW",
    message,
    "Recreate the view from its guarded source read, WFA plan, and declared tradability mask.",
  );
}
