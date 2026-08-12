import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ArtifactEntrypoint, ArtifactParameterValue } from "./artifact.ts";
import { EngineConfigurationError } from "./errors.ts";

export const ARTIFACT_EXECUTION_REQUEST_FORMAT = "veil.artifact-execution-request.v0" as const;
export const ARTIFACT_EXECUTION_RESULT_FORMAT = "veil.artifact-execution-result.v0" as const;
export const ARTIFACT_EXECUTION_FRAME_HEADER_BYTES = 20;
export const ARTIFACT_EXECUTION_DEFAULT_CONTROL_BYTES = 64 * 1024;
export const ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES = 256 * 1024 * 1024;

const REQUEST_MAGIC = Buffer.from("VLRQ0001", "ascii");
const RESULT_MAGIC = Buffer.from("VLRS0001", "ascii");
const REQUEST_HASH_DOMAIN = "veil.artifact-execution-request.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

export interface ArtifactExecutionDataset {
  readonly dataset: string;
  readonly version: string;
  readonly declarationHash: string;
}

export interface ArtifactExecutionRuntime {
  readonly id: string;
  readonly implementation: {
    readonly name: string;
    readonly version: string;
  };
}

export interface ArtifactExecutionRequestMetadata {
  readonly format: typeof ARTIFACT_EXECUTION_REQUEST_FORMAT;
  readonly artifactHash: string;
  readonly codeTreeHash: string;
  readonly runtime: ArtifactExecutionRuntime;
  readonly entry: ArtifactEntrypoint;
  readonly dataset: ArtifactExecutionDataset;
  readonly readSetId: string;
  readonly decisionTime: string;
  readonly inputArrowHash: string;
  readonly paramsLocked: Readonly<Record<string, ArtifactParameterValue>>;
  readonly declaredLiterals: Readonly<Record<string, ArtifactParameterValue>>;
  readonly requestHash: string;
}

export interface ArtifactExecutionRequest {
  readonly metadata: ArtifactExecutionRequestMetadata;
  readonly arrowIpc: Uint8Array;
}

export interface CreateArtifactExecutionRequestInput {
  readonly artifactHash: string;
  readonly codeTreeHash: string;
  readonly runtime: ArtifactExecutionRuntime;
  readonly entry: ArtifactEntrypoint;
  readonly dataset: ArtifactExecutionDataset;
  readonly readSetId: string;
  readonly decisionTime: string;
  readonly paramsLocked: Readonly<Record<string, ArtifactParameterValue>>;
  readonly declaredLiterals: Readonly<Record<string, ArtifactParameterValue>>;
  readonly arrowIpc: Uint8Array;
}

export interface ArtifactExecutionResultMetadata {
  readonly format: typeof ARTIFACT_EXECUTION_RESULT_FORMAT;
  readonly requestHash: string;
  readonly artifactHash: string;
  readonly readSetId: string;
  readonly outputArrowHash: string;
}

export interface ArtifactExecutionResultFrame {
  readonly metadata: ArtifactExecutionResultMetadata;
  readonly arrowIpc: Uint8Array;
}

export interface CreateArtifactExecutionResultInput {
  readonly requestHash: string;
  readonly artifactHash: string;
  readonly readSetId: string;
  readonly arrowIpc: Uint8Array;
}

export interface ArtifactExecutionFrameLimits {
  readonly maxControlBytes?: number;
  readonly maxArrowBytes?: number;
}

type RequestBody = Omit<ArtifactExecutionRequestMetadata, "requestHash">;

/** Creates immutable child metadata tied to the exact guarded Arrow bytes. */
export function createArtifactExecutionRequest(
  input: CreateArtifactExecutionRequestInput,
): ArtifactExecutionRequest {
  const arrowIpc = arrowBytes(input.arrowIpc, "request", ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES);
  const body = normalizeRequestBody({
    format: ARTIFACT_EXECUTION_REQUEST_FORMAT,
    artifactHash: input.artifactHash,
    codeTreeHash: input.codeTreeHash,
    runtime: input.runtime,
    entry: input.entry,
    dataset: input.dataset,
    readSetId: input.readSetId,
    decisionTime: input.decisionTime,
    inputArrowHash: hashBytes(arrowIpc),
    paramsLocked: input.paramsLocked,
    declaredLiterals: input.declaredLiterals,
  });
  return deepFreezeRequest({
    metadata: { ...body, requestHash: hashCanonical(REQUEST_HASH_DOMAIN, body) },
    arrowIpc,
  });
}

/** Encodes one canonical control envelope followed by one exact Arrow payload. */
export function encodeArtifactExecutionRequest(
  input: ArtifactExecutionRequest,
  limits?: ArtifactExecutionFrameLimits,
): Uint8Array {
  const request = normalizeRequest(input, limits);
  return encodeFrame(REQUEST_MAGIC, request.metadata, request.arrowIpc, limits, "request");
}

/** Decodes exactly one request frame; partial, duplicate, and trailing bytes are rejected. */
export function decodeArtifactExecutionRequest(
  input: Uint8Array,
  limits?: ArtifactExecutionFrameLimits,
): ArtifactExecutionRequest {
  const decoded = decodeFrame(input, REQUEST_MAGIC, limits, "request");
  const metadata = normalizeRequestMetadata(decoded.control);
  if (canonicalJson(metadata) !== decoded.controlText) {
    throw invalidRequest("artifact execution request control must use canonical JSON");
  }
  if (hashBytes(decoded.arrowIpc) !== metadata.inputArrowHash) {
    throw invalidRequest(
      "artifact execution request Arrow hash does not match its control envelope",
    );
  }
  return deepFreezeRequest({ metadata, arrowIpc: decoded.arrowIpc });
}

/** Creates a success result bound to the request and exact output Arrow bytes. */
export function createArtifactExecutionResult(
  input: CreateArtifactExecutionResultInput,
): ArtifactExecutionResultFrame {
  const arrowIpc = arrowBytes(input.arrowIpc, "result", ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES);
  const metadata = normalizeResultMetadata({
    format: ARTIFACT_EXECUTION_RESULT_FORMAT,
    requestHash: input.requestHash,
    artifactHash: input.artifactHash,
    readSetId: input.readSetId,
    outputArrowHash: hashBytes(arrowIpc),
  });
  return deepFreezeResult({ metadata, arrowIpc });
}

/** Encodes the only bytes a successful child may write to stdout. */
export function encodeArtifactExecutionResult(
  input: ArtifactExecutionResultFrame,
  limits?: ArtifactExecutionFrameLimits,
): Uint8Array {
  const result = normalizeResult(input, limits);
  return encodeFrame(RESULT_MAGIC, result.metadata, result.arrowIpc, limits, "result");
}

/** Decodes exactly one result frame and independently verifies its Arrow hash. */
export function decodeArtifactExecutionResult(
  input: Uint8Array,
  limits?: ArtifactExecutionFrameLimits,
): ArtifactExecutionResultFrame {
  const decoded = decodeFrame(input, RESULT_MAGIC, limits, "result");
  const metadata = normalizeResultMetadata(decoded.control);
  if (canonicalJson(metadata) !== decoded.controlText) {
    throw invalidOutput("artifact execution result control must use canonical JSON");
  }
  if (hashBytes(decoded.arrowIpc) !== metadata.outputArrowHash) {
    throw invalidOutput("artifact execution result Arrow hash does not match its control envelope");
  }
  return deepFreezeResult({ metadata, arrowIpc: decoded.arrowIpc });
}

function normalizeRequest(
  input: ArtifactExecutionRequest,
  limits?: ArtifactExecutionFrameLimits,
): ArtifactExecutionRequest {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["metadata", "arrowIpc"])) {
    throw invalidRequest("artifact execution request must contain only metadata and Arrow IPC");
  }
  const normalizedLimits = frameLimits(limits);
  const arrowIpc = arrowBytes(input.arrowIpc, "request", normalizedLimits.maxArrowBytes);
  const metadata = normalizeRequestMetadata(input.metadata);
  if (hashBytes(arrowIpc) !== metadata.inputArrowHash) {
    throw invalidRequest(
      "artifact execution request Arrow hash does not match its control envelope",
    );
  }
  return deepFreezeRequest({ metadata, arrowIpc });
}

function normalizeRequestMetadata(input: unknown): ArtifactExecutionRequestMetadata {
  const root = exactRecord(
    input,
    [
      "format",
      "artifactHash",
      "codeTreeHash",
      "runtime",
      "entry",
      "dataset",
      "readSetId",
      "decisionTime",
      "inputArrowHash",
      "paramsLocked",
      "declaredLiterals",
      "requestHash",
    ],
    "request control",
    "request",
  );
  const body = normalizeRequestBody({
    format: root.format,
    artifactHash: root.artifactHash,
    codeTreeHash: root.codeTreeHash,
    runtime: root.runtime,
    entry: root.entry,
    dataset: root.dataset,
    readSetId: root.readSetId,
    decisionTime: root.decisionTime,
    inputArrowHash: root.inputArrowHash,
    paramsLocked: root.paramsLocked,
    declaredLiterals: root.declaredLiterals,
  });
  const requestHash = sha256(root.requestHash, "request hash", "request");
  if (hashCanonical(REQUEST_HASH_DOMAIN, body) !== requestHash) {
    throw invalidRequest("artifact execution request hash does not match its control envelope");
  }
  return deepFreeze({ ...body, requestHash });
}

function normalizeRequestBody(input: unknown): RequestBody {
  const root = exactRecord(
    input,
    [
      "format",
      "artifactHash",
      "codeTreeHash",
      "runtime",
      "entry",
      "dataset",
      "readSetId",
      "decisionTime",
      "inputArrowHash",
      "paramsLocked",
      "declaredLiterals",
    ],
    "request body",
    "request",
  );
  if (root.format !== ARTIFACT_EXECUTION_REQUEST_FORMAT) {
    throw invalidRequest("artifact execution request uses an unsupported format");
  }
  const entry = exactRecord(root.entry, ["file", "callable"], "request entry", "request");
  const runtime = exactRecord(root.runtime, ["id", "implementation"], "request runtime", "request");
  const implementation = exactRecord(
    runtime.implementation,
    ["name", "version"],
    "request runtime implementation",
    "request",
  );
  const dataset = exactRecord(
    root.dataset,
    ["dataset", "version", "declarationHash"],
    "request dataset",
    "request",
  );
  return deepFreeze({
    format: ARTIFACT_EXECUTION_REQUEST_FORMAT,
    artifactHash: sha256(root.artifactHash, "artifact hash", "request"),
    codeTreeHash: sha256(root.codeTreeHash, "code tree hash", "request"),
    runtime: {
      id: portableId(runtime.id, "runtime provider id"),
      implementation: {
        name: portableId(implementation.name, "runtime implementation name"),
        version: portableText(implementation.version, "runtime implementation version"),
      },
    },
    entry: {
      file: portablePath(entry.file, "entry file"),
      callable: portableId(entry.callable, "entry callable"),
    },
    dataset: {
      dataset: portableId(dataset.dataset, "dataset id"),
      version: portableText(dataset.version, "dataset version"),
      declarationHash: sha256(dataset.declarationHash, "declaration hash", "request"),
    },
    readSetId: sha256(root.readSetId, "read-set id", "request"),
    decisionTime: canonicalTime(root.decisionTime),
    inputArrowHash: sha256(root.inputArrowHash, "input Arrow hash", "request"),
    paramsLocked: parameterMap(root.paramsLocked, "locked parameters"),
    declaredLiterals: parameterMap(root.declaredLiterals, "declared literals"),
  });
}

function normalizeResult(
  input: ArtifactExecutionResultFrame,
  limits?: ArtifactExecutionFrameLimits,
): ArtifactExecutionResultFrame {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["metadata", "arrowIpc"])) {
    throw invalidOutput("artifact execution result must contain only metadata and Arrow IPC");
  }
  const normalizedLimits = frameLimits(limits);
  const arrowIpc = arrowBytes(input.arrowIpc, "result", normalizedLimits.maxArrowBytes);
  const metadata = normalizeResultMetadata(input.metadata);
  if (hashBytes(arrowIpc) !== metadata.outputArrowHash) {
    throw invalidOutput("artifact execution result Arrow hash does not match its control envelope");
  }
  return deepFreezeResult({ metadata, arrowIpc });
}

function normalizeResultMetadata(input: unknown): ArtifactExecutionResultMetadata {
  const root = exactRecord(
    input,
    ["format", "requestHash", "artifactHash", "readSetId", "outputArrowHash"],
    "result control",
    "result",
  );
  if (root.format !== ARTIFACT_EXECUTION_RESULT_FORMAT) {
    throw invalidOutput("artifact execution result uses an unsupported format");
  }
  return deepFreeze({
    format: ARTIFACT_EXECUTION_RESULT_FORMAT,
    requestHash: sha256(root.requestHash, "request hash", "result"),
    artifactHash: sha256(root.artifactHash, "artifact hash", "result"),
    readSetId: sha256(root.readSetId, "read-set id", "result"),
    outputArrowHash: sha256(root.outputArrowHash, "output Arrow hash", "result"),
  });
}

function encodeFrame(
  magic: Buffer,
  control: unknown,
  arrowIpc: Uint8Array,
  limitsInput: ArtifactExecutionFrameLimits | undefined,
  kind: "request" | "result",
): Uint8Array {
  const limits = frameLimits(limitsInput);
  const controlBytes = Buffer.from(canonicalJson(control), "utf8");
  if (controlBytes.byteLength > limits.maxControlBytes) {
    throw frameError(kind, "artifact execution control exceeds its byte limit");
  }
  if (arrowIpc.byteLength > limits.maxArrowBytes) {
    throw frameError(kind, "artifact execution Arrow payload exceeds its byte limit");
  }
  const header = Buffer.alloc(ARTIFACT_EXECUTION_FRAME_HEADER_BYTES);
  magic.copy(header, 0);
  header.writeUInt32BE(controlBytes.byteLength, 8);
  header.writeBigUInt64BE(BigInt(arrowIpc.byteLength), 12);
  return Uint8Array.from(Buffer.concat([header, controlBytes, Buffer.from(arrowIpc)]));
}

function decodeFrame(
  input: Uint8Array,
  magic: Buffer,
  limitsInput: ArtifactExecutionFrameLimits | undefined,
  kind: "request" | "result",
): { readonly control: unknown; readonly controlText: string; readonly arrowIpc: Uint8Array } {
  if (!(input instanceof Uint8Array)) {
    throw frameError(kind, "artifact execution frame must be bytes");
  }
  const limits = frameLimits(limitsInput);
  const bytes = Buffer.from(input);
  if (bytes.byteLength < ARTIFACT_EXECUTION_FRAME_HEADER_BYTES) {
    throw frameError(kind, "artifact execution frame is partial");
  }
  if (!bytes.subarray(0, 8).equals(magic)) {
    throw frameError(kind, "artifact execution frame has invalid magic or version");
  }
  const controlLength = bytes.readUInt32BE(8);
  const arrowLengthBig = bytes.readBigUInt64BE(12);
  if (controlLength === 0 || controlLength > limits.maxControlBytes) {
    throw frameError(kind, "artifact execution control length is invalid");
  }
  if (arrowLengthBig === 0n || arrowLengthBig > BigInt(limits.maxArrowBytes)) {
    throw frameError(kind, "artifact execution Arrow length is invalid");
  }
  const arrowLength = Number(arrowLengthBig);
  const expectedLength = ARTIFACT_EXECUTION_FRAME_HEADER_BYTES + controlLength + arrowLength;
  if (bytes.byteLength !== expectedLength) {
    throw frameError(kind, "artifact execution frame is partial or contains trailing output");
  }
  let controlText: string;
  try {
    controlText = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(
        ARTIFACT_EXECUTION_FRAME_HEADER_BYTES,
        ARTIFACT_EXECUTION_FRAME_HEADER_BYTES + controlLength,
      ),
    );
  } catch {
    throw frameError(kind, "artifact execution control is not valid UTF-8");
  }
  let control: unknown;
  try {
    control = JSON.parse(controlText) as unknown;
  } catch {
    throw frameError(kind, "artifact execution control is not valid JSON");
  }
  return {
    control,
    controlText,
    arrowIpc: Uint8Array.from(
      bytes.subarray(ARTIFACT_EXECUTION_FRAME_HEADER_BYTES + controlLength),
    ),
  };
}

function frameLimits(input?: ArtifactExecutionFrameLimits): {
  readonly maxControlBytes: number;
  readonly maxArrowBytes: number;
} {
  if (
    input !== undefined &&
    (!isPlainRecord(input) || !hasExactKeys(input, ["maxControlBytes", "maxArrowBytes"], true))
  ) {
    throw invalidRequest("artifact execution frame limits contain unknown fields");
  }
  return {
    maxControlBytes: positiveLimit(
      input?.maxControlBytes ?? ARTIFACT_EXECUTION_DEFAULT_CONTROL_BYTES,
      "control byte limit",
    ),
    maxArrowBytes: positiveLimit(
      input?.maxArrowBytes ?? ARTIFACT_EXECUTION_DEFAULT_ARROW_BYTES,
      "Arrow byte limit",
    ),
  };
}

function positiveLimit(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw invalidRequest(`${field} must be a positive safe integer`);
  }
  return input;
}

function arrowBytes(input: unknown, kind: "request" | "result", maximum: number): Uint8Array {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw frameError(kind, `artifact execution ${kind} requires non-empty Arrow IPC bytes`);
  }
  if (input.byteLength > maximum) {
    throw frameError(kind, `artifact execution ${kind} Arrow payload exceeds its byte limit`);
  }
  return Uint8Array.from(input);
}

function parameterMap(
  input: unknown,
  field: string,
): Readonly<Record<string, ArtifactParameterValue>> {
  if (!isPlainRecord(input)) {
    throw invalidRequest(`${field} must be a plain object`);
  }
  const entries = Object.keys(input)
    .sort(compareText)
    .map((key) => [key, parameterValue(input[key], `${field}.${key}`, 0)] as const);
  return deepFreeze(Object.fromEntries(entries));
}

function parameterValue(input: unknown, field: string, depth: number): ArtifactParameterValue {
  if (depth > 16) {
    throw invalidRequest(`${field} exceeds the supported nesting depth`);
  }
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw invalidRequest(`${field} must use a finite canonical JSON number`);
    }
    return input;
  }
  if (Array.isArray(input)) {
    return Object.freeze(
      input.map((value, index) => parameterValue(value, `${field}[${index}]`, depth + 1)),
    );
  }
  if (!isPlainRecord(input)) {
    throw invalidRequest(`${field} must contain only canonical JSON values`);
  }
  return deepFreeze(
    Object.fromEntries(
      Object.keys(input)
        .sort(compareText)
        .map((key) => [key, parameterValue(input[key], `${field}.${key}`, depth + 1)]),
    ),
  );
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
  kind: "request" | "result",
): Record<string, unknown> {
  if (!isPlainRecord(input) || !hasExactKeys(input, keys)) {
    throw frameError(kind, `artifact execution ${field} has missing or unknown fields`);
  }
  return input;
}

function hasExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): boolean {
  const allowed = new Set(keys);
  const actual = Object.keys(input);
  return (
    actual.every((key) => allowed.has(key)) &&
    (optional || keys.every((key) => actual.includes(key)))
  );
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function portablePath(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 1024) {
    throw invalidRequest(`${field} must be a portable relative path`);
  }
  const segments = input.split("/");
  if (
    input.includes("\\") ||
    input.startsWith("/") ||
    WINDOWS_DRIVE_PATTERN.test(input) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw invalidRequest(`${field} must be a portable relative path`);
  }
  return input;
}

function portableId(input: unknown, field: string): string {
  if (typeof input !== "string" || !PORTABLE_ID_PATTERN.test(input)) {
    throw invalidRequest(`${field} must be a portable identifier`);
  }
  return input;
}

function portableText(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 128 ||
    input.trim() !== input ||
    [...input].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    }) ||
    input.includes("/") ||
    input.includes("\\")
  ) {
    throw invalidRequest(`${field} must be portable text`);
  }
  return input;
}

function canonicalTime(input: unknown): string {
  if (typeof input !== "string") {
    throw invalidRequest("decision time must be a canonical UTC instant");
  }
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== input) {
    throw invalidRequest("decision time must be a canonical UTC instant");
  }
  return input;
}

function sha256(input: unknown, field: string, kind: "request" | "result"): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw frameError(kind, `${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function hashBytes(input: Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function hashCanonical(domain: string, input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(input))
    .digest("hex")}`;
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return JSON.stringify(input);
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw invalidRequest("artifact execution control contains a non-canonical number");
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
  throw invalidRequest("artifact execution control contains an unsupported value");
}

function deepFreezeRequest(input: ArtifactExecutionRequest): ArtifactExecutionRequest {
  return Object.freeze({ metadata: deepFreeze(input.metadata), arrowIpc: input.arrowIpc });
}

function deepFreezeResult(input: ArtifactExecutionResultFrame): ArtifactExecutionResultFrame {
  return Object.freeze({ metadata: deepFreeze(input.metadata), arrowIpc: input.arrowIpc });
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !(input instanceof Uint8Array)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function frameError(kind: "request" | "result", message: string): EngineConfigurationError {
  return kind === "request" ? invalidRequest(message) : invalidOutput(message);
}

function invalidRequest(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_ARTIFACT_EXECUTION",
    message,
    "Rebuild the request from a verified artifact and guarded read-set using the v0 codec.",
  );
}

function invalidOutput(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_ARTIFACT_OUTPUT",
    message,
    "Fix the runtime adapter so stdout contains exactly one valid v0 result frame.",
  );
}
