import { resolve } from "node:path";
import {
  AdapterDeclarationError,
  ContractViolation,
  type DataSemantics,
} from "@veilquant/contract";
import { DataType, type Table, tableFromIPC } from "apache-arrow";
import {
  BackendRegistry,
  createSourceBinding,
  createVeilData,
  DuckDbFileBackend,
  EngineConfigurationError,
  loadAdapterFile,
} from "../../packages/veil-engine/src/index.ts";

export const OWN_DATA_INSPECTION_FORMAT = "veil.own-data-inspection.v0" as const;
export const OWN_DATA_INSPECTION_HELP = `Inspect a CSV or Parquet file through Veil's mandatory temporal guard.

Usage:
  npm run data:inspect -- --adapter <adapter.yaml> --root <data-root> --as-of <ISO-8601> [--columns a,b] [--preview 0-20]

The adapter and root stay local. The JSON report contains no physical path. Preview is disabled by
default because rows may be sensitive; enable it explicitly only for local inspection.`;

export interface OwnDataInspectionOptions {
  readonly adapterPath: string;
  readonly root: string;
  readonly asOf: string;
  readonly columns?: readonly string[];
  readonly previewRows?: number;
}

export type OwnDataPreviewValue = string | number | boolean | null;

export interface OwnDataInspectionReport {
  readonly format: typeof OWN_DATA_INSPECTION_FORMAT;
  readonly ok: true;
  readonly dataset: string;
  readonly adapterVersion: string;
  readonly sourceType: "csv" | "parquet";
  readonly view: {
    readonly mode: "panel";
    readonly grade: "exploration-grade";
    readonly asOf: string;
    readonly rowCount: number;
    readonly columns: readonly string[];
    readonly temporalColumn: string;
    readonly tradabilityMask: string | null;
  };
  readonly guard: {
    readonly mandatoryArrowGuardApplied: true;
    readonly inputRowsAfterBackendPushdown: number;
    readonly outputRows: number;
    readonly droppedByArrowGuard: number;
    readonly backendClaimedTemporalPushdown: boolean;
  };
  readonly semantics: DataSemantics;
  readonly evidence: {
    readonly readSetId: string;
    readonly resultHash: string;
    readonly arrowHash: string;
  };
  readonly preview: readonly Readonly<Record<string, OwnDataPreviewValue>>[];
}

export interface OwnDataInspectionFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly remedy: string;
}

interface NormalizedOwnDataInspectionOptions {
  readonly adapterPath: string;
  readonly root: string;
  readonly asOf: string;
  readonly columns: readonly string[] | undefined;
  readonly previewRows: number;
}

/** A checkout-local launcher used by the Stage 2 external CSV trial. */
export async function inspectOwnData(
  optionsInput: OwnDataInspectionOptions,
): Promise<OwnDataInspectionReport> {
  const options = normalizeOptions(optionsInput);
  const declaration = await loadAdapterFile(resolve(options.adapterPath));
  if (declaration.source.type !== "csv" && declaration.source.type !== "parquet") {
    throw new EngineConfigurationError(
      "INVALID_SOURCE",
      "the own-data launcher supports only CSV or Parquet declarations",
      "Use source.type csv or parquet, or inject a different backend through the engine API.",
    );
  }

  const backend = new DuckDbFileBackend();
  const registry = new BackendRegistry();
  registry.register(backend);
  const view = await createVeilData(registry).panel({
    declaration,
    binding: createSourceBinding({
      id: "own-data-file",
      backend: backend.id,
      options: { root: resolve(options.root) },
    }),
    asOf: options.asOf,
    ...(options.columns === undefined ? {} : { columns: options.columns }),
  });
  const table = tableFromIPC(view.arrowIpc);
  const columns = Object.freeze(table.schema.fields.map((field) => field.name));
  const preview = previewTable(table, options.previewRows);

  return Object.freeze({
    format: OWN_DATA_INSPECTION_FORMAT,
    ok: true,
    dataset: declaration.dataset,
    adapterVersion: declaration.version,
    sourceType: declaration.source.type,
    view: Object.freeze({
      mode: view.mode,
      grade: view.grade,
      asOf: view.asOf,
      rowCount: view.rowCount,
      columns,
      temporalColumn: declaration.availableTime ?? declaration.eventTime,
      tradabilityMask: declaration.guarantees.tradabilityMask,
    }),
    guard: Object.freeze({
      mandatoryArrowGuardApplied: true,
      inputRowsAfterBackendPushdown: view.audit.inputRows,
      outputRows: view.audit.outputRows,
      droppedByArrowGuard: view.audit.droppedFutureRows,
      backendClaimedTemporalPushdown: view.audit.backendClaimedTemporalPushdown,
    }),
    semantics: view.semantics,
    evidence: Object.freeze({
      readSetId: view.readSetId,
      resultHash: view.resultHash,
      arrowHash: view.arrowHash,
    }),
    preview,
  });
}

export function parseOwnDataInspectionArguments(
  argumentsInput: readonly string[],
): OwnDataInspectionOptions {
  if (!Array.isArray(argumentsInput)) throw invalidArguments("arguments must be an array");
  const allowed = new Set(["--adapter", "--root", "--as-of", "--columns", "--preview"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsInput.length; index += 2) {
    const flag = argumentsInput[index];
    const value = argumentsInput[index + 1];
    if (flag === undefined || !allowed.has(flag)) {
      throw invalidArguments("received an unknown argument");
    }
    if (value === undefined || value.startsWith("--")) {
      throw invalidArguments(`${flag} is missing its value`);
    }
    if (values.has(flag)) throw invalidArguments(`${flag} was provided more than once`);
    values.set(flag, value);
  }

  const adapterPath = requiredArgument(values, "--adapter");
  const root = requiredArgument(values, "--root");
  const asOf = requiredArgument(values, "--as-of");
  const columnsInput = values.get("--columns");
  const previewInput = values.get("--preview") ?? "0";
  const previewRows = Number(previewInput);
  if (!Number.isSafeInteger(previewRows) || previewRows < 0 || previewRows > 20) {
    throw invalidArguments("--preview must be an integer from 0 through 20");
  }
  return Object.freeze({
    adapterPath,
    root,
    asOf,
    ...(columnsInput === undefined ? {} : { columns: parseColumns(columnsInput) }),
    previewRows,
  });
}

export function describeOwnDataInspectionError(error: unknown): OwnDataInspectionFailure {
  if (error instanceof AdapterDeclarationError) {
    return Object.freeze({
      ok: false,
      code: error.code,
      message: error.message,
      field: error.path,
      remedy: error.remedy,
    });
  }
  if (error instanceof ContractViolation) {
    return Object.freeze({
      ok: false,
      code: error.invariant,
      message: error.message,
      remedy: error.detail.remedy ?? "Correct the declared decision-time protocol and retry.",
    });
  }
  if (error instanceof EngineConfigurationError) {
    return Object.freeze({
      ok: false,
      code: error.code,
      message: error.message,
      remedy: error.remedy,
    });
  }
  return Object.freeze({
    ok: false,
    code: "UNEXPECTED_ERROR",
    message: "own-data inspection failed without a public diagnostic",
    remedy: "Retry with the smallest CSV and report the command, Node version, and public error.",
  });
}

function normalizeOptions(input: OwnDataInspectionOptions): NormalizedOwnDataInspectionOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidArguments("inspection options must be an object");
  }
  const keys = new Set(["adapterPath", "root", "asOf", "columns", "previewRows"]);
  if (Object.keys(input).some((key) => !keys.has(key))) {
    throw invalidArguments("inspection options contain unknown fields");
  }
  const adapterPath = nonBlank(input.adapterPath, "adapter path");
  const root = nonBlank(input.root, "data root");
  const asOf = nonBlank(input.asOf, "as-of decision time");
  const columns = input.columns === undefined ? undefined : normalizeColumns(input.columns);
  const previewRows = input.previewRows ?? 0;
  if (!Number.isSafeInteger(previewRows) || previewRows < 0 || previewRows > 20) {
    throw invalidArguments("preview rows must be an integer from 0 through 20");
  }
  return Object.freeze({ adapterPath, root, asOf, columns, previewRows });
}

function parseColumns(input: string): readonly string[] {
  return normalizeColumns(input.split(","));
}

function normalizeColumns(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidArguments("columns must contain at least one name");
  }
  const columns: string[] = [];
  for (const value of input) {
    const column = nonBlank(value, "column name");
    if (!columns.includes(column)) columns.push(column);
  }
  return Object.freeze(columns);
}

function previewTable(
  table: Table,
  limit: number,
): readonly Readonly<Record<string, OwnDataPreviewValue>>[] {
  const rows: Readonly<Record<string, OwnDataPreviewValue>>[] = [];
  for (let rowIndex = 0; rowIndex < Math.min(limit, table.numRows); rowIndex += 1) {
    const row: Record<string, OwnDataPreviewValue> = {};
    for (const field of table.schema.fields) {
      row[field.name] = previewValue(
        table.getChild(field.name)?.get(rowIndex),
        DataType.isTimestamp(field.type) || DataType.isDate(field.type),
      );
    }
    rows.push(Object.freeze(row));
  }
  return Object.freeze(rows);
}

function previewValue(input: unknown, temporal: boolean): OwnDataPreviewValue {
  if (input === null || input === undefined) return null;
  if (typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (temporal && Number.isFinite(input)) return new Date(input).toISOString();
    return Number.isFinite(input) ? input : String(input);
  }
  if (typeof input === "bigint") return input.toString();
  if (input instanceof Date) return input.toISOString();
  return String(input);
}

function requiredArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw invalidArguments(`${name} is required`);
  }
  return value.trim();
}

function nonBlank(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw invalidArguments(`${field} must be a non-empty string`);
  }
  return input.trim();
}

function invalidArguments(message: string): EngineConfigurationError {
  return new EngineConfigurationError("INVALID_QUERY", message, OWN_DATA_INSPECTION_HELP);
}
