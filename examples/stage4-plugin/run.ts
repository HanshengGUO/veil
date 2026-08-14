import {
  CostModelRegistry,
  executeRegisteredCostModel,
  executeRegisteredNullGenerator,
  NullGeneratorRegistry,
} from "@veilquant/engine";
import { createExampleEquityCostModel, createExampleSignFlipNull } from "./plugin.ts";

const tradeId = `sha256:${"a".repeat(64)}`;
const costModel = createExampleEquityCostModel();
const costModels = new CostModelRegistry();
costModels.register(costModel);
const costs = await executeRegisteredCostModel(costModels, costModel.reference, {
  trades: [
    {
      tradeId,
      foldIndex: 0,
      signalDecisionIndex: 0,
      executionDecisionIndex: 1,
      signalTime: "2026-01-01T00:00:00.000Z",
      executionTime: "2026-01-02T00:00:00.000Z",
      entityKey: 'string:"AAA"',
      previousWeight: 0,
      targetWeight: 0.5,
      weightChange: 0.5,
    },
  ],
  marketData: [{ tradeId, price: 100, fields: { spread_bps: 6 } }],
});

const nullGenerator = createExampleSignFlipNull();
const nullGenerators = new NullGeneratorRegistry();
nullGenerators.register(nullGenerator);
const nulls = await executeRegisteredNullGenerator(
  nullGenerators,
  nullGenerator.reference,
  [0.01, -0.004, 0.006, -0.002],
);

if (costs.charges[0]?.cost !== 0.00025 || nulls.samples.length !== 64) {
  throw new Error("Stage 4 plugin conformance example produced unexpected output");
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    costModel: costs.descriptor,
    charge: costs.charges[0]?.cost,
    nullGenerator: nulls.descriptor,
    nullReplications: nulls.samples.length,
  })}\n`,
);
