import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tableFromIPC } from "apache-arrow";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DataReadEntryData,
  executeVeilDataTool,
  loadVeilProject,
  VEIL_DATA_READ_ENTRY,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("default agent project and veil-data", () => {
  it("keeps the private root out of output while exporting only guarded Arrow", async () => {
    const root = await projectFixture();
    const project = await loadVeilProject(root);
    const entries: DataReadEntryData[] = [];
    const result = await executeVeilDataTool(
      {
        dataset: "private-prices",
        mode: "panel",
        as_of: "2026-08-12T00:00:00.000Z",
        columns: ["ticker", "close"],
        output: "arrow",
      },
      {
        project,
        appendEntry: (type, data) => {
          expect(type).toBe(VEIL_DATA_READ_ENTRY);
          entries.push(data);
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      dataset: "private-prices",
      view: { mode: "panel", grade: "exploration-grade", rowCount: 1 },
    });
    expect(result.exportReference).toMatch(/^\.veil\/views\/[a-f0-9]{64}\.arrow$/);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(entries).toHaveLength(1);
    if (result.exportReference === null) throw new Error("Arrow export reference is missing");
    const arrow = await readFile(join(root, result.exportReference));
    const table = tableFromIPC(arrow);
    expect(table.getChild("ticker")?.toArray()).toEqual(["PAST"]);
  });

  it("rejects project references that escape the working directory", async () => {
    const root = await projectFixture();
    await writeFile(join(root, ".veil", "project.yaml"), projectYaml("../adapter.yaml"));
    await expect(loadVeilProject(root)).rejects.toThrow(/normalized relative path/);
  });

  it("rejects invalid core tool modes instead of silently treating them as panels", async () => {
    const root = await projectFixture();
    const project = await loadVeilProject(root);
    await expect(
      executeVeilDataTool(
        {
          dataset: "private-prices",
          mode: "future" as never,
          as_of: "2026-08-12T00:00:00.000Z",
          output: "summary",
        },
        { project, appendEntry: () => {} },
      ),
    ).rejects.toThrow(/invalid required fields/);
  });
});

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "veil-agent-project-"));
  roots.push(root);
  await mkdir(join(root, ".veil"), { recursive: true });
  await writeFile(join(root, ".veil", "project.yaml"), projectYaml("adapter.yaml"));
  await writeFile(
    join(root, "adapter.yaml"),
    `dataset: private-prices
version: "1"
entity_key: ticker
event_time: date
available_time: available_at
availability_basis: observed
guarantees:
  point_in_time: true
  tradability_mask: tradable
payload_schema:
  close: float64
source:
  type: csv
  locator: prices.csv
`,
  );
  await writeFile(
    join(root, "prices.csv"),
    `ticker,date,available_at,tradable,close
PAST,2026-08-11T00:00:00.000Z,2026-08-11T00:00:00.000Z,true,10
FUTURE,2026-08-13T00:00:00.000Z,2026-08-13T00:00:00.000Z,true,999
`,
  );
  return root;
}

function projectYaml(adapter: string): string {
  return `format: veil.project.v0
datasets:
  - dataset: private-prices
    adapter: ${adapter}
    root: .
    root_env: null
runtimes:
  - id: veil-node
    constraints:
      - ">=20.10.0,<30"
promotion_concurrency: 1
`;
}
