import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  BackendRegistry,
  createSourceBinding,
  createWalkForwardPlan,
  createWindowReadSet,
  type TemporalBackend,
  TemporalGuard,
  verifyWindowReadSetManifest,
  WINDOW_READ_SET_FILTER_VERSION,
  WINDOW_READ_SET_FORMAT,
} from "../src/index.ts";

const BACKEND_ID = "window-memory";

function declaration() {
  return normalizeAdapterDeclaration({
    dataset: "window-prices",
    version: "2026-08-12",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true },
    payload_schema: { value: "float64" },
    source: { type: "custom", locator: "window-source" },
  });
}

function plan(mode: "rolling" | "expanding" = "rolling") {
  return createWalkForwardPlan({
    protocol: {
      mode,
      folds: 2,
      trainDays: 3,
      oosDays: 1,
      purgeDays: 1,
      embargoDays: 1,
      holdDays: 1,
      executionLagDays: 1,
    },
    decisionSchedule: Array.from({ length: 7 }, (_, index) =>
      new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    ),
  });
}

function sourceTable(eventTimes?: readonly string[]) {
  const times = eventTimes ?? [
    "2025-12-31T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
    "2026-01-03T00:00:00.000Z",
    "2026-01-04T00:00:00.000Z",
  ];
  return tableFromArrays({
    ticker: times.map(() => "AAA"),
    event_time: times,
    // The last event is already available by Jan 3; the derived event-time window must remove it.
    available_time: times.map((_, index) =>
      index === times.length - 1 ? "2026-01-03T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
    ),
    value: times.map((_, index) => index + 1),
  });
}

function guardFor(table = sourceTable()): TemporalGuard {
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
        value: "window-fixture-v1",
        scope: "source-version",
      },
      runtime: { name: "memory", version: "test-v1" },
      pushdown: { projectionApplied: false, temporalPredicateApplied: false },
    }),
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  return new TemporalGuard(registry);
}

function binding() {
  return createSourceBinding({ id: "window-source", backend: BACKEND_ID });
}

describe("derived window read-set v0", () => {
  it("replays an exact rolling training slice from guarded source evidence", async () => {
    const adapter = declaration();
    const topology = plan();
    const source = await guardFor().read(
      adapter,
      { asOf: topology.folds[0]?.train.lastDecisionTime ?? "" },
      binding(),
    );
    const window = createWindowReadSet({
      sourceReadSet: source.readSet,
      sourceArrowIpc: source.arrowIpc,
      declaration: adapter,
      plan: topology,
      foldIndex: 0,
    });

    expect(window.manifest.format).toBe(WINDOW_READ_SET_FORMAT);
    expect(window.manifest.filterVersion).toBe(WINDOW_READ_SET_FILTER_VERSION);
    expect(window.manifest.sourceReadSetId).toBe(source.readSet.manifestHash);
    expect(window.manifest.planHash).toBe(topology.planHash);
    expect(window.manifest.result.rowCount).toBe(3);
    expect(window.manifest.range).toEqual(topology.folds[0]?.train);
    expect(window.manifest.windowHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(tableFromIPC(window.arrowIpc).getChild("event_time")?.toArray()).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);

    const verified = verifyWindowReadSetManifest(JSON.parse(JSON.stringify(window.manifest)), {
      sourceReadSet: source.readSet,
      sourceArrowIpc: source.arrowIpc,
      declaration: adapter,
      plan: topology,
      foldIndex: 0,
      arrowIpc: window.arrowIpc,
      expectedWindowHash: window.manifest.windowHash,
    });
    expect(verified).toEqual(window.manifest);
    expect(Object.isFrozen(verified.range)).toBe(true);
  });

  it("makes rolling and expanding folds derive different row identities", async () => {
    const adapter = declaration();
    const rolling = plan("rolling");
    const expanding = plan("expanding");
    const source = await guardFor().read(
      adapter,
      { asOf: rolling.folds[1]?.train.lastDecisionTime ?? "" },
      binding(),
    );
    const rollingWindow = createWindowReadSet({
      sourceReadSet: source.readSet,
      sourceArrowIpc: source.arrowIpc,
      declaration: adapter,
      plan: rolling,
      foldIndex: 1,
    });
    const expandingWindow = createWindowReadSet({
      sourceReadSet: source.readSet,
      sourceArrowIpc: source.arrowIpc,
      declaration: adapter,
      plan: expanding,
      foldIndex: 1,
    });

    expect(rollingWindow.manifest.result.rowCount).toBe(3);
    expect(expandingWindow.manifest.result.rowCount).toBe(4);
    expect(rollingWindow.manifest.result.resultHash).not.toBe(
      expandingWindow.manifest.result.resultHash,
    );
    expect(rollingWindow.manifest.windowHash).not.toBe(expandingWindow.manifest.windowHash);
  });

  it("rejects omitted event time, invalid event values, and a source read at the wrong cutoff", async () => {
    const adapter = declaration();
    const topology = plan();
    const cutoff = topology.folds[0]?.train.lastDecisionTime ?? "";
    const projected = await guardFor().read(
      adapter,
      { asOf: cutoff, columns: ["ticker", "value"] },
      binding(),
    );
    expect(() =>
      createWindowReadSet({
        sourceReadSet: projected.readSet,
        sourceArrowIpc: projected.arrowIpc,
        declaration: adapter,
        plan: topology,
        foldIndex: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WINDOW_READ_SET" }));

    const invalidTable = tableFromArrays({
      ticker: ["AAA"],
      event_time: ["not-a-time"],
      available_time: ["2026-01-01T00:00:00.000Z"],
      value: [1],
    });
    const invalidSource = await guardFor(invalidTable).read(adapter, { asOf: cutoff }, binding());
    expect(() =>
      createWindowReadSet({
        sourceReadSet: invalidSource.readSet,
        sourceArrowIpc: invalidSource.arrowIpc,
        declaration: adapter,
        plan: topology,
        foldIndex: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WINDOW_READ_SET" }));

    const wrongCutoff = await guardFor().read(
      adapter,
      { asOf: topology.folds[1]?.train.lastDecisionTime ?? "" },
      binding(),
    );
    expect(() =>
      createWindowReadSet({
        sourceReadSet: wrongCutoff.readSet,
        sourceArrowIpc: wrongCutoff.arrowIpc,
        declaration: adapter,
        plan: topology,
        foldIndex: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WINDOW_READ_SET" }));
  });

  it("rejects manifest, fold, source, and derived Arrow substitution", async () => {
    const adapter = declaration();
    const topology = plan();
    const source = await guardFor().read(
      adapter,
      { asOf: topology.folds[0]?.train.lastDecisionTime ?? "" },
      binding(),
    );
    const window = createWindowReadSet({
      sourceReadSet: source.readSet,
      sourceArrowIpc: source.arrowIpc,
      declaration: adapter,
      plan: topology,
      foldIndex: 0,
    });
    const evidence = {
      sourceReadSet: source.readSet,
      sourceArrowIpc: source.arrowIpc,
      declaration: adapter,
      plan: topology,
      foldIndex: 0,
      arrowIpc: window.arrowIpc,
    };
    const tampered = JSON.parse(JSON.stringify(window.manifest)) as { foldIndex: number };
    tampered.foldIndex = 1;
    expect(() => verifyWindowReadSetManifest(tampered, evidence)).toThrowError(
      expect.objectContaining({ code: "INVALID_WINDOW_READ_SET" }),
    );
    expect(() =>
      verifyWindowReadSetManifest(window.manifest, { ...evidence, foldIndex: 1 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_WINDOW_READ_SET" }));
    expect(() =>
      verifyWindowReadSetManifest(window.manifest, {
        ...evidence,
        sourceArrowIpc: window.arrowIpc,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_READ_SET" }));

    const shortened = tableFromIPC(window.arrowIpc).slice(0, 1);
    expect(() =>
      verifyWindowReadSetManifest(window.manifest, {
        ...evidence,
        arrowIpc: tableToIPC(shortened, "stream"),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_READ_SET" }));
  });
});
