# Baselines

The control group: a bare coding agent with no contract, no verification surface, and no gates,
running the same tasks.

Its purpose is evidence, not embarrassment. A baseline should reproduce each task's calibrated
failure mode: an inflated headline result for a loud trap, a stable paired distortion for a silent
trap, or acceptance of an invalid protocol for a structural trap. If it does not, the task needs
investigation before any Veil score from it can be trusted.

Baselines also answer the positive question: did the added structure help the agent deliver better
work, or did it only add ceremony? Safety, competence, delivery quality, failures, and runtime stay
separate so the project cannot market refusal or latency as progress.

Generate a local two-model report with `npm run bench:baseline`; see
[`docs/bench.md`](../../docs/bench.md). Raw event logs live under the ignored `bench/runs/` directory.
Only copy a reviewed `REPORT.md` and `summary.json` here. Provider failures and incomplete sessions
are recorded as failures, never filled in with expected or fixture-derived scores.

Published baselines:

- [Kimi Stage 1 full baseline](./kimi-stage1-full-v1/): Kimi K3 and Kimi K2.7 Code over all 14 tasks.
- [Kimi QBench Engineering baseline](./kimi-qbench-engineering-v1/): Kimi K3 and Kimi K2.7 Code
  over the five QBench v2 Engineering tasks, with official and compatibility-audit results kept
  separate.

The Stage 1 public report must cover all 14 tasks and at least two models. Every task must reach a
recorded terminal outcome; individual timeouts or invalid submissions remain explicit zero-credit
failures rather than blocking or silently shrinking the report. A provider-wide outage is not a
baseline.
