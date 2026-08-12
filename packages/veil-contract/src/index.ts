/**
 * The six Veil Contract invariants. Identifiers are stable: they appear in violation errors,
 * audit records, bench trap declarations, and user-facing documentation.
 *
 * Normative text: docs/contract.md
 */

export type InvariantId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";

/**
 * Where an invariant is enforced. Veil leaves exploration unblocked, so no invariant is
 * enforced while the agent is writing and running its own code.
 */
export type EnforcementPoint =
  | "registration" /** when a dataset adapter is registered */
  | "read" /** when data is read through a Veil tool */
  | "verification" /** when an artifact is re-executed walk-forward */
  | "claim"; /** when a result is written to a conclusion, memory verdict, or deployment */

export interface Invariant {
  readonly id: InvariantId;
  readonly name: string;
  readonly summary: string;
  readonly enforcedAt: readonly EnforcementPoint[];
}

export const INVARIANTS: Readonly<Record<InvariantId, Invariant>> = {
  C1: {
    id: "C1",
    name: "Decision-time information set",
    summary:
      "Every point-in-time read declares the decision time t and never returns information " +
      "that was not available at t.",
    enforcedAt: ["read", "verification"],
  },
  C2: {
    id: "C2",
    name: "Walk-forward only",
    summary:
      "Verification offers no random cross-validation entry point: rolling or expanding " +
      "walk-forward with purge gap and embargo is the only evaluation protocol.",
    enforcedAt: ["verification"],
  },
  C3: {
    id: "C3",
    name: "Parameter lock",
    summary:
      "Parameters are locked in-sample and read-only out-of-sample; changing them means a new " +
      "artifact and a new in-sample window.",
    enforcedAt: ["verification"],
  },
  C4: {
    id: "C4",
    name: "Tradability mask first",
    summary: "Untradable instruments are excluded before signals are formed, not after.",
    enforcedAt: ["read", "verification"],
  },
  C5: {
    id: "C5",
    name: "Claims must pass verification",
    summary:
      "Any metric that enters a conclusion, a memory verdict, a promotion, or a deployment must " +
      "be issued by the verification engine.",
    enforcedAt: ["claim"],
  },
  C6: {
    id: "C6",
    name: "Hypothesis pre-registration",
    summary:
      "A hypothesis is registered and timestamped before it is verified; unregistered findings " +
      "are marked exploratory and face a higher promotion bar.",
    enforcedAt: ["registration", "claim"],
  },
} as const;

export const INVARIANT_IDS: readonly InvariantId[] = Object.keys(INVARIANTS) as InvariantId[];

export interface ContractViolationDetail {
  /** Dataset involved, when the violation is tied to one. */
  readonly dataset?: string;
  /** Decision time under which the offending read or run was attempted. */
  readonly asOf?: string;
  /** Free-form machine-readable context; keep it small and printable. */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  /** What the caller can do about it. Shown to agents, so keep it actionable. */
  readonly remedy?: string;
}

/**
 * Thrown when a run would break an invariant. Structured on purpose: agents read these,
 * bench scores them, and audit records store them.
 */
export class ContractViolation extends Error {
  readonly invariant: InvariantId;
  readonly detail: ContractViolationDetail;

  constructor(invariant: InvariantId, message: string, detail: ContractViolationDetail = {}) {
    super(`[${invariant}] ${message}`);
    this.name = "ContractViolation";
    this.invariant = invariant;
    this.detail = detail;
  }

  /** Human-readable one-liner naming the invariant, used in logs and bench reports. */
  describe(): string {
    return `${this.invariant} (${INVARIANTS[this.invariant].name}): ${this.message}`;
  }
}

export * from "./adapter.ts";
export * from "./canonical.ts";
export * from "./errors.ts";
export * from "./lineage.ts";
export * from "./semantics.ts";
export * from "./temporal.ts";
