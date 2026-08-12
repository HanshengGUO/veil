import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { normalizeAdapterDeclaration } from "@veilquant/contract";
import { type Table, tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BackendReadRequest,
  BackendRegistry,
  createSourceBinding,
  createVeilData,
  openReadSetSnapshotStore,
  runVeilDataCli,
  type TemporalBackend,
  VEIL_DATA_VIEW_FORMAT,
} from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `veil-data-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function declaration() {
  return normalizeAdapterDeclaration({
    dataset: "veil-data-prices",
    version: "1",
    entity_key: "ticker",
    event_time: "event_time",
    available_time: "available_time",
    availability_basis: "observed",
    guarantees: { point_in_time: true, tradability_mask: "tradable" },
    payload_schema: { value: "float64" },
    source: { type: "custom", locator: "logical/prices" },
  });
}

function memoryBackend(onRead?: (request: BackendReadRequest) => void): TemporalBackend {
  return {
    id: "veil-data-memory",
    capabilities: {
      projectionPushdown: false,
      temporalPredicatePushdown: true,
      sourceFingerprint: "none",
      readOnly: true,
    },
    accepts: (source) => source.type === "custom",
    read: async (request) => {
      onRead?.(request);
      return {
        arrowIpc: tableToIPC(
          tableFromArrays({
            ticker: ["PAST", "BOUNDARY", "FUTURE"],
            event_time: ["2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z", "2026-08-12T00:00:00Z"],
            available_time: [
              "2026-08-11T00:00:00Z",
              "2026-08-12T00:00:00Z",
              "2026-08-13T00:00:00Z",
            ],
            value: [1, 2, 999],
            tradable: [true, true, false],
          }),
          "stream",
        ),
        sourceFingerprint: null,
        runtime: { name: "memory", version: "test-v1" },
        pushdown: {
          projectionApplied: false,
          temporalPredicateApplied: true,
        },
      };
    },
  };
}

function harness() {
  let reads = 0;
  let lastRequest: BackendReadRequest | undefined;
  const backend = memoryBackend((request) => {
    reads += 1;
    lastRequest = request;
  });
  const registry = new BackendRegistry();
  registry.register(backend);
  const adapter = declaration();
  const binding = createSourceBinding({
    id: "private-data",
    backend: backend.id,
    options: { root: "/private/physical/root" },
    secrets: { apiKey: "never-serialize-this" },
  });
  return {
    adapter,
    binding,
    registry,
    service: createVeilData(registry),
    reads: () => reads,
    lastRequest: () => lastRequest,
  };
}

function values(table: Table, column: string): unknown[] {
  return [...(table.getChild(column)?.toArray() ?? [])];
}

describe("veil-data API", () => {
  it("makes as_of mandatory before a backend can be touched", async () => {
    const subject = harness();
    const incomplete = {
      declaration: subject.adapter,
      binding: subject.binding,
    };

    await expect(subject.service.point(incomplete as never)).rejects.toMatchObject({
      invariant: "C1",
    });
    await expect(subject.service.panel(incomplete as never)).rejects.toMatchObject({
      invariant: "C1",
    });
    await expect(subject.service.point({ ...incomplete, asOf: "" } as never)).rejects.toMatchObject(
      { invariant: "C1" },
    );
    await expect(
      subject.service.point({ ...incomplete, asOf: "2026-08-12", columns: [] }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(subject.reads()).toBe(0);
  });

  it("returns only guarded point Arrow and a path-free serialized identity", async () => {
    const subject = harness();
    const view = await subject.service.point({
      declaration: subject.adapter,
      binding: subject.binding,
      asOf: "2026-08-12",
      columns: ["ticker", "value"],
    });
    const table = tableFromIPC(view.arrowIpc);

    expect(table.schema.fields.map((field) => field.name)).toEqual(["ticker", "value", "tradable"]);
    expect(values(table, "ticker")).toEqual(["PAST", "BOUNDARY"]);
    expect(view).toMatchObject({
      format: VEIL_DATA_VIEW_FORMAT,
      mode: "point",
      grade: "guarded",
      asOf: "2026-08-12T00:00:00.000Z",
      rowCount: 2,
    });
    expect(view.audit.droppedFutureRows).toBe(1);
    expect(subject.lastRequest()?.plan.temporalPredicate).toEqual({
      column: "available_time",
      operator: "<=",
      value: "2026-08-12T00:00:00.000Z",
    });

    const serialized = `${JSON.stringify(view)}\n${inspect(view)}`;
    expect(serialized).not.toMatch(/private\/physical|never-serialize-this/);
    expect(serialized).not.toContain("FUTURE");
    expect(Object.keys(view)).toEqual([
      "format",
      "mode",
      "grade",
      "asOf",
      "rowCount",
      "readSetId",
      "resultHash",
      "arrowHash",
    ]);
    expect(Object.isFrozen(view)).toBe(true);

    const firstCopy = view.arrowIpc;
    firstCopy[0] = firstCopy[0] ^ 0xff;
    expect(view.arrowIpc).not.toEqual(firstCopy);
    expect(tableFromIPC(view.arrowIpc).numRows).toBe(2);
  });

  it("exports an exploration-grade bitemporal panel through the same guard", async () => {
    const subject = harness();
    const view = await subject.service.panel({
      declaration: subject.adapter,
      binding: subject.binding,
      asOf: "2026-08-12",
      columns: ["value"],
    });
    const table = tableFromIPC(view.arrowIpc);

    expect(view.grade).toBe("exploration-grade");
    expect(table.schema.fields.map((field) => field.name)).toEqual([
      "ticker",
      "event_time",
      "available_time",
      "tradable",
      "value",
    ]);
    expect(values(table, "ticker")).toEqual(["PAST", "BOUNDARY"]);
    expect(view.audit.droppedFutureRows).toBe(1);
  });

  it("writes snapshots only through the explicit result action", async () => {
    const subject = harness();
    const root = await temporaryRoot("snapshot");
    const store = await openReadSetSnapshotStore({ root });

    await expect(
      subject.service.point({
        declaration: subject.adapter,
        binding: subject.binding,
        asOf: "2026-08-12",
        snapshotStore: store,
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(subject.reads()).toBe(0);
    expect(await readdir(join(root, "read-set-snapshots-v0"))).toEqual([]);

    const view = await subject.service.point({
      declaration: subject.adapter,
      binding: subject.binding,
      asOf: "2026-08-12",
      columns: ["ticker", "value"],
    });
    expect(await readdir(join(root, "read-set-snapshots-v0"))).toEqual([]);
    await expect(view.writeSnapshot({} as never)).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT_STORE",
    });

    const written = await view.writeSnapshot(store);
    expect(written.created).toBe(true);
    expect(written.snapshot.id).toBe(view.readSetId);
    expect((await store.read(written.snapshot.id)).arrowIpc).toEqual(view.arrowIpc);
  });
});

describe("veil-data CLI core", () => {
  it("stays backend-neutral and does not persist an Arrow selection", async () => {
    const subject = harness();
    const root = await temporaryRoot("cli-arrow");
    const store = await openReadSetSnapshotStore({ root });
    const result = await runVeilDataCli(
      ["point", "--as-of", "2026-08-12", "--columns", "ticker,value", "--output", "arrow"],
      {
        registry: subject.registry,
        declaration: subject.adapter,
        binding: subject.binding,
        snapshotStore: store,
      },
    );

    expect(result.output).toBe("arrow");
    if (result.output !== "arrow") {
      throw new Error("expected Arrow CLI output");
    }
    expect(values(tableFromIPC(result.arrowIpc), "ticker")).toEqual(["PAST", "BOUNDARY"]);
    expect(result.view.grade).toBe("guarded");
    expect(JSON.stringify(result)).not.toMatch(/FUTURE|private\/physical|never-serialize-this/);
    expect(Object.keys(result)).not.toContain("arrowIpc");
    expect(await readdir(join(root, "read-set-snapshots-v0"))).toEqual([]);
  });

  it("returns a snapshot reference only when that output is selected explicitly", async () => {
    const subject = harness();
    const root = await temporaryRoot("cli-snapshot");
    const store = await openReadSetSnapshotStore({ root });
    const result = await runVeilDataCli(
      ["panel", "--as-of", "2026-08-12", "--columns", "value", "--output", "snapshot"],
      {
        registry: subject.registry,
        declaration: subject.adapter,
        binding: subject.binding,
        snapshotStore: store,
      },
    );

    expect(result).toMatchObject({
      output: "snapshot",
      created: true,
      view: { mode: "panel", grade: "exploration-grade", rowCount: 2 },
      snapshot: { id: result.view.readSetId, rowCount: 2 },
    });
    if (result.output !== "snapshot") {
      throw new Error("expected snapshot CLI output");
    }
    const table = tableFromIPC((await store.read(result.snapshot.id)).arrowIpc);
    expect(table.schema.fields.map((field) => field.name)).toEqual([
      "ticker",
      "event_time",
      "available_time",
      "tradable",
      "value",
    ]);
  });

  it("fails before reading for missing as_of, unknown flags, or an unselected store", async () => {
    const subject = harness();
    const context = {
      registry: subject.registry,
      declaration: subject.adapter,
      binding: subject.binding,
    };

    await expect(runVeilDataCli(["point", "--output", "arrow"], context)).rejects.toMatchObject({
      invariant: "C1",
    });
    await expect(
      runVeilDataCli(
        ["point", "--as-of", "2026-08-12", "--database", "duckdb", "--output", "arrow"],
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      runVeilDataCli(["point", "--as-of", "2026-08-12", "--output", "snapshot"], context),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT_STORE" });
    await expect(
      runVeilDataCli(["point", "--as-of", "2026-08-12", "--output", "snapshot"], {
        ...context,
        snapshotStore: {} as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT_STORE" });
    expect(subject.reads()).toBe(0);
  });
});
