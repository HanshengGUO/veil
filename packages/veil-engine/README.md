# @veilquant/engine

The verification surface. Everything that makes a claim expensive lives here.

Status: Stage 2B-1 — the backend-neutral temporal plan, opaque source bindings, mandatory Arrow
guard, strict adapter YAML loader, default DuckDB CSV/Parquet backend, read-set v0 identity, and
durable content-addressed snapshots are implemented. The package remains private while the
multi-file source manifest, `veil-data` surface, and remaining verification API are completed.

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

DuckDB is the default implementation for in-place CSV/Parquet access, not an architectural
boundary. A backend receives a structured projection and temporal predicate, then returns Arrow IPC.
Its pushdown capabilities are performance hints only: even if it reports that the predicate was
applied, `TemporalGuard` independently checks every returned decision-time value. A missing or broken
pushdown can waste I/O; it cannot expose a correctly timestamped future row through the guarded API.

This is the “invisible protection” boundary: callers use the same `as_of` read regardless of where
the data lives. Backend-specific SQL, connections, and credentials stay behind the adapter.

## Extension surface

`TemporalBackend` has five responsibilities:

- identify which portable `AdapterSource` declarations it accepts;
- consume a SQL-free `TemporalReadPlan`;
- return Arrow IPC plus an optional source fingerprint;
- report its runtime name/version, or explicitly return `null`;
- report which projection/predicate optimizations it attempted.

`BackendRegistry` accepts custom implementations but exposes no raw read method. Reads leave the
registry only through the engine's internal bridge into `TemporalGuard`. The contract test uses an
in-memory backend with no database dependency and deliberately returns a future row after claiming
predicate pushdown; the common guard removes it. This test is the portability invariant for every
future backend.

`SourceBinding` holds runtime roots, DSNs, and credentials as an opaque capability. Values live
outside enumerable object state and never appear in JSON, inspection output, guarded results, or
model-facing diagnostics. Only the selected trusted backend receives accessor functions.

## Default file backend

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
instead of silently filtering it away. CSV and Parquet use the same backend, binding rules, hash
semantics, and guard. The metamorphic suite verifies equal rows and schemas across formats while
their physical source hashes remain different. See the runnable
[`examples/csv-pit`](../../examples/csv-pit/) and
[`examples/parquet-pit`](../../examples/parquet-pit/).

The current canonical Arrow mapping covers primitive scalar columns. Unsupported nested Parquet
types fail closed until an explicit canonical type adapter is provided.

## Read-set v0

Every `GuardedReadResult` includes a versioned `readSet` manifest. It records the normalized adapter
hash, physical source fingerprint, canonical query, guarded schema/row count/result hash, and runtime
identities. It also hashes the exact guarded Arrow IPC delivered to factor code. Absolute paths,
binding ids, mtimes, hostnames, and secrets are excluded.

The result hash canonicalizes column order and hashes a sorted multiset of rows, so equivalent CSV
and reordered Parquet inputs share a result identity even though their source and manifest hashes
differ. A separate Arrow hash remains order/layout-sensitive for exact replay.
`verifyReadSetManifest()` independently checks stored Arrow bytes and optional declaration, source,
and expected-id evidence. See [`docs/read-sets.md`](../../docs/read-sets.md) and the runnable
[`examples/read-set`](../../examples/read-set/).

## Durable snapshot store

The snapshot store accepts only a completed read-set manifest and the exact guarded Arrow IPC. It is
therefore independent of the backend that produced the view:

```ts
import { openReadSetSnapshotStore } from "@veilquant/engine";

const store = await openReadSetSnapshotStore({ root: "/absolute/veil-snapshots" });
const written = await store.put(result.readSet, result.arrowIpc);
const replayed = await store.read(written.snapshot.id, {
  declaration,
  sourceFingerprint: result.sourceFingerprint,
});
```

The manifest hash is the content address. Publication uses a same-shard temporary directory, synced
files, directory metadata sync where supported, and atomic directory rename. Every existing object
and every replay is fully revalidated; concurrent writers converge on one verified object. Missing
objects raise `SNAPSHOT_NOT_FOUND`, while missing files, extra files, symlinks, truncation, tampering,
or mismatched evidence raise `INVALID_SNAPSHOT`. The store never substitutes a fresh source query
for the requested snapshot and never overwrites a corrupt object implicitly.

Store roots are absolute runtime configuration. They are excluded from content identity and from
the public object's JSON representation, so the same snapshot namespace can be copied between
machines without changing ids. The cold example performs the replay in a second process without a
backend or source binding.

## Native runtime gate

The engine pins:

- `@duckdb/node-api` `1.4.5-r.1` (the DuckDB v1.4 LTS line, MIT);
- `apache-arrow` `21.2.0` (Apache-2.0).

`npm run engine:runtime:smoke` cold-loads DuckDB dynamically, executes an in-memory query, then
round-trips an Arrow IPC stream. Failures identify `duckdb-load`, `duckdb-query`, `arrow-load`, or
`arrow-ipc`. The root `npm run check` includes this probe, so the existing five-job Linux/macOS/
Windows matrix verifies native installation and execution.

No DuckDB type appears in the public data-plane API, and importing the engine does not load the
native module. The next slices add multi-file source manifests and the first `veil-data` surface.

## What lands here, and when

| Component | Stage | Notes |
| --- | --- | --- |
| Backend-neutral temporal guard | 2 | Structured plan → replaceable backend → Arrow IPC → mandatory C1 re-check |
| Default file backend | 2 | CSV/Parquet implemented with metamorphic equivalence; DuckDB stays private |
| Read-set identity | 2 | v0 manifest and independent Arrow verification implemented |
| Snapshot persistence | 2 | Durable local content-addressed storage implemented; multi-file source manifests and operator recovery tooling remain |
| Verification engine | 2 | Re-executes an artifact window by window: rows with `available_time > t` do not exist |
| Artifact management | 2 | `compute(data_view)` packaging, parameter locking, content-addressed identity |
| Statistical gates | 4 | Trials-aware deflated Sharpe, parameter stability, null falsification, cost sensitivity |
| Plugin interfaces | 4 | `CostModel`, `NullGenerator` |

## Design constraints

- **The Arrow boundary is the guarantee.** Future rows are absent before data reaches factor code.
- **Pushdown is never trust.** It reduces work but cannot weaken or strengthen C1.
- **Data stays put.** Backends may query in place or extract locally; durable writes are limited to
  explicit read-set snapshots and bench fixtures.
- **User factor code is a subprocess.** Artifacts run in the user's language over Arrow IPC.
- **Exploration stays free.** The guard protects Veil reads and verification claims; it does not
  intercept arbitrary user code.
