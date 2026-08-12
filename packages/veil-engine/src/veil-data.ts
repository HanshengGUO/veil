import { inspect } from "node:util";
import {
  type AdapterDeclaration,
  ContractViolation,
  type DataSemantics,
} from "@veilquant/contract";
import type { BackendRegistry } from "./backend.ts";
import { EngineConfigurationError } from "./errors.ts";
import type { ReadSetManifest } from "./read-set.ts";
import { ReadSetSnapshotStore, type ReadSetSnapshotWriteResult } from "./snapshot-store.ts";
import { SourceBinding } from "./source-binding.ts";
import {
  type GuardedReadResult,
  TemporalGuard,
  type TemporalGuardAudit,
} from "./temporal-guard.ts";

export const VEIL_DATA_VIEW_FORMAT = "veil.data-view.v0" as const;

export type VeilDataMode = "point" | "panel";
export type VeilDataGrade = "guarded" | "exploration-grade";

export interface VeilDataReadRequest {
  readonly declaration: AdapterDeclaration;
  readonly binding: SourceBinding;
  /** Required at runtime as well as in TypeScript. There is deliberately no default of "now". */
  readonly asOf: string;
  /** Point also retains a declared mask; panel retains mask plus bitemporal structural columns. */
  readonly columns?: readonly string[];
}

export interface VeilDataViewSummary {
  readonly format: typeof VEIL_DATA_VIEW_FORMAT;
  readonly mode: VeilDataMode;
  readonly grade: VeilDataGrade;
  readonly asOf: string;
  readonly rowCount: number;
  readonly readSetId: string;
  readonly resultHash: string;
  readonly arrowHash: string;
}

/**
 * A guarded exploration view. Its data plane is Arrow IPC; enumerable and serialized state is only
 * a path-free identity summary. Snapshot persistence is an explicit method call, never a read side
 * effect.
 */
export interface VeilDataView extends VeilDataViewSummary {
  readonly arrowIpc: Uint8Array;
  readonly readSet: ReadSetManifest;
  readonly semantics: DataSemantics;
  readonly audit: TemporalGuardAudit;
  writeSnapshot(store: ReadSetSnapshotStore): Promise<ReadSetSnapshotWriteResult>;
  toJSON(): VeilDataViewSummary;
}

export type VeilDataPointView = VeilDataView & {
  readonly mode: "point";
  readonly grade: "guarded";
};

export type VeilDataPanelView = VeilDataView & {
  readonly mode: "panel";
  readonly grade: "exploration-grade";
};

/** Backend-neutral API/CLI surface for guarded point reads and panel exports. */
export class VeilDataService {
  readonly #guard: TemporalGuard;

  constructor(registry: BackendRegistry) {
    this.#guard = new TemporalGuard(registry);
    Object.freeze(this);
  }

  async point(requestInput: VeilDataReadRequest): Promise<VeilDataPointView> {
    const request = validateRequest(requestInput);
    const guarded = await this.#guard.read(
      request.declaration,
      pointQuery(request),
      request.binding,
    );
    return createView("point", guarded) as VeilDataPointView;
  }

  async panel(requestInput: VeilDataReadRequest): Promise<VeilDataPanelView> {
    const request = validateRequest(requestInput);
    const guarded = await this.#guard.read(
      request.declaration,
      {
        asOf: request.asOf,
        ...(request.columns === undefined
          ? {}
          : { columns: panelProjection(request.declaration, request.columns) }),
      },
      request.binding,
    );
    return createView("panel", guarded) as VeilDataPanelView;
  }
}

export function createVeilData(registry: BackendRegistry): VeilDataService {
  return new VeilDataService(registry);
}

function validateRequest(requestInput: VeilDataReadRequest): VeilDataReadRequest {
  if (typeof requestInput !== "object" || requestInput === null || Array.isArray(requestInput)) {
    throw invalidRequest("veil-data request must be an object");
  }
  const request = requestInput as unknown as Record<string, unknown>;
  const allowed = new Set(["declaration", "binding", "asOf", "columns"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw invalidRequest("veil-data request contains unknown fields");
  }
  if (!Object.hasOwn(request, "asOf") || typeof request.asOf !== "string") {
    throw missingDecisionTime();
  }
  if (request.asOf.trim().length === 0) {
    throw missingDecisionTime();
  }
  if (
    !Object.hasOwn(request, "declaration") ||
    typeof request.declaration !== "object" ||
    request.declaration === null
  ) {
    throw invalidRequest("veil-data request requires a normalized adapter declaration");
  }
  if (!Object.hasOwn(request, "binding") || !(request.binding instanceof SourceBinding)) {
    throw invalidRequest("veil-data request requires an opaque source binding");
  }
  return requestInput;
}

function pointQuery(request: VeilDataReadRequest): {
  readonly asOf: string;
  readonly columns?: readonly string[];
} {
  if (request.columns === undefined) {
    return { asOf: request.asOf };
  }
  const requested = normalizeProjection(request.columns);
  const mask = request.declaration.guarantees.tradabilityMask;
  return {
    asOf: request.asOf,
    columns: mask === null ? requested : unique([...requested, mask]),
  };
}

function panelProjection(
  declaration: AdapterDeclaration,
  columnsInput: readonly string[],
): readonly string[] {
  const requested = normalizeProjection(columnsInput);
  return Object.freeze(
    unique([
      declaration.entityKey,
      declaration.eventTime,
      declaration.availableTime,
      declaration.guarantees.tradabilityMask,
      ...requested,
    ]),
  );
}

function normalizeProjection(columnsInput: readonly string[]): readonly string[] {
  if (!Array.isArray(columnsInput) || columnsInput.length === 0) {
    throw invalidRequest("columns must be omitted or contain at least one column");
  }
  const requested: string[] = [];
  for (const column of columnsInput) {
    if (typeof column !== "string" || column.trim().length === 0) {
      throw invalidRequest("projection contains an empty column");
    }
    const normalized = column.trim();
    if (!requested.includes(normalized)) {
      requested.push(normalized);
    }
  }
  return Object.freeze(requested);
}

function createView(mode: VeilDataMode, guarded: GuardedReadResult): VeilDataView {
  const grade: VeilDataGrade = mode === "panel" ? "exploration-grade" : "guarded";
  const summary = (): VeilDataViewSummary =>
    Object.freeze({
      format: VEIL_DATA_VIEW_FORMAT,
      mode,
      grade,
      asOf: guarded.plan.asOf,
      rowCount: guarded.readSet.result.rowCount,
      readSetId: guarded.readSet.manifestHash,
      resultHash: guarded.readSet.result.resultHash,
      arrowHash: guarded.readSet.result.arrowHash,
    });
  const view = { ...summary() } as VeilDataView;

  Object.defineProperties(view, {
    arrowIpc: {
      enumerable: false,
      get: () => Uint8Array.from(guarded.arrowIpc),
    },
    readSet: {
      enumerable: false,
      get: () => guarded.readSet,
    },
    semantics: {
      enumerable: false,
      get: () => guarded.semantics,
    },
    audit: {
      enumerable: false,
      get: () => guarded.audit,
    },
    writeSnapshot: {
      enumerable: false,
      value: async (store: ReadSetSnapshotStore): Promise<ReadSetSnapshotWriteResult> => {
        if (!(store instanceof ReadSetSnapshotStore)) {
          throw new EngineConfigurationError(
            "INVALID_SNAPSHOT_STORE",
            "veil-data snapshot output requires a validated snapshot store",
            "Open the store with openReadSetSnapshotStore() before writing the guarded view.",
          );
        }
        return store.put(guarded.readSet, guarded.arrowIpc);
      },
    },
    toJSON: {
      enumerable: false,
      value: summary,
    },
    [inspect.custom]: {
      enumerable: false,
      value: () => `VeilDataView ${JSON.stringify(summary())}`,
    },
  });
  return Object.freeze(view);
}

function unique(values: readonly (string | null)[]): string[] {
  return values.filter(
    (value, index): value is string => value !== null && values.indexOf(value) === index,
  );
}

function missingDecisionTime(): ContractViolation {
  return new ContractViolation("C1", "veil-data requires an explicit as_of decision time", {
    remedy:
      "Pass asOf as an ISO-8601 date or timestamp; Veil never defaults it to the current time.",
  });
}

function invalidRequest(message: string): EngineConfigurationError {
  return new EngineConfigurationError(
    "INVALID_QUERY",
    message,
    "Pass only declaration, binding, asOf, and an optional non-empty columns array.",
  );
}
