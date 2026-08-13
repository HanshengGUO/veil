import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Float64,
  Table,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
} from "apache-arrow";

const REQUEST_MAGIC = Buffer.from("VLRQ0001", "ascii");
const RESULT_MAGIC = Buffer.from("VLRS0001", "ascii");
const HEADER_BYTES = 20;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = decodeRequest(Buffer.concat(chunks));
const moduleUrl = pathToFileURL(resolve(process.cwd(), ...request.metadata.entry.file.split("/")));
let callable = await import(moduleUrl.href);
for (const segment of request.metadata.entry.callable.split(".")) callable = callable?.[segment];
if (typeof callable !== "function") throw new Error("artifact entrypoint is not callable");

const source = tableFromIPC(request.arrowIpc);
const factorOutput = await callable(source, request.metadata);
const output = encodeFactorOutput(source, factorOutput);
const metadata = {
  format: "veil.artifact-execution-result.v0",
  requestHash: request.metadata.requestHash,
  artifactHash: request.metadata.artifactHash,
  readSetId: request.metadata.readSetId,
  outputArrowHash: `sha256:${createHash("sha256").update(output).digest("hex")}`,
};
process.stdout.write(encodeResult(metadata, output));

function decodeRequest(bytes) {
  if (bytes.byteLength < HEADER_BYTES || !bytes.subarray(0, 8).equals(REQUEST_MAGIC)) {
    throw new Error("invalid artifact request frame");
  }
  const controlLength = bytes.readUInt32BE(8);
  const arrowLength = Number(bytes.readBigUInt64BE(12));
  if (
    controlLength <= 0 ||
    arrowLength <= 0 ||
    bytes.byteLength !== HEADER_BYTES + controlLength + arrowLength
  ) {
    throw new Error("partial artifact request frame");
  }
  const controlEnd = HEADER_BYTES + controlLength;
  return {
    metadata: JSON.parse(bytes.subarray(HEADER_BYTES, controlEnd).toString("utf8")),
    arrowIpc: Uint8Array.from(bytes.subarray(controlEnd)),
  };
}

function encodeFactorOutput(source, value) {
  if (value === null || typeof value !== "object" || !Array.isArray(value.rowIndices)) {
    throw new Error("factor returned an invalid row selection");
  }
  const entityField = source.schema.fields.find((field) => field.name === "ticker");
  const eventField = source.schema.fields.find((field) => field.name === "date");
  const entity = source.getChild("ticker");
  const eventTime = source.getChild("date");
  if (entityField === undefined || eventField === undefined || entity === null || eventTime === null) {
    throw new Error("factor input is missing admission keys");
  }
  let previous = -1;
  for (const row of value.rowIndices) {
    if (!Number.isSafeInteger(row) || row <= previous || row >= source.numRows) {
      throw new Error("factor row selection is not ordered and unique");
    }
    previous = row;
  }
  if (value.scores === null || typeof value.scores !== "object" || Array.isArray(value.scores)) {
    throw new Error("factor returned invalid score columns");
  }
  const columns = {
    ticker: vectorFromArray(value.rowIndices.map((row) => entity.get(row)), entityField.type),
    date: vectorFromArray(value.rowIndices.map((row) => eventTime.get(row)), eventField.type),
  };
  for (const [name, values] of Object.entries(value.scores).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^momentum_[1-9][0-9]*$/.test(name) || !Array.isArray(values) || values.length !== value.rowIndices.length) {
      throw new Error("factor returned an invalid score column");
    }
    columns[name] = vectorFromArray(values, new Float64());
  }
  return tableToIPC(new Table(columns), "stream");
}

function encodeResult(metadata, arrowIpc) {
  const control = Buffer.from(canonicalJson(metadata), "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  RESULT_MAGIC.copy(header, 0);
  header.writeUInt32BE(control.byteLength, 8);
  header.writeBigUInt64BE(BigInt(arrowIpc.byteLength), 12);
  return Buffer.concat([header, control, Buffer.from(arrowIpc)]);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
