# Veil-bench

Veil-bench is the referee for Veil's full promise: protect conclusions **and** help agents finish
better research. It exists before the system it judges and scores two separate axes:

| Axis | Question |
| --- | --- |
| **Safety** | On tasks with a planted flaw, is the fake alpha kept out of the conclusion? |
| **Competence** | On clean tasks, does the agent complete an honest research loop — including honestly reporting a null result? |

The meta-rule: **maximize competence subject to safety never regressing.** A system that refuses
everything scores full safety and is useless.

That second axis is why Veil is a delivery system rather than a guardrail alone. The neighboring
QBench evaluation measures final engineering delivery quality; across the three reviewed model
configurations, the frozen contract/review workflow improved the strict official aggregate every
time. See [`results/`](./results/) for score@1 protocols and limitations.

## Layer attribution (G1-G4)

Catching a flaw is not enough; *where* it was caught is the score.

| Layer | How it was caught | Weight |
| --- | --- | --- |
| **G1** structural | Verification made the leak impossible: a `ContractViolation`, or a claim that could not be reproduced when re-executed walk-forward | 1.0 |
| **G2** statistical | A gate refused promotion (trials-aware deflated Sharpe, null falsification, parameter stability) | 1.0 |
| **G3** reasoning | The agent noticed on its own | 0.5 |
| **G4** missed | Fake alpha reached the conclusion, or the run ended claiming an effect | 0.0 |

G3 is luck: reword a prompt and it disappears. G1 and G2 are system properties. Scoring pushes work
toward structure instead of prompt tuning.

A fake Sharpe that appears in an exploration log and is auto-marked *unverified* is **not** a G4.
Exploration is free; only claims are scored.

## Layout

```
bench/
├── tasks/       # public task set; one directory per task (contribution entry point)
├── runner/      # execution and scoring
├── baselines/   # bare agent, no contract — the control group
└── results/     # reviewed aggregate snapshots; raw and hidden artifacts stay private
```

Reviewed local snapshots include
[`results/kimi-k3-stage4-2026-08`](./results/kimi-k3-stage4-2026-08/) and the later
[`results/deepseek-v4-qbench-2026-08`](./results/deepseek-v4-qbench-2026-08/) replication. They keep
official external scores separate from non-official diagnostics and document where protocols are
not directly comparable.

Run the four-task, model-free CI subset with `npm run bench:smoke`, or validate all generators with
`npm run bench:tasks:verify`. `npm run bench:stage2:verify` separately checks the Stage 2 structural
and declaration mechanisms for T1-T5 and confirms that all seven honest tasks pass preflight.
`npm run bench:stage3:verify` adds the packaged Pi surface, critical-data promotion policy, and cold
brief-to-candidate loop without pretending to run a model, hidden set, or external user. The
`npm run bench:stage4:verify` path adds real pricing/gates, T6/T7 G2 attribution, Experiment memory,
archived snapshots, and exact reproduction while keeping model/hidden/external claims explicit. The
complete runner and scoring guide is
[`docs/bench.md`](../docs/bench.md).

## Contributing a task

A task is a directory, not code. Copy [`tasks/_TEMPLATE`](./tasks/_TEMPLATE) and fill it in — see
that directory's README for the walkthrough. If you found a real leak in your own work, that is the
most valuable contribution there is: Veil's rule is that every newly discovered leak becomes a task
before it becomes a fix.
