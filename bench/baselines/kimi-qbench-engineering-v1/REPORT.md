# QBench v2 Engineering Track — independent baseline

## Result

| Model | Q1 /18 | Q2 /22 | Q3 /18 | Q4 /18 | Q5 /24 | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Kimi K3, official | 14.50 | 8.00 | 9.00 | 3.25 | 6.75 | 41.50 /100 |
| Kimi K3, compatibility diagnostic | 14.50 | 16.50 | 9.00 | 6.75 | 21.25 | 68.00 /100 |
| Kimi K2.7 Code, official | 18.00 | evaluator error | 5.75 | 3.25 | 10.75 | 37.75 /78 scored |
| Kimi K2.7 Code, compatibility diagnostic | 18.00 | 19.25 | 5.75 | 14.00 | 16.25 | 73.25 /100 |

Official outputs are preserved unchanged. “Compatibility diagnostic” is a separate, non-official
audit: it supplies the semantic normalization described by QBench itself, then invokes the original
deterministic evaluator. Numerical reconciliation, causal clocks, portfolio constraints, Provider
sampling, risk reconstruction, and content hashes remain authoritative.

## Protocol

- QBench v2 Engineering Track only; one independent session per task, score@1, high thinking.
- Models: Kimi K3 and Kimi K2.7 Code. Display names are intentionally separated from mutable
  provider-side selectors.
- Qlib data release `2026-07-30`; archive SHA-256
  `2dfa8be5c38513e67cc18d1208b535660be6bf1612e0f3d19638518e107b5761`.
- Qlib source commit `b87a2c294d364a33fb739359886acffe8ec907d1`; Python 3.11 environment.
- Agent workspaces had no QBench source, evaluator, prior run, project context, extension, or skill.
  Network was disabled, Provider data was mounted read-only, and API/proxy variables were removed
  from child shells.
- Candidate runs and evaluator runs used separate isolated workspaces. The official harness checked
  Provider fingerprints before and after every candidate invocation.
- The local QBench test suite passed 34/34 before model runs. All ten candidate cold-start commands
  completed successfully. Kimi K2.7 Code's Q5 agent session ended with an API error during an empty
  post-completion retry, but its already-written submission subsequently passed the official cold
  run in 42.9 seconds, and its 11 submission tests passed in a fresh isolated replay; this is
  recorded as a runner-tail failure, not hidden.

## What the official scores say

Q1 was the strongest task: Kimi K2.7 Code earned 18/18, while Kimi K3 earned 14.5/18. Q3 exposed
real quantitative mismatches in both submissions. Kimi K3 included the portfolio date in the risk
window and used sample volatility where the evaluator used prior-only data and population
volatility. Kimi K2.7 Code reconstructed materially different volatility exposure and objective
values. Those points remain lost in the compatibility diagnostic.

Kimi K3's Q4 partitions were valid and the full build was fast, but the panel used ordinary columns
and a range index instead of the required `(instrument, datetime)` MultiIndex. Compatibility fixes
the manifest path lookup, not that substantive schema error. Kimi K2.7 Code's Q4 panel was exactly
equal to the reference frame; normalizing `label`/`file`/`file_hash`, nested fingerprints, and the
row count exposed the underlying 14/18 result. Remaining losses concern recovery/concurrency
evidence, which the diagnostic does not synthesize.

On Q5, Kimi K3 had 127/127 valid content hashes, all 32 daily-return tables reconciled, and all 32
full-period metric rows recomputed after `artifact_index.datasets` became visible to semantic
lookup. It still lacked the required complete statistic columns and explicit artifact links in the
report. Kimi K2.7 Code still lost points for only four rather than eight shared execution sets,
missing explicit return-cost reconciliation, incomplete metric statistics, and absent evidence
links. Its final repeated runs produced byte-identical metrics and robustness tables, but the plan,
result, and run manifest remained byte-different because they included generated timestamps; the
diagnostic does not erase that reproducibility limitation.

## Evaluator audit

The benchmark has several excellent design choices worth adopting:

- real cold-start CLIs rather than notebook fragments;
- read-only Provider fingerprinting before and after execution;
- cached references plus independent artifact recomputation;
- causal/metamorphic checks instead of trusting self-reported metrics;
- recovery, corruption, concurrency, memory, and hot-cache dimensions;
- no reward for a high Sharpe by itself.

The run also found reproducible evaluator defects or contract gaps:

1. Q2 crashes while normalizing a legal sparse fills table: it computes optional columns missing
   from orders, then selects them from fills without first checking that fills contains them.
2. Q2's alias table omits common equivalents such as `rebalance_date`, `exec_date`, `weight`,
   `execution_volume`, and before/after log filename variants.
3. Q4 promises directory aliases but drops the partition directory from candidate paths and omits
   `file`, `label`, `file_hash`, nested period, and structured fingerprint layouts.
4. Q4's prompt says the grader injects kill, truncation, and lock contention. The public orchestrator
   runs one ordinary cold command; the evaluator mostly trusts candidate benchmark flags and test
   source text for those dimensions instead of injecting the faults.
5. Q5 validates Kimi K3's content hashes but ignores the same `artifact_index.datasets` registry for
   semantic discovery. It also ignores list-form `shared_references`, nested validation summaries,
   `test_type`, sealed-plan hashes, and CSV chart source data.
6. Some Q5 report checks depend on a narrow keyword set (`advance`/`reject`) even when the report says
   “DO NOT PROCEED” or “does not support entering the next stage.” These prose points were noted but
   were not added by the compatibility diagnostic.

This is why both columns are published. Official scores remain reproducible benchmark outputs;
diagnostic scores answer the narrower question “what survives the benchmark's documented semantic
normalization promise?”

## Changes driven into Veil

This baseline directly produced the following Stage 1 runner changes:

- child shells now receive a credential/proxy-stripped environment and persistent per-run
  HOME/TMP/XDG directories;
- file tools reject lexical and symlink workspace escapes while accepting safe sandbox-visible
  absolute workspace paths;
- runs write atomic phase checkpoints and a content-addressed artifact manifest;
- a tail transport error can be recovered only after input integrity, submission schema, evidence,
  and deterministic scoring all pass; timeouts and incomplete outputs still fail;
- benchmark reports distinguish official values, compatibility normalization, and substantive
  calculation failures instead of blending them.

Fault injection and an OS-level cross-platform sandbox remain later hardening work. QBench shows
that both should be tested by the harness itself rather than inferred from candidate-authored logs.
