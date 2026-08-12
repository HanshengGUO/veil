import { AdapterDeclarationError } from "./errors.ts";
import { deepFreeze } from "./freeze.ts";
import { normalizeIsoInstant, normalizePositiveIsoDuration } from "./time.ts";

export const AVAILABILITY_BASES = ["observed", "reconstructed", "assumed"] as const;
export type AvailabilityBasis = (typeof AVAILABILITY_BASES)[number];

export const SOURCE_TYPES = [
  "parquet",
  "csv",
  "duckdb",
  "dolphindb",
  "clickhouse",
  "custom",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type SurvivorshipGuarantee = boolean | "unknown";

export interface AvailabilityBasisSegment {
  /** Inclusive event-time boundary, normalized to UTC. */
  readonly from: string | null;
  /** Exclusive event-time boundary, normalized to UTC. */
  readonly until: string | null;
  readonly basis: AvailabilityBasis;
  /** Evidence used to reconstruct an availability timestamp. */
  readonly source: string | null;
  /** Positive ISO-8601 duration used for an assumed timestamp. */
  readonly lag: string | null;
  readonly rationale: string | null;
}

export interface AdapterGuarantees {
  readonly pointInTime: boolean;
  readonly vintage: boolean;
  readonly survivorshipFree: SurvivorshipGuarantee;
  readonly tradabilityMask: string | null;
}

export interface AdapterProvenance {
  readonly certified: boolean;
  readonly lineageRef: string | null;
}

/** Portable and non-secret. Runtime paths and credentials live in an engine SourceBinding. */
export interface AdapterSource {
  readonly type: SourceType;
  readonly locator: string;
}

export interface AdapterTimeSemantics {
  readonly barLabeling: "open" | "close" | "na";
  readonly timestampBasis: "exchange" | "receipt" | "processed";
  readonly timezone: string;
  readonly latencyClass: "realtime" | "delayed" | "eod";
}

export interface AdapterDeclaration {
  readonly dataset: string;
  readonly version: string;
  readonly entityKey: string;
  readonly eventTime: string;
  readonly availableTime: string | null;
  readonly availabilityBasis: readonly AvailabilityBasisSegment[] | null;
  readonly frequency: string | null;
  readonly guarantees: AdapterGuarantees;
  readonly provenance: AdapterProvenance;
  readonly payloadSchema: Readonly<Record<string, string>>;
  readonly source: AdapterSource;
  readonly timeSemantics: AdapterTimeSemantics | null;
  readonly notes: string | null;
}

const ROOT_FIELDS = new Set([
  "dataset",
  "version",
  "entity_key",
  "event_time",
  "available_time",
  "availability_basis",
  "frequency",
  "guarantees",
  "provenance",
  "payload_schema",
  "source",
  "time_semantics",
  "notes",
]);

export function normalizeAdapterDeclaration(input: unknown): AdapterDeclaration {
  const root = expectRecord(input, "$", "an adapter declaration object");
  assertKnownFields(root, ROOT_FIELDS, "$", "Remove the field or correct its spelling.");

  const dataset = requiredString(root, "dataset", "$.dataset");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dataset)) {
    fail(
      "INVALID_VALUE",
      "$.dataset",
      "dataset must be a portable registry name",
      "Use letters, digits, dots, underscores, or hyphens, starting with a letter or digit.",
    );
  }

  const version = requiredString(root, "version", "$.version");
  const entityKey = requiredString(root, "entity_key", "$.entity_key");
  const eventTime = requiredString(root, "event_time", "$.event_time");
  const availableTimeValue = required(root, "available_time", "$.available_time");
  const availableTime = nullableString(availableTimeValue, "$.available_time");

  let availabilityBasis: readonly AvailabilityBasisSegment[] | null = null;
  if (availableTime === null) {
    if (
      Object.hasOwn(root, "availability_basis") &&
      root.availability_basis !== null &&
      root.availability_basis !== undefined
    ) {
      fail(
        "CONTRADICTORY_DECLARATION",
        "$.availability_basis",
        "availability_basis cannot describe a missing available_time",
        "Remove availability_basis or declare the column that carries available_time.",
      );
    }
  } else {
    const basisValue = required(root, "availability_basis", "$.availability_basis");
    availabilityBasis = normalizeAvailabilityBasis(basisValue, "$.availability_basis");
  }

  const guarantees = normalizeGuarantees(root.guarantees);
  if (guarantees.pointInTime && availableTime === null) {
    fail(
      "CONTRADICTORY_DECLARATION",
      "$.guarantees.point_in_time",
      "point_in_time cannot be true when available_time is null",
      "Declare the real availability column or set point_in_time to false.",
    );
  }

  const provenance = normalizeProvenance(root.provenance);
  const declaration: AdapterDeclaration = {
    dataset,
    version,
    entityKey,
    eventTime,
    availableTime,
    availabilityBasis,
    frequency: optionalString(root.frequency, "$.frequency"),
    guarantees,
    provenance,
    payloadSchema: normalizePayloadSchema(root.payload_schema),
    source: normalizeSource(required(root, "source", "$.source")),
    timeSemantics: normalizeTimeSemantics(root.time_semantics),
    notes: optionalString(root.notes, "$.notes"),
  };

  return deepFreeze(declaration);
}

/** Selects an availability basis using event-time interval semantics. */
export function availabilityBasisAt(
  declaration: AdapterDeclaration,
  eventTime: string,
): AvailabilityBasis | null {
  if (declaration.availabilityBasis === null) {
    return null;
  }
  const instant = normalizeIsoInstant(eventTime, "$eventTime");
  const segment = declaration.availabilityBasis.find(
    (candidate) =>
      (candidate.from === null || candidate.from <= instant) &&
      (candidate.until === null || instant < candidate.until),
  );
  return segment?.basis ?? null;
}

function normalizeAvailabilityBasis(
  input: unknown,
  path: string,
): readonly AvailabilityBasisSegment[] {
  let rawSegments: unknown[];
  if (typeof input === "string") {
    rawSegments = [{ basis: input }];
  } else if (Array.isArray(input)) {
    if (input.length === 0) {
      fail(
        "INVALID_SEGMENTS",
        path,
        "availability basis segments cannot be empty",
        "Declare one basis or at least one event-time segment.",
      );
    }
    rawSegments = input;
  } else {
    rawSegments = [input];
  }

  const segments = rawSegments.map((segment, index) =>
    normalizeAvailabilitySegment(segment, `${path}[${index}]`),
  );

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous.until === null || current.from === null || previous.until !== current.from) {
      const relation =
        previous.until !== null && current.from !== null && previous.until > current.from
          ? "overlap"
          : "gap";
      fail(
        "INVALID_SEGMENTS",
        `${path}[${index}].from`,
        `availability basis segments contain a ${relation}`,
        "Use ordered, contiguous [from, until) event-time intervals.",
      );
    }
  }

  return segments;
}

function normalizeAvailabilitySegment(input: unknown, path: string): AvailabilityBasisSegment {
  const segment = expectRecord(input, path, "an availability basis segment");
  assertKnownFields(
    segment,
    new Set(["from", "until", "basis", "source", "lag", "rationale"]),
    path,
    "Remove the field or correct its spelling.",
  );

  const from = optionalInstant(segment.from, `${path}.from`);
  const until = optionalInstant(segment.until, `${path}.until`);
  if (from !== null && until !== null && from >= until) {
    fail(
      "INVALID_SEGMENTS",
      `${path}.until`,
      "segment until must be later than from",
      "Use a non-empty [from, until) event-time interval.",
    );
  }

  const basis = enumValue(
    required(segment, "basis", `${path}.basis`),
    AVAILABILITY_BASES,
    `${path}.basis`,
  );
  const source = optionalString(segment.source, `${path}.source`);
  const lag =
    segment.lag === undefined || segment.lag === null
      ? null
      : normalizePositiveIsoDuration(segment.lag, `${path}.lag`);
  const rationale = optionalString(segment.rationale, `${path}.rationale`);

  if (basis === "reconstructed" && source === null) {
    fail(
      "MISSING_EVIDENCE",
      `${path}.source`,
      "reconstructed availability needs its vendor or publication-date source",
      "Add source, or use assumed with an explicit lag and rationale.",
    );
  }
  if (basis === "assumed" && lag === null) {
    fail(
      "MISSING_EVIDENCE",
      `${path}.lag`,
      "assumed availability needs the lag used to construct it",
      "Add a positive ISO-8601 lag such as P2D.",
    );
  }
  if (basis === "assumed" && rationale === null) {
    fail(
      "MISSING_EVIDENCE",
      `${path}.rationale`,
      "assumed availability needs a rationale",
      "State why this lag is defensible and where it came from.",
    );
  }
  if (basis === "observed" && (source !== null || lag !== null || rationale !== null)) {
    fail(
      "INVALID_VALUE",
      path,
      "observed availability cannot carry reconstruction or assumption fields",
      "Remove source/lag/rationale; observed evidence is supplied through lineage.",
    );
  }
  if (basis === "reconstructed" && (lag !== null || rationale !== null)) {
    fail(
      "INVALID_VALUE",
      path,
      "reconstructed availability cannot carry assumption fields",
      "Remove lag/rationale, or change the basis to assumed.",
    );
  }

  return { from, until, basis, source, lag, rationale };
}

function normalizeGuarantees(input: unknown): AdapterGuarantees {
  if (input === undefined) {
    return {
      pointInTime: false,
      vintage: false,
      survivorshipFree: "unknown",
      tradabilityMask: null,
    };
  }
  const guarantees = expectRecord(input, "$.guarantees", "a guarantees object");
  assertKnownFields(
    guarantees,
    new Set(["point_in_time", "vintage", "survivorship_free", "tradability_mask"]),
    "$.guarantees",
    "Remove the field or correct its spelling.",
  );

  return {
    pointInTime: optionalBoolean(guarantees.point_in_time, "$.guarantees.point_in_time", false),
    vintage: optionalBoolean(guarantees.vintage, "$.guarantees.vintage", false),
    survivorshipFree: optionalSurvivorship(guarantees.survivorship_free),
    tradabilityMask: optionalString(guarantees.tradability_mask, "$.guarantees.tradability_mask"),
  };
}

function normalizeProvenance(input: unknown): AdapterProvenance {
  if (input === undefined) {
    return { certified: false, lineageRef: null };
  }
  const provenance = expectRecord(input, "$.provenance", "a provenance object");
  assertKnownFields(
    provenance,
    new Set(["certified", "lineage_ref"]),
    "$.provenance",
    "Remove the field or correct its spelling.",
  );

  const certified = optionalBoolean(provenance.certified, "$.provenance.certified", false);
  const lineageRef = optionalString(provenance.lineage_ref, "$.provenance.lineage_ref");
  if (lineageRef?.startsWith("sha256:") && !/^sha256:[a-f0-9]{64}$/.test(lineageRef)) {
    fail(
      "INVALID_VALUE",
      "$.provenance.lineage_ref",
      "malformed SHA-256 lineage reference",
      "Use sha256 followed by exactly 64 lowercase hexadecimal characters.",
    );
  }
  if (certified && lineageRef === null) {
    fail(
      "MISSING_EVIDENCE",
      "$.provenance.lineage_ref",
      "certified provenance needs a resolvable lineage reference",
      "Add the lineage URI/hash, or set certified to false.",
    );
  }
  return { certified, lineageRef };
}

function normalizePayloadSchema(input: unknown): Readonly<Record<string, string>> {
  if (input === undefined) {
    return {};
  }
  const schema = expectRecord(input, "$.payload_schema", "a column-to-Arrow-type object");
  const normalized: Record<string, string> = {};
  for (const column of Object.keys(schema).sort()) {
    if (column.trim().length === 0) {
      fail(
        "INVALID_VALUE",
        "$.payload_schema",
        "payload column names cannot be empty",
        "Use the exact non-empty source column name.",
      );
    }
    normalized[column] = nonEmptyString(
      schema[column],
      `$.payload_schema[${JSON.stringify(column)}]`,
    );
  }
  return normalized;
}

function normalizeSource(input: unknown): AdapterSource {
  const source = expectRecord(input, "$.source", "a portable source object");
  assertKnownFields(
    source,
    new Set(["type", "locator"]),
    "$.source",
    "Portable declarations accept only type and locator; put paths/DSNs/credentials in SourceBinding.",
  );
  const type = enumValue(required(source, "type", "$.source.type"), SOURCE_TYPES, "$.source.type");
  const locator = requiredString(source, "locator", "$.source.locator");
  if (
    /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(locator) ||
    /[?&](?:password|passwd|token|api[_-]?key|secret|access[_-]?key)=/i.test(locator)
  ) {
    fail(
      "INLINE_SECRET",
      "$.source.locator",
      "portable source locator appears to contain credentials",
      "Use a non-secret logical locator and pass credentials through the engine SourceBinding.",
    );
  }
  return { type, locator };
}

function normalizeTimeSemantics(input: unknown): AdapterTimeSemantics | null {
  if (input === undefined || input === null) {
    return null;
  }
  const semantics = expectRecord(input, "$.time_semantics", "a time semantics object");
  assertKnownFields(
    semantics,
    new Set(["bar_labeling", "timestamp_basis", "timezone", "latency_class"]),
    "$.time_semantics",
    "Remove the field or correct its spelling.",
  );
  return {
    barLabeling: enumValue(
      required(semantics, "bar_labeling", "$.time_semantics.bar_labeling"),
      ["open", "close", "na"] as const,
      "$.time_semantics.bar_labeling",
    ),
    timestampBasis: enumValue(
      required(semantics, "timestamp_basis", "$.time_semantics.timestamp_basis"),
      ["exchange", "receipt", "processed"] as const,
      "$.time_semantics.timestamp_basis",
    ),
    timezone: requiredString(semantics, "timezone", "$.time_semantics.timezone"),
    latencyClass: enumValue(
      required(semantics, "latency_class", "$.time_semantics.latency_class"),
      ["realtime", "delayed", "eod"] as const,
      "$.time_semantics.latency_class",
    ),
  };
}

function expectRecord(value: unknown, path: string, expected: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_TYPE", path, `expected ${expected}`, `Replace this value with ${expected}.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  remedy: string,
): void {
  const unknown = Object.keys(record)
    .filter((key) => !allowed.has(key))
    .sort()[0];
  if (unknown !== undefined) {
    fail("UNKNOWN_FIELD", `${path}.${unknown}`, "unknown declaration field", remedy);
  }
}

function required(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(record, key) || record[key] === undefined) {
    fail("MISSING_FIELD", path, "required field is missing", "Add this field to the declaration.");
  }
  return record[key];
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  return nonEmptyString(required(record, key, path), path);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_TYPE", path, "expected a non-empty string", "Use a non-empty string value.");
  }
  return value.trim();
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : nonEmptyString(value, path);
}

function optionalString(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : nonEmptyString(value, path);
}

function optionalInstant(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : normalizeIsoInstant(value, path);
}

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    fail("INVALID_TYPE", path, "expected a boolean", "Use true or false.");
  }
  return value;
}

function optionalSurvivorship(value: unknown): SurvivorshipGuarantee {
  if (value === undefined) {
    return "unknown";
  }
  if (typeof value === "boolean" || value === "unknown") {
    return value;
  }
  fail(
    "INVALID_VALUE",
    "$.guarantees.survivorship_free",
    "expected true, false, or unknown",
    "Use unknown when survivorship handling cannot be established.",
  );
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(
      "INVALID_VALUE",
      path,
      `expected one of: ${allowed.join(", ")}`,
      "Choose one of the listed values exactly.",
    );
  }
  return value as T[number];
}

function fail(
  code: ConstructorParameters<typeof AdapterDeclarationError>[0],
  path: string,
  message: string,
  remedy: string,
): never {
  throw new AdapterDeclarationError(code, path, message, remedy);
}
