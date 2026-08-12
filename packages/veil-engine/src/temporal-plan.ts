import {
  type AdapterDeclaration,
  type DataSemantics,
  deriveDataSemantics,
  normalizeDecisionTime,
} from "@veilquant/contract";
import { EngineConfigurationError } from "./errors.ts";

export interface TemporalReadQuery {
  /** Required. There is intentionally no default for the decision time. */
  readonly asOf: string;
  /** Omit to return all columns. Guard columns are fetched even when not requested. */
  readonly columns?: readonly string[];
}

export interface TemporalPredicate {
  readonly column: string;
  readonly operator: "<=";
  readonly value: string;
}

/** Structured and SQL-free so every backend receives exactly the same temporal obligation. */
export interface TemporalReadPlan {
  readonly dataset: string;
  readonly adapterVersion: string;
  readonly asOf: string;
  readonly requestedColumns: readonly string[] | null;
  readonly guardColumns: readonly string[];
  readonly backendProjection: readonly string[] | null;
  readonly temporalPredicate: TemporalPredicate;
  readonly semantics: DataSemantics;
}

export function createTemporalReadPlan(
  declaration: AdapterDeclaration,
  query: TemporalReadQuery,
): TemporalReadPlan {
  const asOf = normalizeDecisionTime(query.asOf);
  const requestedColumns = normalizeProjection(query.columns);
  const temporalColumn = declaration.availableTime ?? declaration.eventTime;
  const guardColumns = unique([
    declaration.entityKey,
    declaration.eventTime,
    temporalColumn,
    declaration.guarantees.tradabilityMask,
  ]);
  const backendProjection =
    requestedColumns === null ? null : unique([...requestedColumns, ...guardColumns]);

  return deepFreeze({
    dataset: declaration.dataset,
    adapterVersion: declaration.version,
    asOf,
    requestedColumns,
    guardColumns,
    backendProjection,
    temporalPredicate: {
      column: temporalColumn,
      operator: "<=",
      value: asOf,
    },
    semantics: deriveDataSemantics(declaration),
  });
}

function normalizeProjection(columns: readonly string[] | undefined): readonly string[] | null {
  if (columns === undefined) {
    return null;
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new EngineConfigurationError(
      "INVALID_QUERY",
      "columns must be omitted or contain at least one column",
      "Omit columns to request all fields, or name the desired fields.",
    );
  }
  const normalized: string[] = [];
  for (const column of columns) {
    if (typeof column !== "string" || column.trim().length === 0) {
      throw new EngineConfigurationError(
        "INVALID_QUERY",
        "projection contains an empty column",
        "Use exact, non-empty source column names.",
      );
    }
    const name = column.trim();
    if (!normalized.includes(name)) {
      normalized.push(name);
    }
  }
  return Object.freeze(normalized);
}

function unique(values: readonly (string | null)[]): readonly string[] {
  return Object.freeze(
    values.filter(
      (value, index): value is string => value !== null && values.indexOf(value) === index,
    ),
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
