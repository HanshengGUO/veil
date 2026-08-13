import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  type AdapterDeclaration,
  hashAdapterDeclaration,
  normalizeDecisionTime,
  SOURCE_TYPES,
  type SourceType,
} from "@veilquant/contract";
import { type Table, tableFromIPC, tableToIPC } from "apache-arrow";
import type { BackendDescriptor, BackendRuntime, SourceFingerprint } from "./backend.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  sourceFingerprintMatchesManifest,
  verifyCompositeSourceManifest,
  verifySourceManifest,
} from "./source-manifest.ts";
import {
  createTemporalReadPlan,
  type TemporalReadPlan,
  type TemporalReadQuery,
} from "./temporal-plan.ts";

export const READ_SET_FORMAT = "veil.read-set.v0" as const;
export const READ_SET_FILTER_VERSION = "veil.temporal-filter.v1" as const;
export const READ_SET_RESULT_VERSION = "veil.arrow-result.v1" as const;

const ENGINE_RUNTIME = "@veilquant/engine@0.1.0";
const ARROW_RUNTIME = "apache-arrow@21.2.0";
const QUERY_HASH_DOMAIN = "veil.read-set.query.v0";
const SCHEMA_HASH_DOMAIN = "veil.read-set.schema.v0";
const ROW_HASH_DOMAIN = "veil.read-set.row.v0";
const ORDERED_CACHE_HASH_DOMAIN = "veil.read-set.ordered-cache.v0";
const RESULT_HASH_DOMAIN = "veil.read-set.result.v0";
const MANIFEST_HASH_DOMAIN = "veil.read-set.manifest.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface ReadSetMetadataEntry {
  readonly key: string;
  readonly value: string;
}

export interface ReadSetSchemaField {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly metadata: readonly ReadSetMetadataEntry[];
}

export interface ReadSetSchema {
  readonly fields: readonly ReadSetSchemaField[];
  readonly metadata: readonly ReadSetMetadataEntry[];
}

export interface ReadSetQueryEnvelope {
  readonly dataset: string;
  readonly adapterVersion: string;
  readonly asOf: string;
  readonly projection: readonly string[] | null;
  readonly temporalPredicate: {
    readonly column: string;
    readonly operator: "<=";
    readonly value: string;
  };
  readonly filterVersion: typeof READ_SET_FILTER_VERSION;
}

export interface ReadSetResultIdentity {
  readonly canonicalizationVersion: typeof READ_SET_RESULT_VERSION;
  readonly schema: ReadSetSchema;
  readonly schemaHash: string;
  readonly rowCount: number;
  readonly resultHash: string;
  readonly arrowHash: string;
}

export interface ReadSetManifest {
  readonly format: typeof READ_SET_FORMAT;
  readonly declarationHash: string;
  readonly source: {
    readonly kind: SourceType;
    readonly fingerprint: SourceFingerprint | null;
  };
  readonly query: ReadSetQueryEnvelope;
  readonly queryHash: string;
  readonly result: ReadSetResultIdentity;
  readonly runtime: {
    readonly engine: string;
    readonly arrow: string;
    readonly backend: {
      readonly id: string;
      readonly runtime: BackendRuntime | null;
    };
  };
  readonly manifestHash: string;
}

export interface ReadSetVerificationEvidence {
  readonly arrowIpc: Uint8Array;
  readonly expectedManifestHash?: string;
  readonly declaration?: AdapterDeclaration;
  readonly sourceFingerprint?: SourceFingerprint | null;
}

interface CreateReadSetManifestInput {
  readonly declaration: AdapterDeclaration;
  readonly plan: TemporalReadPlan;
  readonly table: Table;
  readonly arrowIpc: Uint8Array;
  readonly sourceFingerprint: SourceFingerprint | null;
  readonly backend: BackendDescriptor;
  readonly backendRuntime: BackendRuntime | null;
}

type ReadSetManifestBody = Omit<ReadSetManifest, "manifestHash">;

interface CanonicalField {
  readonly index: number;
  readonly schema: ReadSetSchemaField;
}

const READ_SET_IDENTITY_CACHE_BRAND: unique symbol = Symbol("veil.read-set-identity-cache");

/** Opaque internal per-guard memo; result identities remain unchanged. */
export type ReadSetIdentityCache = {
  readonly [READ_SET_IDENTITY_CACHE_BRAND]: true;
};

interface ReadSetIdentityCacheState {
  readonly maximumRows: number;
  readonly rowHashes: Map<string, string>;
  readonly resultsByArrow: WeakMap<Uint8Array, CachedArrowResult>;
  readonly resultsByArrowHash: Map<string, ExactCachedArrowResult>;
  readonly series: Map<string, CachedArrowResult>;
}

interface CachedArrowResult {
  readonly arrowHash: string;
  readonly result: ReadSetResultIdentity;
  readonly rowHashesInOrder: readonly string[];
  readonly orderedRowsHash: string | null;
  readonly orderedRowsHasher: ReturnType<typeof createHash> | null;
}

interface ExactCachedArrowResult {
  readonly arrowHash: string;
  readonly result: ReadSetResultIdentity;
}

const IDENTITY_CACHE_STATES = new WeakMap<ReadSetIdentityCache, ReadSetIdentityCacheState>();

export function createReadSetIdentityCache(maximumRows = 500_000): ReadSetIdentityCache {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 0) {
    throw invalidReadSet("read-set identity cache limit must be a non-negative safe integer");
  }
  const cache = Object.freeze({ [READ_SET_IDENTITY_CACHE_BRAND]: true as const });
  IDENTITY_CACHE_STATES.set(cache, {
    maximumRows,
    rowHashes: new Map(),
    resultsByArrow: new WeakMap(),
    resultsByArrowHash: new Map(),
    series: new Map(),
  });
  return cache;
}

export function createReadSetManifest(
  input: CreateReadSetManifestInput,
  identityCache?: ReadSetIdentityCache,
  identitySeries?: string,
): ReadSetManifest {
  const query = queryEnvelope(input.plan);
  const result = canonicalArrowResult(input.table, input.arrowIpc, identityCache, identitySeries);
  const body: ReadSetManifestBody = {
    format: READ_SET_FORMAT,
    declarationHash: hashAdapterDeclaration(input.declaration),
    source: {
      kind: input.declaration.source.type,
      fingerprint:
        input.sourceFingerprint === null ? null : Object.freeze({ ...input.sourceFingerprint }),
    },
    query,
    queryHash: hashCanonical(QUERY_HASH_DOMAIN, query),
    result,
    runtime: {
      engine: ENGINE_RUNTIME,
      arrow: ARROW_RUNTIME,
      backend: {
        id: input.backend.id,
        runtime: input.backendRuntime === null ? null : Object.freeze({ ...input.backendRuntime }),
      },
    },
  };
  return deepFreeze({
    ...body,
    manifestHash: hashCanonical(MANIFEST_HASH_DOMAIN, body),
  });
}

export function verifyReadSetManifest(
  input: unknown,
  evidence: ReadSetVerificationEvidence,
  identityCache?: ReadSetIdentityCache,
): ReadSetManifest {
  if (!(evidence.arrowIpc instanceof Uint8Array) || evidence.arrowIpc.byteLength === 0) {
    throw invalidReadSet("read-set verification requires non-empty Arrow IPC evidence");
  }
  const manifest = normalizeManifest(input);
  const body = manifestBody(manifest);

  requireHash(
    hashCanonical(QUERY_HASH_DOMAIN, manifest.query) === manifest.queryHash,
    "read-set query hash does not match its envelope",
  );
  requireHash(
    hashCanonical(SCHEMA_HASH_DOMAIN, {
      canonicalizationVersion: manifest.result.canonicalizationVersion,
      schema: manifest.result.schema,
    }) === manifest.result.schemaHash,
    "read-set schema hash does not match its schema",
  );
  requireHash(
    hashCanonical(MANIFEST_HASH_DOMAIN, body) === manifest.manifestHash,
    "read-set manifest hash does not match its content",
  );

  if (evidence.expectedManifestHash !== undefined) {
    const expected = sha256(evidence.expectedManifestHash, "expected manifest hash");
    requireHash(
      expected === manifest.manifestHash,
      "read-set identity differs from the expected id",
    );
  }

  if (evidence.declaration !== undefined) {
    requireHash(
      hashAdapterDeclaration(evidence.declaration) === manifest.declarationHash,
      "read-set declaration hash does not match the supplied declaration",
    );
    requireHash(
      evidence.declaration.source.type === manifest.source.kind,
      "read-set source kind does not match the supplied declaration",
    );
    const verificationPlan = createTemporalReadPlan(
      evidence.declaration,
      queryFromEnvelope(manifest.query),
    );
    requireHash(
      canonicalJson(queryEnvelope(verificationPlan)) === canonicalJson(manifest.query),
      "read-set query does not match the supplied declaration",
    );
  }

  if (Object.hasOwn(evidence, "sourceFingerprint")) {
    const supplied = normalizeFingerprint(evidence.sourceFingerprint, "verification fingerprint");
    requireHash(
      canonicalJson(supplied) === canonicalJson(manifest.source.fingerprint),
      "read-set source fingerprint does not match the supplied evidence",
    );
  }

  verifyReadSetResultIdentity(manifest.result, evidence.arrowIpc, identityCache);

  return manifest;
}

/** Builds the same canonical Arrow identity used inside read-set and derived-window manifests. */
export function createReadSetResultIdentity(
  arrowIpc: Uint8Array,
  identityCache?: ReadSetIdentityCache,
): ReadSetResultIdentity {
  if (!(arrowIpc instanceof Uint8Array) || arrowIpc.byteLength === 0) {
    throw invalidReadSet("read-set result identity requires non-empty Arrow IPC evidence");
  }
  let table: Table;
  try {
    table = tableFromIPC(arrowIpc);
  } catch {
    throw invalidReadSet("read-set Arrow IPC evidence is unreadable");
  }
  return canonicalArrowResult(table, arrowIpc, identityCache);
}

/** Independently recomputes schema, logical rows, and exact Arrow bytes for a result identity. */
export function verifyReadSetResultIdentity(
  input: unknown,
  arrowIpc: Uint8Array,
  identityCache?: ReadSetIdentityCache,
): ReadSetResultIdentity {
  const expected = normalizeResult(input);
  requireHash(
    hashCanonical(SCHEMA_HASH_DOMAIN, {
      canonicalizationVersion: expected.canonicalizationVersion,
      schema: expected.schema,
    }) === expected.schemaHash,
    "read-set result schema hash does not match its schema",
  );
  const actual = createReadSetResultIdentity(arrowIpc, identityCache);
  requireHash(
    canonicalJson(actual.schema) === canonicalJson(expected.schema),
    "read-set Arrow schema differs from the result identity",
  );
  requireHash(actual.schemaHash === expected.schemaHash, "read-set schema hash differs");
  requireHash(actual.rowCount === expected.rowCount, "read-set row count differs");
  requireHash(actual.resultHash === expected.resultHash, "read-set result hash differs");
  requireHash(actual.arrowHash === expected.arrowHash, "read-set Arrow content hash differs");
  return deepFreeze(expected);
}

/** Internal fast path for an engine-created exact row selection from a cached guarded Arrow. */
export function createSelectedReadSetResultIdentity(
  sourceArrowIpc: Uint8Array,
  selectedTable: Table,
  selectedArrowIpc: Uint8Array,
  rows: readonly number[],
  identityCache: ReadSetIdentityCache,
): ReadSetResultIdentity {
  const state = identityCacheState(identityCache);
  const source = state.resultsByArrow.get(sourceArrowIpc);
  if (source === undefined || source.arrowHash !== hashBytes(sourceArrowIpc)) {
    throw invalidReadSet("selected result source is absent from the guarded identity cache");
  }
  if (
    selectedTable.numRows !== rows.length ||
    rows.some(
      (row, index) =>
        !Number.isSafeInteger(row) ||
        row < 0 ||
        row >= source.rowHashesInOrder.length ||
        (index > 0 && row <= (rows[index - 1] ?? -1)),
    )
  ) {
    throw invalidReadSet("selected result rows are not a valid ordered source selection");
  }
  const { schema, schemaHash } = canonicalSchema(selectedTable);
  const rowHashesInOrder = rows.map((row) => source.rowHashesInOrder[row] ?? "");
  if (rowHashesInOrder.some((rowHash) => rowHash.length === 0)) {
    throw invalidReadSet("selected result is missing a cached source row identity");
  }
  const arrowHash = hashBytes(selectedArrowIpc);
  const result = resultIdentity(schema, schemaHash, rowHashesInOrder, arrowHash);
  state.resultsByArrow.set(selectedArrowIpc, {
    arrowHash,
    result,
    rowHashesInOrder,
    orderedRowsHash: null,
    orderedRowsHasher: null,
  });
  return result;
}

function queryEnvelope(plan: TemporalReadPlan): ReadSetQueryEnvelope {
  return deepFreeze({
    dataset: plan.dataset,
    adapterVersion: plan.adapterVersion,
    asOf: plan.asOf,
    projection: plan.requestedColumns === null ? null : [...plan.requestedColumns],
    temporalPredicate: { ...plan.temporalPredicate },
    filterVersion: READ_SET_FILTER_VERSION,
  });
}

function queryFromEnvelope(query: ReadSetQueryEnvelope): TemporalReadQuery {
  return query.projection === null
    ? { asOf: query.asOf }
    : { asOf: query.asOf, columns: query.projection };
}

function canonicalArrowResult(
  table: Table,
  arrowIpc: Uint8Array,
  identityCache?: ReadSetIdentityCache,
  identitySeries?: string,
): ReadSetResultIdentity {
  const cacheState = identityCache === undefined ? undefined : identityCacheState(identityCache);
  const arrowHash = hashBytes(arrowIpc);
  const cachedByObject = cacheState?.resultsByArrow.get(arrowIpc);
  if (cachedByObject !== undefined && cachedByObject.arrowHash === arrowHash) {
    return cachedByObject.result;
  }
  const cachedByHash = cacheState?.resultsByArrowHash.get(arrowHash);
  if (
    identitySeries === undefined &&
    cachedByHash !== undefined &&
    cachedByHash.arrowHash === arrowHash
  ) {
    return cachedByHash.result;
  }
  const names = table.schema.fields.map((field) => field.name);
  if (names.some((name, index) => names.indexOf(name) !== index)) {
    throw invalidReadSet("canonical read-set schema contains duplicate column names");
  }

  const { fields, schema, schemaHash } = canonicalSchema(table);
  const prior = identitySeries === undefined ? undefined : cacheState?.series.get(identitySeries);
  const canCheckExtension =
    prior !== undefined &&
    prior.result.schemaHash === schemaHash &&
    prior.result.rowCount <= table.numRows &&
    prior.orderedRowsHash !== null &&
    prior.orderedRowsHasher !== null;
  let orderedHasher = orderedCacheHasher(schemaHash);
  let rowHashesInOrder: string[] = [];
  if (canCheckExtension) {
    const physicalPrefixMatches =
      hashBytes(tableToIPC(table.slice(0, prior.result.rowCount), "stream")) === prior.arrowHash;
    if (physicalPrefixMatches) {
      rowHashesInOrder = [...prior.rowHashesInOrder];
      orderedHasher = prior.orderedRowsHasher.copy();
    } else {
      for (let row = 0; row < prior.result.rowCount; row += 1) {
        updateOrderedCacheHash(orderedHasher, canonicalTableRow(table, fields, row));
      }
      if (orderedCacheDigest(orderedHasher) === prior.orderedRowsHash) {
        rowHashesInOrder = [...prior.rowHashesInOrder];
      } else {
        orderedHasher = orderedCacheHasher(schemaHash);
      }
    }
  }
  for (let row = rowHashesInOrder.length; row < table.numRows; row += 1) {
    const canonicalRow = canonicalTableRow(table, fields, row);
    updateOrderedCacheHash(orderedHasher, canonicalRow);
    const cacheKey = `${schemaHash}\0${canonicalRow}`;
    let rowHash = cacheState?.rowHashes.get(cacheKey);
    if (rowHash === undefined) {
      rowHash = hashCanonicalText(ROW_HASH_DOMAIN, canonicalRow);
      if (cacheState !== undefined && cacheState.rowHashes.size < cacheState.maximumRows) {
        cacheState.rowHashes.set(cacheKey, rowHash);
      }
    }
    rowHashesInOrder.push(rowHash);
  }
  const result = resultIdentity(schema, schemaHash, rowHashesInOrder, arrowHash);
  const cachedResult = {
    arrowHash,
    result,
    rowHashesInOrder,
    orderedRowsHash: orderedCacheDigest(orderedHasher),
    orderedRowsHasher: orderedHasher.copy(),
  };
  if (cacheState !== undefined) {
    cacheState.resultsByArrow.set(arrowIpc, cachedResult);
    if (cacheState.resultsByArrowHash.size < 5_000) {
      cacheState.resultsByArrowHash.set(arrowHash, { arrowHash, result });
    }
    if (identitySeries !== undefined) {
      const latest = cacheState.series.get(identitySeries);
      if (latest === undefined || result.rowCount >= latest.result.rowCount) {
        cacheState.series.set(identitySeries, cachedResult);
      }
    }
  }
  return result;
}

function canonicalTableRow(table: Table, fields: readonly CanonicalField[], row: number): string {
  const values = fields.map((field) => {
    const vector = table.getChildAt(field.index);
    if (vector === null) {
      throw invalidReadSet("canonical read-set schema is missing a column vector");
    }
    return canonicalScalar(vector.get(row));
  });
  return canonicalJson(values);
}

function orderedCacheHasher(schemaHash: string): ReturnType<typeof createHash> {
  return createHash("sha256")
    .update(ORDERED_CACHE_HASH_DOMAIN)
    .update("\0")
    .update(schemaHash)
    .update("\0");
}

function updateOrderedCacheHash(hasher: ReturnType<typeof createHash>, canonicalRow: string): void {
  hasher
    .update(String(Buffer.byteLength(canonicalRow)))
    .update(":")
    .update(canonicalRow);
}

function orderedCacheDigest(hasher: ReturnType<typeof createHash>): string {
  return `sha256:${hasher.copy().digest("hex")}`;
}

function canonicalSchema(table: Table): {
  readonly fields: readonly CanonicalField[];
  readonly schema: ReadSetSchema;
  readonly schemaHash: string;
} {
  const fields: CanonicalField[] = table.schema.fields
    .map((field, index) => ({
      index,
      schema: {
        name: nonemptyString(field.name, "Arrow field name"),
        type: nonemptyString(field.type.toString(), "Arrow field type"),
        nullable: field.nullable,
        metadata: metadataEntries(field.metadata),
      },
    }))
    .sort((left, right) => compareText(left.schema.name, right.schema.name));
  const schema: ReadSetSchema = {
    fields: fields.map((field) => field.schema),
    metadata: metadataEntries(table.schema.metadata),
  };
  return {
    fields,
    schema,
    schemaHash: hashCanonical(SCHEMA_HASH_DOMAIN, {
      canonicalizationVersion: READ_SET_RESULT_VERSION,
      schema,
    }),
  };
}

function resultIdentity(
  schema: ReadSetSchema,
  schemaHash: string,
  rowHashesInOrder: readonly string[],
  arrowHash: string,
): ReadSetResultIdentity {
  const rowHashes = [...rowHashesInOrder].sort(compareText);
  return deepFreeze({
    canonicalizationVersion: READ_SET_RESULT_VERSION,
    schema,
    schemaHash,
    rowCount: rowHashes.length,
    resultHash: hashCanonical(RESULT_HASH_DOMAIN, {
      canonicalizationVersion: READ_SET_RESULT_VERSION,
      schemaHash,
      rowCount: rowHashes.length,
      rowHashes,
    }),
    arrowHash,
  });
}

function identityCacheState(cache: ReadSetIdentityCache): ReadSetIdentityCacheState {
  const state = IDENTITY_CACHE_STATES.get(cache);
  if (state === undefined) {
    throw invalidReadSet("read-set identity cache was not created by this engine instance");
  }
  return state;
}

function canonicalScalar(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return { $number: "nan" };
    }
    if (value === Number.POSITIVE_INFINITY) {
      return { $number: "+infinity" };
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return { $number: "-infinity" };
    }
    if (Object.is(value, -0)) {
      return { $number: "-0" };
    }
    return value;
  }
  if (typeof value === "bigint") {
    return { $bigint: value.toString(10) };
  }
  if (value instanceof Date) {
    const milliseconds = value.valueOf();
    if (Number.isFinite(milliseconds)) {
      return milliseconds;
    }
  }
  if (value instanceof Uint8Array) {
    return { $binary: Buffer.from(value).toString("base64") };
  }
  throw invalidReadSet("Arrow result contains a value unsupported by read-set v0 canonicalization");
}

function metadataEntries(metadata: Map<string, string>): readonly ReadSetMetadataEntry[] {
  return [...metadata.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => compareText(left.key, right.key));
}

function normalizeManifest(input: unknown): ReadSetManifest {
  const root = exactRecord(
    input,
    [
      "format",
      "declarationHash",
      "source",
      "query",
      "queryHash",
      "result",
      "runtime",
      "manifestHash",
    ],
    "manifest",
  );
  const format = nonemptyString(root.format, "manifest format");
  if (format !== READ_SET_FORMAT) {
    throw invalidReadSet("read-set manifest uses an unsupported format");
  }
  return deepFreeze({
    format,
    declarationHash: sha256(root.declarationHash, "declaration hash"),
    source: normalizeSource(root.source),
    query: normalizeQuery(root.query),
    queryHash: sha256(root.queryHash, "query hash"),
    result: normalizeResult(root.result),
    runtime: normalizeRuntime(root.runtime),
    manifestHash: sha256(root.manifestHash, "manifest hash"),
  });
}

function normalizeSource(input: unknown): ReadSetManifest["source"] {
  const source = exactRecord(input, ["kind", "fingerprint"], "source");
  const kind = nonemptyString(source.kind, "source kind");
  if (!SOURCE_TYPES.includes(kind as SourceType)) {
    throw invalidReadSet("read-set source kind is unsupported");
  }
  return {
    kind: kind as SourceType,
    fingerprint: normalizeFingerprint(source.fingerprint, "source fingerprint"),
  };
}

function normalizeFingerprint(input: unknown, field: string): SourceFingerprint | null {
  if (input === null) {
    return null;
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw invalidReadSet(`${field} must be an object`);
  }
  const hasManifest = Object.hasOwn(input, "manifest");
  const hasEvidence = Object.hasOwn(input, "evidence");
  const fingerprint = exactRecord(
    input,
    [
      "algorithm",
      "value",
      "scope",
      ...(hasManifest ? ["manifest"] : []),
      ...(hasEvidence ? ["evidence"] : []),
    ],
    field,
  );
  const scope = nonemptyString(fingerprint.scope, `${field} scope`);
  if (scope !== "source-version" && scope !== "read-snapshot") {
    throw invalidReadSet(`${field} scope is unsupported`);
  }
  const normalized: SourceFingerprint = {
    algorithm: nonemptyString(fingerprint.algorithm, `${field} algorithm`),
    value: nonemptyString(fingerprint.value, `${field} value`),
    scope,
  };
  if (hasManifest && hasEvidence) {
    throw invalidReadSet(`${field} cannot contain both file manifest and derived evidence`);
  }
  if (!hasManifest && !hasEvidence) {
    return normalized;
  }
  try {
    const evidence = hasManifest
      ? verifySourceManifest(fingerprint.manifest)
      : verifyCompositeSourceManifest(fingerprint.evidence);
    if (!sourceFingerprintMatchesManifest(normalized, evidence)) {
      throw new Error("fingerprint mismatch");
    }
    if (evidence.format === "veil.source-manifest.v0") {
      return { ...normalized, manifest: evidence };
    }
    return { ...normalized, evidence };
  } catch {
    throw invalidReadSet(`${field} contains an invalid or mismatched source manifest`);
  }
}

function normalizeQuery(input: unknown): ReadSetQueryEnvelope {
  const query = exactRecord(
    input,
    ["dataset", "adapterVersion", "asOf", "projection", "temporalPredicate", "filterVersion"],
    "query",
  );
  const asOf = nonemptyString(query.asOf, "query asOf");
  try {
    if (normalizeDecisionTime(asOf) !== asOf) {
      throw new Error("not normalized");
    }
  } catch {
    throw invalidReadSet("read-set query asOf is not a normalized decision time");
  }
  const projection = normalizeProjection(query.projection);
  const predicate = exactRecord(
    query.temporalPredicate,
    ["column", "operator", "value"],
    "temporal predicate",
  );
  if (predicate.operator !== "<=" || predicate.value !== asOf) {
    throw invalidReadSet("read-set temporal predicate is inconsistent with its query");
  }
  if (query.filterVersion !== READ_SET_FILTER_VERSION) {
    throw invalidReadSet("read-set query uses an unsupported temporal filter version");
  }
  return {
    dataset: nonemptyString(query.dataset, "query dataset"),
    adapterVersion: nonemptyString(query.adapterVersion, "query adapter version"),
    asOf,
    projection,
    temporalPredicate: {
      column: nonemptyString(predicate.column, "temporal predicate column"),
      operator: "<=",
      value: asOf,
    },
    filterVersion: READ_SET_FILTER_VERSION,
  };
}

function normalizeProjection(input: unknown): readonly string[] | null {
  if (input === null) {
    return null;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidReadSet("read-set query projection must be null or a non-empty array");
  }
  const projection = input.map((value) => nonemptyString(value, "projection column"));
  if (new Set(projection).size !== projection.length) {
    throw invalidReadSet("read-set query projection contains duplicate columns");
  }
  return projection;
}

function normalizeResult(input: unknown): ReadSetResultIdentity {
  const result = exactRecord(
    input,
    ["canonicalizationVersion", "schema", "schemaHash", "rowCount", "resultHash", "arrowHash"],
    "result",
  );
  if (result.canonicalizationVersion !== READ_SET_RESULT_VERSION) {
    throw invalidReadSet("read-set result uses an unsupported canonicalization version");
  }
  return {
    canonicalizationVersion: READ_SET_RESULT_VERSION,
    schema: normalizeSchema(result.schema),
    schemaHash: sha256(result.schemaHash, "schema hash"),
    rowCount: nonnegativeInteger(result.rowCount, "result row count"),
    resultHash: sha256(result.resultHash, "result hash"),
    arrowHash: sha256(result.arrowHash, "Arrow content hash"),
  };
}

function normalizeSchema(input: unknown): ReadSetSchema {
  const schema = exactRecord(input, ["fields", "metadata"], "schema");
  if (!Array.isArray(schema.fields) || !Array.isArray(schema.metadata)) {
    throw invalidReadSet("read-set schema fields and metadata must be arrays");
  }
  const fields = schema.fields.map((field, index) => normalizeSchemaField(field, index));
  requireSortedUnique(
    fields.map((field) => field.name),
    "read-set schema fields must be unique and sorted by name",
  );
  return {
    fields,
    metadata: normalizeMetadata(schema.metadata, "schema metadata"),
  };
}

function normalizeSchemaField(input: unknown, index: number): ReadSetSchemaField {
  const field = exactRecord(input, ["name", "type", "nullable", "metadata"], `field ${index}`);
  if (typeof field.nullable !== "boolean") {
    throw invalidReadSet("read-set schema field nullable flag must be boolean");
  }
  if (!Array.isArray(field.metadata)) {
    throw invalidReadSet("read-set schema field metadata must be an array");
  }
  return {
    name: nonemptyString(field.name, "schema field name"),
    type: nonemptyString(field.type, "schema field type"),
    nullable: field.nullable,
    metadata: normalizeMetadata(field.metadata, "field metadata"),
  };
}

function normalizeMetadata(
  input: readonly unknown[],
  field: string,
): readonly ReadSetMetadataEntry[] {
  const entries = input.map((value, index) => {
    const entry = exactRecord(value, ["key", "value"], `${field} entry ${index}`);
    return {
      key: nonemptyString(entry.key, `${field} key`),
      value: stringValue(entry.value, `${field} value`),
    };
  });
  requireSortedUnique(
    entries.map((entry) => entry.key),
    `${field} keys must be unique and sorted`,
  );
  return entries;
}

function normalizeRuntime(input: unknown): ReadSetManifest["runtime"] {
  const runtime = exactRecord(input, ["engine", "arrow", "backend"], "runtime");
  const backend = exactRecord(runtime.backend, ["id", "runtime"], "backend runtime envelope");
  const backendRuntime =
    backend.runtime === null ? null : normalizeBackendRuntime(backend.runtime, "backend runtime");
  const backendId = nonemptyString(backend.id, "backend id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(backendId)) {
    throw invalidReadSet("read-set backend id is not portable");
  }
  return {
    engine: nonemptyString(runtime.engine, "engine runtime"),
    arrow: nonemptyString(runtime.arrow, "Arrow runtime"),
    backend: { id: backendId, runtime: backendRuntime },
  };
}

function normalizeBackendRuntime(input: unknown, field: string): BackendRuntime {
  const runtime = exactRecord(input, ["name", "version"], field);
  return {
    name: nonemptyString(runtime.name, `${field} name`),
    version: nonemptyString(runtime.version, `${field} version`),
  };
}

function manifestBody(manifest: ReadSetManifest): ReadSetManifestBody {
  return {
    format: manifest.format,
    declarationHash: manifest.declarationHash,
    source: manifest.source,
    query: manifest.query,
    queryHash: manifest.queryHash,
    result: manifest.result,
    runtime: manifest.runtime,
  };
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidReadSet(`${field} must be an object`);
  }
  const record = input as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw invalidReadSet(`${field} has missing or unknown fields`);
  }
  return record;
}

function nonemptyString(input: unknown, field: string): string {
  const value = stringValue(input, field);
  if (value.length === 0) {
    throw invalidReadSet(`${field} must not be empty`);
  }
  return value;
}

function stringValue(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw invalidReadSet(`${field} must be a string`);
  }
  return input;
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidReadSet(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  const value = nonemptyString(input, field);
  if (!SHA256_PATTERN.test(value)) {
    throw invalidReadSet(`${field} must be a lowercase sha256 identity`);
  }
  return value;
}

function requireSortedUnique(values: readonly string[], message: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || compareText(previous, current) >= 0) {
      throw invalidReadSet(message);
    }
  }
}

function requireHash(condition: boolean, message: string): void {
  if (!condition) {
    throw invalidReadSet(message);
  }
}

function hashCanonical(domain: string, value: unknown): string {
  return hashCanonicalText(domain, canonicalJson(value));
}

function hashCanonicalText(domain: string, canonical: string): string {
  const digest = createHash("sha256").update(domain).update("\0").update(canonical).digest("hex");
  return `sha256:${digest}`;
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidReadSet("canonical read-set JSON contains a non-finite number");
    }
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
  throw invalidReadSet("canonical read-set JSON contains an unsupported value");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidReadSet(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_READ_SET",
    message,
    "Regenerate the read-set from trusted declaration, source, query, and Arrow evidence.",
  );
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
