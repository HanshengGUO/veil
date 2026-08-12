# @veilquant/engine

The verification surface. Everything that makes a claim expensive lives here.

Status: Stage 2A — the backend-neutral temporal plan, opaque source bindings, mandatory Arrow guard,
strict adapter YAML loader, and default DuckDB CSV backend are implemented. The package remains
private until the Parquet adapter and stable public API are complete.

## The database is replaceable; the guard is not

```text
adapter declaration + as_of
            ↓
TemporalReadPlan (structured, no SQL dialect)
            ↓
TemporalBackend (DuckDB files / ClickHouse extract / DolphinDB / custom)
            ↓ Arrow IPC
TemporalGuard (always re-checks and removes rows after as_of)
            ↓
safe data_view
```

DuckDB is the default implementation for zero-copy CSV/Parquet access, not an architectural
boundary. A backend receives a structured projection and temporal predicate, then returns Arrow IPC.
Its pushdown capabilities are performance hints only: even if it reports that the predicate was
applied, `TemporalGuard` independently checks every returned decision-time value. A missing or broken
pushdown can waste I/O; it cannot expose a correctly timestamped future row through the guarded API.

This is the “invisible protection” boundary: callers use the same `as_of` read regardless of where
the data lives. Backend-specific SQL, connections, and credentials stay behind the adapter.

## Extension surface

`TemporalBackend` has four responsibilities:

- identify which portable `AdapterSource` declarations it accepts;
- consume a SQL-free `TemporalReadPlan`;
- return Arrow IPC plus an optional source fingerprint;
- report which projection/predicate optimizations it attempted.

`BackendRegistry` accepts custom implementations but exposes no raw read method. Reads leave the
registry only through the engine's internal bridge into `TemporalGuard`. The contract test uses an
in-memory backend with no database dependency and deliberately returns a future row after claiming
predicate pushdown; the common guard removes it. This test is the portability invariant for every
future backend.

`SourceBinding` holds runtime roots, DSNs, and credentials as an opaque capability. Values live
outside enumerable object state and never appear in JSON, inspection output, guarded results, or
model-facing diagnostics. Only the selected trusted backend receives accessor functions.

## Default CSV backend

The first real backend is deliberately ordinary to use:

```ts
import {
  BackendRegistry,
  createSourceBinding,
  DuckDbFileBackend,
  loadAdapterFile,
  TemporalGuard,
} from "@veilquant/engine";

const declaration = await loadAdapterFile("adapter.yaml");
const backend = new DuckDbFileBackend();
const registry = new BackendRegistry();
registry.register(backend);

const result = await new TemporalGuard(registry).read(
  declaration,
  { asOf: "2026-08-12", columns: ["ticker", "value"] },
  createSourceBinding({
    id: "research-data",
    backend: backend.id,
    options: { root: "/absolute/data/root" },
  }),
);
```

The declaration keeps a relative, portable locator. The binding root must be absolute and cannot be
a filesystem root; realpath containment rejects parent traversal and symlinks escaping that root.
The backend executes only in-memory read queries, hashes the source bytes before and after the query,
and returns the SHA-256 as its source fingerprint.

DuckDB validates the temporal column before applying pushdown. If any value is null or unparseable,
the backend deliberately skips temporal pushdown so the common guard sees the bad row and raises C1
instead of silently filtering it away. See the runnable [`examples/csv-pit`](../../examples/csv-pit/).

## Native runtime gate

The engine pins:

- `@duckdb/node-api` `1.4.5-r.1` (the DuckDB v1.4 LTS line, MIT);
- `apache-arrow` `21.2.0` (Apache-2.0).

`npm run engine:runtime:smoke` cold-loads DuckDB dynamically, executes an in-memory query, then
round-trips an Arrow IPC stream. Failures identify `duckdb-load`, `duckdb-query`, `arrow-load`, or
`arrow-ipc`. The root `npm run check` includes this probe, so the existing five-job Linux/macOS/
Windows matrix verifies native installation and execution.

No DuckDB type appears in the public data-plane API, and importing the engine does not load the
native module. The next slice adds Parquet behind the same interface and checks CSV/Parquet
metamorphic equivalence.

## What lands here, and when

| Component | Stage | Notes |
| --- | --- | --- |
| Backend-neutral temporal guard | 2 | Structured plan → replaceable backend → Arrow IPC → mandatory C1 re-check |
| Default file backend | 2 | CSV implemented; Parquet is next; neither exposes DuckDB to callers |
| Read-set snapshots | 2 | What an experiment actually read, content-addressed, for metric-level reproduction |
| Verification engine | 2 | Re-executes an artifact window by window: rows with `available_time > t` do not exist |
| Artifact management | 2 | `compute(data_view)` packaging, parameter locking, content-addressed identity |
| Statistical gates | 4 | Trials-aware deflated Sharpe, parameter stability, null falsification, cost sensitivity |
| Plugin interfaces | 4 | `CostModel`, `NullGenerator` |

## Design constraints

- **The Arrow boundary is the guarantee.** Future rows are absent before data reaches factor code.
- **Pushdown is never trust.** It reduces work but cannot weaken or strengthen C1.
- **Data stays put.** Backends may query in place or extract locally; Veil writes only read-set
  snapshots and bench fixtures.
- **User factor code is a subprocess.** Artifacts run in the user's language over Arrow IPC.
- **Exploration stays free.** The guard protects Veil reads and verification claims; it does not
  intercept arbitrary user code.
