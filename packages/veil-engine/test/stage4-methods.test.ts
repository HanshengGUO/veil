import { describe, expect, it } from "vitest";
import { executeRegisteredCostModel } from "../src/cost-model.ts";
import {
  CostModelRegistry,
  computeDeflatedSharpe,
  createCenteredBlockBootstrapNullGenerator,
  createCryptoFuturesCostModel,
  createHongKongEquityCostModel,
  NullGeneratorRegistry,
} from "../src/index.ts";
import { executeRegisteredNullGenerator } from "../src/null-generator.ts";

const trades = [
  {
    tradeId: hash("a"),
    foldIndex: 0,
    signalDecisionIndex: 1,
    executionDecisionIndex: 2,
    signalTime: "2026-01-01T00:00:00.000Z",
    executionTime: "2026-01-02T00:00:00.000Z",
    entityKey: 'string:"AAA"',
    previousWeight: 0,
    targetWeight: 0.5,
    weightChange: 0.5,
  },
  {
    tradeId: hash("b"),
    foldIndex: 0,
    signalDecisionIndex: 2,
    executionDecisionIndex: 3,
    signalTime: "2026-01-02T00:00:00.000Z",
    executionTime: "2026-01-03T00:00:00.000Z",
    entityKey: 'string:"AAA"',
    previousWeight: 0.5,
    targetWeight: 0,
    weightChange: -0.5,
  },
] as const;

const marketData = trades.map((trade) => ({
  tradeId: trade.tradeId,
  price: 100,
  fields: {},
}));

describe("Stage 4 statistical and domain methods", () => {
  it("tightens deflated Sharpe as observable trials increase", () => {
    const positive = Array.from(
      { length: 120 },
      (_, index) => [0.003, 0.001, -0.0005, 0.002][index % 4] ?? 0,
    );
    const single = computeDeflatedSharpe(positive, 1);
    const searched = computeDeflatedSharpe(positive, 100);
    const nullLike = computeDeflatedSharpe(
      Array.from({ length: 120 }, (_, index) => (index % 2 === 0 ? 0.001 : -0.001)),
      20,
    );

    expect(single.sampleSharpe).toBeGreaterThan(0);
    expect(searched.expectedMaximumSharpe).toBeGreaterThan(single.expectedMaximumSharpe);
    expect(searched.probability).toBeLessThan(single.probability);
    expect(nullLike.probability).toBeLessThan(0.95);
  });

  it("replays a seeded centered block bootstrap exactly", async () => {
    const provider = createCenteredBlockBootstrapNullGenerator({
      reference: "test.block-bootstrap",
      replications: 64,
      blockLength: 3,
      seed: 42,
    });
    const registry = new NullGeneratorRegistry();
    registry.register(provider);
    const observed = [0.01, -0.004, 0.006, -0.002, 0.005, -0.001];
    const first = await executeRegisteredNullGenerator(registry, provider.reference, observed);
    const second = await executeRegisteredNullGenerator(registry, provider.reference, observed);

    expect(first).toEqual(second);
    expect(first.samples).toHaveLength(64);
    expect(first.samples.every((sample) => sample.length === observed.length)).toBe(true);
    expect(Object.isFrozen(first.samples)).toBe(true);
  });

  it("prices Hong Kong equities and crypto futures with distinct locked schedules", async () => {
    const hongKong = createHongKongEquityCostModel({
      reference: "test.hk-equity",
      commissionBps: 3,
      tradingFeeBps: 0.05,
      transactionLevyBps: 0.027,
      stampDutyBps: 10,
    });
    const crypto = createCryptoFuturesCostModel({
      reference: "test.crypto-futures",
      takerFeeBps: 4,
      slippageBps: 2,
    });
    const hongKongRegistry = new CostModelRegistry();
    const cryptoRegistry = new CostModelRegistry();
    hongKongRegistry.register(hongKong);
    cryptoRegistry.register(crypto);

    const hongKongCharges = await executeRegisteredCostModel(hongKongRegistry, hongKong.reference, {
      trades,
      marketData,
    });
    const cryptoCharges = await executeRegisteredCostModel(cryptoRegistry, crypto.reference, {
      trades,
      marketData,
    });

    expect(hongKongCharges.charges.map((charge) => charge.cost)).toEqual([0.00065385, 0.00015385]);
    expect(cryptoCharges.charges.map((charge) => charge.cost)).toEqual([0.0003, 0.0003]);
    expect(hongKong.toJSON().implementationHash).not.toBe(crypto.toJSON().implementationHash);
  });
});

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
