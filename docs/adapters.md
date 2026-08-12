# Dataset adapters

An adapter tells Veil what your rows mean in time. It maps arbitrary source column names onto the
three fields the contract needs:

```text
(entity, event_time, available_time, payload)
```

Status: Stage 2A. Declaration validation and the backend-neutral temporal guard are implemented.
DuckDB/Arrow native runtimes are pinned and checked, while the actual CSV/Parquet backend is the next
slice. No package is published yet.

## Smallest honest CSV declaration

If the source has no trustworthy availability timestamp, say so. Veil still accepts it, filters on
`event_time`, and carries `PIT_UNSAFE` into every downstream result.

```yaml
dataset: alt_news
version: "2026-08"
entity_key: ticker
event_time: published_at
available_time: null
source:
  type: csv
  locator: data/news.csv
```

Omitted guarantees take conservative defaults: no point-in-time guarantee, no vintage history,
unknown survivorship handling, no tradability mask, and uncertified provenance.

## Point-in-time data

Having an availability column is not enough; declare where it came from:

```yaml
dataset: vendor_fundamentals
version: "2026-08"
entity_key: ticker
event_time: period_end
available_time: first_known_at
availability_basis:
  - until: 2026-08-07
    basis: reconstructed
    source: vendor publish_date
  - from: 2026-08-07
    basis: observed
guarantees:
  point_in_time: true
  vintage: true
  survivorship_free: true
provenance:
  certified: true
  lineage_ref: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
payload_schema:
  revenue: float64
  currency: utf8
source:
  type: parquet
  locator: fundamentals/**/*.parquet
```

Segment boundaries apply to `event_time`. They use `[from, until)`: `from` is included, `until` is
not. A date such as `2026-08-07` means `2026-08-07T00:00:00Z`; timestamps must otherwise include an
explicit timezone. Segments must be ordered and contiguous wherever their ranges meet.

The three bases are deliberately small:

| Basis | Meaning | Required evidence | Consequence |
| --- | --- | --- | --- |
| `observed` | You really received it then | Certified claims are checked against lineage | Full availability credit only with certification |
| `reconstructed` | Rebuilt from a vendor publication/effective date | `source` | `AVAILABILITY_RECONSTRUCTED` |
| `assumed` | Computed with a chosen lag | ISO-8601 `lag` and `rationale` | `PIT_DEGRADED_ASSUMED` |

For a whole dataset that was genuinely observed, shorthand is valid:

```yaml
availability_basis: observed
```

For a whole-range assumption, use an object because the evidence is mandatory:

```yaml
availability_basis:
  basis: assumed
  lag: P2D
  rationale: The vendor SLA promises delivery within two calendar days.
```

## Declaration and connection settings are different objects

`adapter.yaml` is portable, hashable, and safe to show an agent. Its `source` block contains only a
format and a non-secret locator:

```yaml
source:
  type: csv
  locator: data/prices.csv
```

The engine will resolve that locator through a runtime `SourceBinding`. Absolute roots, database
DSNs, usernames, passwords, tokens, and environment-variable values belong there. Inline URL
credentials and secret-looking query parameters in `source.locator` are rejected. This keeps the
same declaration usable on another machine without putting credentials in an artifact or hash.

`SourceBinding` is opaque: serialized and inspected forms contain only the binding id, backend id,
and option/secret **names**, never their values. The selected trusted backend can resolve values while
reading; they are not returned with query results or placed in model context.

## Backends are replaceable

Adapters do not emit SQL. The engine builds one structured `TemporalReadPlan` containing projection,
`as_of`, and the required `column <= as_of` predicate. A `TemporalBackend` may translate that plan to
DuckDB, ClickHouse, DolphinDB, a REST extraction, or a custom in-memory source, then returns Arrow IPC.

Predicate pushdown is an optimization, not a guarantee. The common `TemporalGuard` decodes every
backend's Arrow result and applies the temporal predicate again before returning the data view. Even
a backend that incorrectly claims successful pushdown cannot expose a future row. Backends without a
stable source version can still serve exploration reads with a missing fingerprint; later promotion
and reproduction gates can conservatively reject or degrade that separate capability.

DuckDB is therefore the default CSV/Parquet backend, not part of the public contract. No DuckDB type
or SQL fragment crosses the engine API, and the native module is dynamically loaded only by that
backend or its runtime probe.

## What validation returns

The contract API accepts the object produced by a YAML parser and returns a deeply frozen,
camel-case declaration:

```ts
import {
  deriveDataSemantics,
  hashAdapterDeclaration,
  normalizeAdapterDeclaration,
} from "@veilquant/contract";

const declaration = normalizeAdapterDeclaration(parsedYaml);
const semantics = deriveDataSemantics(declaration);
const declarationHash = hashAdapterDeclaration(declaration);
```

`deriveDataSemantics()` does not collapse trust into one score. It preserves point-in-time mode,
availability origin, certification, vintage, survivorship, and mask support, then emits explicit
engine obligations such as `FILTER_AVAILABLE_TIME` or `FILTER_EVENT_TIME` and stable degradation
codes. Supplying an event time selects the basis active in that segment:

```ts
deriveDataSemantics(declaration, "2026-08-06"); // reconstructed segment
deriveDataSemantics(declaration, "2026-08-07"); // observed segment
```

Equivalent declarations have the same `sha256:` identity regardless of YAML key order or whether
whole-range observed availability used shorthand or a one-element segment array.

## Errors are meant to be fixed by tools

Invalid input raises `AdapterDeclarationError`, separate from a runtime C1-C6
`ContractViolation`. It carries:

- `code`: stable category such as `MISSING_EVIDENCE`, `INVALID_SEGMENTS`, or `INLINE_SECRET`;
- `path`: exact field such as `$.availability_basis[0].lag`;
- `remedy`: a short, actionable correction.

Unknown fields are rejected. A misspelling such as `availble_time` must not silently fall back to a
weaker guarantee.

## Why lineage is required for certified observed data

The statement `basis: observed` cannot prove itself. On first contact, a vendor may hand you fifteen
years of history; labelling that history observed would fabricate point-in-time evidence.

For `certified: true`, `lineage_ref` is mandatory. At registration the engine independently resolves
and hashes the lineage summary, then checks that rows marked observed do not claim availability
before collection began. A contradictory backfill is rejected. Without lineage the dataset may
still be used as uncertified data, but it never receives certified trust.

## Full wire reference

See the annotated [`adapter.yaml`](../packages/veil-contract/schemas/adapter.yaml) and the normative
degradation rules in [`contract.md`](./contract.md#5-guarantee-declarations-and-degradation).
