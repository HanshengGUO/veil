import { type AdapterDeclaration, type AvailabilityBasis, availabilityBasisAt } from "./adapter.ts";
import { AdapterDeclarationError } from "./errors.ts";
import { deepFreeze } from "./freeze.ts";
import { normalizeIsoInstant } from "./time.ts";

export interface LineageBatch {
  readonly observedAt: string;
  readonly sourceContentHash: string;
}

/** Minimal Stage 2 envelope; Stage 8 may add fields without changing these meanings. */
export interface LineageSummary {
  readonly schemaVersion: 1;
  /** Hash independently computed by the engine for the resolved lineage document. */
  readonly contentHash: string;
  readonly firstObservedAt: string | null;
  readonly batches: readonly LineageBatch[];
}

export interface SourceTemporalRow {
  readonly eventTime: string;
  readonly availableTime: string | null;
}

export function normalizeLineageSummary(input: unknown): LineageSummary {
  const root = record(input, "$lineage");
  knownFields(root, new Set(["schema_version", "content_hash", "first_observed_at", "batches"]));

  if (root.schema_version !== 1) {
    throw new AdapterDeclarationError(
      "INVALID_VALUE",
      "$lineage.schema_version",
      "only lineage schema version 1 is supported",
      "Set schema_version to 1 or upgrade Veil before registering this lineage document.",
    );
  }
  const contentHash = sha256(root.content_hash, "$lineage.content_hash");
  const firstObservedAt =
    root.first_observed_at === undefined || root.first_observed_at === null
      ? null
      : normalizeIsoInstant(root.first_observed_at, "$lineage.first_observed_at");
  const batchesValue = root.batches ?? [];
  if (!Array.isArray(batchesValue)) {
    throw new AdapterDeclarationError(
      "INVALID_TYPE",
      "$lineage.batches",
      "expected an array of lineage batches",
      "Use an empty array when no per-batch evidence is available.",
    );
  }
  const batches = batchesValue
    .map((value, index): LineageBatch => {
      const batch = record(value, `$lineage.batches[${index}]`);
      knownFields(
        batch,
        new Set(["observed_at", "source_content_hash"]),
        `$lineage.batches[${index}]`,
      );
      return {
        observedAt: normalizeIsoInstant(
          required(batch, "observed_at", `$lineage.batches[${index}].observed_at`),
          `$lineage.batches[${index}].observed_at`,
        ),
        sourceContentHash: sha256(
          required(batch, "source_content_hash", `$lineage.batches[${index}].source_content_hash`),
          `$lineage.batches[${index}].source_content_hash`,
        ),
      };
    })
    .sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        left.sourceContentHash.localeCompare(right.sourceContentHash),
    );

  if (firstObservedAt !== null && batches.some((batch) => batch.observedAt < firstObservedAt)) {
    throw new AdapterDeclarationError(
      "LINEAGE_MISMATCH",
      "$lineage.first_observed_at",
      "a batch predates first_observed_at",
      "Correct first_observed_at or the batch observation timestamp.",
    );
  }

  return deepFreeze({ schemaVersion: 1, contentHash, firstObservedAt, batches });
}

/**
 * Cross-checks the declaration against engine-resolved lineage and source timestamps. Segment
 * boundaries are evaluated on event_time; observed evidence is evaluated on available_time.
 */
export function validateLineageClaim(
  declaration: AdapterDeclaration,
  lineage: LineageSummary,
  rows: Iterable<SourceTemporalRow>,
): void {
  const lineageRef = declaration.provenance.lineageRef;
  if (lineageRef?.startsWith("sha256:") && lineageRef !== lineage.contentHash) {
    throw new AdapterDeclarationError(
      "LINEAGE_MISMATCH",
      "$.provenance.lineage_ref",
      "resolved lineage content does not match the declared hash",
      "Resolve the referenced lineage document or update the declaration as a new version.",
    );
  }

  const hasObservedBasis = declaration.availabilityBasis?.some(
    (segment) => segment.basis === "observed",
  );
  const firstObservedAt = lineage.firstObservedAt ?? lineage.batches[0]?.observedAt ?? null;
  if (declaration.provenance.certified && hasObservedBasis && firstObservedAt === null) {
    throw new AdapterDeclarationError(
      "MISSING_EVIDENCE",
      "$lineage.first_observed_at",
      "certified observed availability has no observation boundary",
      "Record first_observed_at or at least one observed lineage batch.",
    );
  }

  let index = 0;
  for (const row of rows) {
    const eventTime = normalizeIsoInstant(row.eventTime, `$rows[${index}].eventTime`);
    const basis: AvailabilityBasis | null = availabilityBasisAt(declaration, eventTime);
    if (basis === null && declaration.availableTime !== null) {
      throw new AdapterDeclarationError(
        "INVALID_SEGMENTS",
        `$rows[${index}].eventTime`,
        "source row is not covered by availability_basis segments",
        "Extend the declaration so every event-time row has an explicit basis.",
      );
    }
    if (basis === "observed" && firstObservedAt !== null) {
      if (row.availableTime === null) {
        throw new AdapterDeclarationError(
          "INVALID_VALUE",
          `$rows[${index}].availableTime`,
          "observed row has no availability timestamp",
          "Provide the captured availability time or change the basis declaration.",
        );
      }
      const availableTime = normalizeIsoInstant(row.availableTime, `$rows[${index}].availableTime`);
      if (availableTime < firstObservedAt) {
        throw new AdapterDeclarationError(
          "OBSERVED_BEFORE_LINEAGE",
          `$rows[${index}].availableTime`,
          "row claims observed availability before collection began",
          "Mark the historical segment reconstructed/assumed or provide valid earlier lineage.",
        );
      }
    }
    index += 1;
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterDeclarationError(
      "INVALID_TYPE",
      path,
      "expected an object",
      "Replace this value with an object.",
    );
  }
  return value as Record<string, unknown>;
}

function knownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path = "$lineage",
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()[0];
  if (unknown !== undefined) {
    throw new AdapterDeclarationError(
      "UNKNOWN_FIELD",
      `${path}.${unknown}`,
      "unknown lineage field",
      "Remove the field or correct its spelling.",
    );
  }
}

function required(value: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(value, key) || value[key] === undefined) {
    throw new AdapterDeclarationError(
      "MISSING_FIELD",
      path,
      "required field is missing",
      "Add this field to the lineage document.",
    );
  }
  return value[key];
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new AdapterDeclarationError(
      "INVALID_VALUE",
      path,
      "expected a sha256 content hash",
      "Use sha256 followed by exactly 64 lowercase hexadecimal characters.",
    );
  }
  return value;
}
