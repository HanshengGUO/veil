# Changelog

All notable changes to this project are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versions are shared across all packages. The meaning of C1-C5 is frozen from v0.1; C6 and the
degradation tiers are provisional until v1.0, and other APIs may change during 0.x. Every change
appears here.

## [Unreleased]

### Changed

Contract v1.0 review rulings, applied to the specification:

- **C3 now requires a candidate count** (`trialsDeclared`): promoting the best of thirty explored
  ideas is a multiple-testing event even when twenty-nine were never verified. The declared number is
  not taken on trust — the effective count is `max(declared, observed lower bound)` from the session
  log and from prior experiments against the same hypothesis family, and it feeds the trials parameter
  of the significance test rather than sitting in a manifest.
- **C3's literal declaration narrowed** to data-derived constants, with structural constants (trading
  days per year, epsilons) whitelisted. Undeclared literals are still treated as parameters. The rule
  is documented as friction reduction, not detection: nothing can statically tell where a number came
  from.
- **C6 split into a hard and a soft half.** Registration preceding verification is machine-checked by
  timestamp; the *specificity* of automatically captured content cannot be guaranteed, and the
  specification now says so rather than implying a stronger guarantee.
- **C5's credential clause corrected.** It claimed the engine holds all data credentials, which is not
  true of a user who already has database access in their own shell. It now states what is actually
  enforced: the engine grants the agent no new credentials.
- **C4 gained a declared operator exemption** for research whose subject is the untradable instruments
  themselves (halt effects, delistings). It is audited and marks every conclusion reached through it.
  C4 itself admits no exemption.
- **Stability promise scoped**: C1-C5 frozen from v0.1; C6 and the §5 degradation tiers provisional
  until v1.0, since the statistical gates that exercise them arrive in Stage 4. Identifiers `C1`-`C6`
  are stable from v0.1 regardless, and moving an enforcement point earlier counts as strengthening
  rather than a semantic change.

### Added

- **Content-addressed artifact v0 identity**: explicit portable code files are captured twice and
  hashed individually and as a tree, independent of checkout root, mtimes, and creation order.
  Normalized manifests bind code to logical runtime/entrypoint, immutable parameters, adapter
  declaration hashes and their development read-sets, trials, WFA protocol, hypothesis, and cost model.
  Independent verification rejects tampering, unknown fields, symlinks, unsafe paths, credentials,
  and non-canonical values; a clean-process Python-package identity probe runs in the default check.
- **`veil-data` minimum surface**: backend-neutral point reads and exploration-grade bitemporal panel
  exports require an explicit `as_of`, retain a declared tradability mask, and expose only Arrow
  that passed the common temporal guard. Snapshot writes are a separate explicit action. The
  dependency-injected CLI core accepts only point/panel, projection, decision time, and Arrow or
  snapshot output; backend selection, physical roots, SQL, DSNs, and credentials remain outside it.
- **Durable read-set snapshots**: guarded Arrow and its manifest publish atomically into a local
  content-addressed namespace, converge under concurrent writers, revalidate on every read, and fail
  closed for missing or corrupt evidence without silently querying a current source or overwriting a
  damaged object. Read-only inspection now classifies valid/missing/invalid objects; a separate
  operator capability can quarantine only intrinsically corrupt evidence with durable intent/result
  hashes, per-id recovery locking, retained forensic bytes, and explicit trusted republication.
- **Stable multi-file source manifests**: file adapters accept confined portable globs and hash the
  exact sorted set of root-relative members before and after each read. Added, removed, renamed,
  replaced, or truncated members change source identity or raise `SOURCE_CHANGED`; paths, mtimes,
  discovery order, and binding ids remain outside the identity.
- **Database-neutral temporal protection** in `@veilquant/engine`: SQL-free read plans, replaceable
  capability-declared backends, opaque runtime source bindings, and one mandatory Arrow IPC guard
  that independently removes future rows even when a backend claims predicate pushdown.
- **Read-set v0 identity and verification**: every guarded result separates declaration, physical
  source, canonical query, canonical schema/result, and whole-manifest hashes. Result identity is
  stable across CSV/Parquet, physical column order, input row order, binding roots, and Arrow IPC
  layout, while a separate Arrow hash preserves the exact delivered bytes and order. Strict
  verification recomputes stored Arrow evidence and rejects changed manifests, rows, layouts,
  declarations, sources, or expected ids with `INVALID_READ_SET`; a disk round-trip cold probe runs
  in the default check.
- **Default CSV/Parquet point-in-time backend**: strict `adapter.yaml` loading, realpath-confined
  source bindings, read-only DuckDB projection/time pushdown, SHA-256 source identity checked before
  and after each query, preserved Arrow schemas for empty results, and fail-closed fallback when
  temporal values are invalid. Cold examples keep a future sentinel out of both formats. Metamorphic
  tests verify that reordered Parquet and CSV produce the same guarded rows and primitive Arrow
  schema while retaining distinct physical source hashes. DuckDB v1.4 LTS remains an implementation
  detail behind the same replaceable backend contract.
- **Adapter declaration validation** in `@veilquant/contract`: strict field-addressable errors,
  conservative defaults, event-time `[from, until)` availability segments, evidence requirements for
  reconstructed/assumed timestamps, orthogonal degradation and engine-obligation derivation,
  canonical declaration hashes, and lineage cross-validation for certified observed data. Portable
  source locators are now separated from runtime paths and credentials. See
  [`docs/adapters.md`](./docs/adapters.md).
- **Veil-bench v1 task set and runner**: 14 deterministic, parameterized tasks (seven calibrated
  traps and seven honest tasks), loud/silent/structural calibration, oracle-isolated workspaces,
  structured submissions, Pi event capture, deterministic G1-G4 attribution, safety/competence
  aggregation, two-model baseline reporting, and a four-task cross-platform CI smoke set. See
  [`docs/bench.md`](./docs/bench.md).
- **First full bare-agent baseline**: Kimi K3 and K2.7 Code over all 14 tasks, with raw failures
  retained as zero-credit outcomes and reviewed aggregates published under
  [`bench/baselines/kimi-stage1-full-v1`](./bench/baselines/kimi-stage1-full-v1/).
- **Independent QBench Engineering baseline and evaluator audit**: five score@1 tasks for Kimi K3
  and Kimi K2.7 Code, with official results kept separate from a reproducible compatibility-normalized
  diagnostic. The audit drove credential-stripped shell environments, symlink-safe file tools,
  persistent per-run temp/config directories, atomic run checkpoints, content-addressed artifact
  manifests, and deterministic recovery of valid terminal artifacts after a tail transport error.
  See [`bench/baselines/kimi-qbench-engineering-v1`](./bench/baselines/kimi-qbench-engineering-v1/).
- **Veil Contract v1.0** ([`docs/contract.md`](./docs/contract.md)): the six invariants, the
  guarantee-declaration and degradation rules, the `ContractViolation` shape, and the v1 threat
  model.
- **Golden path** ([`examples/golden-path`](./examples/golden-path)): the reference study, written by
  hand. A deterministic synthetic market (165 instruments, 2016-2024, with halts, delistings and a
  lagged fundamentals feed), one momentum factor evaluated under an honest protocol and seven
  variations, and a null-environment comparison. Metrics are committed and reproduced bit-identically
  on Linux, macOS and Windows.
- **Declaration formats**: annotated schemas for
  [`adapter.yaml`](./packages/veil-contract/schemas/adapter.yaml) and
  [`artifact.yaml`](./packages/veil-contract/schemas/artifact.yaml), and a bench task template
  ([`bench/tasks/_TEMPLATE`](./bench/tasks/_TEMPLATE)) that doubles as the task contribution guide.
- **`availability_basis` and `provenance` in the adapter declaration.** Having an availability
  timestamp is not the same as being able to trust it: the history a vendor hands over on the first
  pull was never observed arriving. Its origin is now declared per segment — `observed`,
  `reconstructed`, or `assumed`, the last degrading exactly like a missing `available_time`.
  Declaring a backfill as `observed` is the one lie the data itself can never contradict, which is
  why it has to be declared rather than inferred.
- **`@veilquant/contract`**: the invariant registry and `ContractViolation`.
- Package skeletons for `@veilquant/engine`, `veil-quant` (the Pi package users install), and the
  bench runner, each documenting what it delivers and when.
- Repository scaffolding: npm workspaces, TypeScript 7 strict with erasable syntax only, Biome,
  Vitest, and a three-platform CI matrix.

### Notes

- Nothing is installable yet. The first public release is v0.1, at the end of Stage 3.
