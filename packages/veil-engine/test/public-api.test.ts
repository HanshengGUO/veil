import { describe, expect, it } from "vitest";
import * as engineApi from "../src/index.ts";

describe("public engine API", () => {
  it("exports extension points without exporting unguarded internal capabilities", () => {
    expect(engineApi).toHaveProperty("BackendRegistry");
    expect(engineApi).toHaveProperty("ArtifactRuntimeRegistry");
    expect(engineApi).toHaveProperty("captureArtifactCode");
    expect(engineApi).toHaveProperty("createArtifactManifest");
    expect(engineApi).toHaveProperty("createArtifactRuntimeProvider");
    expect(engineApi).toHaveProperty("createSourceManifest");
    expect(engineApi).toHaveProperty("DuckDbFileBackend");
    expect(engineApi).toHaveProperty("executeArtifact");
    expect(engineApi).toHaveProperty("loadAdapterFile");
    expect(engineApi).toHaveProperty("ReadSetSnapshotStore");
    expect(engineApi).toHaveProperty("ReadSetSnapshotRecovery");
    expect(engineApi).toHaveProperty("openReadSetSnapshotRecovery");
    expect(engineApi).toHaveProperty("runVeilDataCli");
    expect(engineApi).toHaveProperty("VeilDataService");
    expect(engineApi).toHaveProperty("verifySourceManifest");
    expect(engineApi).toHaveProperty("verifyArtifactCode");
    expect(engineApi).toHaveProperty("verifyArtifactManifest");
    expect(engineApi).toHaveProperty("TemporalGuard");
    expect(engineApi).not.toHaveProperty("readRegisteredBackend");
    expect(engineApi).not.toHaveProperty("resolveSourceBinding");
    expect(engineApi).not.toHaveProperty("selectArtifactRuntimeProvider");
  });
});
