import { describe, expect, it } from "vitest";
import {
  AdapterDeclarationError,
  type AdapterDeclarationErrorCode,
  deriveDataSemantics,
  hashAdapterDeclaration,
  normalizeAdapterDeclaration,
  normalizeLineageSummary,
  validateLineageClaim,
} from "../src/index.ts";

const minimalCsv = {
  dataset: "news",
  version: "1",
  entity_key: "ticker",
  event_time: "published_at",
  available_time: null,
  source: {
    type: "csv",
    locator: "data/news.csv",
  },
};

const observedCsv = {
  ...minimalCsv,
  available_time: "received_at",
  availability_basis: "observed",
  guarantees: {
    point_in_time: true,
  },
};

function captureAdapterError(
  operation: () => unknown,
  code: AdapterDeclarationErrorCode,
  path: string,
): AdapterDeclarationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterDeclarationError);
    const declarationError = error as AdapterDeclarationError;
    expect(declarationError.code).toBe(code);
    expect(declarationError.path).toBe(path);
    expect(declarationError.remedy.length).toBeGreaterThan(0);
    return declarationError;
  }
  throw new Error("expected AdapterDeclarationError");
}

describe("normalizeAdapterDeclaration", () => {
  it("normalizes a minimal non-PIT declaration to conservative defaults", () => {
    const declaration = normalizeAdapterDeclaration(minimalCsv);

    expect(declaration).toEqual({
      dataset: "news",
      version: "1",
      entityKey: "ticker",
      eventTime: "published_at",
      availableTime: null,
      availabilityBasis: null,
      frequency: null,
      guarantees: {
        pointInTime: false,
        vintage: false,
        survivorshipFree: "unknown",
        tradabilityMask: null,
      },
      provenance: {
        certified: false,
        lineageRef: null,
      },
      payloadSchema: {},
      source: {
        type: "csv",
        locator: "data/news.csv",
      },
      timeSemantics: null,
      notes: null,
    });
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.guarantees)).toBe(true);

    const semantics = deriveDataSemantics(declaration);
    expect(semantics.pitMode).toBe("event-time-fallback");
    expect(semantics.availability).toBe("unknown");
    expect(semantics.certification).toBe("uncertified");
    expect(semantics.degradations).toContain("PIT_UNSAFE");
    expect(semantics.degradations).toContain("VINTAGE_UNAVAILABLE");
    expect(semantics.obligations).toContain("FILTER_EVENT_TIME");
    expect(semantics.obligations).toContain("PROPAGATE_DEGRADATIONS");
  });

  it("requires availability provenance whenever available_time is present", () => {
    captureAdapterError(
      () =>
        normalizeAdapterDeclaration({
          ...minimalCsv,
          available_time: "received_at",
        }),
      "MISSING_FIELD",
      "$.availability_basis",
    );
  });

  it("rejects contradictory point-in-time claims", () => {
    captureAdapterError(
      () =>
        normalizeAdapterDeclaration({
          ...minimalCsv,
          guarantees: { point_in_time: true },
        }),
      "CONTRADICTORY_DECLARATION",
      "$.guarantees.point_in_time",
    );
  });

  it("rejects unknown fields with an exact field path", () => {
    captureAdapterError(
      () => normalizeAdapterDeclaration({ ...minimalCsv, availble_time: "typo" }),
      "UNKNOWN_FIELD",
      "$.availble_time",
    );
  });

  it("requires evidence for reconstructed and assumed timestamps", () => {
    captureAdapterError(
      () =>
        normalizeAdapterDeclaration({
          ...observedCsv,
          availability_basis: [{ basis: "reconstructed" }],
        }),
      "MISSING_EVIDENCE",
      "$.availability_basis[0].source",
    );

    captureAdapterError(
      () =>
        normalizeAdapterDeclaration({
          ...observedCsv,
          availability_basis: [{ basis: "assumed", lag: "P2D" }],
        }),
      "MISSING_EVIDENCE",
      "$.availability_basis[0].rationale",
    );
  });

  it("normalizes contiguous event-time segments and selects boundaries as [from, until)", () => {
    const declaration = normalizeAdapterDeclaration({
      ...observedCsv,
      availability_basis: [
        {
          until: "2026-08-07",
          basis: "reconstructed",
          source: "vendor publish_date",
        },
        { from: "2026-08-07", basis: "observed" },
      ],
    });

    expect(declaration.availabilityBasis).toEqual([
      {
        from: null,
        until: "2026-08-07T00:00:00.000Z",
        basis: "reconstructed",
        source: "vendor publish_date",
        lag: null,
        rationale: null,
      },
      {
        from: "2026-08-07T00:00:00.000Z",
        until: null,
        basis: "observed",
        source: null,
        lag: null,
        rationale: null,
      },
    ]);
    expect(deriveDataSemantics(declaration).availability).toBe("mixed");
    expect(deriveDataSemantics(declaration, "2026-08-06T23:59:59Z").availability).toBe(
      "reconstructed",
    );
    expect(deriveDataSemantics(declaration, "2026-08-07").availability).toBe("observed");
  });

  it("rejects gaps and overlaps instead of silently reordering segments", () => {
    captureAdapterError(
      () =>
        normalizeAdapterDeclaration({
          ...observedCsv,
          availability_basis: [
            { until: "2026-08-07", basis: "observed" },
            { from: "2026-08-08", basis: "observed" },
          ],
        }),
      "INVALID_SEGMENTS",
      "$.availability_basis[1].from",
    );

    captureAdapterError(
      () =>
        normalizeAdapterDeclaration({
          ...observedCsv,
          availability_basis: [
            { until: "2026-08-08", basis: "observed" },
            { from: "2026-08-07", basis: "observed" },
          ],
        }),
      "INVALID_SEGMENTS",
      "$.availability_basis[1].from",
    );
  });

  it("requires lineage for a certified declaration", () => {
    captureAdapterError(
      () =>
        normalizeAdapterDeclaration({
          ...observedCsv,
          provenance: { certified: true },
        }),
      "MISSING_EVIDENCE",
      "$.provenance.lineage_ref",
    );
  });

  it("rejects credentials embedded in the portable source locator", () => {
    captureAdapterError(
      () =>
        normalizeAdapterDeclaration({
          ...minimalCsv,
          source: {
            type: "clickhouse",
            locator: "clickhouse://user:password@example.test/market.prices",
          },
        }),
      "INLINE_SECRET",
      "$.source.locator",
    );
  });
});

describe("adapter declaration identity", () => {
  it("is independent of input key order and equivalent observed shorthand", () => {
    const first = normalizeAdapterDeclaration(observedCsv);
    const second = normalizeAdapterDeclaration({
      source: { locator: "data/news.csv", type: "csv" },
      guarantees: { point_in_time: true },
      availability_basis: [{ basis: "observed" }],
      available_time: "received_at",
      event_time: "published_at",
      entity_key: "ticker",
      version: "1",
      dataset: "news",
    });

    expect(hashAdapterDeclaration(first)).toBe(hashAdapterDeclaration(second));
    expect(hashAdapterDeclaration(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("lineage cross-validation", () => {
  const lineageHash = `sha256:${"a".repeat(64)}`;
  const lineage = normalizeLineageSummary({
    schema_version: 1,
    content_hash: lineageHash,
    first_observed_at: "2026-08-07",
    batches: [
      {
        observed_at: "2026-08-07T09:30:00Z",
        source_content_hash: `sha256:${"b".repeat(64)}`,
      },
    ],
  });

  it("accepts reconstructed history followed by genuinely observed rows", () => {
    const declaration = normalizeAdapterDeclaration({
      ...observedCsv,
      availability_basis: [
        { until: "2026-08-07", basis: "reconstructed", source: "vendor publish_date" },
        { from: "2026-08-07", basis: "observed" },
      ],
      provenance: { certified: true, lineage_ref: lineageHash },
    });

    expect(() =>
      validateLineageClaim(declaration, lineage, [
        { eventTime: "2015-03-31", availableTime: "2015-05-01" },
        { eventTime: "2026-08-08", availableTime: "2026-08-08T09:30:00Z" },
      ]),
    ).not.toThrow();
  });

  it("rejects historical availability falsely labelled as observed", () => {
    const declaration = normalizeAdapterDeclaration({
      ...observedCsv,
      provenance: { certified: true, lineage_ref: lineageHash },
    });

    captureAdapterError(
      () =>
        validateLineageClaim(declaration, lineage, [
          { eventTime: "2015-03-31", availableTime: "2015-05-01" },
        ]),
      "OBSERVED_BEFORE_LINEAGE",
      "$rows[0].availableTime",
    );
  });

  it("rejects a lineage document whose computed hash does not match the declaration", () => {
    const declaration = normalizeAdapterDeclaration({
      ...observedCsv,
      provenance: { certified: true, lineage_ref: `sha256:${"c".repeat(64)}` },
    });

    captureAdapterError(
      () => validateLineageClaim(declaration, lineage, []),
      "LINEAGE_MISMATCH",
      "$.provenance.lineage_ref",
    );
  });
});
