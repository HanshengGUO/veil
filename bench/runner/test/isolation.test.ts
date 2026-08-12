import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeWorkspacePath,
  prepareWorkspaceRuntime,
  redactSensitiveValues,
  restrictPathTool,
  sanitizeChildEnvironment,
} from "../src/isolation.ts";

const directories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `veil-${label}-`));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("agent execution isolation", () => {
  it("maps sandbox paths and rejects lexical and symlink escapes", () => {
    const workspace = temporaryDirectory("workspace-path");
    const outside = temporaryDirectory("outside-path");
    mkdirSync(join(workspace, "nested"));
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(workspace, "linked"));

    expect(normalizeWorkspacePath(workspace, "nested/result.json")).toBe(
      join(workspace, "nested", "result.json"),
    );
    expect(normalizeWorkspacePath(workspace, "/workspace/nested/result.json")).toBe(
      join(workspace, "nested", "result.json"),
    );
    expect(() => normalizeWorkspacePath(workspace, "../secret.txt")).toThrow("escapes");
    expect(() => normalizeWorkspacePath(workspace, "linked/secret.txt")).toThrow("follows a link");
  });

  it("forwards a normalized path through a guarded file tool", async () => {
    const workspace = temporaryDirectory("workspace-tool");
    const execute = vi.fn(async (_id: string, input: { path: string }) => input.path);
    const tool = restrictPathTool(workspace, { name: "read", execute });

    await tool.execute("call-1", { path: "/tmp/work/result.json" });
    expect(execute).toHaveBeenCalledWith("call-1", { path: join(workspace, "result.json") });
  });

  it("removes credentials while keeping a persistent per-run home and temp", () => {
    const workspace = temporaryDirectory("workspace-env");
    const runtime = prepareWorkspaceRuntime(workspace);
    const sanitized = sanitizeChildEnvironment(
      {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "super-secret",
        GITHUB_TOKEN: "token",
        CUSTOM_ENDPOINT: "https://example.test",
        CUSTOM_CREDENTIAL: "credential",
        HTTPS_PROXY: "https://proxy.test",
      },
      runtime,
      ["CUSTOM_ENDPOINT"],
    );

    expect(sanitized).toMatchObject({
      PATH: "/usr/bin",
      HOME: runtime.home,
      TMPDIR: runtime.temporary,
      XDG_CACHE_HOME: runtime.cache,
    });
    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.GITHUB_TOKEN).toBeUndefined();
    expect(sanitized.CUSTOM_ENDPOINT).toBeUndefined();
    expect(sanitized.CUSTOM_CREDENTIAL).toBeUndefined();
    expect(sanitized.HTTPS_PROXY).toBeUndefined();
    expect(redactSensitiveValues("failed with super-secret", ["super-secret"])).toBe(
      "failed with [REDACTED]",
    );
  });
});
