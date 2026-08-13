import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/storage.ts";

describe("portable agent storage", () => {
  it("canonicalizes prototype-shaped keys as ordinary evidence fields", () => {
    const input = JSON.parse('{"value":1,"__proto__":{"polluted":true}}') as unknown;

    expect(canonicalJson(input)).toBe('{"__proto__":{"polluted":true},"value":1}');
    expect(({} as { readonly polluted?: unknown }).polluted).toBeUndefined();
  });
});
