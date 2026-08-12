# QBench v2 Engineering baseline

Independent score@1 runs of **Kimi K3** and **Kimi K2.7 Code** on the five QBench v2 Engineering
tasks, using the documented 2026-07-30 Qlib release.

| Model | Official public evaluator | Compatibility-normalized diagnostic |
| --- | ---: | ---: |
| Kimi K3 | 41.50 / 100 | 68.00 / 100 |
| Kimi K2.7 Code | 37.75 / 78 scored; Q2 evaluator crashed | 73.25 / 100 |

The diagnostic column is deliberately non-official. It reruns the original numerical and causal
checks after normalizing only semantically equivalent field names and manifest layouts promised by
the benchmark documentation; it does not repair candidate calculations.

See [REPORT.md](REPORT.md) for per-task results, evaluator findings, and the resulting Veil changes.
Machine-readable values are in [summary.json](summary.json).
