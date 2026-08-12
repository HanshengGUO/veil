import { describe, expect, it } from "vitest";
import { safeEventJson } from "../src/pi-session.ts";

describe("Pi session event capture", () => {
  it("keeps streaming deltas without cumulative message snapshots", () => {
    const event = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "next token",
        partial: { content: "the complete response so far" },
      },
      message: { content: "the complete response so far" },
    };

    expect(JSON.parse(safeEventJson(event as never))).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "next token",
      },
    });
  });
});
