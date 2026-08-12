# Veil

**A quant research harness that lets you explore freely and makes you verify before you claim.**

Veil sits on top of your normal AI coding workflow. You keep writing factors, models and backtests
with an agent exactly as you do now — Veil does not intercept that, does not replace your backtester,
and does not ask you to learn a new research API. It changes one thing:

> A number becomes a **result** only after the factor has been repackaged, re-executed walk-forward
> on windows where future data does not exist, and put through the gates. Everything else is labelled
> `unverified`.

Nobody would accept an editor that blocks their keystrokes. Everybody accepts CI that blocks their
merge. Veil is CI for research claims.

Status: **Stage 1 exit / Stage 2D implementation, pre-alpha.** The backend-neutral temporal guard,
native runtime gate, single/multi-file CSV/Parquet point-in-time backend, source/read-set v0
identities, durable snapshots with operator quarantine, minimum `veil-data` point/panel surface, and
path-independent content-addressed artifact identities, runtime-provider-neutral framed execution,
deterministic rolling/expanding training-window runs, and per-decision OOS mask-first contract
verification are now implemented. A `contract-verified` record binds complete C1-C4 evidence but
contains no prices, metrics, gates, or experiment verdict. The promotion boundary now admits only
that replay-verified record, checks hypothesis-registration chronology, and emits an explicitly
`unverified` candidate for later pricing and gates—not a citable Experiment. The 14-task bench,
runner, and first real
[two-model bare-agent baseline](./bench/baselines/kimi-stage1-full-v1/) are also complete. Independent scoring
review, an external docs-only trial, and remote CI confirmation remain before Stage 1 closes. An
independent [QBench Engineering baseline](./bench/baselines/kimi-qbench-engineering-v1/) now also
tests cold-start artifacts, causal reconciliation, recovery, and content-addressed manifests.
Nothing is installable yet. The first public release (v0.1) lands at the end of Stage 3 — see
[Roadmap](#roadmap).

---

## Why

An agent that writes its own backtest will, sooner or later, standardize with statistics that include
the future, fill at the bar it decided on, pick the window that worked, or try twenty variants and
report the best one. None of these look like bugs. All of them produce numbers that do not survive
contact with money.

Here is the same momentum factor, on the same synthetic market, under an honest protocol and under a
naive one. Each leaky row flips exactly one switch:

| Protocol | Sharpe (out of sample) |
| --- | --- |
| **honest** | **0.88** |
| honest, costs ignored | 2.81 |
| signal and fill on the same bar | 8.44 |
| lookback chosen on the full sample | 1.41 |
| **naive pipeline — every switch flipped** | **8.61** |
| naive pipeline, on a market with **no signal at all** | **7.21** |

The last row is the one that matters. A protocol that reports an edge on pure noise cannot be
evidence of anything. Full study and reproduction instructions:
[`examples/golden-path`](./examples/golden-path).

## How it works

Two surfaces, different rules.

```
┌──────────────────────────────────────────────────────────────────────┐
│ your agent, your code, your workflow                                 │
├───────────────────────────────┬──────────────────────────────────────┤
│ EXPLORATION                   │ VERIFICATION                         │
│ never blocked                 │ structurally enforced                │
│                               │                                      │
│ point-in-time views by        │ artifact re-executed window by       │
│ default, tradability mask     │ window; rows you could not have      │
│ attached, advisories when     │ known do not exist in the window     │
│ something looks off           │                                      │
│                               │ gates: costs, trials-aware           │
│ output: unverified            │ significance, parameter stability,   │
│                               │ falsification against synthetic null │
│                               │                                      │
│                               │ output: an experiment record — the   │
│                               │ only citable metric there is         │
└───────────────────────────────┴──────────────────────────────────────┘
```

The six invariants that hold this together — decision-time information sets, walk-forward only,
parameter locking, mask-first, claims-must-verify, hypothesis pre-registration — are specified in
[`docs/contract.md`](./docs/contract.md). They are enforced at the points listed there, and nowhere
else.

Veil is built as extensions to [Pi](https://github.com/badlogic/pi-mono), whose tool-call
interception, session log and package system it uses rather than reimplements. Veil does not fork Pi.

## Repository layout

```
packages/veil-contract/   the invariants, the declaration formats, their validators
packages/veil-engine/     point-in-time views, walk-forward verification, gates
packages/veil-agent/      the Pi package users install (published as veil-quant)
bench/                    Veil-bench: tasks, runner, bare-agent baselines
examples/golden-path/     the reference study, done by hand
examples/csv-pit/         the smallest adapter → guarded CSV view
examples/parquet-pit/     the same guarded contract over Parquet
examples/multi-file-pit/  one portable glob → one stable source manifest
examples/read-set/        atomic snapshot + independent-process replay
examples/snapshot-recovery/ explicit corrupt-evidence quarantine + audit
examples/veil-data/        cold point Arrow + exploration-grade panel snapshot
examples/artifact-identity/ explicit code tree + portable artifact identity
examples/artifact-execution/ guarded Arrow + clean framed artifact child
examples/walk-forward-windows/ explicit schedule + derived windows + deterministic run record
examples/walk-forward-contract/ per-decision PIT + mask-first C1-C4 contract record
docs/                     one page per thing
```

## Documentation

| Page | For |
| --- | --- |
| [contract.md](./docs/contract.md) | The specification: invariants, degradation rules, threat model |
| [adapters.md](./docs/adapters.md) | Declare time semantics, conservative defaults, lineage, and source bindings |
| [read-sets.md](./docs/read-sets.md) | Distinguish source, query, logical result, Arrow, and whole-read identities |
| [veil-data.md](./docs/veil-data.md) | Query guarded point views and export exploration-grade panels |
| [artifacts.md](./docs/artifacts.md) | Package and execute locked artifacts over guarded Arrow |
| [examples/csv-pit](./examples/csv-pit) | Run the smallest guarded CSV point-in-time view |
| [examples/parquet-pit](./examples/parquet-pit) | Run the same guarded view over generated Parquet |
| [examples/multi-file-pit](./examples/multi-file-pit) | Read a stable multi-file view through one portable glob |
| [examples/read-set](./examples/read-set) | Atomically persist and cold-replay one guarded read set |
| [examples/snapshot-recovery](./examples/snapshot-recovery) | Quarantine corrupt evidence and cold-verify its audit |
| [examples/veil-data](./examples/veil-data) | Exercise point/panel output in clean Node processes |
| [examples/artifact-identity](./examples/artifact-identity) | Reproduce a Python artifact identity across roots and a clean process |
| [examples/artifact-execution](./examples/artifact-execution) | Execute a materialized artifact through the bounded child protocol |
| [examples/walk-forward-windows](./examples/walk-forward-windows) | Execute derived rolling windows through a custom backend and deterministic run record |
| [examples/walk-forward-contract](./examples/walk-forward-contract) | Verify fresh PIT and mask-first train/OOS decisions without binding to a database |
| [examples/golden-path](./examples/golden-path) | What a Veil research log looks like, with real numbers |
| [bench/README.md](./bench/README.md) | How scoring works: two axes, four attribution layers |
| [bench.md](./docs/bench.md) | Run, score, replay, and contribute Veil-bench tasks |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Three ways to contribute without reading the internals |

Written as they are built: `concepts`, `quickstart`, `gates`, `faq`.

## Roadmap

| Stage | Delivers | Release |
| --- | --- | --- |
| 0 | Contract v1.0, skeleton, hand-written golden path, CI | — |
| 1 | Veil-bench: 14 tasks, runner, bare-agent baseline | — |
| 2 | Point-in-time views, adapters, verification engine, C1-C6 at runtime | — |
| 3 | The Pi package, end-to-end research loop | **v0.1** |
| 4 | Statistical gates, experiment memory, metric-level reproduction | **v0.2** |
| 5 | Specialist agents — only if real failure cases demand it | — |
| 6 | Hardening profile, full docs, model leaderboard | **v1.0** |
| 7 | Deployment alignment: artifact identity, parity gate | v2 |

Every stage exits on bench numbers, not on opinion. Safety may never regress; competence has to keep
climbing. The rules are in [`bench/README.md`](./bench/README.md); the invariants they protect are in
[`docs/contract.md`](./docs/contract.md).

## Development

Requires Node 20 or newer.

```bash
npm install
npm run check          # lint, types, tests, file cold probes, bench smoke, golden path
npm run golden-path    # regenerate the reference study and print the table above
```

## License

MIT.
