import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeOwnDataInspectionError,
  inspectOwnData,
  OWN_DATA_INSPECTION_FORMAT,
  parseOwnDataInspectionArguments,
} from "../inspect.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("own-data inspection", () => {
  it("runs the documented checkout command without exposing its physical root", async () => {
    const root = resolve("examples/csv-pit");
    const report = await inspectOwnData({
      adapterPath: join(root, "adapter.yaml"),
      root,
      asOf: "2026-08-12",
      columns: ["ticker", "value"],
      previewRows: 3,
    });

    expect(report).toMatchObject({
      format: OWN_DATA_INSPECTION_FORMAT,
      ok: true,
      dataset: "example-prices",
      sourceType: "csv",
      view: {
        mode: "panel",
        grade: "exploration-grade",
        rowCount: 2,
        temporalColumn: "available_time",
      },
      guard: { mandatoryArrowGuardApplied: true, outputRows: 2 },
    });
    expect(report.preview.map((row) => row.ticker)).toEqual(["PAST", "BOUNDARY"]);
    expect(report.preview[0]?.available_time).toBe("2026-08-11T00:00:00.000Z");
    expect(report.preview.some((row) => row.ticker === "FUTURE")).toBe(false);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it("accepts the conservative quickstart adapter and preserves PIT_UNSAFE", async () => {
    const root = await mkdtemp(join(tmpdir(), "veil-own-data-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "prices.csv"),
      [
        "ticker,date,close",
        "PAST,2026-08-11T00:00:00Z,10",
        "FUTURE,2026-08-13T00:00:00Z,999",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "adapter.yaml"),
      [
        "dataset: my-prices",
        'version: "1"',
        "entity_key: ticker",
        "event_time: date",
        "available_time: null",
        "payload_schema:",
        "  close: float64",
        "source:",
        "  type: csv",
        "  locator: prices.csv",
        "",
      ].join("\n"),
    );

    const report = await inspectOwnData({
      adapterPath: join(root, "adapter.yaml"),
      root,
      asOf: "2026-08-12",
      columns: ["close"],
      previewRows: 2,
    });

    expect(report.view).toMatchObject({ rowCount: 1, temporalColumn: "date" });
    expect(report.preview.map((row) => row.ticker)).toEqual(["PAST"]);
    expect(report.semantics.degradations).toContain("PIT_UNSAFE");
    expect(report.semantics.obligations).toContain("FILTER_EVENT_TIME");
  });

  it("keeps CLI errors actionable and path-free", () => {
    expect(
      parseOwnDataInspectionArguments([
        "--adapter",
        "adapter.yaml",
        "--root",
        ".",
        "--as-of",
        "2026-08-12",
        "--columns",
        "ticker, value,ticker",
        "--preview",
        "2",
      ]),
    ).toEqual({
      adapterPath: "adapter.yaml",
      root: ".",
      asOf: "2026-08-12",
      columns: ["ticker", "value"],
      previewRows: 2,
    });

    let failure: unknown;
    try {
      parseOwnDataInspectionArguments(["--adapter", "/private/adapter.yaml"]);
    } catch (error) {
      failure = describeOwnDataInspectionError(error);
    }
    expect(failure).toMatchObject({ ok: false, code: "INVALID_QUERY" });
    expect(JSON.stringify(failure)).not.toContain("/private/adapter.yaml");
  });
});
