import { normalizeDecisionTime } from "@veilquant/contract";
import { createVeilData, type VeilDataView } from "@veilquant/engine";
import {
  VEIL_AGENT_TOOL_RESULT_FORMAT,
  VEIL_DATA_READ_ENTRY,
  VEIL_DATA_TOOL,
} from "./constants.ts";
import { VeilAgentError } from "./errors.ts";
import type { DataReadEntryData } from "./ledger.ts";
import type { VeilProjectRuntime } from "./project.ts";
import { hashBytes, writeImmutableProjectFile } from "./storage.ts";

export interface VeilDataToolInput {
  readonly dataset: string;
  readonly mode: "point" | "panel";
  readonly as_of: string;
  readonly columns?: readonly string[];
  readonly output: "summary" | "arrow";
}

export interface VeilDataToolResult {
  readonly format: typeof VEIL_AGENT_TOOL_RESULT_FORMAT;
  readonly tool: typeof VEIL_DATA_TOOL;
  readonly ok: true;
  readonly dataset: string;
  readonly adapterVersion: string;
  readonly view: {
    readonly mode: "point" | "panel";
    readonly grade: "guarded" | "exploration-grade";
    readonly asOf: string;
    readonly rowCount: number;
  };
  readonly evidence: {
    readonly readSetId: string;
    readonly resultHash: string;
    readonly arrowHash: string;
  };
  readonly semantics: VeilDataView["semantics"];
  readonly guard: VeilDataView["audit"];
  readonly exportReference: string | null;
}

export async function executeVeilDataTool(
  input: VeilDataToolInput,
  context: {
    readonly project: VeilProjectRuntime;
    readonly appendEntry: (
      customType: typeof VEIL_DATA_READ_ENTRY,
      data: DataReadEntryData,
    ) => void;
  },
): Promise<VeilDataToolResult> {
  validateDataInput(input);
  const dataset = context.project.datasets.get(input.dataset);
  if (dataset === undefined) {
    throw invalidData("veil-data dataset is not registered by the current project");
  }
  const asOf = normalizeDecisionTime(input.as_of);
  const service = createVeilData(context.project.backends);
  const request = {
    declaration: dataset.declaration,
    binding: dataset.binding,
    asOf,
    ...(input.columns === undefined ? {} : { columns: normalizeColumns(input.columns) }),
  };
  const view = input.mode === "point" ? await service.point(request) : await service.panel(request);
  if (hashBytes(view.arrowIpc) !== view.arrowHash) {
    throw invalidData("guarded Arrow bytes do not match their engine identity");
  }
  const exportReference =
    input.output === "arrow" ? `.veil/views/${view.readSetId.slice("sha256:".length)}.arrow` : null;
  if (exportReference !== null) {
    await writeImmutableProjectFile({
      projectRoot: context.project.root,
      reference: exportReference,
      bytes: view.arrowIpc,
    });
  }
  const ledgerEntry: DataReadEntryData = Object.freeze({
    format: VEIL_DATA_READ_ENTRY,
    dataset: dataset.declaration.dataset,
    adapterVersion: dataset.declaration.version,
    mode: view.mode,
    grade: view.grade,
    asOf: view.asOf,
    readSetId: view.readSetId,
    resultHash: view.resultHash,
    arrowHash: view.arrowHash,
    exportReference,
  });
  context.appendEntry(VEIL_DATA_READ_ENTRY, ledgerEntry);
  return Object.freeze({
    format: VEIL_AGENT_TOOL_RESULT_FORMAT,
    tool: VEIL_DATA_TOOL,
    ok: true,
    dataset: dataset.declaration.dataset,
    adapterVersion: dataset.declaration.version,
    view: Object.freeze({
      mode: view.mode,
      grade: view.grade,
      asOf: view.asOf,
      rowCount: view.rowCount,
    }),
    evidence: Object.freeze({
      readSetId: view.readSetId,
      resultHash: view.resultHash,
      arrowHash: view.arrowHash,
    }),
    semantics: view.semantics,
    guard: view.audit,
    exportReference,
  });
}

function validateDataInput(input: VeilDataToolInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidData("veil-data input must be an object");
  }
  const keys = Object.keys(input);
  const allowed = new Set(["dataset", "mode", "as_of", "columns", "output"]);
  if (keys.some((key) => !allowed.has(key))) {
    throw invalidData("veil-data input contains an unsupported field");
  }
  if (
    typeof input.dataset !== "string" ||
    input.dataset.trim().length === 0 ||
    (input.mode !== "point" && input.mode !== "panel") ||
    typeof input.as_of !== "string" ||
    (input.output !== "summary" && input.output !== "arrow")
  ) {
    throw invalidData("veil-data input has missing or invalid required fields");
  }
}

function normalizeColumns(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidData("veil-data columns must be omitted or contain at least one name");
  }
  const columns: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw invalidData("veil-data columns contain an empty name");
    }
    const column = value.trim();
    if (!columns.includes(column)) columns.push(column);
  }
  return Object.freeze(columns);
}

function invalidData(message: string): VeilAgentError {
  return new VeilAgentError(
    "INVALID_DATA_REQUEST",
    message,
    "Select a dataset from .veil/project.yaml and pass an explicit as_of decision time.",
  );
}
