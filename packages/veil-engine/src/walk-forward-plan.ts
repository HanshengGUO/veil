import { createHash } from "node:crypto";
import { normalizeDecisionTime } from "@veilquant/contract";
import type { ArtifactProtocol } from "./artifact.ts";
import { EngineConfigurationError } from "./errors.ts";

export const WALK_FORWARD_PLAN_FORMAT = "veil.walk-forward-plan.v0" as const;
export const WALK_FORWARD_MAX_SCHEDULE_ENTRIES = 1_000_000;

const PLAN_HASH_DOMAIN = "veil.walk-forward-plan.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface WalkForwardScheduleRange {
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly firstDecisionTime: string;
  readonly lastDecisionTime: string;
  readonly sessionCount: number;
}

export interface WalkForwardFold {
  readonly index: number;
  readonly train: WalkForwardScheduleRange;
  readonly purge: WalkForwardScheduleRange;
  readonly embargo: WalkForwardScheduleRange;
  readonly outOfSample: WalkForwardScheduleRange;
}

export interface WalkForwardPlan {
  readonly format: typeof WALK_FORWARD_PLAN_FORMAT;
  readonly protocol: ArtifactProtocol;
  /** Explicit ordered sessions. `*Days` in the protocol count entries, never calendar days. */
  readonly decisionSchedule: readonly string[];
  readonly folds: readonly WalkForwardFold[];
  readonly planHash: string;
}

export interface CreateWalkForwardPlanInput {
  readonly protocol: ArtifactProtocol;
  readonly decisionSchedule: readonly string[];
}

export interface WalkForwardPlanVerificationEvidence {
  readonly expectedPlanHash?: string;
}

type WalkForwardPlanBody = Omit<WalkForwardPlan, "planHash">;

/** Builds the only Stage 2C window topology: ordered rolling/expanding folds with purge + embargo. */
export function createWalkForwardPlan(input: CreateWalkForwardPlanInput): WalkForwardPlan {
  const root = exactRecord(input, ["protocol", "decisionSchedule"], "walk-forward plan input");
  const protocol = normalizeProtocol(root.protocol);
  const requiredLength = requiredScheduleLength(protocol);
  const decisionSchedule = normalizeSchedule(root.decisionSchedule, requiredLength);
  const folds = Object.freeze(
    Array.from({ length: protocol.folds }, (_, index) =>
      createFold(protocol, decisionSchedule, index),
    ),
  );
  const body: WalkForwardPlanBody = {
    format: WALK_FORWARD_PLAN_FORMAT,
    protocol,
    decisionSchedule,
    folds,
  };
  return deepFreeze({ ...body, planHash: hashCanonical(PLAN_HASH_DOMAIN, body) });
}

/** Recomputes every index/time boundary instead of trusting serialized fold descriptions. */
export function verifyWalkForwardPlan(
  input: unknown,
  evidenceInput: WalkForwardPlanVerificationEvidence = {},
): WalkForwardPlan {
  const root = exactRecord(
    input,
    ["format", "protocol", "decisionSchedule", "folds", "planHash"],
    "walk-forward plan",
  );
  if (root.format !== WALK_FORWARD_PLAN_FORMAT) {
    throw invalidPlan("walk-forward plan uses an unsupported format");
  }
  const recomputed = createWalkForwardPlan({
    protocol: normalizeProtocol(root.protocol),
    decisionSchedule: normalizedSerializedSchedule(root.decisionSchedule),
  });
  if (canonicalJson(root.folds) !== canonicalJson(recomputed.folds)) {
    throw invalidPlan("walk-forward folds do not match the declared protocol and schedule");
  }
  const planHash = sha256(root.planHash, "walk-forward plan hash");
  if (planHash !== recomputed.planHash) {
    throw invalidPlan("walk-forward plan hash does not match its normalized content");
  }
  const evidence = normalizeEvidence(evidenceInput);
  if (evidence.expectedPlanHash !== undefined && evidence.expectedPlanHash !== planHash) {
    throw invalidPlan("walk-forward plan differs from the expected content id");
  }
  return recomputed;
}

function createFold(
  protocol: ArtifactProtocol,
  schedule: readonly string[],
  index: number,
): WalkForwardFold {
  const trainEnd = protocol.trainDays + index * protocol.oosDays;
  const trainStart = protocol.mode === "expanding" ? 0 : trainEnd - protocol.trainDays;
  const purgeEnd = trainEnd + protocol.purgeDays;
  const embargoEnd = purgeEnd + protocol.embargoDays;
  const oosEnd = embargoEnd + protocol.oosDays;
  return deepFreeze({
    index,
    train: scheduleRange(schedule, trainStart, trainEnd),
    purge: scheduleRange(schedule, trainEnd, purgeEnd),
    embargo: scheduleRange(schedule, purgeEnd, embargoEnd),
    outOfSample: scheduleRange(schedule, embargoEnd, oosEnd),
  });
}

function scheduleRange(
  schedule: readonly string[],
  startIndex: number,
  endIndexExclusive: number,
): WalkForwardScheduleRange {
  const firstDecisionTime = schedule[startIndex];
  const lastDecisionTime = schedule[endIndexExclusive - 1];
  if (
    firstDecisionTime === undefined ||
    lastDecisionTime === undefined ||
    endIndexExclusive <= startIndex
  ) {
    throw invalidPlan("walk-forward protocol produced an empty or out-of-range schedule segment");
  }
  return Object.freeze({
    startIndex,
    endIndexExclusive,
    firstDecisionTime,
    lastDecisionTime,
    sessionCount: endIndexExclusive - startIndex,
  });
}

function requiredScheduleLength(protocol: ArtifactProtocol): number {
  const length =
    protocol.trainDays +
    protocol.purgeDays +
    protocol.embargoDays +
    protocol.folds * protocol.oosDays;
  if (!Number.isSafeInteger(length) || length > WALK_FORWARD_MAX_SCHEDULE_ENTRIES) {
    throw invalidPlan(
      `walk-forward schedule exceeds the ${WALK_FORWARD_MAX_SCHEDULE_ENTRIES}-entry safety limit`,
    );
  }
  return length;
}

function normalizeSchedule(input: unknown, requiredLength: number): readonly string[] {
  if (!Array.isArray(input) || input.length !== requiredLength) {
    throw invalidPlan(
      `decision schedule must contain exactly ${requiredLength} sessions for the declared protocol`,
    );
  }
  const schedule = input.map((value, index) => normalizedTime(value, `decision schedule ${index}`));
  for (let index = 1; index < schedule.length; index += 1) {
    const previous = schedule[index - 1];
    const current = schedule[index];
    if (previous === undefined || current === undefined || previous >= current) {
      throw invalidPlan("decision schedule must contain unique strictly increasing UTC instants");
    }
  }
  return Object.freeze(schedule);
}

function normalizedSerializedSchedule(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw invalidPlan("walk-forward decision schedule must be an array");
  }
  return input.map((value, index) => {
    if (typeof value !== "string") {
      throw invalidPlan(`decision schedule ${index} must be a canonical UTC instant`);
    }
    const normalized = normalizedTime(value, `decision schedule ${index}`);
    if (normalized !== value) {
      throw invalidPlan("serialized decision schedule must already use canonical UTC instants");
    }
    return value;
  });
}

function normalizedTime(input: unknown, field: string): string {
  try {
    return normalizeDecisionTime(input);
  } catch {
    throw invalidPlan(`${field} must be an ISO-8601 decision time`);
  }
}

function normalizeProtocol(input: unknown): ArtifactProtocol {
  const protocol = exactRecord(
    input,
    ["mode", "folds", "trainDays", "oosDays", "purgeDays", "embargoDays", "holdDays"],
    "walk-forward protocol",
  );
  if (protocol.mode !== "rolling" && protocol.mode !== "expanding") {
    throw invalidPlan("walk-forward mode must be rolling or expanding");
  }
  const normalized: ArtifactProtocol = {
    mode: protocol.mode,
    folds: positiveInteger(protocol.folds, "fold count"),
    trainDays: positiveInteger(protocol.trainDays, "training sessions"),
    oosDays: positiveInteger(protocol.oosDays, "out-of-sample sessions"),
    purgeDays: nonnegativeInteger(protocol.purgeDays, "purge sessions"),
    embargoDays: positiveInteger(protocol.embargoDays, "embargo sessions"),
    holdDays: positiveInteger(protocol.holdDays, "holding horizon"),
  };
  if (normalized.purgeDays < normalized.holdDays) {
    throw invalidPlan("purge sessions cannot be shorter than the holding horizon");
  }
  return Object.freeze(normalized);
}

function normalizeEvidence(
  input: WalkForwardPlanVerificationEvidence,
): WalkForwardPlanVerificationEvidence {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["expectedPlanHash"], true)) {
    throw invalidPlan("walk-forward plan evidence contains unknown fields");
  }
  return Object.freeze({
    expectedPlanHash:
      input.expectedPlanHash === undefined
        ? undefined
        : sha256(input.expectedPlanHash, "expected plan hash"),
  });
}

function positiveInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw invalidPlan(`${field} must be a positive safe integer`);
  }
  return input;
}

function nonnegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw invalidPlan(`${field} must be a non-negative safe integer`);
  }
  return input;
}

function sha256(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw invalidPlan(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isPlainRecord(input) || !hasExactKeys(input, keys)) {
    throw invalidPlan(`${field} has missing or unknown fields`);
  }
  return input;
}

function hasExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): boolean {
  const actual = Object.keys(input);
  const allowed = new Set(keys);
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
      throw invalidPlan("walk-forward plan contains a non-canonical number");
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
  throw invalidPlan("walk-forward plan contains an unsupported value");
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidPlan(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_WALK_FORWARD_PLAN",
    message,
    "Provide the exact ordered UTC session schedule required by the artifact's WFA protocol.",
  );
}
