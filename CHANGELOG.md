# Changelog

All notable changes to this project are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versions are shared across all packages. The meaning of C1-C5 is frozen from v0.1; C6 and the
degradation tiers are provisional until v1.0, and other APIs may change during 0.x. Every change
appears here.

## [Unreleased]

### Changed

Contract v1.0 review rulings, applied to the specification:

- **C3 now requires a candidate count** (`trials_declared`): promoting the best of thirty explored
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
- **Declaration formats**: draft schemas for
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
