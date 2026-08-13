import { describe, expect, it } from "vitest";
import * as agentApi from "../src/index.ts";

describe("veil-quant public API", () => {
  it("exports the extension, tool cores, ledger, and project loader", () => {
    for (const name of [
      "createVeilExtension",
      "executeVeilDataTool",
      "executeVeilBacktestTool",
      "executeVeilMemoryTool",
      "reconstructSessionLedger",
      "loadVeilProject",
      "VEIL_DATA_TOOL",
      "VEIL_BACKTEST_TOOL",
      "VEIL_MEMORY_TOOL",
    ]) {
      expect(agentApi).toHaveProperty(name);
    }
  });
});
