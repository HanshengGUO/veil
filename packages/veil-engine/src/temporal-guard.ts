import {
  type AdapterDeclaration,
  ContractViolation,
  type DataSemantics,
  normalizeDecisionTime,
} from "@veilquant/contract";
import { Table, tableFromIPC, tableToIPC, type Vector, vectorFromArray } from "apache-arrow";
import {
  type BackendDescriptor,
  type BackendRegistry,
  readRegisteredBackend,
  type SourceFingerprint,
} from "./backend.ts";
import { EngineConfigurationError } from "./errors.ts";
import type { SourceBinding } from "./source-binding.ts";
import {
  createTemporalReadPlan,
  type TemporalReadPlan,
  type TemporalReadQuery,
} from "./temporal-plan.ts";

export interface TemporalGuardAudit {
  readonly inputRows: number;
  readonly outputRows: number;
  readonly droppedFutureRows: number;
  readonly backendClaimedProjectionPushdown: boolean;
  readonly backendClaimedTemporalPushdown: boolean;
}

export interface GuardedReadResult {
  readonly arrowIpc: Uint8Array;
  readonly plan: TemporalReadPlan;
  readonly semantics: DataSemantics;
  readonly backend: BackendDescriptor;
  readonly sourceFingerprint: SourceFingerprint | null;
  readonly audit: TemporalGuardAudit;
}

/**
 * The mandatory backend-neutral protection layer. Backends may push down the structured predicate
 * for speed, but every Arrow result is independently checked and filtered before it is returned.
 */
export class TemporalGuard {
  readonly #registry: BackendRegistry;

  constructor(registry: BackendRegistry) {
    this.#registry = registry;
  }

  async read(
    declaration: AdapterDeclaration,
    query: TemporalReadQuery,
    binding: SourceBinding,
  ): Promise<GuardedReadResult> {
    const plan = createTemporalReadPlan(declaration, query);
    const backendRead = await readRegisteredBackend(
      this.#registry,
      declaration.source,
      plan,
      binding,
    );
    const input = decodeArrow(backendRead.result.arrowIpc, backendRead.descriptor.id);
    validateUniqueColumns(input, backendRead.descriptor.id);
    for (const column of plan.guardColumns) {
      requireColumn(input, column, declaration, plan);
    }
    for (const column of plan.requestedColumns ?? []) {
      requireColumn(input, column, declaration, plan);
    }

    const temporalVector = input.getChild(plan.temporalPredicate.column);
    if (temporalVector === null) {
      throw missingTemporalColumn(declaration, plan);
    }
    const asOfMillis = Date.parse(plan.asOf);
    const keptRows: number[] = [];
    for (let row = 0; row < input.numRows; row += 1) {
      const value = temporalVector.get(row);
      const instant = temporalValueMillis(value, declaration, plan, row);
      if (instant <= asOfMillis) {
        keptRows.push(row);
      }
    }

    const guarded =
      keptRows.length === input.numRows
        ? input
        : takeRows(input, keptRows, backendRead.descriptor.id);
    const projected =
      plan.requestedColumns === null ? guarded : guarded.select([...plan.requestedColumns]);
    const outputIpc = tableToIPC(projected, "stream");
    const droppedFutureRows = input.numRows - keptRows.length;

    return Object.freeze({
      arrowIpc: outputIpc,
      plan,
      semantics: plan.semantics,
      backend: backendRead.descriptor,
      sourceFingerprint: backendRead.result.sourceFingerprint,
      audit: Object.freeze({
        inputRows: input.numRows,
        outputRows: projected.numRows,
        droppedFutureRows,
        backendClaimedProjectionPushdown: backendRead.result.pushdown.projectionApplied,
        backendClaimedTemporalPushdown: backendRead.result.pushdown.temporalPredicateApplied,
      }),
    });
  }
}

function decodeArrow(ipc: Uint8Array, backendId: string): Table {
  try {
    return tableFromIPC(ipc);
  } catch (cause) {
    throw new EngineConfigurationError(
      "INVALID_BACKEND_RESULT",
      `backend ${backendId} returned unreadable Arrow IPC: ${errorMessage(cause)}`,
      "Fix the backend's Arrow IPC output; no rows were exposed.",
    );
  }
}

function validateUniqueColumns(table: Table, backendId: string): void {
  const names = table.schema.fields.map((field) => field.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new EngineConfigurationError(
      "INVALID_BACKEND_RESULT",
      `backend ${backendId} returned duplicate column ${JSON.stringify(duplicate)}`,
      "Canonical Arrow output must have unique column names.",
    );
  }
}

function requireColumn(
  table: Table,
  column: string,
  declaration: AdapterDeclaration,
  plan: TemporalReadPlan,
): void {
  if (table.getChild(column) !== null) {
    return;
  }
  if (column === plan.temporalPredicate.column) {
    throw missingTemporalColumn(declaration, plan);
  }
  throw new EngineConfigurationError(
    "INVALID_BACKEND_RESULT",
    `backend omitted required column ${JSON.stringify(column)}`,
    "Return every requested and guard column in the Arrow result.",
  );
}

function missingTemporalColumn(
  declaration: AdapterDeclaration,
  plan: TemporalReadPlan,
): ContractViolation {
  return new ContractViolation("C1", "backend omitted the decision-time guard column", {
    dataset: `${declaration.dataset}@${declaration.version}`,
    asOf: plan.asOf,
    context: { column: plan.temporalPredicate.column },
    remedy: "Fix the backend adapter; C1 fails closed when the temporal column is absent.",
  });
}

function temporalValueMillis(
  value: unknown,
  declaration: AdapterDeclaration,
  plan: TemporalReadPlan,
  row: number,
): number {
  let instant: number;
  try {
    if (typeof value === "number") {
      instant = value;
    } else if (value instanceof Date) {
      instant = value.valueOf();
    } else if (typeof value === "string") {
      instant = Date.parse(normalizeDecisionTime(value));
    } else {
      instant = Number.NaN;
    }
  } catch {
    instant = Number.NaN;
  }
  if (Number.isFinite(instant)) {
    return instant;
  }
  throw new ContractViolation("C1", "row has an invalid decision-time value", {
    dataset: `${declaration.dataset}@${declaration.version}`,
    asOf: plan.asOf,
    context: { column: plan.temporalPredicate.column, row },
    remedy: "Normalize the backend's guard column to ISO-8601 or Arrow timestamp milliseconds.",
  });
}

function takeRows(table: Table, rows: readonly number[], backendId: string): Table {
  try {
    const columns: Record<string, Vector> = {};
    for (let index = 0; index < table.schema.fields.length; index += 1) {
      const field = table.schema.fields[index];
      const vector = table.getChildAt(index);
      if (field === undefined || vector === null) {
        throw new Error(`missing column vector at index ${index}`);
      }
      columns[field.name] = vectorFromArray(
        rows.map((row) => vector.get(row)),
        field.type,
      );
    }
    return new Table(columns);
  } catch (cause) {
    throw new EngineConfigurationError(
      "INVALID_BACKEND_RESULT",
      `backend ${backendId} result could not be guarded: ${errorMessage(cause)}`,
      "Return Arrow types supported by the canonical temporal guard.",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
