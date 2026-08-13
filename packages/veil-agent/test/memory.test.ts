import { describe, expect, it } from "vitest";
import {
  executeVeilMemoryTool,
  type HypothesisEntryData,
  type VEIL_HYPOTHESIS_ENTRY,
  VeilAgentError,
} from "../src/index.ts";

describe("veil-memory", () => {
  it("strictly registers once and reports branch-local Stage 3 scope", () => {
    const entries: Array<{
      readonly type: "custom";
      readonly id: string;
      readonly parentId: string | null;
      readonly timestamp: string;
      readonly customType: string;
      readonly data: unknown;
    }> = [];
    const appendEntry = (customType: typeof VEIL_HYPOTHESIS_ENTRY, data: HypothesisEntryData) => {
      entries.push({
        type: "custom",
        id: `entry-${entries.length + 1}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-08-13T00:00:01.000Z",
        customType,
        data,
      });
    };
    const context = {
      getBranch: () => entries,
      appendEntry,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    };
    const first = executeVeilMemoryTool(
      {
        action: "register_hypothesis",
        hypothesis_ref: "momentum-v1",
        statement: "Past winners outperform after a one-session lag.",
      },
      context,
    );
    const second = executeVeilMemoryTool(
      {
        action: "register_hypothesis",
        hypothesis_ref: "momentum-v1",
        statement: "Past winners outperform after a one-session lag.",
      },
      context,
    );
    const status = executeVeilMemoryTool({ action: "status" }, context);

    expect(first.result).toMatchObject({ created: true, captureMode: "explicit" });
    expect(second.result).toMatchObject({ created: false });
    expect(entries).toHaveLength(1);
    expect(status.result).toMatchObject({
      scope: "active-session-branch",
      counts: { hypotheses: 1, completedRuns: 0 },
      experimentCount: 0,
    });
    expect(JSON.stringify(status)).not.toContain("experimentId");

    expect(() =>
      executeVeilMemoryTool(
        {
          action: "register_hypothesis",
          hypothesis_ref: "momentum-v1",
          statement: "A changed statement under the same reference.",
        },
        context,
      ),
    ).toThrowError(VeilAgentError);

    expect(() => executeVeilMemoryTool({ action: "status", statement: "unused" }, context)).toThrow(
      /fields unused/,
    );

    expect(() =>
      executeVeilMemoryTool(
        {
          action: "register_hypothesis",
          hypothesis_ref: "future-v1",
          statement: "An idea from the future.",
          idea_available_at: "2026-08-14T00:00:00.000Z",
        },
        context,
      ),
    ).toThrow(/no later than registration/);
  });
});
