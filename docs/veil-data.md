# `veil-data`

`veil-data` is the minimum exploration surface over the point-in-time view layer. It has two modes,
and both require an explicit decision time:

| Mode | Output shape | Label | Intended use |
| --- | --- | --- | --- |
| `point` | The requested projection plus a declared tradability mask at one `as_of` | `guarded` | Inspect or compute from the information set available then |
| `panel` | The requested projection plus entity/event/availability/mask columns | `exploration-grade` | Export a PIT-shaped panel for unrestricted exploration |

`guarded` does **not** mean verified. It means the common C1 guard physically removed rows whose
decision-time column is after `as_of`. A citable metric still has to come from the future
walk-forward verification surface. Data without a trustworthy availability column remains marked
`PIT_UNSAFE`; `veil-data` does not upgrade its semantics.

## API

```ts
import {
  BackendRegistry,
  createSourceBinding,
  createVeilData,
  DuckDbFileBackend,
  loadAdapterFile,
  openReadSetSnapshotStore,
  runVeilDataCli,
} from "@veilquant/engine";

const declaration = await loadAdapterFile("adapter.yaml");
const backend = new DuckDbFileBackend();
const registry = new BackendRegistry();
registry.register(backend);
const binding = createSourceBinding({
  id: "local-prices",
  backend: backend.id,
  options: { root: "/absolute/data/root" },
});

const data = createVeilData(registry);
const view = await data.point({
  declaration,
  binding,
  asOf: "2026-08-12",
  columns: ["ticker", "close"],
});

const guardedArrow = view.arrowIpc;
```

`asOf` is checked at runtime, not merely by TypeScript. Missing or blank input raises C1 before any
backend read. There is intentionally no default of the current clock. The request accepts only the
normalized declaration, opaque binding, `asOf`, and an optional projection; backend handles, SQL,
physical roots, and snapshot stores are not query fields.

The returned Arrow is a copy of the bytes that passed `TemporalGuard`. `readSet`, `semantics`, and
the guard audit remain available as non-enumerable evidence properties. JSON and inspection show a
small path-free summary containing the normalized decision time, row count, and content identities,
not Arrow rows or binding values.

## Panel shape

When a panel projection is supplied, Veil prepends the declared entity key, event time, availability
time (when one exists), and tradability mask (when declared), removes duplicates, and then applies
the same backend-neutral guard as a point read. Point projections also retain a declared mask so a
caller cannot accidentally strip the C4 input:

```ts
const panel = await data.panel({
  declaration,
  binding,
  asOf: "2026-08-12",
  columns: ["value"],
});
// Arrow columns: ticker, event_time, available_time, [declared mask], value
```

Omitting `columns` exports all guarded source columns. If the declaration has
`available_time: null`, the event time is the conservative filter fallback, the panel cannot invent
an availability column, and `PIT_UNSAFE` stays attached.

## Explicit snapshots

Reads have no persistence side effect. Snapshot storage is available only as a separate, explicit
action on an already guarded view:

```ts
const store = await openReadSetSnapshotStore({ root: "/absolute/veil-snapshots" });
const written = await panel.writeSnapshot(store);
console.log(written.snapshot); // portable content-addressed reference
```

Putting `snapshotStore` into a read request is rejected as an unknown field. A configured CLI store
also remains untouched when Arrow output is selected.

## CLI core

The pre-alpha package exposes a dependency-injected command runner rather than a database-specific
global config format:

```ts
const result = await runVeilDataCli(
  ["panel", "--as-of", "2026-08-12", "--columns", "value", "--output", "arrow"],
  { registry, declaration, binding },
);
```

The grammar is deliberately narrow:

```text
veil-data <point|panel> --as-of <ISO-8601> [--columns a,b] --output <arrow|snapshot>
```

The launcher owns backend registration and binding construction. Consequently, the CLI core has no
DuckDB switch, database-name branch, SQL input, root argument, DSN, or credential parsing. A file
launcher can choose the default DuckDB backend; a DolphinDB, ClickHouse, API, or in-memory launcher
can inject another `TemporalBackend` without changing the command. Snapshot output additionally
requires the launcher to pass an opened store.

Run `npm run veil-data:verify` for a clean-process CSV example. It decodes point Arrow directly,
replays a panel through its explicit snapshot reference, verifies the bitemporal columns, and checks
that the future sentinel is absent in both outputs.
