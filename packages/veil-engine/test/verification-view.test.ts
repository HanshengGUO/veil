import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { type Table, tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  BackendRegistry,
  createSourceBinding,
  createVerificationView,
  createWalkForwardPlan,
  type TemporalBackend,
  TemporalGuard,
  VERIFICATION_VIEW_FILTER_VERSION,
  VERIFICATION_VIEW_FORMAT,
  verifyVerificationView,
} from "../src/index.ts";

const BACKEND_ID = "verification-view-memory";
const schedule = Array.from({ length: 7 }, (_, index) =>
  new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
);

function declaration(mask: string | null = "tradable") {
  return normalizeAdapterDeclaration({
    dataset: "verification-prices",
    version: "2026-08-12",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true, tradability_mask: mask },
    payload_schema: { value: "float64" },
    source: { type: "custom", locator: "logical/verification-prices" },
  });
}

function plan() {
  return createWalkForwardPlan({
    protocol: {
      mode: "rolling",
      folds: 2,
      trainDays: 3,
      oosDays: 1,
      purgeDays: 1,
      embargoDays: 1,
      holdDays: 1,
    },
    decisionSchedule: schedule,
  });
}

function sourceTable(maskValues?: readonly (boolean | null)[]) {
  const eventTime = schedule.flatMap((time) => [time, time]);
  return tableFromArrays({
    ticker: schedule.flatMap(() => ["AAA", "BBB"]),
    event_time: eventTime,
    // Future event rows are intentionally known early; the event-history bound must still remove them.
    available_time: eventTime.map(() => schedule[0]),
    tradable: maskValues ?? schedule.flatMap((_, index) => [true, index !== 1 && index !== 5]),
    value: eventTime.map((_, index) => index + 1),
  });
}

function harness(table: Table = sourceTable()) {
  const backend: TemporalBackend = {
    id: BACKEND_ID,
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: false,
      sourceFingerprint: "content-hash",
      readOnly: true,
    },
    accepts: (source) => source.type === "custom",
    read: async () => ({
      arrowIpc: tableToIPC(table, "stream"),
      sourceFingerprint: {
        algorithm: "sha256",
        value: "verification-view-fixture-v1",
        scope: "source-version",
      },
      runtime: { name: "memory", version: "test-v1" },
      pushdown: { projectionApplied: false, temporalPredicateApplied: false },
    }),
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  return {
    guard: new TemporalGuard(registry),
    binding: createSourceBinding({ id: "verification-view", backend: BACKEND_ID }),
  };
}

describe("mask-first verification views", () => {
  it("replays bounded train and per-decision OOS histories before factor execution", async () => {
    const adapter = declaration();
    const topology = plan();
    const source = harness();
    const trainRead = await source.guard.read(adapter, { asOf: schedule[2] ?? "" }, source.binding);
    const train = createVerificationView({
      sourceReadSet: trainRead.readSet,
      sourceArrowIpc: trainRead.arrowIpc,
      declaration: adapter,
      plan: topology,
      foldIndex: 0,
      role: "train",
      decisionIndex: 2,
    });

    expect(train.manifest.format).toBe(VERIFICATION_VIEW_FORMAT);
    expect(train.manifest.filterVersion).toBe(VERIFICATION_VIEW_FILTER_VERSION);
    expect(train.manifest.audit).toEqual({
      sourceRows: 14,
      historyRows: 6,
      droppedOutsideHistoryRows: 8,
      droppedUntradableRows: 1,
      outputRows: 5,
      decisionRows: 2,
    });
    expect(tableFromIPC(train.arrowIpc).getChild("event_time")?.toArray()).toEqual([
      schedule[0],
      schedule[0],
      schedule[1],
      schedule[2],
      schedule[2],
    ]);

    const oosRead = await source.guard.read(adapter, { asOf: schedule[5] ?? "" }, source.binding);
    const oos = createVerificationView({
      sourceReadSet: oosRead.readSet,
      sourceArrowIpc: oosRead.arrowIpc,
      declaration: adapter,
      plan: topology,
      foldIndex: 0,
      role: "out-of-sample",
      decisionIndex: 5,
    });
    expect(oos.manifest.history).toEqual({
      startIndex: 0,
      endIndexExclusive: 6,
      firstDecisionTime: schedule[0],
      lastDecisionTime: schedule[5],
      sessionCount: 6,
    });
    expect(oos.manifest.audit).toEqual({
      sourceRows: 14,
      historyRows: 12,
      droppedOutsideHistoryRows: 2,
      droppedUntradableRows: 2,
      outputRows: 10,
      decisionRows: 1,
    });
    expect(
      verifyVerificationView(JSON.parse(JSON.stringify(oos.manifest)), {
        sourceReadSet: oosRead.readSet,
        sourceArrowIpc: oosRead.arrowIpc,
        declaration: adapter,
        plan: topology,
        foldIndex: 0,
        role: "out-of-sample",
        decisionIndex: 5,
        arrowIpc: oos.arrowIpc,
        expectedViewHash: oos.manifest.viewHash,
      }),
    ).toEqual(oos.manifest);
  });

  it("fails C4 for a missing declaration or non-boolean in-window mask", async () => {
    const unmasked = declaration(null);
    const adapter = declaration();
    const topology = plan();
    const noMaskSource = harness();
    const noMaskRead = await noMaskSource.guard.read(
      unmasked,
      { asOf: schedule[2] ?? "" },
      noMaskSource.binding,
    );
    expect(() =>
      createVerificationView({
        sourceReadSet: noMaskRead.readSet,
        sourceArrowIpc: noMaskRead.arrowIpc,
        declaration: unmasked,
        plan: topology,
        foldIndex: 0,
        role: "train",
        decisionIndex: 2,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C4" }));

    const nullEntity = tableFromArrays({
      ticker: [null],
      event_time: [schedule[0]],
      available_time: [schedule[0]],
      tradable: [true],
      value: [1],
    });
    const nullEntitySource = harness(nullEntity);
    const nullEntityRead = await nullEntitySource.guard.read(
      adapter,
      { asOf: schedule[2] ?? "" },
      nullEntitySource.binding,
    );
    expect(() =>
      createVerificationView({
        sourceReadSet: nullEntityRead.readSet,
        sourceArrowIpc: nullEntityRead.arrowIpc,
        declaration: adapter,
        plan: topology,
        foldIndex: 0,
        role: "train",
        decisionIndex: 2,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C4" }));

    const values = schedule.flatMap((_, index) => [true, index === 1 ? null : true]);
    const invalidSource = harness(sourceTable(values));
    const invalidRead = await invalidSource.guard.read(
      adapter,
      { asOf: schedule[2] ?? "" },
      invalidSource.binding,
    );
    expect(() =>
      createVerificationView({
        sourceReadSet: invalidRead.readSet,
        sourceArrowIpc: invalidRead.arrowIpc,
        declaration: adapter,
        plan: topology,
        foldIndex: 0,
        role: "train",
        decisionIndex: 2,
      }),
    ).toThrowError(expect.objectContaining({ invariant: "C4" }));
  });

  it("rejects wrong decision roles, manifest tampering, and derived Arrow substitution", async () => {
    const adapter = declaration();
    const topology = plan();
    const source = harness();
    const read = await source.guard.read(adapter, { asOf: schedule[5] ?? "" }, source.binding);
    expect(() =>
      createVerificationView({
        sourceReadSet: read.readSet,
        sourceArrowIpc: read.arrowIpc,
        declaration: adapter,
        plan: topology,
        foldIndex: 0,
        role: "train",
        decisionIndex: 5,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_VERIFICATION_VIEW" }));

    const view = createVerificationView({
      sourceReadSet: read.readSet,
      sourceArrowIpc: read.arrowIpc,
      declaration: adapter,
      plan: topology,
      foldIndex: 0,
      role: "out-of-sample",
      decisionIndex: 5,
    });
    const evidence = {
      sourceReadSet: read.readSet,
      sourceArrowIpc: read.arrowIpc,
      declaration: adapter,
      plan: topology,
      foldIndex: 0,
      role: "out-of-sample" as const,
      decisionIndex: 5,
      arrowIpc: view.arrowIpc,
    };
    const tampered = JSON.parse(JSON.stringify(view.manifest)) as { decisionIndex: number };
    tampered.decisionIndex = 6;
    expect(() => verifyVerificationView(tampered, evidence)).toThrowError(
      expect.objectContaining({ code: "INVALID_VERIFICATION_VIEW" }),
    );
    expect(() =>
      verifyVerificationView(view.manifest, {
        ...evidence,
        arrowIpc: tableToIPC(tableFromIPC(view.arrowIpc).slice(0, 1), "stream"),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_READ_SET" }));
  });
});
