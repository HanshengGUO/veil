import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  createArtifactExecutionRequest,
  decodeArtifactExecutionResult,
  encodeArtifactExecutionRequest,
} from "../../../packages/veil-engine/src/index.ts";

const here = dirname(fileURLToPath(new URL("../factor.mjs", import.meta.url)));
const runner = fileURLToPath(new URL("../runner.mjs", import.meta.url));

describe("golden-path evidence child", () => {
  it("executes the locked factor through the same framed protocol used by the full acceptance", async () => {
    const dates = Array.from({ length: 25 }, (_, index) =>
      new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    );
    const arrowIpc = tableToIPC(
      tableFromArrays({
        ticker: dates.flatMap(() => ["AAA", "BBB"]),
        date: dates.flatMap((date) => [date, date]),
        close: dates.flatMap((_, index) => [100 + index, 100 - index / 2]),
        eligible: dates.flatMap(() => [true, true]),
      }),
      "stream",
    );
    const request = createArtifactExecutionRequest({
      artifactHash: `sha256:${"a".repeat(64)}`,
      codeTreeHash: `sha256:${"b".repeat(64)}`,
      runtime: {
        id: "node-golden-path",
        implementation: { name: "node", version: process.versions.node },
      },
      entry: { file: "factor.mjs", callable: "compute" },
      dataset: {
        dataset: "golden-path-research-panel",
        version: "2026-08-12",
        declarationHash: `sha256:${"c".repeat(64)}`,
      },
      readSetId: `sha256:${"d".repeat(64)}`,
      decisionTime: dates.at(-1) ?? "",
      paramsLocked: {
        candidateLookbacks: [3, 5, 10, 20],
        standardization: "expanding",
        selectionScope: "training-fold-only",
      },
      declaredLiterals: { minimumHistory: 20, longShortQuantile: 0.2 },
      arrowIpc,
    });

    const output = decodeArtifactExecutionResult(
      await runChild(encodeArtifactExecutionRequest(request)),
    );
    const table = tableFromIPC(output.arrowIpc);
    expect(output.metadata.requestHash).toBe(request.metadata.requestHash);
    expect(table.numRows).toBe(2);
    expect(table.schema.fields.map((field) => field.name)).toEqual([
      "ticker",
      "date",
      "momentum_10",
      "momentum_20",
      "momentum_3",
      "momentum_5",
    ]);
    expect(table.getChild("date")?.toArray()).toEqual([dates.at(-1), dates.at(-1)]);
    expect(Array.from(table.getChild("momentum_3")?.toArray() ?? [])).toEqual([
      -1.5578191225100353, -1.7143434976965828,
    ]);
    expect(Array.from(table.getChild("momentum_5")?.toArray() ?? [])).toEqual([
      -1.5593697417762113, -1.7002405973445847,
    ]);
    expect(Array.from(table.getChild("momentum_10")?.toArray() ?? [])).toEqual([
      Number.NaN,
      Number.NaN,
    ]);
    expect(Array.from(table.getChild("momentum_20")?.toArray() ?? [])).toEqual([
      Number.NaN,
      Number.NaN,
    ]);
  });
});

function runChild(input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner], {
      cwd: here,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`golden-path child failed: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolve(Uint8Array.from(Buffer.concat(stdout)));
    });
    child.stdin.end(Buffer.from(input));
  });
}
