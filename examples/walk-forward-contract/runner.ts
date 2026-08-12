import { Buffer } from "node:buffer";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createArtifactExecutionResult,
  decodeArtifactExecutionRequest,
  encodeArtifactExecutionResult,
} from "../../packages/veil-engine/src/index.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = decodeArtifactExecutionRequest(Buffer.concat(chunks));
const moduleUrl = pathToFileURL(join(process.cwd(), ...request.metadata.entry.file.split("/")));
let callable: unknown = await import(moduleUrl.href);
for (const segment of request.metadata.entry.callable.split(".")) {
  if (callable === null || (typeof callable !== "object" && typeof callable !== "function")) {
    throw new Error("artifact callable could not be resolved");
  }
  callable = (callable as Record<string, unknown>)[segment];
}
if (typeof callable !== "function") throw new Error("artifact entrypoint is not callable");

const output: unknown = await callable(request.arrowIpc, request.metadata);
if (!(output instanceof Uint8Array)) {
  throw new Error("artifact callable did not return Arrow bytes");
}
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
