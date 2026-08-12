import { describe, expect, it } from "vitest";
import { probeNativeRuntime } from "../src/runtime-smoke.ts";

describe("native runtime", () => {
  it("loads DuckDB LTS, executes a query, and round-trips Arrow IPC", async () => {
    const report = await probeNativeRuntime();

    expect(report.duckdbVersion.length).toBeGreaterThan(0);
    expect(report.duckdbRows).toBe(1);
    expect(report.arrowRows).toBe(2);
    expect(report.arrowIpcBytes).toBeGreaterThan(0);
  });
});
