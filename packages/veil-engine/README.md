# @veilquant/engine

The verification surface. Everything that makes a claim expensive lives here.

Status: Stage 2D — the backend-neutral temporal plan, opaque source bindings, mandatory Arrow
guard, strict adapter YAML loader, default single/multi-file DuckDB CSV/Parquet backend, source and
read-set v0 identities, durable content-addressed snapshots, and the minimum `veil-data` point/panel
surface are implemented and hardened with operator-controlled snapshot quarantine. Portable
content-addressed artifact identity and runtime-provider-neutral framed execution are also
implemented. Explicit-session rolling/expanding plans, replayable derived views, per-decision OOS
mask-first execution, and complete C1-C4 contract records now feed a narrow promotion boundary.
That boundary checks C5/C6 evidence and emits only an unverified candidate for later pricing and
gates. The golden-path prices and point-in-time membership now meet through replayable composite
evidence before this contract path. The package stays private while the remaining Stage 2
acceptance work is completed.

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

## `veil-data` exploration surface

`VeilDataService` is the narrow public orchestration layer over `TemporalGuard`. Point and panel
requests both require `asOf` at runtime and reject unknown fields; there is no fallback to the wall
clock. Point reads preserve the requested projection and attach a declared tradability mask. Panel
reads retain the entity key, event time, declared availability time, and mask around that projection
and are explicitly labelled `exploration-grade`.

```ts
const data = createVeilData(registry);
const point = await data.point({ declaration, binding, asOf: "2026-08-12" });
const panel = await data.panel({
  declaration,
  binding,
  asOf: "2026-08-12",
  columns: ["value"],
});
```

Both modes return only Arrow that passed the common guard. JSON/inspection exposes a small path-free
identity summary; Arrow, read-set evidence, semantics, and the guard audit require explicit property
access. Persistence is separate: `await panel.writeSnapshot(store)` is the only snapshot action on a
view. A store cannot be embedded in the read request, and merely configuring one in the CLI context
does not write anything.

The dependency-injected CLI core accepts `point|panel`, `--as-of`, an optional comma-separated
projection, and `--output arrow|snapshot`. A launcher supplies the registry, declaration, opaque
binding, and—only for snapshot output—an opened store. The core contains no file/database switch,
SQL, physical path, DSN, or credential handling. See [`docs/veil-data.md`](../../docs/veil-data.md)
and the clean-process [`examples/veil-data`](../../examples/veil-data/).

## Extension surface

`TemporalBackend` has five responsibilities:

- identify which portable `AdapterSource` declarations it accepts;
- consume a SQL-free `TemporalReadPlan`;
- return Arrow IPC plus an optional source fingerprint;
- report its runtime name/version, or explicitly return `null`;
- report which projection/predicate optimizations it attempted.

`SourceFingerprint.manifest` is deliberately optional. Enumerable file backends can attach a strict
`veil.source-manifest.v0`; a database backend can instead return its transaction/version token, and
an unversioned source returns `null`. Derived sources use the separate `evidence` field. The first
format, `veil.composite-source-manifest.v0`, binds two guarded read sets and a replayable exact-key
membership join without pretending that derived evidence is a directory of files.

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
A locator may be one file or a portable `*`, `?`, or whole-segment `**` glob. The engine resolves and
sorts matches itself, then gives DuckDB the exact list—it does not delegate membership to
database-specific glob behavior.

Before and after each query, the backend enumerates all matching members and hashes their bytes. A
`veil.source-manifest.v0` records sorted root-relative logical names, byte lengths, and content
hashes. Addition, deletion, rename, replacement, or truncation during a read raises `SOURCE_CHANGED`.
Absolute roots, discovery order, mtimes, binding ids, hostnames, and credentials are excluded, so an
identical file set under another root has the same source identity. Single-file reads use this same
abstraction and preserve their existing guarded-query behavior.

DuckDB validates the temporal column before applying pushdown. If any value is null or unparseable,
the backend deliberately skips temporal pushdown so the common guard sees the bad row and raises C1
instead of silently filtering it away. CSV and Parquet use the same backend, binding rules, hash
semantics, and guard. The metamorphic suite verifies equal rows and schemas across formats while
their physical source hashes remain different. See the runnable
[`examples/csv-pit`](../../examples/csv-pit/) and
[`examples/parquet-pit`](../../examples/parquet-pit/), plus the manifest-focused
[`examples/multi-file-pit`](../../examples/multi-file-pit/).

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

`store.inspect(id, evidence)` returns `valid`, `missing`, or `invalid` without mutation. A separate
`ReadSetSnapshotRecovery` capability can quarantine only an intrinsically corrupt object after an
operator supplies an actor and reason. It persists a hash-addressed intent, atomically moves the
object out of the readable namespace, retains its bytes, and persists a hash-verified result audit.
It refuses valid/missing objects and never interprets mismatched caller evidence as corruption.
Restoration requires a later explicit `put()` of the exact trusted manifest and Arrow bytes. See the
operator contract in [`docs/read-sets.md`](../../docs/read-sets.md) and the cold
[`examples/snapshot-recovery`](../../examples/snapshot-recovery/).

## Artifact v0 identity

Artifact packaging starts from an explicit code set. `captureArtifactCode()` rejects symlinks and
unsafe/case-colliding paths, captures exact bytes twice, and returns sorted per-file hashes plus a
code-tree hash. The local absolute root and mtimes never enter the manifest.

`createArtifactManifest()` binds that code identity to a logical runtime and entrypoint, immutable
parameters and data-derived literals, normalized adapter declaration hashes and development
read-sets, declared trials, WFA protocol, hypothesis, and cost model. Canonical JSON values only;
unknown fields, credentials, runtime paths, ambiguous numbers, malformed protocol, or a missing
entrypoint fail closed. `verifyArtifactManifest()` recomputes the complete identity, while
`verifyArtifactCode()` re-hashes the files from any checkout.

Artifact, per-window read-set, and experiment identities are deliberately distinct. Framed requests
now bind an artifact, concrete runtime implementation, and one new guarded read-set without
mutating either identity. WFA training orchestration aggregates those executions into a separate
deterministic run record; it does not yet create the final experiment or a citable metric. See
[`docs/artifacts.md`](../../docs/artifacts.md),
[`examples/artifact-identity`](../../examples/artifact-identity/), and the clean child
[`examples/artifact-execution`](../../examples/artifact-execution/).

## Framed artifact execution

`ArtifactRuntimeRegistry` maps a manifest's logical runtime id/constraint to an opaque trusted
provider. Only its path-free implementation name/version is public and bound into the request hash;
the executable, argv, and explicit environment remain provider-private. The engine always spawns an
absolute executable with `shell: false` and a clean environment.

`executeArtifact()` verifies the artifact, code tree, read-set manifest, exact guarded Arrow, and
declared dataset relationship. It refuses development evidence as a verification window, copies the
declared code set to a fresh root, and re-hashes that copy around provider preparation. The child
receives one bounded request frame over stdin, never a backend, `SourceBinding`, source locator, or
query capability. It may write one result frame to stdout; stderr is counted and discarded from the
public surface. Bad framing, identity mismatch, unreadable Arrow, non-zero/signal exit,
timeout/cancel, and stdout/stderr floods all fail closed with sanitized structured errors.

The frame codec is exported for thin language adapters and contains no Node- or DB-specific factor
semantics. The first example adapter happens to use Node; Python and other providers can consume the
same protocol.

## Walk-forward training windows

`createWalkForwardPlan()` accepts only the artifact protocol plus an explicit, strictly increasing
UTC decision schedule. Protocol `*Days` count schedule entries, never guessed calendar days. The
schedule must have exactly
`trainDays + purgeDays + embargoDays + folds * oosDays` entries. Rolling and expanding training
ranges differ only at the training start; purge, embargo, and contiguous OOS boundaries are derived
and content-hashed in both modes.

`executeWalkForwardWindows()` owns the data capability. At each fold's training cutoff it asks the
injected `TemporalGuard` for a fresh read, retains the declared event-time column, and derives an
inclusive training slice. `veil.window-read-set.v0` binds that slice to the source read-set, plan,
fold, declaration, range, and exact Arrow identity. Its verifier must replay the filter from the
source Arrow; a copied hash is insufficient. Only the derived Arrow crosses the existing framed
child boundary.

Successful folds produce `veil.walk-forward-window-execution.v0` records, then one
`veil.walk-forward-run.v0`. Hashes include artifact, plan, source/window, request, input/output, and
runtime identities plus all fold boundaries. Temporary roots, stderr, wall time, and completion
order are excluded. An empty fold fails before child launch; any later failure returns no run record.
Records say `executed`, never `verified`: this frozen API remains the training-only layer. See the
custom in-memory backend probe in
[`examples/walk-forward-windows`](../../examples/walk-forward-windows/).

## Contract and promotion boundary

`createCompositeSource()` combines a guarded primary source with guarded point-in-time membership
before the factor runs. It rejects missing/duplicate entity-event keys and non-boolean masks,
derives availability as the later component timestamp, and computes the output mask as tradability
AND membership. Its manifest binds both read sets, join rule, audit, and result. The materialized
snapshot is served by `CompositeSourceBackend` and must pass through `TemporalGuard` again at every
decision; database-specific joins never enter orchestration or artifact code.

`executeWalkForwardContract()` performs a fresh guarded read at every train cutoff and OOS decision,
derives a bounded history, applies the declared boolean mask before child execution, and validates
that child entity/event output came from that masked view. Only the current OOS decision slice is
admitted. One immutable parameter-lock identity and the exact complete fold topology are required
before `veil.walk-forward-contract.v0` is issued.

Large contracts may set bounded `concurrency` and `retainExecutionEvidence: false`. Every decision
still executes and remains in the record, but intermediate Arrow is released after its identities
are fixed. Completion order is excluded from content identity.

`createPromotionCandidate()` accepts that replay-verified contract and no lower-level result. It
binds a `veil.hypothesis-registration.v0` whose durable timestamp must predate verification. Missing
registration stays exploratory at a higher future gate tier; late or mismatched registration raises
C6. The candidate remains `unverified` and requires pricing, costs, and statistical gates before an
Experiment can exist. The session log supplying trusted chronology belongs to Stage 3, not this
database-neutral engine.

## Native runtime gate

The engine pins:

- `@duckdb/node-api` `1.4.5-r.1` (the DuckDB v1.4 LTS line, MIT);
- `apache-arrow` `21.2.0` (Apache-2.0).

`npm run engine:runtime:smoke` cold-loads DuckDB dynamically, executes an in-memory query, then
round-trips an Arrow IPC stream. Failures identify `duckdb-load`, `duckdb-query`, `arrow-load`, or
`arrow-ipc`. The root `npm run check` includes this probe, so the existing five-job Linux/macOS/
Windows matrix verifies native installation and execution.

No DuckDB type appears in the public data-plane API, and importing the engine does not load the
native module. Framed and WFA execution use that same Arrow boundary; neither planner nor run record
contains a backend id, SQL, DSN, binding, or physical path.

## What lands here, and when

| Component | Stage | Notes |
| --- | --- | --- |
| Backend-neutral temporal guard | 2 | Structured plan → replaceable backend → Arrow IPC → mandatory C1 re-check |
| Default file backend | 2 | Single/multi-file CSV/Parquet with stable source manifests; DuckDB stays private |
| Read-set identity | 2 | v0 manifest and independent Arrow verification implemented |
| Snapshot persistence | 2 | Durable local content-addressed storage plus explicit inspect/quarantine/audit recovery |
| Verification engine | 2 | Per-decision PIT/mask-first C1-C4 contract and replay verifier implemented |
| Promotion boundary | 2 | Contract-only C5 admission plus C6 chronology/exploratory tier implemented; no metrics issued |
| Artifact management | 2 | Explicit code identity, bounded child execution, and deterministic WFA evidence implemented |
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
