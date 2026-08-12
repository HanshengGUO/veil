import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { describe, expect, it } from "vitest";
import { loadAdapterFile } from "../src/index.ts";

describe("adapter YAML loading", () => {
  it("loads strict YAML through the engine I/O boundary", async () => {
    const declaration = await loadAdapterFile(new URL("fixtures/adapter.yaml", import.meta.url));

    expect(declaration).toEqual(
      normalizeAdapterDeclaration({
        dataset: "csv-prices",
        version: "1",
        entity_key: "ticker",
        event_time: "event_time",
        available_time: "available_time",
        availability_basis: "observed",
        guarantees: { point_in_time: true },
        payload_schema: { value: "float64" },
        source: { type: "csv", locator: "temporal.csv" },
      }),
    );
  });

  it("fails with a structured error when the file cannot be read", async () => {
    await expect(
      loadAdapterFile(new URL("fixtures/does-not-exist.yaml", import.meta.url)),
    ).rejects.toMatchObject({ code: "ADAPTER_LOAD_FAILED" });
  });

  it("rejects duplicate YAML keys before semantic normalization", async () => {
    await expect(
      loadAdapterFile(new URL("fixtures/duplicate-adapter.yaml", import.meta.url)),
    ).rejects.toMatchObject({ code: "ADAPTER_LOAD_FAILED" });
  });
});
