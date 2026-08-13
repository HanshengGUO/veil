import { Buffer } from "node:buffer";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createArtifactExecutionResult,
  decodeArtifactExecutionRequest,
  encodeArtifactExecutionResult,
} from "@veilquant/engine";
import { Table, tableFromIPC, tableToIPC, vectorFromArray } from "apache-arrow";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = decodeArtifactExecutionRequest(Buffer.concat(chunks));
const moduleUrl = pathToFileURL(join(process.cwd(), ...request.metadata.entry.file.split("/")));
let callable = await import(moduleUrl.href);
for (const segment of request.metadata.entry.callable.split(".")) {
  if (callable === null || (typeof callable !== "object" && typeof callable !== "function")) {
    throw new Error("artifact callable could not be resolved");
  }
  callable = callable[segment];
}
if (typeof callable !== "function") throw new Error("artifact entrypoint is not callable");

const inputTable = tableFromIPC(request.arrowIpc);
const factorOutput = await callable(inputTable, request.metadata);
const output = encodeFactorOutput(inputTable, factorOutput);
process.stdout.write(
  encodeArtifactExecutionResult(
    createArtifactExecutionResult({
      requestHash: request.metadata.requestHash,
      artifactHash: request.metadata.artifactHash,
      readSetId: request.metadata.readSetId,
      arrowIpc: output,
    }),
  ),
);

function encodeFactorOutput(source, output) {
  if (output instanceof Uint8Array) return output;
  if (output instanceof Table) return tableToIPC(output, "stream");
  if (
    output === null ||
    typeof output !== "object" ||
    !Array.isArray(output.rowIndices) ||
    output.columns === null ||
    typeof output.columns !== "object" ||
    Array.isArray(output.columns)
  ) {
    throw new Error(
      "artifact callable must return Arrow bytes, an Arrow Table, or { rowIndices, columns }",
    );
  }
  let previous = -1;
  for (const row of output.rowIndices) {
    if (!Number.isSafeInteger(row) || row <= previous || row >= source.numRows) {
      throw new Error("artifact rowIndices must be ordered, unique, and inside the input table");
    }
    previous = row;
  }
  const columns = Object.create(null);
  for (const field of source.schema.fields) {
    const vector = source.getChild(field.name);
    if (vector === null) throw new Error("artifact input field could not be read");
    columns[field.name] = vectorFromArray(
      output.rowIndices.map((row) => vector.get(row)),
      field.type,
    );
  }
  for (const [name, values] of Object.entries(output.columns).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      !/^[A-Za-z_][A-Za-z0-9._-]{0,127}$/.test(name) ||
      Object.hasOwn(columns, name) ||
      !Array.isArray(values) ||
      values.length !== output.rowIndices.length ||
      values.some(
        (value) =>
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "boolean" &&
          (typeof value !== "number" || !Number.isFinite(value)),
      )
    ) {
      throw new Error("artifact returned an invalid derived column");
    }
    columns[name] = vectorFromArray(values);
  }
  return tableToIPC(new Table(columns), "stream");
}
