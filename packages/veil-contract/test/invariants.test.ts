import { describe, expect, it } from "vitest";
import { ContractViolation, INVARIANT_IDS, INVARIANTS, type InvariantId } from "../src/index.ts";

describe("invariant registry", () => {
  it("declares exactly C1 through C6", () => {
    expect(INVARIANT_IDS).toEqual(["C1", "C2", "C3", "C4", "C5", "C6"]);
  });

  it("keys agree with the declared ids", () => {
    for (const [key, invariant] of Object.entries(INVARIANTS)) {
      expect(invariant.id).toBe(key);
      expect(invariant.name.length).toBeGreaterThan(0);
      expect(invariant.summary.length).toBeGreaterThan(0);
      expect(invariant.enforcedAt.length).toBeGreaterThan(0);
    }
  });

  it("never enforces an invariant during exploration", () => {
    const points = Object.values(INVARIANTS).flatMap((invariant) => invariant.enforcedAt);
    expect(points).not.toContain("exploration");
  });
});

describe("ContractViolation", () => {
  it("is an Error that carries the invariant and its detail", () => {
    const violation = new ContractViolation("C1", "read at 2021-06-01 exposed 2021-06-02 rows", {
      dataset: "prices@v1",
      asOf: "2021-06-01",
      remedy: "pass as_of and re-run",
    });

    expect(violation).toBeInstanceOf(Error);
    expect(violation.name).toBe("ContractViolation");
    expect(violation.invariant).toBe("C1");
    expect(violation.message).toContain("[C1]");
    expect(violation.detail.dataset).toBe("prices@v1");
    expect(violation.describe()).toContain("Decision-time information set");
  });

  it("defaults detail to an empty object", () => {
    const violation = new ContractViolation(
      "C5" satisfies InvariantId,
      "claim without experiment id",
    );
    expect(violation.detail).toEqual({});
  });
});
