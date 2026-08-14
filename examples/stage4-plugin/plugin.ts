import { createHash } from "node:crypto";
import { createCostModelProvider, createNullGeneratorProvider } from "@veilquant/engine";

function implementationHash(name: string): string {
  return `sha256:${createHash("sha256").update(`veil-example-plugin:${name}:v1`).digest("hex")}`;
}

/** Example spread-plus-impact model. Production plugins should hash their shipped build artifact. */
export function createExampleEquityCostModel() {
  return createCostModelProvider({
    reference: "example.equity-spread-impact",
    version: "1.0.0",
    implementationHash: implementationHash("equity-spread-impact"),
    configuration: { impactBps: 2 },
    evaluate: ({ trades, marketData, configuration }) => {
      const config = configuration as Readonly<{ impactBps: number }>;
      const marketByTrade = new Map(marketData.map((row) => [row.tradeId, row]));
      return {
        charges: trades.map((trade) => {
          const spread = marketByTrade.get(trade.tradeId)?.fields.spread_bps;
          if (typeof spread !== "number" || spread < 0) {
            throw new Error("spread_bps must be a non-negative number");
          }
          return {
            tradeId: trade.tradeId,
            cost: (Math.abs(trade.weightChange) * (spread / 2 + config.impactBps)) / 10_000,
          };
        }),
      };
    },
  });
}

/** Deterministic sign-flip null for demonstrating the typed boundary, not a universal market null. */
export function createExampleSignFlipNull() {
  return createNullGeneratorProvider({
    reference: "example.sign-flip-null",
    version: "1.0.0",
    implementationHash: implementationHash("sign-flip-null"),
    configuration: { replications: 64 },
    generate: ({ observedReturns, configuration }) => {
      const { replications } = configuration as Readonly<{ replications: number }>;
      return {
        samples: Array.from({ length: replications }, (_, replication) =>
          observedReturns.map((value, index) => ((replication + index) % 2 === 0 ? value : -value)),
        ),
      };
    },
  });
}
