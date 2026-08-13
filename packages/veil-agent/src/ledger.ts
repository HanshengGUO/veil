import { createHash, randomUUID } from "node:crypto";
import {
  createHypothesisRegistration,
  type HypothesisRegistrationRecord,
  type PromotionCandidateRecord,
} from "@veilquant/engine";
import {
  VEIL_ADVISORY_ENTRY,
  VEIL_AGENT_ENTRY_TYPES,
  VEIL_BRIEF_ENTRY,
  VEIL_DATA_READ_ENTRY,
  VEIL_HYPOTHESIS_ENTRY,
  VEIL_RUN_RESULT_ENTRY,
  VEIL_VERIFICATION_START_ENTRY,
  VEIL_VIOLATION_ENTRY,
  type VeilAgentEntryType,
} from "./constants.ts";
import { VeilAgentError } from "./errors.ts";

const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

export type CaptureMode = "automatic" | "explicit";

export interface BriefEntryData {
  readonly format: typeof VEIL_BRIEF_ENTRY;
  readonly briefRef: string;
  readonly statement: string;
  readonly captureMode: CaptureMode;
}

export interface HypothesisEntryData {
  readonly format: typeof VEIL_HYPOTHESIS_ENTRY;
  readonly hypothesisRef: string;
  readonly statement: string;
  readonly ideaAvailableAt: string;
  readonly captureMode: CaptureMode;
}

export interface DataReadEntryData {
  readonly format: typeof VEIL_DATA_READ_ENTRY;
  readonly dataset: string;
  readonly adapterVersion: string;
  readonly mode: "point" | "panel";
  readonly grade: "guarded" | "exploration-grade";
  readonly asOf: string;
  readonly readSetId: string;
  readonly resultHash: string;
  readonly arrowHash: string;
  readonly exportReference: string | null;
}

export interface VerificationStartEntryData {
  readonly format: typeof VEIL_VERIFICATION_START_ENTRY;
  readonly runId: string;
  readonly requestReference: string;
  readonly hypothesisRef: string;
}

export interface RunResultEntryData {
  readonly format: typeof VEIL_RUN_RESULT_ENTRY;
  readonly runId: string;
  readonly outcome: "candidate" | "rejected";
  readonly candidate: RunCandidateSummary | null;
  readonly failureCode: string | null;
  readonly evidenceReference: string | null;
  readonly evidenceHash: string | null;
  readonly researchLogReference: string;
}

export interface RunCandidateSummary {
  readonly candidateHash: string;
  readonly artifactHash: string;
  readonly planHash: string;
  readonly contractHash: string;
  readonly claimStatus: "unverified";
  readonly registrationStatus: "preregistered" | "exploratory";
  readonly requiredEvidence: readonly ["pricing", "costs", "statistical-gates"];
}

export interface ViolationEntryData {
  readonly format: typeof VEIL_VIOLATION_ENTRY;
  readonly phase: "tool-call" | "data" | "promotion" | "ledger";
  readonly code: string;
  readonly message: string;
  readonly remedy: string;
  readonly toolName: string | null;
  readonly runId: string | null;
}

export interface AdvisoryEntryData {
  readonly format: typeof VEIL_ADVISORY_ENTRY;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly codes: readonly AdvisoryCode[];
}

export type AdvisoryCode = "FULL_SAMPLE" | "FUTURE_FUNCTION" | "SURVIVORSHIP";

export type VeilLedgerData =
  | BriefEntryData
  | HypothesisEntryData
  | DataReadEntryData
  | VerificationStartEntryData
  | RunResultEntryData
  | ViolationEntryData
  | AdvisoryEntryData;

export interface SessionEntryLike {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface DurableLedgerEntry<T extends VeilLedgerData = VeilLedgerData> {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly customType: T["format"];
  readonly data: T;
}

export interface VeilSessionLedger {
  readonly briefs: readonly DurableLedgerEntry<BriefEntryData>[];
  readonly hypotheses: readonly DurableLedgerEntry<HypothesisEntryData>[];
  readonly dataReads: readonly DurableLedgerEntry<DataReadEntryData>[];
  readonly verificationStarts: readonly DurableLedgerEntry<VerificationStartEntryData>[];
  readonly runResults: readonly DurableLedgerEntry<RunResultEntryData>[];
  readonly violations: readonly DurableLedgerEntry<ViolationEntryData>[];
  readonly advisories: readonly DurableLedgerEntry<AdvisoryEntryData>[];
}

export function createBriefEntry(statementInput: string, captureMode: CaptureMode): BriefEntryData {
  const statement = boundedText(statementInput, "brief", 16_384);
  return Object.freeze({
    format: VEIL_BRIEF_ENTRY,
    briefRef: contentReference("brief", statement),
    statement,
    captureMode,
  });
}

export function createHypothesisEntry(input: {
  readonly hypothesisRef?: string;
  readonly statement: string;
  readonly ideaAvailableAt: string;
  readonly captureMode: CaptureMode;
}): HypothesisEntryData {
  const statement = boundedText(input.statement, "hypothesis", 4096);
  return Object.freeze({
    format: VEIL_HYPOTHESIS_ENTRY,
    hypothesisRef:
      input.hypothesisRef === undefined
        ? contentReference("hypothesis", statement)
        : portableReference(input.hypothesisRef, "hypothesis reference"),
    statement,
    ideaAvailableAt: canonicalTime(input.ideaAvailableAt, "idea availability"),
    captureMode: captureMode(input.captureMode),
  });
}

export function createVerificationStartEntry(input: {
  readonly requestReference: string;
  readonly hypothesisRef: string;
}): VerificationStartEntryData {
  return Object.freeze({
    format: VEIL_VERIFICATION_START_ENTRY,
    runId: `run:${randomUUID()}`,
    requestReference: portablePathReference(input.requestReference, "promotion request reference"),
    hypothesisRef: portableReference(input.hypothesisRef, "hypothesis reference"),
  });
}

export function candidateSummary(candidate: PromotionCandidateRecord): RunCandidateSummary {
  return Object.freeze({
    candidateHash: sha256(candidate.candidateHash, "candidate hash"),
    artifactHash: sha256(candidate.artifactHash, "artifact hash"),
    planHash: sha256(candidate.planHash, "plan hash"),
    contractHash: sha256(candidate.contractHash, "contract hash"),
    claimStatus: "unverified",
    registrationStatus: candidate.hypothesis.registrationStatus,
    requiredEvidence: Object.freeze(["pricing", "costs", "statistical-gates"] as const),
  });
}

export function reconstructSessionLedger(entriesInput: readonly unknown[]): VeilSessionLedger {
  if (!Array.isArray(entriesInput)) throw corruptLedger("session branch is not an entry array");
  const briefs: DurableLedgerEntry<BriefEntryData>[] = [];
  const hypotheses: DurableLedgerEntry<HypothesisEntryData>[] = [];
  const dataReads: DurableLedgerEntry<DataReadEntryData>[] = [];
  const verificationStarts: DurableLedgerEntry<VerificationStartEntryData>[] = [];
  const runResults: DurableLedgerEntry<RunResultEntryData>[] = [];
  const violations: DurableLedgerEntry<ViolationEntryData>[] = [];
  const advisories: DurableLedgerEntry<AdvisoryEntryData>[] = [];

  for (const input of entriesInput) {
    const entry = sessionEntry(input);
    if (entry === null || !isVeilEntryType(entry.customType)) continue;
    const durable = durableEntry(entry, normalizeLedgerData(entry.customType, entry.data));
    switch (durable.customType) {
      case VEIL_BRIEF_ENTRY:
        briefs.push(durable as DurableLedgerEntry<BriefEntryData>);
        break;
      case VEIL_HYPOTHESIS_ENTRY:
        hypotheses.push(durable as DurableLedgerEntry<HypothesisEntryData>);
        break;
      case VEIL_DATA_READ_ENTRY:
        dataReads.push(durable as DurableLedgerEntry<DataReadEntryData>);
        break;
      case VEIL_VERIFICATION_START_ENTRY:
        verificationStarts.push(durable as DurableLedgerEntry<VerificationStartEntryData>);
        break;
      case VEIL_RUN_RESULT_ENTRY:
        runResults.push(durable as DurableLedgerEntry<RunResultEntryData>);
        break;
      case VEIL_VIOLATION_ENTRY:
        violations.push(durable as DurableLedgerEntry<ViolationEntryData>);
        break;
      case VEIL_ADVISORY_ENTRY:
        advisories.push(durable as DurableLedgerEntry<AdvisoryEntryData>);
        break;
    }
  }
  enforceRunChronology(verificationStarts, runResults);
  return Object.freeze({
    briefs: Object.freeze(briefs),
    hypotheses: Object.freeze(hypotheses),
    dataReads: Object.freeze(dataReads),
    verificationStarts: Object.freeze(verificationStarts),
    runResults: Object.freeze(runResults),
    violations: Object.freeze(violations),
    advisories: Object.freeze(advisories),
  });
}

export function hypothesisRegistrationFromEntry(
  entry: DurableLedgerEntry<HypothesisEntryData>,
): HypothesisRegistrationRecord {
  if (Date.parse(entry.data.ideaAvailableAt) > Date.parse(entry.timestamp)) {
    throw corruptLedger("hypothesis idea availability is later than its durable session entry");
  }
  return createHypothesisRegistration({
    hypothesisRef: entry.data.hypothesisRef,
    statement: entry.data.statement,
    registeredAt: entry.timestamp,
    ideaAvailableAt: entry.data.ideaAvailableAt,
    source: {
      kind: entry.data.captureMode === "explicit" ? "explicit" : "brief",
      reference: portableReference(`pi-entry:${entry.id}`, "session entry reference"),
    },
  });
}

export function latestHypothesis(
  ledger: VeilSessionLedger,
  hypothesisRef?: string,
): DurableLedgerEntry<HypothesisEntryData> | null {
  const expected = hypothesisRef?.trim();
  return (
    [...ledger.hypotheses]
      .reverse()
      .find((entry) => expected === undefined || entry.data.hypothesisRef === expected) ?? null
  );
}

export function findVerificationStart(
  ledger: VeilSessionLedger,
  runId: string,
): DurableLedgerEntry<VerificationStartEntryData> {
  const matches = ledger.verificationStarts.filter((entry) => entry.data.runId === runId);
  if (matches.length !== 1)
    throw corruptLedger("verification start could not be resolved uniquely");
  const match = matches[0];
  if (match === undefined) throw corruptLedger("verification start is missing");
  return match;
}

function normalizeLedgerData(type: VeilAgentEntryType, input: unknown): VeilLedgerData {
  switch (type) {
    case VEIL_BRIEF_ENTRY:
      return normalizeBrief(input);
    case VEIL_HYPOTHESIS_ENTRY:
      return normalizeHypothesis(input);
    case VEIL_DATA_READ_ENTRY:
      return normalizeDataRead(input);
    case VEIL_VERIFICATION_START_ENTRY:
      return normalizeVerificationStart(input);
    case VEIL_RUN_RESULT_ENTRY:
      return normalizeRunResult(input);
    case VEIL_VIOLATION_ENTRY:
      return normalizeViolation(input);
    case VEIL_ADVISORY_ENTRY:
      return normalizeAdvisory(input);
  }
}

function normalizeBrief(input: unknown): BriefEntryData {
  const root = exactRecord(input, ["format", "briefRef", "statement", "captureMode"], "brief");
  if (root.format !== VEIL_BRIEF_ENTRY)
    throw corruptLedger("brief format does not match entry type");
  return Object.freeze({
    format: VEIL_BRIEF_ENTRY,
    briefRef: portableReference(root.briefRef, "brief reference"),
    statement: boundedText(root.statement, "brief", 16_384),
    captureMode: captureMode(root.captureMode),
  });
}

function normalizeHypothesis(input: unknown): HypothesisEntryData {
  const root = exactRecord(
    input,
    ["format", "hypothesisRef", "statement", "ideaAvailableAt", "captureMode"],
    "hypothesis",
  );
  if (root.format !== VEIL_HYPOTHESIS_ENTRY) {
    throw corruptLedger("hypothesis format does not match entry type");
  }
  return Object.freeze({
    format: VEIL_HYPOTHESIS_ENTRY,
    hypothesisRef: portableReference(root.hypothesisRef, "hypothesis reference"),
    statement: boundedText(root.statement, "hypothesis", 4096),
    ideaAvailableAt: canonicalTime(root.ideaAvailableAt, "idea availability"),
    captureMode: captureMode(root.captureMode),
  });
}

function normalizeDataRead(input: unknown): DataReadEntryData {
  const root = exactRecord(
    input,
    [
      "format",
      "dataset",
      "adapterVersion",
      "mode",
      "grade",
      "asOf",
      "readSetId",
      "resultHash",
      "arrowHash",
      "exportReference",
    ],
    "data read",
  );
  if (root.format !== VEIL_DATA_READ_ENTRY) {
    throw corruptLedger("data read format does not match entry type");
  }
  const mode = oneOf(root.mode, ["point", "panel"] as const, "data read mode");
  const grade = oneOf(root.grade, ["guarded", "exploration-grade"] as const, "data read grade");
  if (
    (mode === "point" && grade !== "guarded") ||
    (mode === "panel" && grade !== "exploration-grade")
  ) {
    throw corruptLedger("data read mode and grade disagree");
  }
  return Object.freeze({
    format: VEIL_DATA_READ_ENTRY,
    dataset: portableReference(root.dataset, "dataset"),
    adapterVersion: boundedText(root.adapterVersion, "adapter version", 256),
    mode,
    grade,
    asOf: canonicalTime(root.asOf, "data decision time"),
    readSetId: sha256(root.readSetId, "read-set id"),
    resultHash: sha256(root.resultHash, "result hash"),
    arrowHash: sha256(root.arrowHash, "Arrow hash"),
    exportReference:
      root.exportReference === null
        ? null
        : portablePathReference(root.exportReference, "export reference"),
  });
}

function normalizeVerificationStart(input: unknown): VerificationStartEntryData {
  const root = exactRecord(
    input,
    ["format", "runId", "requestReference", "hypothesisRef"],
    "verification start",
  );
  if (root.format !== VEIL_VERIFICATION_START_ENTRY) {
    throw corruptLedger("verification start format does not match entry type");
  }
  return Object.freeze({
    format: VEIL_VERIFICATION_START_ENTRY,
    runId: portableReference(root.runId, "run id"),
    requestReference: portablePathReference(root.requestReference, "promotion request reference"),
    hypothesisRef: portableReference(root.hypothesisRef, "hypothesis reference"),
  });
}

function normalizeRunResult(input: unknown): RunResultEntryData {
  const root = exactRecord(
    input,
    [
      "format",
      "runId",
      "outcome",
      "candidate",
      "failureCode",
      "evidenceReference",
      "evidenceHash",
      "researchLogReference",
    ],
    "run result",
  );
  if (root.format !== VEIL_RUN_RESULT_ENTRY) {
    throw corruptLedger("run result format does not match entry type");
  }
  const outcome = oneOf(root.outcome, ["candidate", "rejected"] as const, "run outcome");
  const candidate = root.candidate === null ? null : normalizeCandidateSummary(root.candidate);
  const failureCode =
    root.failureCode === null ? null : portableReference(root.failureCode, "failure code");
  const evidenceReference =
    root.evidenceReference === null
      ? null
      : portablePathReference(root.evidenceReference, "run evidence reference");
  const evidenceHash =
    root.evidenceHash === null ? null : sha256(root.evidenceHash, "run evidence hash");
  if (
    (outcome === "candidate" &&
      (candidate === null ||
        failureCode !== null ||
        evidenceReference === null ||
        evidenceHash === null)) ||
    (outcome === "rejected" &&
      (candidate !== null ||
        failureCode === null ||
        evidenceReference !== null ||
        evidenceHash !== null))
  ) {
    throw corruptLedger("run result fields disagree with its outcome");
  }
  return Object.freeze({
    format: VEIL_RUN_RESULT_ENTRY,
    runId: portableReference(root.runId, "run id"),
    outcome,
    candidate,
    failureCode,
    evidenceReference,
    evidenceHash,
    researchLogReference: portablePathReference(
      root.researchLogReference,
      "research log reference",
    ),
  });
}

function normalizeCandidateSummary(input: unknown): RunCandidateSummary {
  const root = exactRecord(
    input,
    [
      "candidateHash",
      "artifactHash",
      "planHash",
      "contractHash",
      "claimStatus",
      "registrationStatus",
      "requiredEvidence",
    ],
    "run candidate summary",
  );
  if (root.claimStatus !== "unverified") throw corruptLedger("run candidate claimed verification");
  const registrationStatus = oneOf(
    root.registrationStatus,
    ["preregistered", "exploratory"] as const,
    "registration status",
  );
  if (
    !Array.isArray(root.requiredEvidence) ||
    JSON.stringify(root.requiredEvidence) !==
      JSON.stringify(["pricing", "costs", "statistical-gates"])
  ) {
    throw corruptLedger("run candidate required evidence is invalid");
  }
  return Object.freeze({
    candidateHash: sha256(root.candidateHash, "candidate hash"),
    artifactHash: sha256(root.artifactHash, "artifact hash"),
    planHash: sha256(root.planHash, "plan hash"),
    contractHash: sha256(root.contractHash, "contract hash"),
    claimStatus: "unverified",
    registrationStatus,
    requiredEvidence: Object.freeze(["pricing", "costs", "statistical-gates"] as const),
  });
}

function normalizeViolation(input: unknown): ViolationEntryData {
  const root = exactRecord(
    input,
    ["format", "phase", "code", "message", "remedy", "toolName", "runId"],
    "violation",
  );
  if (root.format !== VEIL_VIOLATION_ENTRY) {
    throw corruptLedger("violation format does not match entry type");
  }
  return Object.freeze({
    format: VEIL_VIOLATION_ENTRY,
    phase: oneOf(
      root.phase,
      ["tool-call", "data", "promotion", "ledger"] as const,
      "violation phase",
    ),
    code: portableReference(root.code, "violation code"),
    message: boundedText(root.message, "violation message", 4096),
    remedy: boundedText(root.remedy, "violation remedy", 4096),
    toolName: root.toolName === null ? null : portableReference(root.toolName, "tool name"),
    runId: root.runId === null ? null : portableReference(root.runId, "run id"),
  });
}

function normalizeAdvisory(input: unknown): AdvisoryEntryData {
  const root = exactRecord(input, ["format", "toolName", "toolCallId", "codes"], "advisory");
  if (root.format !== VEIL_ADVISORY_ENTRY) {
    throw corruptLedger("advisory format does not match entry type");
  }
  if (!Array.isArray(root.codes) || root.codes.length === 0) {
    throw corruptLedger("advisory requires at least one code");
  }
  const codes = root.codes.map((code) =>
    oneOf(code, ["FULL_SAMPLE", "FUTURE_FUNCTION", "SURVIVORSHIP"] as const, "advisory code"),
  );
  if (new Set(codes).size !== codes.length) throw corruptLedger("advisory codes are duplicated");
  return Object.freeze({
    format: VEIL_ADVISORY_ENTRY,
    toolName: portableReference(root.toolName, "tool name"),
    toolCallId: boundedText(root.toolCallId, "tool call id", 256),
    codes: Object.freeze(codes),
  });
}

function enforceRunChronology(
  starts: readonly DurableLedgerEntry<VerificationStartEntryData>[],
  results: readonly DurableLedgerEntry<RunResultEntryData>[],
): void {
  const startById = new Map<string, DurableLedgerEntry<VerificationStartEntryData>>();
  for (const start of starts) {
    if (startById.has(start.data.runId))
      throw corruptLedger("run id has multiple verification starts");
    startById.set(start.data.runId, start);
  }
  const resultIds = new Set<string>();
  for (const result of results) {
    const start = startById.get(result.data.runId);
    if (start === undefined) throw corruptLedger("run result has no earlier verification start");
    if (resultIds.has(result.data.runId))
      throw corruptLedger("run id has multiple terminal results");
    if (Date.parse(result.timestamp) < Date.parse(start.timestamp)) {
      throw corruptLedger("run result predates its verification start");
    }
    resultIds.add(result.data.runId);
  }
}

function sessionEntry(input: unknown): (SessionEntryLike & { readonly customType: string }) | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const root = input as Record<string, unknown>;
  if (root.type !== "custom") return null;
  if (
    typeof root.id !== "string" ||
    root.id.length === 0 ||
    (root.parentId !== null && typeof root.parentId !== "string") ||
    typeof root.timestamp !== "string" ||
    typeof root.customType !== "string"
  ) {
    throw corruptLedger("custom session entry metadata is malformed");
  }
  return {
    type: "custom",
    id: root.id,
    parentId: root.parentId as string | null,
    timestamp: canonicalTime(root.timestamp, "session entry timestamp"),
    customType: root.customType,
    data: root.data,
  };
}

function durableEntry<T extends VeilLedgerData>(
  entry: SessionEntryLike & { readonly customType: string },
  data: T,
): DurableLedgerEntry<T> {
  return Object.freeze({
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    customType: data.format,
    data,
  });
}

function isVeilEntryType(input: string): input is VeilAgentEntryType {
  return (VEIL_AGENT_ENTRY_TYPES as readonly string[]).includes(input);
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw corruptLedger(`${label} entry is not an object`);
  }
  const root = input as Record<string, unknown>;
  const actual = Object.keys(root).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw corruptLedger(`${label} entry has missing or unknown fields`);
  }
  return root;
}

function captureMode(input: unknown): CaptureMode {
  return oneOf(input, ["automatic", "explicit"] as const, "capture mode");
}

function oneOf<const T extends readonly string[]>(
  input: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof input !== "string" || !values.includes(input)) {
    throw corruptLedger(`${label} is invalid`);
  }
  return input as T[number];
}

function portableReference(input: unknown, label: string): string {
  if (typeof input !== "string" || !PORTABLE_REFERENCE.test(input)) {
    throw corruptLedger(`${label} is not portable`);
  }
  return input;
}

function portablePathReference(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1024 ||
    input.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(input) ||
    input.includes("\\") ||
    input.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw corruptLedger(`${label} is not a portable project-relative path`);
  }
  return input;
}

function boundedText(input: unknown, label: string, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum ||
    [...input].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point === 0 || (point < 0x20 && character !== "\n" && character !== "\t");
    })
  ) {
    throw corruptLedger(`${label} is empty, too long, or contains control characters`);
  }
  return input.trim();
}

function canonicalTime(input: unknown, label: string): string {
  if (typeof input !== "string") throw corruptLedger(`${label} is not an ISO-8601 timestamp`);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds)) throw corruptLedger(`${label} is not an ISO-8601 timestamp`);
  return new Date(milliseconds).toISOString();
}

function sha256(input: unknown, label: string): string {
  if (typeof input !== "string" || !SHA256_ID.test(input)) {
    throw corruptLedger(`${label} is not a lowercase sha256 identity`);
  }
  return input;
}

function contentReference(kind: "brief" | "hypothesis", content: string): string {
  return `${kind}:auto:${createHash("sha256").update(content).digest("hex").slice(0, 24)}`;
}

function corruptLedger(message: string): VeilAgentError {
  return new VeilAgentError(
    "CORRUPT_SESSION_LEDGER",
    message,
    "Inspect the active Pi session branch; remove or fork before the malformed Veil entry, then retry.",
  );
}
