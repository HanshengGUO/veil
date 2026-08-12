import { resolve } from "node:path";
import { generateMarket } from "../../fixtures/market.ts";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const seed = Number(option("--seed"));
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
  throw new Error("--seed must be an unsigned 32-bit integer");
}

generateMarket(
  {
    seed,
    startDate: "2018-01-02",
    endDate: "2024-12-31",
    survivors: 120,
    delisted: 12,
    momentumKappa: 0.02,
  },
  resolve(option("--out")),
);
