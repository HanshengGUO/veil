import { describe, expect, it } from "vitest";
import * as engineApi from "../src/index.ts";

describe("public engine API", () => {
  it("exports extension points without exporting unguarded internal capabilities", () => {
    expect(engineApi).toHaveProperty("BackendRegistry");
    expect(engineApi).toHaveProperty("DuckDbFileBackend");
    expect(engineApi).toHaveProperty("loadAdapterFile");
    expect(engineApi).toHaveProperty("ReadSetSnapshotStore");
    expect(engineApi).toHaveProperty("TemporalGuard");
    expect(engineApi).not.toHaveProperty("readRegisteredBackend");
    expect(engineApi).not.toHaveProperty("resolveSourceBinding");
  });
});
