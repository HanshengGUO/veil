/**
 * The golden path's thesis, as assertions. Reads the committed metrics rather than recomputing
 * them; `npm run golden-path:verify` is what proves the metrics still reproduce.
 *
 * If these assertions ever fail, either the synthetic market or the honest protocol changed in a
 * way that invalidates every downstream stage that treats this run as the standard answer.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ProtocolReport {
  sharpe: number;
  annualReturn: number;
  annualTurnover: number;
}

interface Report {
  protocols: Record<string, ProtocolReport>;
  nullEnvironment: Record<string, ProtocolReport>;
}

const here = dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(readFileSync(join(here, "..", "results.json"), "utf8")) as Report;

describe("golden path", () => {
  it("recovers the planted signal under the honest protocol", () => {
    expect(report.protocols.honest.sharpe).toBeGreaterThan(0.5);
    expect(report.protocols.honest.sharpe).toBeLessThan(1.5);
  });

  it("shows costs are not a formality", () => {
    const drag = report.protocols.honest_gross.sharpe - report.protocols.honest.sharpe;
    expect(drag).toBeGreaterThan(0.5);
  });

  it("reproduces the fake alpha a naive pipeline reports", () => {
    // Stage 1 requires trap tasks where an unconstrained pipeline clears Sharpe 2.5.
    expect(report.protocols.naive_pipeline.sharpe).toBeGreaterThan(2.5);
  });

  it("manufactures nothing on a null market under the honest protocol", () => {
    expect(report.nullEnvironment.honest.sharpe).toBeLessThan(0.5);
  });

  it("still finds an edge on a null market under the naive pipeline", () => {
    // This is why promotion has to be re-run against synthetic nulls (the Stage 4 gate).
    expect(report.nullEnvironment.naive_pipeline.sharpe).toBeGreaterThan(2.5);
  });
});
