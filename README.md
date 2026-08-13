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

Status: **v0.1 / Stage 3 implementation, release acceptance pending.** The `veil-quant` Pi package now
registers `veil-data`, `veil-backtest`, and `veil-memory`; captures C6 chronology in Pi's append-only
session tree; keeps ordinary exploration tools unblocked; and writes content-addressed structural
run evidence plus an honest Markdown log. The engine beneath it provides the backend-neutral temporal
guard, CSV/Parquet file backend, read-set identities/snapshots, content-addressed artifacts, framed
runtime execution, per-decision mask-first WFA contracts, and the narrow promotion boundary. A
successful v0.1 run is `contract-verified` and still explicitly `unverified`: it contains no prices,
returns, metrics, gate verdict, or Experiment id. The hand-written golden-path metrics remain an
independent reference until Stage 4 pricing and statistical gates exist.

The source package can be installed locally now; `pi install npm:veil-quant@0.1.0` becomes available
only after the v0.1 tag passes release smoke and is published. Model-free and local acceptance do not
replace the remaining external own-data, bench, cross-OS user, hidden-set, and native CI trials.

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

## Start a loop

From a source checkout:

```bash
npm install
pi install ./packages/veil-agent
npm run agent-loop:verify # model-free cold reference
```

The libraries support Node 20.10 through 29; the repository-pinned Pi 0.84.1 model runner requires
Node 22.19 or newer.

Then follow the [30-minute quickstart](./docs/quickstart.md) to declare a private CSV, create
`.veil/project.yaml`, start from a brief, explore normally, and run `/veil-promote`. The default
profile never serializes the data root; use an environment variable when the data lives outside the
project.

## How it works

Two surfaces, different rules.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ your agent, your code, your workflow                                     │
├────────────────────────────┬──────────────────────────┬──────────────────┤
│ EXPLORATION                │ STRUCTURAL PROMOTION     │ CLAIM (Stage 4)  │
│ never blocked              │ enforced in v0.1        │ not in v0.1      │
│                            │                          │                  │
│ guarded views available;   │ artifact rerun at each  │ pricing, costs,  │
│ ordinary code and shell;   │ train/OOS decision;     │ statistical and  │
│ advisories never gate      │ C1-C6 chronology        │ null gates       │
│                            │                          │                  │
│ output: unverified notes   │ output: unverified      │ output: citable  │
│ and exploratory metrics    │ promotion candidate     │ Experiment       │
└────────────────────────────┴──────────────────────────┴──────────────────┘
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
packages/veil-engine/     point-in-time views, walk-forward verification, promotion evidence
packages/veil-agent/      the Pi package users install (published as veil-quant)
bench/                    Veil-bench: tasks, runner, bare-agent baselines
examples/golden-path/     independent reference + full structural evidence acceptance
examples/csv-pit/         the smallest adapter → guarded CSV view
examples/parquet-pit/     the same guarded contract over Parquet
examples/multi-file-pit/  one portable glob → one stable source manifest
examples/read-set/        atomic snapshot + independent-process replay
examples/snapshot-recovery/ explicit corrupt-evidence quarantine + audit
examples/veil-data/        cold point Arrow + exploration-grade panel snapshot
examples/own-data/         checkout-local own-CSV/Parquet inspection launcher
examples/artifact-identity/ explicit code tree + portable artifact identity
examples/artifact-execution/ guarded Arrow + clean framed artifact child
examples/walk-forward-windows/ explicit schedule + derived windows + deterministic run record
examples/walk-forward-contract/ per-decision PIT + mask-first C1-C4 contract record
examples/agent-loop/       cold Stage 3 brief → candidate → research-log loop
docs/                     one page per thing
```

## Documentation

| Page | For |
| --- | --- |
| [quickstart.md](./docs/quickstart.md) | Install the Pi package and run a private CSV through the first full loop |
| [concepts.md](./docs/concepts.md) | Exploration, verification, artifacts, candidates, Experiments, and gates |
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
| [examples/own-data](./examples/own-data) | Inspect a private CSV/Parquet source without editing Veil code |
| [examples/artifact-identity](./examples/artifact-identity) | Reproduce a Python artifact identity across roots and a clean process |
| [examples/artifact-execution](./examples/artifact-execution) | Execute a materialized artifact through the bounded child protocol |
| [examples/walk-forward-windows](./examples/walk-forward-windows) | Execute derived rolling windows through a custom backend and deterministic run record |
| [examples/walk-forward-contract](./examples/walk-forward-contract) | Verify fresh PIT and mask-first train/OOS decisions without binding to a database |
| [examples/agent-loop](./examples/agent-loop) | Run the Stage 3 orchestration in an isolated project without a model |
| [examples/golden-path](./examples/golden-path) | What a Veil research log looks like, with real numbers |
| [bench/README.md](./bench/README.md) | How scoring works: two axes, four attribution layers |
| [bench.md](./docs/bench.md) | Run, score, replay, and contribute Veil-bench tasks |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Three ways to contribute without reading the internals |

Written as they are built: `gates` and `faq` arrive with the features they document.

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
npm run data:inspect -- --help # inspect your own CSV/Parquet from this checkout
npm run agent-loop:verify # run the cold Stage 3 brief-to-candidate loop
npm run golden-path    # regenerate the reference study and print the table above
npm run golden-path:evidence:verify # run the full 370,728-row structural acceptance path
npm run bench:stage2:verify # run model-free T1-T5 enforcement and honest-task preflights
npm run bench:stage3:verify # verify the Pi surface and cold Stage 3 loop without a model
npm run bench:evaluate -- --profile veil ... # run the diagnostic model-enabled Veil profile
npm run release:verify # verify v0.1 package and Pi resource manifests without publishing
```

## License

MIT.
