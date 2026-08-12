import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateMarket, type MarketOutput, type MarketSpec } from "../market.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `veil-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(output: MarketOutput, directory: string): string {
  const hash = createHash("sha256");
  for (const file of output.files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(directory, file)));
  }
  return hash.digest("hex");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic market", () => {
  it("produces byte-identical files for a fixed seed", () => {
    const spec = {
      seed: 20260810,
      startDate: "2020-01-02",
      endDate: "2020-12-31",
      survivors: 12,
      delisted: 3,
      momentumKappa: 0.02,
      volatilityRegimes: true,
      perInstrumentRegimes: true,
      fundamentals: "with-availability",
    } satisfies MarketSpec;
    const firstDirectory = temporaryDirectory("market-first");
    const secondDirectory = temporaryDirectory("market-second");

    const first = generateMarket(spec, firstDirectory);
    const second = generateMarket(spec, secondDirectory);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      priceRows: 3750,
      universeRows: 3750,
      fundamentalRows: 164,
      sentinelRows: 1,
      files: [
        "prices.csv",
        "universe_history.csv",
        "universe_current.csv",
        "sentinel.csv",
        "fundamentals.csv",
      ],
    });
    expect(digest(first, firstDirectory)).toBe(
      "336a399cfd06751246c0efea22854638264ed5a63864c9cd805e8462b6606f81",
    );
    expect(digest(second, secondDirectory)).toBe(digest(first, firstDirectory));
  });
});
