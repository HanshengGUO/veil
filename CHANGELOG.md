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
- **Stage 3 research-loop guidance now converges on the public contract**: the skill ships a minimal
  runtime-decoded Arrow factor, gives the exact decision-schedule topology, keeps development read
  sets on one registered dataset, rejects filesystem cost-model references with an actionable
  logical-id remedy, and treats immutable C1-C4 conflicts as terminal rather than silently changing
  the research question. Successful promotion and truthful terminal rejection now have explicit
  stop conditions, while missing-mask diagnostics forbid inventing adapter guarantees.
- **Stage 3 protocol claims are now concordant with their candidates**: explicit zero-lag requests
  reach the engine and receive a structured C1 rejection instead of being flattened into a request
  shape error. Public task manifests can freeze execution lag, and the Veil bench scorer rejects an
  effect at C5 when its cited immutable candidate changed the task's purge, embargo, or execution
  timing. Guidance now states that an unverified local metric cannot support allocation.

### Fixed

- **Node artifact runtimes now start portably on Windows**: TypeScript loader arguments remain
  `file://` module specifiers for Node's `--import` flag instead of becoming drive-letter paths that
  Node interprets as unsupported URL schemes. The engine also supplies isolated values for the
  variables libuv requires on Windows, preventing it from restoring the developer's path, temporary
  directory, and user profile. The default agent runtime, public examples, Stage 3 acceptance, and
  subprocess fixtures all use the same portable form.
- **Portable npm installs no longer inherit a contributor's registry mirror into the lockfile**:
  project defaults point at the HTTPS npm registry, and zero-dependency preinstall validation rejects
  HTTP or third-party tarball URLs before CI or release jobs call `npm ci`.

### Added

- **Stage 3 single-agent Pi loop**: the publishable `veil-quant` package registers `veil-data`,
  `veil-backtest`, and `veil-memory`; captures the first brief/hypothesis and verification start in
  Pi's append-only active branch; exposes strict brief, hypothesis, promotion, and structural replay
  commands; and ships a research-loop skill plus plan/log prompt templates. Built-in coding tools
  remain unblocked. `tool_result` heuristics for full-sample fitting, future functions, and current
  universes append advisories without changing tool success.
- **Stage 3 promotion ledger**: a project-local profile keeps adapter paths, data roots, runtime
  executables, and bindings outside portable evidence. Promotion packages explicit factor files,
  performs fresh per-decision C1-C4 execution, derives C6 chronology from Pi entry ids/timestamps,
  and writes one content-addressed evidence file plus an append-only Markdown entry. Success is a
  research run and `unverified` candidate—never an Experiment or performance verdict. Rejections
  receive a terminal run entry and actionable public diagnostic. Known point-in-time and
  survivorship-critical degradations remain usable for exploration but fail promotion as C1.
- **Stage 3 bench profile**: the Pi runner now selects `bare` or `veil` without changing task inputs.
  Veil runs load the packaged extension/resources, collect active-branch violation and candidate
  evidence, require honest submissions to cite immutable run evidence, and reject premature
  Experiment or verified-metric claims. The model-free acceptance separately names deferred Stage 4
  traps and never represents model, hidden-set, or external-user work as completed.
- **v0.1 release path and cold example**: package versions and dependency order are aligned at
  `0.1.0`; the Pi manifest includes extension, skills, prompts, generic framed Node runtime, and
  public package metadata. A tag-triggered workflow packs and installs all three public packages on
  Linux, macOS, and Windows before provenance-enabled npm publication and GitHub Release creation.
  `examples/agent-loop` runs the complete model-free brief-to-candidate flow in an isolated project,
  and the 30-minute quickstart now covers a private CSV through structural promotion.

- **Stage 2 own-data quickstart**: a checkout-local CSV/Parquet launcher now turns an adapter,
  runtime root, explicit decision time, and optional projection into a path-free guarded-view report
  without requiring users to edit Veil source. Row preview is opt-in and capped. The public
  quickstart includes conservative availability guidance, report interpretation, and a privacy-safe
  external 30-minute CSV trial checklist.

- **Stage 2 bench acceptance**: all public task adapters now use the current portable
  `source.locator` schema and are strictly loaded during snapshot verification. A fast model-free
  acceptance checks the retired T1 future-isolation mechanism, rejects T2 as C2, propagates T3/T4
  data degradations, rejects T5's same-session execution as C1, and preflights all seven honest tasks
  without blocking exploration. Artifact protocols now bind a minimum explicit-session execution
  lag alongside purge, embargo, and holding horizon.

- **Golden-path structural evidence flow**: guarded prices and point-in-time membership are joined by
  a database-neutral, independently replayable composite-source manifest. The materialized result
  returns through the temporal guard, the honest candidate factor runs in framed per-decision
  expanding WFA, and the replayed contract produces only an unverified promotion candidate. Bounded
  execution concurrency and records-only Arrow retention keep large contracts deterministic and
  memory-bounded. The hand-written pricing, leak calibration, null environment, and committed metrics
  remain independent and unchanged.

- **Framed artifact execution**: opaque runtime providers resolve logical runtime constraints while
  exposing only a path-free concrete implementation identity. The engine verifies and materializes
  artifact code, rejects reuse of development evidence, supplies only exact guarded Arrow plus
  immutable identity-bound metadata to a clean no-shell child, and validates one bounded result
  frame. Timeout/cancel, non-zero/signal exits, malformed/partial/duplicate/oversized/trailing frames,
  unreadable Arrow, code races, and stdout/stderr floods fail closed without exposing executable
  paths, inherited developer environment/credentials, or private diagnostics. The wire codec is
  language- and database-neutral, with a clean Node adapter example in the default check.
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

- v0.1 package and release automation are prepared for source/path installation. The npm command is
  not available until a versioned project release tag passes the release matrix and the publish job;
  local automation is not represented as an npm or external-user release pass.
