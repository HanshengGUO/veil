import {
  type AdapterDeclaration,
  type AvailabilityBasis,
  availabilityBasisAt,
  type SurvivorshipGuarantee,
} from "./adapter.ts";
import { AdapterDeclarationError } from "./errors.ts";
import { deepFreeze } from "./freeze.ts";

export type PitMode = "available-time" | "event-time-fallback";
export type AvailabilitySemantics = AvailabilityBasis | "mixed" | "unknown";
export type CertificationSemantics = "certified" | "uncertified";

export type DegradationCode =
  | "PIT_UNSAFE"
  | "POINT_IN_TIME_UNVERIFIED"
  | "AVAILABILITY_RECONSTRUCTED"
  | "PIT_DEGRADED_ASSUMED"
  | "VINTAGE_UNAVAILABLE"
  | "SURVIVORSHIP_BIASED"
  | "SURVIVORSHIP_UNKNOWN"
  | "TRADABILITY_MASK_UNAVAILABLE"
  | "PROVENANCE_UNCERTIFIED";

export type DataObligation =
  | "VERIFY_LINEAGE"
  | "FILTER_AVAILABLE_TIME"
  | "FILTER_EVENT_TIME"
  | "APPLY_TRADABILITY_MASK"
  | "PROPAGATE_DEGRADATIONS";

export interface DataSemantics {
  readonly pitMode: PitMode;
  readonly availability: AvailabilitySemantics;
  readonly certification: CertificationSemantics;
  readonly vintage: boolean;
  readonly survivorship: SurvivorshipGuarantee;
  readonly degradations: readonly DegradationCode[];
  readonly obligations: readonly DataObligation[];
}

/**
 * Derives what the engine must enforce and propagate. When eventTime is supplied, segmented
 * availability is evaluated at that event-time instant; without it, the result is conservative over
 * the whole declaration.
 */
export function deriveDataSemantics(
  declaration: AdapterDeclaration,
  eventTime?: string,
): DataSemantics {
  const activeBases = selectBases(declaration, eventTime);
  const availability: AvailabilitySemantics =
    activeBases.length === 0
      ? "unknown"
      : activeBases.length === 1
        ? (activeBases[0] ?? "unknown")
        : "mixed";
  const degradations: DegradationCode[] = [];
  const addDegradation = (code: DegradationCode): void => {
    if (!degradations.includes(code)) {
      degradations.push(code);
    }
  };

  if (declaration.availableTime === null) {
    addDegradation("PIT_UNSAFE");
  } else if (!declaration.guarantees.pointInTime) {
    addDegradation("POINT_IN_TIME_UNVERIFIED");
  }
  if (activeBases.includes("reconstructed")) {
    addDegradation("AVAILABILITY_RECONSTRUCTED");
  }
  if (activeBases.includes("assumed")) {
    addDegradation("PIT_DEGRADED_ASSUMED");
  }
  if (!declaration.guarantees.vintage) {
    addDegradation("VINTAGE_UNAVAILABLE");
  }
  if (declaration.guarantees.survivorshipFree === false) {
    addDegradation("SURVIVORSHIP_BIASED");
  } else if (declaration.guarantees.survivorshipFree === "unknown") {
    addDegradation("SURVIVORSHIP_UNKNOWN");
  }
  if (declaration.guarantees.tradabilityMask === null) {
    addDegradation("TRADABILITY_MASK_UNAVAILABLE");
  }
  if (!declaration.provenance.certified) {
    addDegradation("PROVENANCE_UNCERTIFIED");
  }

  const obligations: DataObligation[] = [];
  if (declaration.provenance.certified) {
    obligations.push("VERIFY_LINEAGE");
  }
  obligations.push(
    declaration.availableTime === null ? "FILTER_EVENT_TIME" : "FILTER_AVAILABLE_TIME",
  );
  if (declaration.guarantees.tradabilityMask !== null) {
    obligations.push("APPLY_TRADABILITY_MASK");
  }
  if (degradations.length > 0) {
    obligations.push("PROPAGATE_DEGRADATIONS");
  }

  return deepFreeze({
    pitMode: declaration.availableTime === null ? "event-time-fallback" : "available-time",
    availability,
    certification: declaration.provenance.certified ? "certified" : "uncertified",
    vintage: declaration.guarantees.vintage,
    survivorship: declaration.guarantees.survivorshipFree,
    degradations,
    obligations,
  });
}

function selectBases(
  declaration: AdapterDeclaration,
  eventTime: string | undefined,
): AvailabilityBasis[] {
  if (declaration.availabilityBasis === null) {
    return [];
  }
  if (eventTime !== undefined) {
    const basis = availabilityBasisAt(declaration, eventTime);
    if (basis === null) {
      throw new AdapterDeclarationError(
        "INVALID_SEGMENTS",
        "$eventTime",
        "event time is not covered by availability_basis segments",
        "Extend the segment boundaries so every source row has an explicit basis.",
      );
    }
    return [basis];
  }
  return [...new Set(declaration.availabilityBasis.map((segment) => segment.basis))];
}
