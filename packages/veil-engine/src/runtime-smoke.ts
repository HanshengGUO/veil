export type NativeRuntimeStage = "duckdb-load" | "duckdb-query" | "arrow-load" | "arrow-ipc";

export class NativeRuntimeError extends Error {
  readonly stage: NativeRuntimeStage;

  constructor(stage: NativeRuntimeStage, cause: unknown) {
    super(`[${stage}] ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "NativeRuntimeError";
    this.stage = stage;
  }
}

export interface NativeRuntimeReport {
  readonly duckdbVersion: string;
  readonly duckdbRows: number;
  readonly arrowRows: number;
  readonly arrowIpcBytes: number;
}

/** Cold-loads both runtimes. DuckDB stays out of the engine's public data-plane interfaces. */
export async function probeNativeRuntime(): Promise<NativeRuntimeReport> {
  const duckdb = await loadDuckDB();
  const arrow = await loadArrow();
  let instance: Awaited<ReturnType<typeof duckdb.DuckDBInstance.create>> | undefined;
  let connection:
    | Awaited<ReturnType<InstanceType<typeof duckdb.DuckDBInstance>["connect"]>>
    | undefined;
  let duckdbRows = 0;

  try {
    try {
      instance = await duckdb.DuckDBInstance.create(":memory:");
      connection = await instance.connect();
      const reader = await connection.runAndReadAll(
        "select 1::integer as value, '2026-08-12T00:00:00Z'::timestamptz::varchar as observed_at",
      );
      duckdbRows = reader.getRowObjectsJson().length;
      if (duckdbRows !== 1) {
        throw new Error(`expected one DuckDB row, got ${duckdbRows}`);
      }
    } catch (cause) {
      throw new NativeRuntimeError("duckdb-query", cause);
    }
  } finally {
    connection?.closeSync();
    instance?.closeSync();
  }

  try {
    const table = arrow.tableFromArrays({
      value: [1, 2],
      label: ["guard", "backend-neutral"],
    });
    const ipc = arrow.tableToIPC(table, "stream");
    const restored = arrow.tableFromIPC(ipc);
    if (restored.numRows !== 2) {
      throw new Error(`expected two Arrow rows, got ${restored.numRows}`);
    }
    return Object.freeze({
      duckdbVersion: duckdb.default.version(),
      duckdbRows,
      arrowRows: restored.numRows,
      arrowIpcBytes: ipc.byteLength,
    });
  } catch (cause) {
    throw new NativeRuntimeError("arrow-ipc", cause);
  }
}

async function loadDuckDB(): Promise<typeof import("@duckdb/node-api")> {
  try {
    return await import("@duckdb/node-api");
  } catch (cause) {
    throw new NativeRuntimeError("duckdb-load", cause);
  }
}

async function loadArrow(): Promise<typeof import("apache-arrow")> {
  try {
    return await import("apache-arrow");
  } catch (cause) {
    throw new NativeRuntimeError("arrow-load", cause);
  }
}
