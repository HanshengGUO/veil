import { describe, expect, it } from "vitest";
import type { ArtifactProtocol } from "../src/index.ts";
import {
  createWalkForwardPlan,
  verifyWalkForwardPlan,
  WALK_FORWARD_PLAN_FORMAT,
} from "../src/index.ts";

function protocol(mode: "rolling" | "expanding" = "rolling"): ArtifactProtocol {
  return {
    mode,
    folds: 3,
    trainDays: 4,
    oosDays: 2,
    purgeDays: 1,
    embargoDays: 1,
    holdDays: 1,
  };
}

function schedule(length = 12): string[] {
  return Array.from({ length }, (_, index) => {
    const instant = new Date(Date.UTC(2026, 0, index + 1));
    return instant.toISOString();
  });
}

describe("walk-forward window planner", () => {
  it("builds deterministic rolling folds with explicit purge, embargo, and contiguous OOS blocks", () => {
    const plan = createWalkForwardPlan({ protocol: protocol(), decisionSchedule: schedule() });

    expect(plan.format).toBe(WALK_FORWARD_PLAN_FORMAT);
    expect(plan.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      plan.folds.map((fold) => ({
        train: [fold.train.startIndex, fold.train.endIndexExclusive],
        purge: [fold.purge.startIndex, fold.purge.endIndexExclusive],
        embargo: [fold.embargo.startIndex, fold.embargo.endIndexExclusive],
        oos: [fold.outOfSample.startIndex, fold.outOfSample.endIndexExclusive],
      })),
    ).toEqual([
      { train: [0, 4], purge: [4, 5], embargo: [5, 6], oos: [6, 8] },
      { train: [2, 6], purge: [6, 7], embargo: [7, 8], oos: [8, 10] },
      { train: [4, 8], purge: [8, 9], embargo: [9, 10], oos: [10, 12] },
    ]);
    expect(plan.folds[0]?.train.sessionCount).toBe(4);
    expect(plan.folds[0]?.train.firstDecisionTime).toBe("2026-01-01T00:00:00.000Z");
    expect(plan.folds[2]?.outOfSample.lastDecisionTime).toBe("2026-01-12T00:00:00.000Z");
    expect(Object.isFrozen(plan.folds[0]?.train)).toBe(true);
    expect(verifyWalkForwardPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it("expands only the training start while preserving all other fold boundaries", () => {
    const rolling = createWalkForwardPlan({
      protocol: protocol("rolling"),
      decisionSchedule: schedule(),
    });
    const expanding = createWalkForwardPlan({
      protocol: protocol("expanding"),
      decisionSchedule: schedule(),
    });

    expect(expanding.folds.map((fold) => fold.train.startIndex)).toEqual([0, 0, 0]);
    expect(expanding.folds.map((fold) => fold.train.endIndexExclusive)).toEqual([4, 6, 8]);
    expect(expanding.folds.map((fold) => fold.outOfSample)).toEqual(
      rolling.folds.map((fold) => fold.outOfSample),
    );
    expect(expanding.planHash).not.toBe(rolling.planHash);
  });

  it("normalizes creation input but requires serialized evidence to already be canonical", () => {
    const dates = schedule().map((instant) => instant.slice(0, 10));
    const plan = createWalkForwardPlan({ protocol: protocol(), decisionSchedule: dates });
    expect(plan.decisionSchedule[0]).toBe("2026-01-01T00:00:00.000Z");

    const serialized = JSON.parse(JSON.stringify(plan)) as { decisionSchedule: string[] };
    serialized.decisionSchedule[0] = "2026-01-01";
    expect(() => verifyWalkForwardPlan(serialized)).toThrowError(
      expect.objectContaining({ code: "INVALID_WALK_FORWARD_PLAN" }),
    );
  });

  it("rejects schedule ambiguity, unsafe gaps, and tampered serialized folds", () => {
    expect(() =>
      createWalkForwardPlan({ protocol: protocol(), decisionSchedule: schedule(11) }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WALK_FORWARD_PLAN" }));

    const duplicate = schedule();
    duplicate[5] = duplicate[4] ?? "";
    expect(() =>
      createWalkForwardPlan({ protocol: protocol(), decisionSchedule: duplicate }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WALK_FORWARD_PLAN" }));

    const outOfOrder = schedule();
    [outOfOrder[4], outOfOrder[5]] = [outOfOrder[5] ?? "", outOfOrder[4] ?? ""];
    expect(() =>
      createWalkForwardPlan({ protocol: protocol(), decisionSchedule: outOfOrder }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WALK_FORWARD_PLAN" }));

    expect(() =>
      createWalkForwardPlan({
        protocol: { ...protocol(), purgeDays: 0 },
        decisionSchedule: schedule(11),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WALK_FORWARD_PLAN" }));

    const plan = createWalkForwardPlan({ protocol: protocol(), decisionSchedule: schedule() });
    const tampered = JSON.parse(JSON.stringify(plan)) as {
      folds: Array<{ train: { startIndex: number } }>;
    };
    const first = tampered.folds[0];
    if (first === undefined) throw new Error("test fold missing");
    first.train.startIndex = 1;
    expect(() => verifyWalkForwardPlan(tampered)).toThrowError(
      expect.objectContaining({ code: "INVALID_WALK_FORWARD_PLAN" }),
    );
    expect(() =>
      verifyWalkForwardPlan(plan, { expectedPlanHash: `sha256:${"0".repeat(64)}` }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WALK_FORWARD_PLAN" }));
  });
});
