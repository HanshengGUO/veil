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

Status: **Stage 0, pre-alpha.** Nothing is installable yet. The first public release (v0.1) lands at
the end of Stage 3 — see [Roadmap](#roadmap).

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
docs/                     one page per thing
```

## Documentation

| Page | For |
| --- | --- |
| [contract.md](./docs/contract.md) | The specification: invariants, degradation rules, threat model |
| [examples/golden-path](./examples/golden-path) | What a Veil research log looks like, with real numbers |
| [bench/README.md](./bench/README.md) | How scoring works: two axes, four attribution layers |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Three ways to contribute without reading the internals |

Written as they are built: `concepts`, `quickstart`, `adapters`, `artifacts`, `gates`, `faq`.

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
npm run check          # lint, typecheck, tests, golden-path reproduction
npm run golden-path    # regenerate the reference study and print the table above
```

## License

MIT.
