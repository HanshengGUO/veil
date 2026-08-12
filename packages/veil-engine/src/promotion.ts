import { createHash } from "node:crypto";
import {
  type AdapterDeclaration,
  ContractViolation,
  normalizeDecisionTime,
} from "@veilquant/contract";
import { type ArtifactManifest, verifyArtifactManifest } from "./artifact.ts";
import { EngineConfigurationError } from "./errors.ts";
import {
  verifyWalkForwardContractRecord,
  WALK_FORWARD_CONTRACT_FORMAT,
  type WalkForwardContractRecord,
} from "./walk-forward-contract-record.ts";
import { verifyWalkForwardPlan, type WalkForwardPlan } from "./walk-forward-plan.ts";

export const HYPOTHESIS_REGISTRATION_FORMAT = "veil.hypothesis-registration.v0" as const;
export const PROMOTION_CANDIDATE_FORMAT = "veil.promotion-candidate.v0" as const;

const REGISTRATION_HASH_DOMAIN = "veil.hypothesis-registration.v0";
const CANDIDATE_HASH_DOMAIN = "veil.promotion-candidate.v0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const REQUIRED_EVIDENCE = Object.freeze(["pricing", "costs", "statistical-gates"] as const);

export type HypothesisRegistrationSourceKind = "brief" | "explicit" | "external";

export interface VerificationStartEvidence {
  readonly startedAt: string;
  /** Opaque durable run-start entry id resolved by the Stage 3 integration. */
  readonly sourceReference: string;
}

export interface HypothesisRegistrationRecord {
  readonly format: typeof HYPOTHESIS_REGISTRATION_FORMAT;
  readonly hypothesisRef: string;
  readonly statement: string;
  /** Durable session or external-source timestamp used by the later chronology check. */
  readonly registeredAt: string;
  /** When the underlying idea or source first became available, for contamination audits. */
  readonly ideaAvailableAt: string;
  readonly source: {
    readonly kind: HypothesisRegistrationSourceKind;
    /** Opaque durable entry id, never a path, credential, or inline source payload. */
    readonly reference: string;
  };
  readonly registrationHash: string;
}

export interface CreateHypothesisRegistrationInput {
  readonly hypothesisRef: string;
  readonly statement: string;
  readonly registeredAt: string;
  readonly ideaAvailableAt: string;
  readonly source: HypothesisRegistrationRecord["source"];
}

export interface HypothesisRegistrationVerificationEvidence {
  readonly expectedRegistrationHash?: string;
}

export interface PromotionCandidateRecord {
  readonly format: typeof PROMOTION_CANDIDATE_FORMAT;
  /** The structure is eligible to proceed to pricing and gates; no claim has been verified. */
  readonly status: "awaiting-pricing-and-gates";
  readonly structuralStatus: "contract-verified";
  readonly claimStatus: "unverified";
  readonly artifactHash: string;
  readonly planHash: string;
  readonly contractHash: string;
  readonly parameterLockHash: string;
  readonly hypothesis: {
    readonly hypothesisRef: string;
    readonly registrationHash: string | null;
    readonly registrationStatus: "preregistered" | "exploratory";
  };
  readonly verification: VerificationStartEvidence;
  readonly gateInputs: {
    readonly costModel: string;
    readonly trialsDeclared: number;
    readonly significanceTier: "standard" | "higher";
  };
  readonly requiredEvidence: readonly ["pricing", "costs", "statistical-gates"];
  readonly candidateHash: string;
}

export interface CreatePromotionCandidateInput {
  readonly artifact: unknown;
  readonly plan: unknown;
  readonly declaration: AdapterDeclaration;
  readonly contractRecord: unknown;
  /** Trusted durable run-start evidence supplied by the Stage 3 integration boundary. */
  readonly verification: VerificationStartEvidence;
  /** Missing registration is allowed but is explicitly exploratory and faces a higher gate tier. */
  readonly registration: unknown | null;
}

export interface PromotionCandidateVerificationEvidence {
  readonly artifact: unknown;
  readonly plan: unknown;
  readonly declaration: AdapterDeclaration;
  readonly contractRecord: unknown;
  readonly registration: unknown | null;
  readonly verification: VerificationStartEvidence;
  readonly expectedCandidateHash?: string;
}

type RegistrationBody = Omit<HypothesisRegistrationRecord, "registrationHash">;
type CandidateBody = Omit<PromotionCandidateRecord, "candidateHash">;

/** Creates the portable content record that Stage 3 will persist through the session log. */
export function createHypothesisRegistration(
  input: CreateHypothesisRegistrationInput,
): HypothesisRegistrationRecord {
  const root = exactRecord(
    input,
    ["hypothesisRef", "statement", "registeredAt", "ideaAvailableAt", "source"],
    "hypothesis registration input",
    invalidRegistration,
  );
  const body = registrationBody(root);
  return deepFreeze({
    ...body,
    registrationHash: hashCanonical(REGISTRATION_HASH_DOMAIN, body, invalidRegistration),
  });
}

export function verifyHypothesisRegistration(
  input: unknown,
  evidenceInput: HypothesisRegistrationVerificationEvidence = {},
): HypothesisRegistrationRecord {
  const root = exactRecord(
    input,
    [
      "format",
      "hypothesisRef",
      "statement",
      "registeredAt",
      "ideaAvailableAt",
      "source",
      "registrationHash",
    ],
    "hypothesis registration",
    invalidRegistration,
  );
  if (root.format !== HYPOTHESIS_REGISTRATION_FORMAT) {
    throw invalidRegistration("hypothesis registration uses an unsupported format");
  }
  const body = registrationBody(root);
  const registrationHash = sha256(root.registrationHash, "registration hash", invalidRegistration);
  if (hashCanonical(REGISTRATION_HASH_DOMAIN, body, invalidRegistration) !== registrationHash) {
    throw invalidRegistration("hypothesis registration hash does not match its normalized content");
  }
  const evidence = exactRecord(
    evidenceInput,
    ["expectedRegistrationHash"],
    "hypothesis registration verification evidence",
    invalidRegistration,
    true,
  );
  if (
    evidence.expectedRegistrationHash !== undefined &&
    sha256(evidence.expectedRegistrationHash, "expected registration hash", invalidRegistration) !==
      registrationHash
  ) {
    throw invalidRegistration("hypothesis registration differs from the expected content id");
  }
  return deepFreeze({ ...body, registrationHash });
}

/**
 * Admits only a complete C1-C4 contract into the later pricing/gate pipeline. This does not issue an
 * Experiment, accept metrics, or make a claim citable.
 */
export function createPromotionCandidate(
  input: CreatePromotionCandidateInput,
): PromotionCandidateRecord {
  const root = exactRecord(
    input,
    ["artifact", "plan", "declaration", "contractRecord", "verification", "registration"],
    "promotion candidate input",
    invalidCandidate,
  );
  return issuePromotionCandidate({
    artifact: root.artifact,
    plan: root.plan,
    declaration: root.declaration as AdapterDeclaration,
    contractRecord: root.contractRecord,
    verification: root.verification,
    registration: root.registration,
  });
}

export function verifyPromotionCandidate(
  input: unknown,
  evidenceInput: PromotionCandidateVerificationEvidence,
): PromotionCandidateRecord {
  const evidence = normalizeCandidateEvidence(evidenceInput);
  const candidate = normalizeCandidate(input);
  const recreated = issuePromotionCandidate({
    artifact: evidence.artifact,
    plan: evidence.plan,
    declaration: evidence.declaration,
    contractRecord: evidence.contractRecord,
    verification: evidence.verification,
    registration: evidence.registration,
  });
  if (canonicalJson(candidate, invalidCandidate) !== canonicalJson(recreated, invalidCandidate)) {
    throw invalidCandidate("promotion candidate does not match its replayed contract evidence");
  }
  if (
    evidence.expectedCandidateHash !== undefined &&
    evidence.expectedCandidateHash !== candidate.candidateHash
  ) {
    throw invalidCandidate("promotion candidate differs from the expected content id");
  }
  return candidate;
}

function issuePromotionCandidate(input: {
  readonly artifact: unknown;
  readonly plan: unknown;
  readonly declaration: AdapterDeclaration;
  readonly contractRecord: unknown;
  readonly verification: unknown;
  readonly registration: unknown | null;
}): PromotionCandidateRecord {
  const artifact = verifyArtifactManifest(input.artifact);
  const plan = verifyWalkForwardPlan(input.plan);
  const contract = promotionContract(input.contractRecord, artifact, plan, input.declaration);
  const verification = normalizeVerificationStart(input.verification, invalidCandidate);
  const registration = promotionRegistration(input.registration, artifact, verification.startedAt);
  const preregistered = registration !== null;
  const body: CandidateBody = {
    format: PROMOTION_CANDIDATE_FORMAT,
    status: "awaiting-pricing-and-gates",
    structuralStatus: "contract-verified",
    claimStatus: "unverified",
    artifactHash: artifact.artifactHash,
    planHash: plan.planHash,
    contractHash: contract.contractHash,
    parameterLockHash: contract.parameterLockHash,
    hypothesis: Object.freeze({
      hypothesisRef: artifact.hypothesisRef,
      registrationHash: registration?.registrationHash ?? null,
      registrationStatus: preregistered ? "preregistered" : "exploratory",
    }),
    verification,
    gateInputs: Object.freeze({
      costModel: artifact.costModel,
      trialsDeclared: artifact.trialsDeclared,
      significanceTier: preregistered ? "standard" : "higher",
    }),
    requiredEvidence: REQUIRED_EVIDENCE,
  };
  return deepFreeze({
    ...body,
    candidateHash: hashCanonical(CANDIDATE_HASH_DOMAIN, body, invalidCandidate),
  });
}

function promotionContract(
  input: unknown,
  artifact: ArtifactManifest,
  plan: WalkForwardPlan,
  declaration: AdapterDeclaration,
): WalkForwardContractRecord {
  try {
    return verifyWalkForwardContractRecord(input, { artifact, plan, declaration });
  } catch (cause) {
    if (
      cause instanceof ContractViolation &&
      (cause.invariant === "C1" ||
        cause.invariant === "C2" ||
        cause.invariant === "C3" ||
        cause.invariant === "C4")
    ) {
      throw cause;
    }
    throw new ContractViolation("C5", "promotion requires a valid engine contract record", {
      context: { recordFormat: recordFormat(input) },
      remedy:
        "Run executeWalkForwardContract and supply its replay-verified record; exploration and training-only outputs are not promotion evidence.",
    });
  }
}

function promotionRegistration(
  input: unknown | null,
  artifact: ArtifactManifest,
  verificationStartedAt: string,
): HypothesisRegistrationRecord | null {
  if (input === null) return null;
  let registration: HypothesisRegistrationRecord;
  try {
    registration = verifyHypothesisRegistration(input);
  } catch {
    throw c6("promotion supplied an invalid hypothesis registration");
  }
  if (registration.hypothesisRef !== artifact.hypothesisRef) {
    throw c6("hypothesis registration does not match the artifact reference");
  }
  if (Date.parse(registration.registeredAt) >= Date.parse(verificationStartedAt)) {
    throw new ContractViolation("C6", "hypothesis registration must precede verification start", {
      context: {
        registeredAt: registration.registeredAt,
        verificationStartedAt,
      },
      remedy:
        "Treat the finding as exploratory by omitting registration; a late entry cannot become preregistration.",
    });
  }
  return registration;
}

function registrationBody(input: Record<string, unknown>): RegistrationBody {
  const registeredAt = canonicalTime(input.registeredAt, "registeredAt", invalidRegistration);
  const ideaAvailableAt = canonicalTime(
    input.ideaAvailableAt,
    "ideaAvailableAt",
    invalidRegistration,
  );
  if (Date.parse(ideaAvailableAt) > Date.parse(registeredAt)) {
    throw invalidRegistration("idea availability cannot be later than registration");
  }
  return deepFreeze({
    format: HYPOTHESIS_REGISTRATION_FORMAT,
    hypothesisRef: portableReference(
      input.hypothesisRef,
      "hypothesis reference",
      invalidRegistration,
    ),
    statement: printableText(input.statement, "hypothesis statement", 4096, invalidRegistration),
    registeredAt,
    ideaAvailableAt,
    source: normalizeRegistrationSource(input.source),
  });
}

function normalizeRegistrationSource(input: unknown): HypothesisRegistrationRecord["source"] {
  const root = exactRecord(
    input,
    ["kind", "reference"],
    "hypothesis registration source",
    invalidRegistration,
  );
  if (root.kind !== "brief" && root.kind !== "explicit" && root.kind !== "external") {
    throw invalidRegistration("hypothesis registration source kind is unsupported");
  }
  return Object.freeze({
    kind: root.kind,
    reference: portableReference(root.reference, "source reference", invalidRegistration),
  });
}

function normalizeCandidate(input: unknown): PromotionCandidateRecord {
  const root = exactRecord(
    input,
    [
      "format",
      "status",
      "structuralStatus",
      "claimStatus",
      "artifactHash",
      "planHash",
      "contractHash",
      "parameterLockHash",
      "hypothesis",
      "verification",
      "gateInputs",
      "requiredEvidence",
      "candidateHash",
    ],
    "promotion candidate",
    invalidCandidate,
  );
  if (
    root.format !== PROMOTION_CANDIDATE_FORMAT ||
    root.status !== "awaiting-pricing-and-gates" ||
    root.structuralStatus !== "contract-verified" ||
    root.claimStatus !== "unverified"
  ) {
    throw invalidCandidate("promotion candidate uses an unsupported format or status");
  }
  const hypothesis = exactRecord(
    root.hypothesis,
    ["hypothesisRef", "registrationHash", "registrationStatus"],
    "promotion candidate hypothesis",
    invalidCandidate,
  );
  if (
    hypothesis.registrationStatus !== "preregistered" &&
    hypothesis.registrationStatus !== "exploratory"
  ) {
    throw invalidCandidate("promotion candidate registration status is unsupported");
  }
  const registrationHash =
    hypothesis.registrationHash === null
      ? null
      : sha256(hypothesis.registrationHash, "registration hash", invalidCandidate);
  if ((hypothesis.registrationStatus === "preregistered") !== (registrationHash !== null)) {
    throw invalidCandidate("promotion candidate registration status and identity disagree");
  }
  const gateInputs = exactRecord(
    root.gateInputs,
    ["costModel", "trialsDeclared", "significanceTier"],
    "promotion candidate gate inputs",
    invalidCandidate,
  );
  if (gateInputs.significanceTier !== "standard" && gateInputs.significanceTier !== "higher") {
    throw invalidCandidate("promotion candidate significance tier is unsupported");
  }
  if (
    (hypothesis.registrationStatus === "preregistered") !==
    (gateInputs.significanceTier === "standard")
  ) {
    throw invalidCandidate("promotion candidate registration and significance tiers disagree");
  }
  if (
    canonicalJson(root.requiredEvidence, invalidCandidate) !==
    canonicalJson(REQUIRED_EVIDENCE, invalidCandidate)
  ) {
    throw invalidCandidate("promotion candidate required evidence is not canonical");
  }
  const body: CandidateBody = {
    format: PROMOTION_CANDIDATE_FORMAT,
    status: "awaiting-pricing-and-gates",
    structuralStatus: "contract-verified",
    claimStatus: "unverified",
    artifactHash: sha256(root.artifactHash, "artifact hash", invalidCandidate),
    planHash: sha256(root.planHash, "plan hash", invalidCandidate),
    contractHash: sha256(root.contractHash, "contract hash", invalidCandidate),
    parameterLockHash: sha256(root.parameterLockHash, "parameter lock hash", invalidCandidate),
    hypothesis: Object.freeze({
      hypothesisRef: portableReference(
        hypothesis.hypothesisRef,
        "hypothesis reference",
        invalidCandidate,
      ),
      registrationHash,
      registrationStatus: hypothesis.registrationStatus,
    }),
    verification: normalizeVerificationStart(root.verification, invalidCandidate),
    gateInputs: Object.freeze({
      costModel: portableReference(gateInputs.costModel, "cost model", invalidCandidate),
      trialsDeclared: positiveInteger(
        gateInputs.trialsDeclared,
        "declared trial count",
        invalidCandidate,
      ),
      significanceTier: gateInputs.significanceTier,
    }),
    requiredEvidence: REQUIRED_EVIDENCE,
  };
  const candidateHash = sha256(root.candidateHash, "candidate hash", invalidCandidate);
  if (hashCanonical(CANDIDATE_HASH_DOMAIN, body, invalidCandidate) !== candidateHash) {
    throw invalidCandidate("promotion candidate hash does not match its normalized content");
  }
  return deepFreeze({ ...body, candidateHash });
}

function normalizeCandidateEvidence(input: PromotionCandidateVerificationEvidence): {
  readonly artifact: unknown;
  readonly plan: unknown;
  readonly declaration: AdapterDeclaration;
  readonly contractRecord: unknown;
  readonly registration: unknown | null;
  readonly verification: VerificationStartEvidence;
  readonly expectedCandidateHash?: string;
} {
  const root = exactRecord(
    input,
    [
      "artifact",
      "plan",
      "declaration",
      "contractRecord",
      "registration",
      "verification",
      "expectedCandidateHash",
    ],
    "promotion candidate verification evidence",
    invalidCandidate,
    true,
  );
  for (const required of [
    "artifact",
    "plan",
    "declaration",
    "contractRecord",
    "registration",
    "verification",
  ]) {
    if (!Object.hasOwn(root, required)) {
      throw invalidCandidate("promotion candidate verification evidence has missing fields");
    }
  }
  return Object.freeze({
    artifact: root.artifact,
    plan: root.plan,
    declaration: root.declaration as AdapterDeclaration,
    contractRecord: root.contractRecord,
    registration: root.registration,
    verification: normalizeVerificationStart(root.verification, invalidCandidate),
    ...(root.expectedCandidateHash === undefined
      ? {}
      : {
          expectedCandidateHash: sha256(
            root.expectedCandidateHash,
            "expected candidate hash",
            invalidCandidate,
          ),
        }),
  });
}

function recordFormat(input: unknown): string {
  if (isPlainRecord(input) && input.format === WALK_FORWARD_CONTRACT_FORMAT) {
    return WALK_FORWARD_CONTRACT_FORMAT;
  }
  if (isPlainRecord(input)) return "unsupported-object";
  return "unknown";
}

function normalizeVerificationStart(
  input: unknown,
  error: ErrorFactory,
): VerificationStartEvidence {
  const root = exactRecord(
    input,
    ["startedAt", "sourceReference"],
    "verification start evidence",
    error,
  );
  return Object.freeze({
    startedAt: canonicalTime(root.startedAt, "verification start", error),
    sourceReference: portableReference(
      root.sourceReference,
      "verification source reference",
      error,
    ),
  });
}

type ErrorFactory = (message: string) => EngineConfigurationError;

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  field: string,
  error: ErrorFactory,
  optional = false,
): Record<string, unknown> {
  if (!isPlainRecord(input)) throw error(`${field} must be an object`);
  const actual = Object.keys(input);
  const allowed = new Set(expectedKeys);
  if (
    actual.some((key) => !allowed.has(key)) ||
    (!optional && expectedKeys.some((key) => !actual.includes(key)))
  ) {
    throw error(`${field} has missing or unknown fields`);
  }
  return input;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function portableReference(input: unknown, field: string, error: ErrorFactory): string {
  if (typeof input !== "string" || !PORTABLE_REFERENCE.test(input)) {
    throw error(`${field} must be a portable identifier`);
  }
  return input;
}

function printableText(
  input: unknown,
  field: string,
  maximum: number,
  error: ErrorFactory,
): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum ||
    hasForbiddenControl(input)
  ) {
    throw error(`${field} must be printable text of at most ${maximum} characters`);
  }
  return input;
}

function hasForbiddenControl(input: string): boolean {
  return [...input].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
  });
}

function canonicalTime(input: unknown, field: string, error: ErrorFactory): string {
  if (typeof input !== "string") throw error(`${field} must be a canonical UTC instant`);
  try {
    const normalized = normalizeDecisionTime(input);
    if (normalized !== input) throw new Error("not canonical");
    return normalized;
  } catch {
    throw error(`${field} must be a canonical UTC instant`);
  }
}

function positiveInteger(input: unknown, field: string, error: ErrorFactory): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw error(`${field} must be a positive safe integer`);
  }
  return input;
}

function sha256(input: unknown, field: string, error: ErrorFactory): string {
  if (typeof input !== "string" || !SHA256_PATTERN.test(input)) {
    throw error(`${field} must be a lowercase sha256 identity`);
  }
  return input;
}

function hashCanonical(domain: string, input: unknown, error: ErrorFactory): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(input, error))
    .digest("hex")}`;
}

function canonicalJson(input: unknown, error: ErrorFactory): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return JSON.stringify(input);
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw error("record contains a non-canonical number");
    }
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((value) => canonicalJson(value, error)).join(",")}]`;
  }
  if (isPlainRecord(input)) {
    return `{${Object.keys(input)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key], error)}`)
      .join(",")}}`;
  }
  throw error("record contains an unsupported value");
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

function c6(message: string): ContractViolation {
  return new ContractViolation("C6", message, {
    remedy:
      "Use the durable hypothesis entry that predates verification, or omit it and keep the candidate exploratory.",
  });
}

function invalidRegistration(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_HYPOTHESIS_REGISTRATION",
    message,
    "Create a portable registration with canonical timestamps and a durable source entry reference.",
  );
}

function invalidCandidate(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_PROMOTION_CANDIDATE",
    message,
    "Recreate the candidate from a verified C1-C4 contract and matching registration evidence.",
  );
}
