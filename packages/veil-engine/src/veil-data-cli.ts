import { type AdapterDeclaration, ContractViolation } from "@veilquant/contract";
import type { BackendRegistry } from "./backend.ts";
import { EngineConfigurationError } from "./errors.ts";
import { type ReadSetSnapshotReference, ReadSetSnapshotStore } from "./snapshot-store.ts";
import type { SourceBinding } from "./source-binding.ts";
import { type VeilDataMode, VeilDataService, type VeilDataViewSummary } from "./veil-data.ts";

export interface VeilDataCliContext {
  readonly registry: BackendRegistry;
  readonly declaration: AdapterDeclaration;
  readonly binding: SourceBinding;
  /** Supplying a store does not write to it; `--output snapshot` must also be selected. */
  readonly snapshotStore?: ReadSetSnapshotStore;
}

export interface VeilDataCliArrowResult {
  readonly output: "arrow";
  readonly contentType: "application/vnd.apache.arrow.stream";
  readonly view: VeilDataViewSummary;
  /** Non-enumerable so JSON/logging cannot accidentally expand the complete data plane. */
  readonly arrowIpc: Uint8Array;
}

export interface VeilDataCliSnapshotResult {
  readonly output: "snapshot";
  readonly view: VeilDataViewSummary;
  readonly created: boolean;
  readonly snapshot: ReadSetSnapshotReference;
}

export type VeilDataCliResult = VeilDataCliArrowResult | VeilDataCliSnapshotResult;

interface ParsedArguments {
  readonly mode: VeilDataMode;
  readonly asOf: string;
  readonly columns?: readonly string[];
  readonly output: "arrow" | "snapshot";
}

/**
 * Dependency-injected CLI core. A launcher chooses the backend and creates its opaque binding; this
 * parser never branches on a database, file format, physical path, SQL dialect, or credential.
 */
export async function runVeilDataCli(
  argumentsInput: readonly string[],
  context: VeilDataCliContext,
): Promise<VeilDataCliResult> {
  const parsed = parseArguments(argumentsInput);
  let snapshotStore: ReadSetSnapshotStore | undefined;
  if (parsed.output === "snapshot") {
    snapshotStore = requireSnapshotStore(context.snapshotStore);
  }
  const service = new VeilDataService(context.registry);
  const request = {
    declaration: context.declaration,
    binding: context.binding,
    asOf: parsed.asOf,
    ...(parsed.columns === undefined ? {} : { columns: parsed.columns }),
  };
  const view =
    parsed.mode === "point" ? await service.point(request) : await service.panel(request);

  if (parsed.output === "arrow") {
    const arrowIpc = view.arrowIpc;
    const result = {
      output: "arrow",
      contentType: "application/vnd.apache.arrow.stream",
      view: view.toJSON(),
    } as VeilDataCliArrowResult;
    Object.defineProperty(result, "arrowIpc", {
      enumerable: false,
      get: () => Uint8Array.from(arrowIpc),
    });
    return Object.freeze(result);
  }
  if (snapshotStore === undefined) {
    throw invalidCli("snapshot output requires an explicitly selected store");
  }
  const written = await view.writeSnapshot(snapshotStore);
  return Object.freeze({
    output: "snapshot",
    view: view.toJSON(),
    created: written.created,
    snapshot: written.snapshot,
  });
}

function parseArguments(argumentsInput: readonly string[]): ParsedArguments {
  if (!Array.isArray(argumentsInput)) {
    throw invalidCli("veil-data arguments must be an array");
  }
  const [modeInput, ...flags] = argumentsInput;
  if (modeInput !== "point" && modeInput !== "panel") {
    throw invalidCli("veil-data requires point or panel as its first argument");
  }

  const values = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (flag === undefined || !["--as-of", "--columns", "--output"].includes(flag)) {
      throw invalidCli("veil-data received an unknown argument");
    }
    if (value === undefined || value.startsWith("--")) {
      throw invalidCli("veil-data option is missing its value");
    }
    if (values.has(flag)) {
      throw invalidCli("veil-data option was provided more than once");
    }
    values.set(flag, value);
  }

  const asOf = values.get("--as-of");
  if (asOf === undefined || asOf.trim().length === 0) {
    throw new ContractViolation("C1", "veil-data requires an explicit as_of decision time", {
      remedy:
        "Pass --as-of with an ISO-8601 date or timestamp; Veil never defaults it to the current time.",
    });
  }
  const output = values.get("--output");
  if (output !== "arrow" && output !== "snapshot") {
    throw invalidCli("veil-data requires --output arrow or --output snapshot");
  }
  const columnsInput = values.get("--columns");
  const columns = columnsInput === undefined ? undefined : parseColumns(columnsInput);
  return Object.freeze({
    mode: modeInput,
    asOf,
    ...(columns === undefined ? {} : { columns }),
    output,
  });
}

function parseColumns(input: string): readonly string[] {
  const columns = input.split(",").map((column) => column.trim());
  if (columns.length === 0 || columns.some((column) => column.length === 0)) {
    throw invalidCli("--columns must be a comma-separated list of non-empty names");
  }
  return Object.freeze(columns);
}

function requireSnapshotStore(input: ReadSetSnapshotStore | undefined): ReadSetSnapshotStore {
  if (!(input instanceof ReadSetSnapshotStore)) {
    throw new EngineConfigurationError(
      "INVALID_SNAPSHOT_STORE",
      "snapshot output requires a store selected explicitly by the CLI launcher",
      "Open a snapshot store and pass it in the CLI context, or select --output arrow.",
    );
  }
  return input;
}

function invalidCli(
  message: string,
  remedy = "Use: veil-data <point|panel> --as-of <ISO-8601> [--columns a,b] --output <arrow|snapshot>.",
): EngineConfigurationError {
  return new EngineConfigurationError("INVALID_QUERY", message, remedy);
}
