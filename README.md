# Veil

English | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/HanshengGUO/veil/actions/workflows/ci.yml/badge.svg)](https://github.com/HanshengGUO/veil/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/HanshengGUO/veil?display_name=tag)](https://github.com/HanshengGUO/veil/releases)
[![npm](https://img.shields.io/npm/v/veil-quant?logo=npm&label=veil-quant)](https://www.npmjs.com/package/veil-quant)
[![Node.js](https://img.shields.io/node/v/veil-quant?logo=nodedotjs)](./packages/veil-agent/package.json)
[![License: MIT](https://img.shields.io/github/license/HanshengGUO/veil)](./LICENSE)

**An evidence-first harness for AI-assisted quant research — explore freely, then turn promising
work into verified, reproducible results.**

Veil is a harness around your normal AI coding workflow. You keep writing factors, models and
backtests with an agent exactly as you do now — Veil does not intercept that, does not replace your
backtester, and does not ask you to learn a new research API. It adds a delivery path that turns
promising exploration into reviewable, reproducible, promotion-ready evidence:

> A number becomes a **result** only after the factor has been repackaged, re-executed walk-forward
> on windows where future data does not exist, and put through the gates. Everything else is labelled
> `unverified`.

Nobody would accept an editor that blocks their keystrokes. Everybody accepts CI that blocks their
merge. Veil is CI and an evidence delivery pipeline for quant research.

> One result surprised us: in the evaluated workflow, contracts, independent review, and bounded
> repair did more than protect the work — they improved the quality of the final delivery.

Veil still keeps unsafe alpha out of claims. The same structure also makes good work easier to
review and continue: the contract is explicit, failed ideas stay in memory, and a result can be
reproduced without reconstructing the original chat session.

Status: **[v0.1.0](https://github.com/HanshengGUO/veil/releases/tag/v0.1.0) is available on npm.**
The release passed package installation smoke tests on Linux, macOS, and Windows before publication.
Broader plugin-author, hidden-set, and user acceptance continues toward v0.2.

The `veil-quant` Pi package registers `veil-data`, `veil-backtest`, and `veil-memory`. The engine
beneath it handles temporal guards, CSV/Parquet reads, read-set snapshots, artifact execution, and
mask-first walk-forward contracts. A run without a Stage 4 block stops at a `contract-verified` but
explicitly `unverified` candidate. A complete run adds OOS pricing, eight gates, Experiment memory,
and exact reproduction from archived code and read sets.

The release workflow publishes only after the package matrix and full repository gate pass. That
release evidence does not replace the remaining external plugin-author, full hidden-set, and
cross-OS user trials required for formal Stage 4 exit.

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

## Measured results

The evaluation evidence below was collected locally before the first public release. Model tasks
were frozen score@1 runs: one session per task, with no result-selected reruns. Kimi K3 was evaluated
at Pi thinking level `low` on Veil-bench and `high` on QBench. A later QBench-only replication
evaluated DeepSeek V4 Flash and V4 Pro at `high` under one frozen protocol.

> Across all three evaluated QBench model configurations, the strict official aggregate increased:
> **+4.25 for Kimi K3, +3.25 for DeepSeek V4 Flash, and +3.25 for DeepSeek V4 Pro.**

| Evidence                  | Reference                                                                              | Measured result                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Veil-bench public**     | Historical bare Kimi K3 control: 35.7% safety, 57.1% competence, 2 false-effect claims | Current Veil profile: **100% safety**, **71.4% competence**, 0 false-effect claims; all 8 traps stopped at G1/G2        |
| **Held-out safety check** | Frozen acceptance: safety >= 87.5%, no G4 or false-effect claim                        | **4/4 traps stopped at G1**, 0 G4, 0 false-effect claims; the single honest smoke task passed                           |
| **QBench v2 Engineering** | Prior Kimi K3 official score: 41.50/100                                                | Internal opt-in delivery workflow: **45.75/100 strict official aggregate** (**+4.25**; evaluator error counted as zero) |
| **QBench replication**    | Bare DeepSeek V4 Flash / Pro: 40.00 / 41.00                                            | Same frozen workflow: **43.25 / 44.25** — **+3.25 for both models** (evaluator error counted as zero)                   |

These rows measure different things. Veil-bench evaluates whether Veil keeps invalid research out of
claims while preserving useful work. QBench evaluates general engineering delivery; its gain came
from an internal test-time contract/review workflow, not a change to QBench or Veil's core. The
DeepSeek replication held the benchmark release, data fingerprint, task budgets, runner and workflow
fixed; both model variants independently gained 3.25 strict official points. Separate non-official
compatibility diagnostics did not move uniformly with official scores and remain outside the
headline; their full values are retained in the linked snapshots. The official score@1 gains are not
presented as causal estimates. The DeepSeek row is QBench-only and does not claim a Veil-bench
competence gain. The held-out set is deliberately small, and its one honest task is a smoke test
rather than a hidden competence estimate.

See the reviewed evaluation snapshots for [Kimi K3](./bench/results/kimi-k3-stage4-2026-08/) and the
[DeepSeek V4 QBench replication](./bench/results/deepseek-v4-qbench-2026-08/) for protocols, integrity
notes, machine-readable results, and limitations.

## Start a loop

Install the Pi package from npm:

```bash
pi install npm:veil-quant
```

For source development:

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
│ never blocked              │ enforced                │ enforced locally │
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
packages/veil-agent/      the Pi package users install (npm name: veil-quant)
bench/                    Veil-bench: tasks, runner, bare-agent baselines
bench/results/            reviewed local evaluation snapshots
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
examples/stage4-plugin/    runnable CostModel + NullGenerator contribution template
examples/stage4-claim/     direct pricing → gates → Experiment → reproduction chain
examples/stage4-agent-loop/ default tool path with rejection memory and snapshot replay
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
| [gates.md](./docs/gates.md) | Understand Stage 4 pricing, gate-policy, and Experiment evidence |
| [faq.md](./docs/faq.md) | Resolve common claim, degradation, plugin, and reproduction questions |
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
| [examples/stage4-plugin](./examples/stage4-plugin) | Implement and execute custom cost and null providers |
| [examples/stage4-claim](./examples/stage4-claim) | Run direct Stage 4 issuance, memory, and exact reproduction |
| [examples/stage4-agent-loop](./examples/stage4-agent-loop) | Run the default agent path through rejected and accepted Experiments |
| [examples/golden-path](./examples/golden-path) | What a Veil research log looks like, with real numbers |
| [bench/README.md](./bench/README.md) | How scoring works: two axes, four attribution layers |
| [bench.md](./docs/bench.md) | Run, score, replay, and contribute Veil-bench tasks |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Three ways to contribute without reading the internals |

## Roadmap

| Stage | Delivers | Release |
| --- | --- | --- |
| 0 | Contract v1.0, skeleton, hand-written golden path, CI | — |
| 1 | Veil-bench: 15 current tasks, runner, bare-agent baseline | — |
| 2 | Point-in-time views, adapters, verification engine, C1-C6 at runtime | — |
| 3 | The Pi package, end-to-end research loop | **v0.1** |
| 4 | Statistical gates, experiment memory, metric-level reproduction | **v0.2** |
| 5 | Specialist agents — only if real failure cases demand it | — |
| 6 | Hardening profile, full docs, model leaderboard | **v1.0** |
| 7 | Deployment alignment: artifact identity, parity gate | v2 |

Every stage exits on bench numbers, not on opinion. Safety may never regress; competence and delivery
quality have to keep climbing. The rules are in [`bench/README.md`](./bench/README.md); the invariants
that make better delivery trustworthy are in [`docs/contract.md`](./docs/contract.md).

## Development

Requires Node 20 or newer.

```bash
npm install
npm run check          # lint, types, tests, file cold probes, bench smoke, golden path
npm run data:inspect -- --help # inspect your own CSV/Parquet from this checkout
npm run agent-loop:verify # run the cold Stage 3 brief-to-candidate loop
npm run stage4-plugin:verify # execute the public plugin conformance example
npm run stage4-agent:verify # run complete tool-path Experiment archival and reproduction
npm run golden-path    # regenerate the reference study and print the table above
npm run golden-path:evidence:verify # run the full 370,728-row structural acceptance path
npm run bench:stage2:verify # run model-free T1-T5 enforcement and honest-task preflights
npm run bench:stage3:verify # verify the Pi surface and cold Stage 3 loop without a model
npm run bench:stage4:verify # verify model-free gates, memory, T6/T7 attribution, and replay
npm run bench:evaluate -- --profile veil ... # run the diagnostic model-enabled Veil profile
npm run release:verify # verify v0.1 package and Pi resource manifests without publishing
```

## License

MIT.
