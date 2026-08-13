import { normalizeAdapterDeclaration } from "@veilquant/contract";
import {
  Table,
  tableFromArrays,
  tableFromIPC,
  tableToIPC,
  Utf8,
  vectorFromArray,
} from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  BackendRegistry,
  COMPOSITE_SOURCE_JOIN_VERSION,
  COMPOSITE_SOURCE_MANIFEST_FORMAT,
  CompositeSourceBackend,
  type CompositeSourceComponentEvidence,
  createCompositeSource,
  createCompositeSourceManifest,
  createSourceBinding,
  EngineConfigurationError,
  type TemporalBackend,
  TemporalGuard,
  verifyCompositeSource,
  verifyReadSetManifest,
} from "../src/index.ts";

const COMPONENT_BACKEND_ID = "composite-component-memory";
const COMPONENT_AS_OF = "2026-01-04T00:00:00.000Z";

const primaryDeclaration = normalizeAdapterDeclaration({
  dataset: "composite-prices",
  version: "2026-01-04",
  entity_key: "ticker",
  event_time: "date",
  available_time: "price_available_at",
  availability_basis: "observed",
  guarantees: { point_in_time: true, tradability_mask: "tradable" },
  payload_schema: { close: "float64", tradable: "bool" },
  source: { type: "custom", locator: "memory/prices" },
});

const membershipDeclaration = normalizeAdapterDeclaration({
  dataset: "composite-membership",
  version: "2026-01-04",
  entity_key: "ticker",
  event_time: "date",
  available_time: "membership_available_at",
  availability_basis: "observed",
  guarantees: { point_in_time: true, survivorship_free: true },
  payload_schema: { in_universe: "bool" },
  source: { type: "custom", locator: "memory/membership" },
});

const outputDeclaration = normalizeAdapterDeclaration({
  dataset: "composite-research-panel",
  version: "2026-01-04",
  entity_key: "ticker",
  event_time: "date",
  available_time: "eligible_at",
  availability_basis: {
    basis: "reconstructed",
    source: "veil.composite-source-manifest.v0",
  },
  guarantees: {
    point_in_time: true,
    survivorship_free: true,
    tradability_mask: "eligible",
  },
  payload_schema: {
    close: "float64",
    tradable: "bool",
    in_universe: "bool",
    eligible: "bool",
  },
  source: { type: "custom", locator: "composite/research-panel" },
});

function normalPrimary(): Table {
  return tableFromArrays({
    ticker: ["A", "B", "A", "B"],
    date: [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ],
    price_available_at: [
      "2026-01-01T08:00:00.000Z",
      "2026-01-01T08:00:00.000Z",
      "2026-01-02T08:00:00.000Z",
      "2026-01-02T08:00:00.000Z",
    ],
    tradable: [true, false, true, true],
    close: [10, 20, 11, 19],
  });
}

function normalMembership(): Table {
  return tableFromArrays({
    ticker: ["A", "B", "A", "B", "C"],
    date: [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ],
    membership_available_at: [
      "2026-01-01T09:00:00.000Z",
      "2026-01-01T09:00:00.000Z",
      "2026-01-03T09:00:00.000Z",
      "2026-01-02T09:00:00.000Z",
      "2026-01-01T09:00:00.000Z",
    ],
    in_universe: [true, true, true, false, true],
  });
}

async function components(
  primaryTable: Table = normalPrimary(),
  membershipTable: Table = normalMembership(),
): Promise<{
  primary: CompositeSourceComponentEvidence;
  membership: CompositeSourceComponentEvidence;
}> {
  const tables = new Map([
    [primaryDeclaration.source.locator, primaryTable],
    [membershipDeclaration.source.locator, membershipTable],
  ]);
  const backend: TemporalBackend = {
    id: COMPONENT_BACKEND_ID,
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: false,
      sourceFingerprint: "content-hash",
      readOnly: true,
    },
    accepts: (source) => tables.has(source.locator),
    read: async (request) => {
      const table = tables.get(request.source.locator);
      if (table === undefined) throw new Error("missing fixture table");
      return {
        arrowIpc: tableToIPC(table, "stream"),
        sourceFingerprint: {
          algorithm: "sha256",
          value:
            request.source.locator === primaryDeclaration.source.locator
              ? "a".repeat(64)
              : "b".repeat(64),
          scope: "source-version",
        },
        runtime: { name: "memory", version: "test-v1" },
        pushdown: { projectionApplied: false, temporalPredicateApplied: false },
      };
    },
  };
  const registry = new BackendRegistry();
  registry.register(backend);
  const guard = new TemporalGuard(registry);
  const binding = createSourceBinding({ id: "composite-components", backend: backend.id });
  const [primary, membership] = await Promise.all([
    guard.read(primaryDeclaration, { asOf: COMPONENT_AS_OF }, binding),
    guard.read(membershipDeclaration, { asOf: COMPONENT_AS_OF }, binding),
  ]);
  return {
    primary: {
      declaration: primaryDeclaration,
      readSet: primary.readSet,
      arrowIpc: primary.arrowIpc,
    },
    membership: {
      declaration: membershipDeclaration,
      readSet: membership.readSet,
      arrowIpc: membership.arrowIpc,
    },
  };
}

function createInput(evidence: Awaited<ReturnType<typeof components>>) {
  return {
    ...evidence,
    outputDeclaration,
    membershipColumn: "in_universe",
    outputAvailableTimeColumn: "eligible_at",
    outputMembershipColumn: "in_universe",
    outputMaskColumn: "eligible",
  } as const;
}

describe("guarded composite source evidence", () => {
  it("replays availability and eligibility before returning through the outer guard", async () => {
    const evidence = await components();
    const input = createInput(evidence);
    const snapshot = createCompositeSource(input);
    const table = tableFromIPC(snapshot.arrowIpc);

    expect(snapshot.manifest.format).toBe(COMPOSITE_SOURCE_MANIFEST_FORMAT);
    expect(snapshot.manifest.join.version).toBe(COMPOSITE_SOURCE_JOIN_VERSION);
    expect(snapshot.manifest.audit).toEqual({
      primaryRows: 4,
      membershipRows: 5,
      matchedRows: 4,
      eligibleRows: 2,
      droppedByPrimaryMask: 1,
      droppedByMembership: 1,
      unusedMembershipRows: 1,
    });
    expect(table.getChild("eligible")?.toArray()).toEqual([true, false, true, false]);
    expect(table.getChild("in_universe")?.toArray()).toEqual([true, true, true, false]);
    expect(new Date(Number(table.getChild("eligible_at")?.get(2))).toISOString()).toBe(
      "2026-01-03T09:00:00.000Z",
    );
    expect(snapshot.sourceFingerprint).toMatchObject({
      algorithm: "sha256",
      scope: "read-snapshot",
      evidence: { format: COMPOSITE_SOURCE_MANIFEST_FORMAT },
    });

    expect(
      verifyCompositeSource(snapshot.manifest, {
        ...input,
        arrowIpc: snapshot.arrowIpc,
        expectedManifestHash: snapshot.manifest.manifestHash,
      }),
    ).toEqual(snapshot.manifest);

    const registry = new BackendRegistry();
    registry.register(new CompositeSourceBackend({ snapshot, declaration: outputDeclaration }));
    const guarded = await new TemporalGuard(registry).read(
      outputDeclaration,
      { asOf: "2026-01-02T12:00:00.000Z" },
      createSourceBinding({ id: "composite-output", backend: "composite-source" }),
    );
    const guardedTable = tableFromIPC(guarded.arrowIpc);
    expect(guardedTable.numRows).toBe(3);
    expect(guarded.audit.droppedFutureRows).toBe(0);
    expect(guarded.audit.backendClaimedTemporalPushdown).toBe(true);
    expect(guardedTable.getChild("eligible")?.toArray()).toEqual([true, false, false]);
    expect(
      verifyReadSetManifest(guarded.readSet, {
        arrowIpc: guarded.arrowIpc,
        declaration: outputDeclaration,
        sourceFingerprint: guarded.sourceFingerprint,
      }),
    ).toEqual(guarded.readSet);
  });

  it("fails closed on missing, duplicate, or non-boolean membership evidence", async () => {
    const missing = normalMembership().slice(0, 3);
    const missingEvidence = await components(normalPrimary(), missing);
    expect(() => createCompositeSource(createInput(missingEvidence))).toThrow(
      /does not cover every primary/i,
    );

    const duplicate = tableFromArrays({
      ticker: ["A", "B", "A", "B", "A"],
      date: [
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
      membership_available_at: Array.from({ length: 5 }, () => "2026-01-01T09:00:00.000Z"),
      in_universe: [true, true, true, false, true],
    });
    const duplicateEvidence = await components(normalPrimary(), duplicate);
    expect(() => createCompositeSource(createInput(duplicateEvidence))).toThrow(
      /duplicate entity\/event key/i,
    );

    const nonBoolean = new Table({
      ticker: vectorFromArray(["A", "B", "A", "B"], new Utf8()),
      date: vectorFromArray(
        [
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
        ],
        new Utf8(),
      ),
      membership_available_at: vectorFromArray(
        Array.from({ length: 4 }, () => "2026-01-01T09:00:00.000Z"),
        new Utf8(),
      ),
      in_universe: vectorFromArray(["true", "true", "true", "false"], new Utf8()),
    });
    const nonBooleanEvidence = await components(normalPrimary(), nonBoolean);
    expect(() => createCompositeSource(createInput(nonBooleanEvidence))).toThrow(/non-boolean/i);
  });

  it("rejects validly rehashed audit claims and replaced snapshot bytes", async () => {
    const evidence = await components();
    const input = createInput(evidence);
    const snapshot = createCompositeSource(input);
    const forged = createCompositeSourceManifest({
      output: snapshot.manifest.output,
      primary: snapshot.manifest.primary,
      membership: snapshot.manifest.membership,
      join: snapshot.manifest.join,
      audit: {
        ...snapshot.manifest.audit,
        eligibleRows: 1,
        droppedByMembership: 2,
      },
      result: snapshot.manifest.result,
    });
    expect(() => verifyCompositeSource(forged, { ...input, arrowIpc: snapshot.arrowIpc })).toThrow(
      /does not match the replayed component evidence/i,
    );

    const replacedArrow = tableToIPC(tableFromIPC(snapshot.arrowIpc).slice(0, 1), "stream");
    expect(
      () =>
        new CompositeSourceBackend({
          snapshot: { ...snapshot, arrowIpc: replacedArrow },
          declaration: outputDeclaration,
        }),
    ).toThrowError(EngineConfigurationError);
  });
});
