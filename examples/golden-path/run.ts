/**
 * Runs the golden path end to end.
 *
 *   npm run golden-path            regenerate data, run every protocol, rewrite results.json
 *   npm run golden-path:verify     same, but fail if the numbers moved
 *
 * The verify mode is the point: identical inputs must produce identical metrics on every platform.
 * It is the smallest possible version of what `veil reproduce` will do in Stage 4.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, SEED } from "./generate.ts";
import { loadPanel, PROTOCOLS, type ProtocolResult, runProtocol } from "./research.ts";

interface ProtocolReport {
  sharpe: number;
  annualReturn: number;
  annualVolatility: number;
  maxDrawdown: number;
  annualTurnover: number;
  tradingDays: number;
  lookbacksUsed: number[];
  foldSharpes: number[];
}

interface Report {
  seed: number;
  data: {
    dates: number;
    tickers: number;
    priceRows: number;
    universeRows: number;
    fundamentalRows: number;
  };
  protocols: Record<string, ProtocolReport>;
  /** Same generator, planted signal switched off. Nothing honest should survive here. */
  nullEnvironment: Record<string, ProtocolReport>;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const nullDataDir = join(here, "data-null");
const resultsPath = join(here, "results.json");
const verify = process.argv.includes("--verify");

const generated = generate(dataDir);
const panel = loadPanel(dataDir);

const toReport = (result: ProtocolResult): ProtocolReport => ({
  sharpe: round(result.sharpe),
  annualReturn: round(result.annualReturn),
  annualVolatility: round(result.annualVolatility),
  maxDrawdown: round(result.maxDrawdown),
  annualTurnover: round(result.annualTurnover),
  tradingDays: result.tradingDays,
  lookbacksUsed: result.lookbacksUsed,
  foldSharpes: result.foldSharpes.map(round),
});

const protocols: Record<string, ProtocolReport> = {};
for (const entry of PROTOCOLS) {
  protocols[entry.name] = toReport(runProtocol(panel, entry.protocol));
}

generate(nullDataDir, 0);
const nullPanel = loadPanel(nullDataDir);
const nullProtocolNames = ["honest", "naive_pipeline"];
const nullEnvironment: Record<string, ProtocolReport> = {};
for (const entry of PROTOCOLS) {
  if (!nullProtocolNames.includes(entry.name)) continue;
  nullEnvironment[entry.name] = toReport(runProtocol(nullPanel, entry.protocol));
}

const report: Report = {
  seed: SEED,
  data: {
    dates: generated.dates.length,
    tickers: panel.tickers.length,
    priceRows: generated.priceRows,
    universeRows: generated.universeRows,
    fundamentalRows: generated.fundamentalRows,
  },
  protocols,
  nullEnvironment,
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const pad = (value: string, width: number): string => value.padEnd(width);

console.log(
  `\n${panel.tickers.length} instruments, ${generated.dates.length} trading days, ` +
    `${generated.priceRows} price rows, seed ${SEED}\n`,
);
console.log(
  `${pad("protocol", 26)}${pad("Sharpe", 9)}${pad("return", 9)}${pad("vol", 9)}${pad("maxDD", 9)}${pad("turnover", 10)}lookbacks`,
);
for (const entry of PROTOCOLS) {
  const result = protocols[entry.name];
  console.log(
    pad(entry.name, 26) +
      pad(result.sharpe.toFixed(2), 9) +
      pad(pct(result.annualReturn), 9) +
      pad(pct(result.annualVolatility), 9) +
      pad(pct(result.maxDrawdown), 9) +
      pad(`${result.annualTurnover.toFixed(1)}x`, 10) +
      result.lookbacksUsed.join("/"),
  );
}

console.log(
  `\nhonest per-fold OOS Sharpe: ${protocols.honest.foldSharpes.map((value) => value.toFixed(2)).join(", ")}`,
);

const honest = protocols.honest.sharpe;
const naive = protocols.naive_pipeline.sharpe;
console.log(
  `\nevaporation: naive ${naive.toFixed(2)} - honest ${honest.toFixed(2)} = ` +
    `${(naive - honest).toFixed(2)} Sharpe of the reported edge was protocol, not signal\n`,
);

console.log("null environment (same generator, planted signal switched off):");
for (const name of nullProtocolNames) {
  const result = nullEnvironment[name];
  console.log(`  ${pad(name, 24)}Sharpe ${result.sharpe.toFixed(2).padStart(6)}`);
}
console.log(
  "  the honest protocol finds nothing, as it must; the naive pipeline still reports an edge,\n" +
    "  which is why promotion has to be re-run on synthetic nulls before anyone believes it\n",
);

if (!verify) {
  writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${resultsPath}`);
  process.exit(0);
}

if (!existsSync(resultsPath)) {
  console.error(`missing ${resultsPath}: run \`npm run golden-path\` and commit the result`);
  process.exit(1);
}

const expected = JSON.parse(readFileSync(resultsPath, "utf8")) as Report;
const differences: string[] = [];

const compare = (label: string, actual: number, want: number): void => {
  if (Math.abs(actual - want) > 1e-6) differences.push(`${label}: expected ${want}, got ${actual}`);
};

compare("data.dates", report.data.dates, expected.data.dates);
compare("data.tickers", report.data.tickers, expected.data.tickers);
compare("data.priceRows", report.data.priceRows, expected.data.priceRows);
compare("data.universeRows", report.data.universeRows, expected.data.universeRows);
compare("data.fundamentalRows", report.data.fundamentalRows, expected.data.fundamentalRows);

const compareProtocols = (
  section: string,
  actualSection: Record<string, ProtocolReport>,
  expectedSection: Record<string, ProtocolReport>,
): void => {
  for (const [name, actual] of Object.entries(actualSection)) {
    const want = expectedSection?.[name];
    if (!want) {
      differences.push(`${section}.${name}: not present in results.json`);
      continue;
    }
    compare(`${section}.${name}.sharpe`, actual.sharpe, want.sharpe);
    compare(`${section}.${name}.annualReturn`, actual.annualReturn, want.annualReturn);
    compare(`${section}.${name}.annualVolatility`, actual.annualVolatility, want.annualVolatility);
    compare(`${section}.${name}.maxDrawdown`, actual.maxDrawdown, want.maxDrawdown);
    compare(`${section}.${name}.annualTurnover`, actual.annualTurnover, want.annualTurnover);
    if (actual.lookbacksUsed.join("/") !== want.lookbacksUsed.join("/")) {
      differences.push(
        `${section}.${name}.lookbacksUsed: expected ${want.lookbacksUsed.join("/")}, got ${actual.lookbacksUsed.join("/")}`,
      );
    }
    if (actual.foldSharpes.length !== want.foldSharpes.length) {
      differences.push(`${section}.${name}.foldSharpes: fold count changed`);
    } else {
      for (let i = 0; i < actual.foldSharpes.length; i++) {
        compare(`${section}.${name}.foldSharpes[${i}]`, actual.foldSharpes[i], want.foldSharpes[i]);
      }
    }
  }
};

compareProtocols("protocols", report.protocols, expected.protocols);
compareProtocols("nullEnvironment", report.nullEnvironment, expected.nullEnvironment);

if (differences.length > 0) {
  console.error("golden path is not reproducible:");
  for (const line of differences) console.error(`  ${line}`);
  process.exit(1);
}

console.log("golden path reproduced exactly");
