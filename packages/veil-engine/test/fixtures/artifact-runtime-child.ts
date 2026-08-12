import { Buffer } from "node:buffer";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import {
  createArtifactExecutionResult,
  decodeArtifactExecutionRequest,
  encodeArtifactExecutionResult,
} from "../../src/artifact-execution-protocol.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = decodeArtifactExecutionRequest(Buffer.concat(chunks));
const mode = process.argv[2] ?? "success";

if (mode === "timeout") {
  setInterval(() => undefined, 1_000);
} else if (mode === "nonzero") {
  process.exitCode = 23;
} else if (mode === "signal") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "stdout-flood") {
  process.stdout.on("error", () => undefined);
  process.stdout.write(Buffer.alloc(1024 * 1024, 0x78));
} else if (mode === "stderr-flood") {
  process.stderr.on("error", () => undefined);
  process.stderr.write(Buffer.alloc(1024 * 1024, 0x78));
} else if (mode === "malformed") {
  process.stdout.write("not-a-veil-frame");
} else if (mode === "oversized") {
  const header = Buffer.alloc(20);
  header.write("VLRS0001", 0, "ascii");
  header.writeUInt32BE(64 * 1024 + 1, 8);
  header.writeBigUInt64BE(1n, 12);
  process.stdout.write(header);
} else {
  if (!Object.isFrozen(request.metadata.paramsLocked)) {
    throw new Error("request parameters were not frozen by the child codec");
  }
  const locked = request.metadata.paramsLocked as { lookbackDays?: number };
  try {
    locked.lookbackDays = 999;
  } catch {
    // Expected for a frozen ESM object.
  }
  if (locked.lookbackDays !== 20) throw new Error("child changed locked parameters");
  if (
    process.env.VEIL_TEST_SECRET !== undefined ||
    process.env.HOME !== undefined ||
    process.env.PATH !== undefined ||
    process.env.PWD !== undefined ||
    process.env.INIT_CWD !== undefined ||
    process.env.TEMP !== undefined ||
    process.env.TMP !== undefined ||
    process.env.USERPROFILE !== undefined ||
    process.cwd().includes("veil-artifact-exec-source-")
  ) {
    throw new Error("developer environment or source root crossed the child boundary");
  }

  let arrowIpc = request.arrowIpc;
  if (mode === "untradable-row") {
    arrowIpc = tableToIPC(
      tableFromArrays({
        ticker: ["HALTED"],
        event_time: [request.metadata.decisionTime],
        signal: [1],
      }),
      "stream",
    );
  } else if (mode === "future-row") {
    const future = new Date(Date.parse(request.metadata.decisionTime) + 86_400_000).toISOString();
    arrowIpc = tableToIPC(
      tableFromArrays({ ticker: ["FUTURE"], event_time: [future], signal: [1] }),
      "stream",
    );
  }

  const result = createArtifactExecutionResult({
    requestHash:
      mode === "wrong-request" ? `sha256:${"0".repeat(64)}` : request.metadata.requestHash,
    artifactHash: request.metadata.artifactHash,
    readSetId: request.metadata.readSetId,
    arrowIpc,
  });
  const encoded = encodeArtifactExecutionResult(result);
  if (mode === "partial") {
    process.stdout.write(encoded.subarray(0, 10));
  } else if (mode === "trailing") {
    process.stdout.write(Buffer.concat([Buffer.from(encoded), Buffer.of(0)]));
  } else if (mode === "duplicate") {
    process.stdout.write(Buffer.concat([Buffer.from(encoded), Buffer.from(encoded)]));
  } else if (mode === "corrupt-arrow") {
    const corrupt = Buffer.from(encoded);
    corrupt[corrupt.byteLength - 1] ^= 0xff;
    process.stdout.write(corrupt);
  } else {
    if (mode === "stderr-small") process.stderr.write("private runtime diagnostic\n");
    process.stdout.write(encoded);
  }
}
