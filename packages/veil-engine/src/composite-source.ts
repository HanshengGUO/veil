import { Buffer } from "node:buffer";
import {
  type AdapterDeclaration,
  hashAdapterDeclaration,
  normalizeDecisionTime,
} from "@veilquant/contract";
import {
  Bool,
  Table,
  TimestampMillisecond,
  tableFromIPC,
  tableToIPC,
  type Vector,
  vectorFromArray,
} from "apache-arrow";
import type {
  BackendCapabilities,
  BackendReadRequest,
  BackendReadResult,
  SourceFingerprint,
  TemporalBackend,
} from "./backend.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  createReadSetResultIdentity,
  type ReadSetManifest,
  verifyReadSetManifest,
} from "./read-set.ts";
import {
  COMPOSITE_SOURCE_JOIN_VERSION,
  type CompositeSourceComponentIdentity,
  type CompositeSourceManifest,
  createCompositeSourceManifest,
  sourceFingerprintFromCompositeManifest,
  verifyCompositeSourceManifest,
} from "./source-manifest.ts";
import { createTemporalReadPlan } from "./temporal-plan.ts";

export const COMPOSITE_SOURCE_BACKEND_ID = "composite-source";

const CAPABILITIES: BackendCapabilities = Object.freeze({
  projectionPushdown: true,
  temporalPredicatePushdown: true,
  sourceFingerprint: "content-hash",
  readOnly: true,
});

export interface CompositeSourceComponentEvidence {
  readonly declaration: AdapterDeclaration;
  readonly readSet: ReadSetManifest;
  readonly arrowIpc: Uint8Array;
}

export interface CreateCompositeSourceInput {
  /** The row-bearing source, normally prices with a declared tradability mask. */
  readonly primary: CompositeSourceComponentEvidence;
  /** Point-in-time universe membership keyed by entity and event time. */
  readonly membership: CompositeSourceComponentEvidence;
  /** A custom-source declaration consumed by CompositeSourceBackend and the outer guard. */
  readonly outputDeclaration: AdapterDeclaration;
  readonly membershipColumn: string;
  readonly outputAvailableTimeColumn: string;
  readonly outputMembershipColumn: string;
  readonly outputMaskColumn: string;
}

export interface CompositeSourceSnapshot {
  readonly manifest: CompositeSourceManifest;
  readonly arrowIpc: Uint8Array;
  readonly sourceFingerprint: SourceFingerprint;
}

export interface CompositeSourceVerificationEvidence extends CreateCompositeSourceInput {
  readonly arrowIpc: Uint8Array;
  readonly expectedManifestHash?: string;
}

export interface CompositeSourceBackendInput {
  readonly snapshot: CompositeSourceSnapshot;
  readonly declaration: AdapterDeclaration;
  readonly id?: string;
}

/**
 * Replays a database-neutral, exact-key primary-to-membership join over two guarded read sets.
 * All primary rows are retained. The derived availability is the later component availability,
 * and the output mask is primary tradability AND point-in-time membership.
 */
export function createCompositeSource(input: CreateCompositeSourceInput): CompositeSourceSnapshot {
  validateInputShape(input);
  const primary = verifiedComponent(input.primary, "primary");
  const membership = verifiedComponent(input.membership, "membership");
  const config = validateDeclarations(input, primary.readSet, membership.readSet);
  const primaryTable = decodeArrow(primary.arrowIpc, "primary");
  const membershipTable = decodeArrow(membership.arrowIpc, "membership");
  validateUniqueColumns(primaryTable, "primary");
  validateUniqueColumns(membershipTable, "membership");

  const primaryEntity = requiredColumn(primaryTable, config.primary.entityKey, "primary");
  const primaryEvent = requiredColumn(primaryTable, config.primary.eventTime, "primary");
  const primaryAvailable = requiredColumn(primaryTable, config.primary.availableTime, "primary");
  const primaryMask = requiredColumn(primaryTable, config.primary.maskColumn, "primary");
  const membershipEntity = requiredColumn(
    membershipTable,
    config.membership.entityKey,
    "membership",
  );
  const membershipEvent = requiredColumn(
    membershipTable,
    config.membership.eventTime,
    "membership",
  );
  const membershipAvailable = requiredColumn(
    membershipTable,
    config.membership.availableTime,
    "membership",
  );
  const membershipMask = requiredColumn(
    membershipTable,
    config.membership.membershipColumn,
    "membership",
  );

  const membershipByKey = new Map<string, { available: number; member: boolean }>();
  for (let row = 0; row < membershipTable.numRows; row += 1) {
    const key = joinKey(membershipEntity.get(row), membershipEvent.get(row), "membership", row);
    if (membershipByKey.has(key)) {
      throw invalidComposite("membership evidence contains a duplicate entity/event key");
    }
    membershipByKey.set(key, {
      available: temporalMillis(membershipAvailable.get(row), "membership availability", row),
      member: strictBoolean(
        membershipMask.get(row),
        config.membership.membershipColumn,
        "membership",
        row,
      ),
    });
  }

  const seenPrimary = new Set<string>();
  const matchedMembership = new Set<string>();
  const derivedAvailable: Date[] = [];
  const derivedMembership: boolean[] = [];
  const derivedMask: boolean[] = [];
  let eligibleRows = 0;
  let droppedByPrimaryMask = 0;
  let droppedByMembership = 0;
  for (let row = 0; row < primaryTable.numRows; row += 1) {
    const key = joinKey(primaryEntity.get(row), primaryEvent.get(row), "primary", row);
    if (seenPrimary.has(key)) {
      throw invalidComposite("primary evidence contains a duplicate entity/event key");
    }
    seenPrimary.add(key);
    const member = membershipByKey.get(key);
    if (member === undefined) {
      throw invalidComposite("membership evidence does not cover every primary entity/event key");
    }
    matchedMembership.add(key);
    const tradable = strictBoolean(primaryMask.get(row), config.primary.maskColumn, "primary", row);
    const available = Math.max(
      temporalMillis(primaryAvailable.get(row), "primary availability", row),
      member.available,
    );
    const eligible = tradable && member.member;
    derivedAvailable.push(new Date(available));
    derivedMembership.push(member.member);
    derivedMask.push(eligible);
    if (!tradable) droppedByPrimaryMask += 1;
    else if (!member.member) droppedByMembership += 1;
    else eligibleRows += 1;
  }

  const columns: Record<string, Vector> = {};
  for (let index = 0; index < primaryTable.schema.fields.length; index += 1) {
    const field = primaryTable.schema.fields[index];
    const vector = primaryTable.getChildAt(index);
    if (field === undefined || vector === null) {
      throw invalidComposite("primary Arrow evidence has an incomplete schema");
    }
    columns[field.name] = vectorFromArray(
      Array.from({ length: primaryTable.numRows }, (_, row) => vector.get(row)),
      field.type,
    );
  }
  columns[input.outputAvailableTimeColumn] = vectorFromArray(
    derivedAvailable,
    new TimestampMillisecond("UTC"),
  );
  columns[input.outputMembershipColumn] = vectorFromArray(derivedMembership, new Bool());
  columns[input.outputMaskColumn] = vectorFromArray(derivedMask, new Bool());
  const arrowIpc = tableToIPC(new Table(columns), "stream");
  const result = createReadSetResultIdentity(arrowIpc);
  const manifest = createCompositeSourceManifest({
    output: {
      dataset: input.outputDeclaration.dataset,
      adapterVersion: input.outputDeclaration.version,
      declarationHash: hashAdapterDeclaration(input.outputDeclaration),
    },
    primary: componentIdentity(primary.readSet),
    membership: componentIdentity(membership.readSet),
    join: {
      version: COMPOSITE_SOURCE_JOIN_VERSION,
      primary: config.primary,
      membership: config.membership,
      output: {
        entityKey: input.outputDeclaration.entityKey,
        eventTime: input.outputDeclaration.eventTime,
        availableTime: input.outputAvailableTimeColumn,
        membershipColumn: input.outputMembershipColumn,
        maskColumn: input.outputMaskColumn,
      },
    },
    audit: {
      primaryRows: primaryTable.numRows,
      membershipRows: membershipTable.numRows,
      matchedRows: matchedMembership.size,
      eligibleRows,
      droppedByPrimaryMask,
      droppedByMembership,
      unusedMembershipRows: membershipTable.numRows - matchedMembership.size,
    },
    result: {
      schemaHash: result.schemaHash,
      rowCount: result.rowCount,
      resultHash: result.resultHash,
      arrowHash: result.arrowHash,
    },
  });
  return Object.freeze({
    manifest,
    arrowIpc,
    sourceFingerprint: sourceFingerprintFromCompositeManifest(manifest),
  });
}

/** Independently replays both component read sets and the deterministic composite transform. */
export function verifyCompositeSource(
  input: unknown,
  evidence: CompositeSourceVerificationEvidence,
): CompositeSourceManifest {
  const manifest = verifyCompositeSourceManifest(input);
  if (!(evidence.arrowIpc instanceof Uint8Array) || evidence.arrowIpc.byteLength === 0) {
    throw invalidComposite("composite verification requires non-empty output Arrow evidence");
  }
  const recreated = createCompositeSource(evidence);
  if (canonicalJson(recreated.manifest) !== canonicalJson(manifest)) {
    throw invalidComposite("composite manifest does not match the replayed component evidence");
  }
  const actual = createReadSetResultIdentity(evidence.arrowIpc);
  if (
    actual.schemaHash !== manifest.result.schemaHash ||
    actual.rowCount !== manifest.result.rowCount ||
    actual.resultHash !== manifest.result.resultHash ||
    actual.arrowHash !== manifest.result.arrowHash
  ) {
    throw invalidComposite("composite output Arrow does not match the manifest result identity");
  }
  if (
    evidence.expectedManifestHash !== undefined &&
    evidence.expectedManifestHash !== manifest.manifestHash
  ) {
    throw invalidComposite("composite source differs from the expected content identity");
  }
  return manifest;
}

/** Read-only bridge that puts a verified materialized composite back behind TemporalGuard. */
export class CompositeSourceBackend implements TemporalBackend {
  readonly id: string;
  readonly capabilities = CAPABILITIES;
  readonly #arrowIpc: Uint8Array;
  readonly #declaration: AdapterDeclaration;
  readonly #fingerprint: SourceFingerprint;
  readonly #table: Table;
  readonly #availableMillis: readonly number[];
  readonly #availabilityIsOrdered: boolean;

  constructor(input: CompositeSourceBackendInput) {
    const id = input.id ?? COMPOSITE_SOURCE_BACKEND_ID;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw invalidComposite("composite backend id must be a portable identifier");
    }
    const manifest = verifyCompositeSourceManifest(input.snapshot.manifest);
    if (
      manifest.output.dataset !== input.declaration.dataset ||
      manifest.output.adapterVersion !== input.declaration.version ||
      manifest.output.declarationHash !== hashAdapterDeclaration(input.declaration)
    ) {
      throw invalidComposite("composite backend declaration does not match its snapshot");
    }
    const result = createReadSetResultIdentity(input.snapshot.arrowIpc);
    if (
      result.schemaHash !== manifest.result.schemaHash ||
      result.rowCount !== manifest.result.rowCount ||
      result.resultHash !== manifest.result.resultHash ||
      result.arrowHash !== manifest.result.arrowHash
    ) {
      throw invalidComposite("composite backend Arrow does not match its snapshot manifest");
    }
    this.id = id;
    this.#arrowIpc = Uint8Array.from(input.snapshot.arrowIpc);
    this.#declaration = input.declaration;
    this.#fingerprint = sourceFingerprintFromCompositeManifest(manifest);
    this.#table = tableFromIPC(this.#arrowIpc);
    const availableColumn = this.#table.getChild(manifest.join.output.availableTime);
    if (availableColumn === null) {
      throw invalidComposite("composite backend snapshot is missing its availability column");
    }
    this.#availableMillis = Object.freeze(
      Array.from({ length: this.#table.numRows }, (_, row) =>
        temporalMillis(availableColumn.get(row), "composite availability", row),
      ),
    );
    this.#availabilityIsOrdered = this.#availableMillis.every(
      (value, index, values) => index === 0 || (values[index - 1] ?? value) <= value,
    );
    Object.freeze(this);
  }

  accepts(source: BackendReadRequest["source"]): boolean {
    return (
      source.type === this.#declaration.source.type &&
      source.locator === this.#declaration.source.locator
    );
  }

  async read(request: BackendReadRequest): Promise<BackendReadResult> {
    const expected = createTemporalReadPlan(this.#declaration, {
      asOf: request.plan.asOf,
      ...(request.plan.requestedColumns === null ? {} : { columns: request.plan.requestedColumns }),
    });
    if (canonicalJson(expected) !== canonicalJson(request.plan)) {
      throw invalidComposite("composite backend received a plan for a different declaration");
    }
    const cutoff = Date.parse(expected.asOf);
    let bounded: Table;
    if (this.#availabilityIsOrdered) {
      let low = 0;
      let high = this.#availableMillis.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if ((this.#availableMillis[middle] ?? Number.POSITIVE_INFINITY) <= cutoff) low = middle + 1;
        else high = middle;
      }
      bounded = this.#table.slice(0, low);
    } else {
      const rows = this.#availableMillis.flatMap((value, row) => (value <= cutoff ? [row] : []));
      bounded = takeRows(this.#table, rows, "composite backend temporal pushdown");
    }
    const projection = expected.backendProjection;
    const projectionApplied =
      projection === null ? false : projection.every((column) => bounded.getChild(column) !== null);
    const output =
      projection !== null && projectionApplied ? bounded.select([...projection]) : bounded;
    return {
      arrowIpc: tableToIPC(output, "stream"),
      sourceFingerprint: this.#fingerprint,
      runtime: { name: "veil-composite-source", version: "v0" },
      pushdown: { projectionApplied, temporalPredicateApplied: true },
    };
  }
}

function verifiedComponent(
  input: CompositeSourceComponentEvidence,
  role: "primary" | "membership",
): CompositeSourceComponentEvidence {
  if (!(input.arrowIpc instanceof Uint8Array) || input.arrowIpc.byteLength === 0) {
    throw invalidComposite(`${role} component requires non-empty Arrow evidence`);
  }
  const readSet = verifyReadSetManifest(input.readSet, {
    arrowIpc: input.arrowIpc,
    declaration: input.declaration,
  });
  return { declaration: input.declaration, readSet, arrowIpc: input.arrowIpc };
}

function validateInputShape(input: CreateCompositeSourceInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidComposite("composite source input must be an object");
  }
  for (const key of [
    "primary",
    "membership",
    "outputDeclaration",
    "membershipColumn",
    "outputAvailableTimeColumn",
    "outputMembershipColumn",
    "outputMaskColumn",
  ]) {
    if (!Object.hasOwn(input, key)) throw invalidComposite("composite source input is incomplete");
  }
}

function validateDeclarations(
  input: CreateCompositeSourceInput,
  primaryReadSet: ReadSetManifest,
  membershipReadSet: ReadSetManifest,
): {
  primary: CompositeSourceManifest["join"]["primary"];
  membership: CompositeSourceManifest["join"]["membership"];
} {
  const primary = input.primary.declaration;
  const membership = input.membership.declaration;
  const output = input.outputDeclaration;
  const primaryAvailable = primary.availableTime;
  const primaryMask = primary.guarantees.tradabilityMask;
  const membershipAvailable = membership.availableTime;
  if (primaryAvailable === null || primaryMask === null) {
    throw invalidComposite("primary declaration needs explicit availability and tradability mask");
  }
  if (membershipAvailable === null || membership.guarantees.survivorshipFree !== true) {
    throw invalidComposite(
      "membership declaration needs explicit availability and survivorship_free: true",
    );
  }
  if (primaryReadSet.query.asOf !== membershipReadSet.query.asOf) {
    throw invalidComposite("component read sets must use the same as-of time");
  }
  const names = [
    input.membershipColumn,
    input.outputAvailableTimeColumn,
    input.outputMembershipColumn,
    input.outputMaskColumn,
  ];
  if (names.some((name) => typeof name !== "string" || name.trim() !== name || name.length === 0)) {
    throw invalidComposite("composite column names must be non-empty and normalized");
  }
  if (new Set(names.slice(1)).size !== 3) {
    throw invalidComposite("composite output columns must use distinct names");
  }
  const primaryFields = new Set(
    tableFromIPC(input.primary.arrowIpc).schema.fields.map((field) => field.name),
  );
  for (const name of names.slice(1)) {
    if (primaryFields.has(name)) {
      throw invalidComposite("composite output columns must not replace primary columns");
    }
  }
  if (
    output.source.type !== "custom" ||
    output.entityKey !== primary.entityKey ||
    output.eventTime !== primary.eventTime ||
    output.availableTime !== input.outputAvailableTimeColumn ||
    output.guarantees.pointInTime !== true ||
    output.guarantees.survivorshipFree !== true ||
    output.guarantees.tradabilityMask !== input.outputMaskColumn
  ) {
    throw invalidComposite(
      "output declaration must preserve primary keys and declare the derived PIT, universe, and mask semantics",
    );
  }
  return {
    primary: {
      entityKey: primary.entityKey,
      eventTime: primary.eventTime,
      availableTime: primaryAvailable,
      maskColumn: primaryMask,
    },
    membership: {
      entityKey: membership.entityKey,
      eventTime: membership.eventTime,
      availableTime: membershipAvailable,
      membershipColumn: input.membershipColumn,
    },
  };
}

function componentIdentity(readSet: ReadSetManifest): CompositeSourceComponentIdentity {
  return {
    dataset: readSet.query.dataset,
    adapterVersion: readSet.query.adapterVersion,
    declarationHash: readSet.declarationHash,
    readSetId: readSet.manifestHash,
    asOf: readSet.query.asOf,
    resultHash: readSet.result.resultHash,
    arrowHash: readSet.result.arrowHash,
  };
}

function decodeArrow(input: Uint8Array, role: "primary" | "membership"): Table {
  try {
    return tableFromIPC(input);
  } catch {
    throw invalidComposite(`${role} component contains unreadable Arrow evidence`);
  }
}

function validateUniqueColumns(table: Table, role: "primary" | "membership"): void {
  const names = table.schema.fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    throw invalidComposite(`${role} component contains duplicate Arrow columns`);
  }
}

function requiredColumn(table: Table, name: string, role: "primary" | "membership"): Vector {
  const vector = table.getChild(name);
  if (vector === null) {
    throw invalidComposite(`${role} component is missing required column ${JSON.stringify(name)}`);
  }
  return vector;
}

function takeRows(table: Table, rows: readonly number[], context: string): Table {
  try {
    const columns: Record<string, Vector> = {};
    for (let index = 0; index < table.schema.fields.length; index += 1) {
      const field = table.schema.fields[index];
      const vector = table.getChildAt(index);
      if (field === undefined || vector === null) throw new Error("missing Arrow vector");
      columns[field.name] = vectorFromArray(
        rows.map((row) => vector.get(row)),
        field.type,
      );
    }
    return new Table(columns);
  } catch {
    throw invalidComposite(`${context} could not retain the snapshot Arrow types`);
  }
}

function joinKey(
  entity: unknown,
  eventTime: unknown,
  role: "primary" | "membership",
  row: number,
): string {
  return `${entityIdentity(entity, role, row)}\0${temporalMillis(eventTime, `${role} event time`, row)}`;
}

function entityIdentity(value: unknown, role: "primary" | "membership", row: number): string {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "bigint") return `bigint:${value.toString(10)}`;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
    return `number:${JSON.stringify(value)}`;
  }
  if (value instanceof Date && Number.isFinite(value.valueOf())) {
    return `date:${value.valueOf()}`;
  }
  if (value instanceof Uint8Array) return `binary:${Buffer.from(value).toString("base64")}`;
  throw invalidComposite(`${role} row ${row} has an invalid entity key`);
}

function temporalMillis(value: unknown, field: string, row: number): number {
  let instant = Number.NaN;
  try {
    if (typeof value === "number") instant = value;
    else if (value instanceof Date) instant = value.valueOf();
    else if (typeof value === "string") instant = Date.parse(normalizeDecisionTime(value));
  } catch {
    instant = Number.NaN;
  }
  if (!Number.isFinite(instant)) {
    throw invalidComposite(`${field} is invalid at row ${row}`);
  }
  return instant;
}

function strictBoolean(
  value: unknown,
  column: string,
  role: "primary" | "membership",
  row: number,
): boolean {
  if (typeof value !== "boolean") {
    throw invalidComposite(
      `${role} column ${JSON.stringify(column)} contains a non-boolean value at row ${row}`,
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw invalidComposite("composite source contains a non-canonical value");
}

function invalidComposite(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_COMPOSITE_SOURCE",
    message,
    "Recreate the composite from matching guarded read sets and an explicit output declaration.",
  );
}
