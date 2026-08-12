import type {
  DuckDBConnection,
  DuckDBResultReader,
  DuckDBTypeId,
  JS as DuckDbJsValue,
} from "@duckdb/node-api";
import {
  Binary,
  Bool,
  type DataType,
  Float32,
  Float64,
  Int8,
  Int16,
  Int32,
  Int64,
  Null,
  Table,
  TimeMicrosecond,
  TimeNanosecond,
  TimestampMillisecond,
  tableToIPC,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Utf8,
  type Vector,
  vectorFromArray,
} from "apache-arrow";
import type {
  BackendCapabilities,
  BackendReadRequest,
  BackendReadResult,
  TemporalBackend,
} from "./backend.ts";
import { EngineConfigurationError } from "./errors.ts";
import { withStableFileSource } from "./file-source.ts";
import { sourceFingerprintFromManifest } from "./source-manifest.ts";

export const DUCKDB_FILE_BACKEND_ID = "duckdb-file";

const CAPABILITIES: BackendCapabilities = Object.freeze({
  projectionPushdown: true,
  temporalPredicatePushdown: true,
  sourceFingerprint: "content-hash",
  readOnly: true,
});

const CSV_SCAN =
  "read_csv(?, header = true, auto_detect = true, sample_size = -1, strict_mode = true, null_padding = false)";
const PARQUET_SCAN = "read_parquet(?)";

/** The default CSV/Parquet implementation. Its SQL and native connection stay private. */
export class DuckDbFileBackend implements TemporalBackend {
  readonly id = DUCKDB_FILE_BACKEND_ID;
  readonly capabilities = CAPABILITIES;

  accepts(source: BackendReadRequest["source"]): boolean {
    return source.type === "csv" || source.type === "parquet";
  }

  async read(request: BackendReadRequest): Promise<BackendReadResult> {
    const stable = await withStableFileSource(
      request.binding.option("root"),
      request.source.locator,
      async (source) => {
        const scan = sourceScan(request.source.type, source.paths.length);
        const sourceValues = [...source.paths];
        const duckdb = await import("@duckdb/node-api");
        const instance = await duckdb.DuckDBInstance.create(":memory:");
        let connection: DuckDBConnection | undefined;
        let arrowIpc: Uint8Array | undefined;
        let projectionApplied = false;
        let temporalPredicateApplied = false;

        try {
          connection = await instance.connect();
          await configureConnection(connection);
          const schema = await connection.runAndReadAll(
            `select * from ${scan} limit 0`,
            sourceValues,
          );
          const sourceColumns = schema.columnNames();
          const sourceColumnSet = new Set(sourceColumns);
          const projection = request.plan.backendProjection;
          const applicableProjection =
            projection?.every((column) => sourceColumnSet.has(column)) === true ? projection : null;
          projectionApplied = applicableProjection !== null;
          const selectedColumns =
            applicableProjection === null
              ? "*"
              : applicableProjection.map(quoteIdentifier).join(", ");

          const temporalColumn = request.plan.temporalPredicate.column;
          if (sourceColumnSet.has(temporalColumn)) {
            const temporalIdentifier = quoteIdentifier(temporalColumn);
            const invalid = await invalidTemporalValueCount(
              connection,
              sourceValues,
              scan,
              temporalIdentifier,
            );
            temporalPredicateApplied = invalid === 0;
          }

          const temporalClause = temporalPredicateApplied
            ? ` where cast(${quoteIdentifier(request.plan.temporalPredicate.column)} as timestamptz) <= cast(? as timestamptz)`
            : "";
          const values = temporalPredicateApplied
            ? [...sourceValues, request.plan.asOf]
            : sourceValues;
          const result = await connection.runAndReadAll(
            `select ${selectedColumns} from ${scan}${temporalClause}`,
            values,
          );
          arrowIpc = readerToArrowIpc(result, duckdb.DuckDBTypeId);
        } finally {
          connection?.closeSync();
          instance.closeSync();
        }

        if (arrowIpc === undefined) {
          throw invalidSource(
            "DuckDB returned no result for a stable file source",
            "Retry the read and inspect the source schema if it fails again.",
          );
        }
        return {
          arrowIpc,
          runtimeVersion: duckdb.default.version(),
          projectionApplied,
          temporalPredicateApplied,
        };
      },
    );

    return {
      arrowIpc: stable.value.arrowIpc,
      sourceFingerprint: sourceFingerprintFromManifest(stable.source.manifest),
      runtime: {
        name: "duckdb",
        version: stable.value.runtimeVersion,
      },
      pushdown: {
        projectionApplied: stable.value.projectionApplied,
        temporalPredicateApplied: stable.value.temporalPredicateApplied,
      },
    };
  }
}

function sourceScan(sourceType: BackendReadRequest["source"]["type"], fileCount: number): string {
  if (!Number.isSafeInteger(fileCount) || fileCount < 1) {
    throw invalidSource(
      "file source contains no readable members",
      "Use a locator that resolves to at least one regular file.",
    );
  }
  const sourceArgument =
    fileCount === 1 ? "?" : `[${Array.from({ length: fileCount }, () => "?").join(", ")}]`;
  if (sourceType === "csv") {
    return CSV_SCAN.replace("?", sourceArgument);
  }
  if (sourceType === "parquet") {
    return PARQUET_SCAN.replace("?", sourceArgument);
  }
  throw invalidSource(
    `DuckDB file backend does not support source type ${sourceType}`,
    "Declare a CSV or Parquet source, or choose a compatible backend.",
  );
}

async function configureConnection(connection: DuckDBConnection): Promise<void> {
  await connection.run("set TimeZone = 'UTC'");
  await connection.run("set threads = 1");
  await connection.run("set preserve_insertion_order = true");
}

async function invalidTemporalValueCount(
  connection: DuckDBConnection,
  sourceValues: readonly string[],
  scan: string,
  temporalIdentifier: string,
): Promise<number> {
  const result = await connection.runAndReadAll(
    `select count(*) as invalid_count from ${scan} where ${temporalIdentifier} is null or try_cast(${temporalIdentifier} as timestamptz) is null`,
    [...sourceValues],
  );
  const value = result.getColumnsJS()[0]?.[0];
  if (typeof value === "bigint") {
    if (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    throw invalidSource(
      "file temporal validation count exceeds the supported range",
      "Split the source into smaller immutable files before reading.",
    );
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  throw invalidSource(
    "DuckDB returned an invalid temporal validation result",
    "Check the source schema and temporal column before retrying.",
  );
}

function readerToArrowIpc(
  reader: DuckDBResultReader,
  typeIds: typeof import("@duckdb/node-api")["DuckDBTypeId"],
): Uint8Array {
  const names = reader.columnNames();
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw invalidSource(
      `file query produced duplicate column ${JSON.stringify(duplicate)}`,
      "Use unique source column names and an unambiguous projection.",
    );
  }
  const values = reader.getColumnsJS();
  const vectors: Record<string, Vector> = {};
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const column = values[index] ?? (reader.currentRowCount === 0 ? [] : undefined);
    if (name === undefined || column === undefined) {
      throw invalidSource(
        "DuckDB returned an incomplete column result",
        "Retry the read and inspect the source schema if it fails again.",
      );
    }
    vectors[name] = vectorFromArray(
      column as readonly DuckDbJsValue[],
      arrowType(reader.columnTypeId(index), typeIds, name),
    );
  }
  return tableToIPC(new Table(vectors), "stream");
}

function arrowType(
  typeId: DuckDBTypeId,
  ids: typeof import("@duckdb/node-api")["DuckDBTypeId"],
  column: string,
): DataType {
  switch (typeId) {
    case ids.BOOLEAN:
      return new Bool();
    case ids.TINYINT:
      return new Int8();
    case ids.SMALLINT:
      return new Int16();
    case ids.INTEGER:
      return new Int32();
    case ids.BIGINT:
      return new Int64();
    case ids.UTINYINT:
      return new Uint8();
    case ids.USMALLINT:
      return new Uint16();
    case ids.UINTEGER:
      return new Uint32();
    case ids.UBIGINT:
      return new Uint64();
    case ids.FLOAT:
      return new Float32();
    case ids.DOUBLE:
    case ids.DECIMAL:
      return new Float64();
    case ids.TIMESTAMP:
    case ids.TIMESTAMP_S:
    case ids.TIMESTAMP_MS:
    case ids.TIMESTAMP_NS:
    case ids.TIMESTAMP_TZ:
    case ids.DATE:
      return new TimestampMillisecond("UTC");
    case ids.TIME:
      return new TimeMicrosecond();
    case ids.TIME_NS:
      return new TimeNanosecond();
    case ids.VARCHAR:
    case ids.ENUM:
    case ids.UUID:
      return new Utf8();
    case ids.BLOB:
    case ids.BIT:
      return new Binary();
    case ids.SQLNULL:
      return new Null();
    default:
      throw invalidSource(
        `file column ${JSON.stringify(column)} has an unsupported inferred type`,
        "Declare a primitive scalar representation or add an explicit canonical type adapter.",
      );
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function invalidSource(message: string, remedy: string): EngineConfigurationError {
  return new EngineConfigurationError("INVALID_SOURCE", message, remedy);
}
