import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateMarket } from "../market.ts";
import { HONEST, loadPanel, type Panel, runProtocol } from "../protocols.ts";

let directory: string;
let panel: Panel;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "veil-protocol-test-"));
  generateMarket(
    {
      seed: 19,
      startDate: "2019-01-02",
      endDate: "2022-12-30",
      survivors: 50,
      delisted: 10,
      momentumKappa: 0.02,
    },
    directory,
  );
  panel = loadPanel(directory);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("calibration protocols", () => {
  it("is exactly reproducible", () => {
    const first = runProtocol(panel, HONEST);
    expect(runProtocol(panel, HONEST)).toEqual(first);
    expect(first).toEqual({
      sharpe: -0.8975376385479269,
      annualReturn: -0.0628961366116345,
      annualVolatility: 0.0700763220508395,
      maxDrawdown: -0.29489049780712207,
      annualTurnover: 75.23330333033306,
      tradingDays: 808,
      lookbacksUsed: [10, 5, 5, 5],
      foldSharpes: [
        -1.5934028506589026, -1.5284941615702035, -1.488596215808924, 0.8821937173023235,
      ],
    });
  });

  it("nets a replacement book against the retiring book", () => {
    const result = runProtocol(panel, { ...HONEST, costBps: 0 });

    // Treating each rebalance as a fresh entry produces almost exactly 252 / 5 = 50.4x. A real
    // replacement compares the new book with the retiring one and is materially higher here.
    expect(result.annualTurnover).toBe(80.78573357335736);
    expect(result.annualTurnover).toBeGreaterThan(70);
  });

  it("makes the same-bar execution trap bite", () => {
    const honest = runProtocol(panel, HONEST);
    const sameBar = runProtocol(panel, { ...HONEST, execution: "same-bar" });

    expect(sameBar.sharpe).toBe(6.865581415252962);
    expect(sameBar.sharpe - honest.sharpe).toBeGreaterThan(7);
  });
});
