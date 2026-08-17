# Local evaluation snapshot — DeepSeek V4 on QBench, August 2026

This is a reviewed aggregate of local, pre-release QBench runs. It is evidence for one frozen
test-time delivery workflow, not a production guarantee, a Veil-bench result, or a claim about every
future revision behind these hosted model names. Raw model sessions remain local.

Machine-readable values are in [`summary.json`](./summary.json). QBench is an external engineering
diagnostic; it does not contribute to Veil-bench safety or competence.

## Headline result

The same workflow improved the strict official aggregate by **3.25 points for both evaluated model
variants**.

| Model | Run | Q1 | Q2 | Q3 | Q4 | Q5 | Strict official aggregate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek V4 Flash | bare baseline | 14.50 | 0* | 6.75 | 9.25 | 9.50 | 40.00 |
| DeepSeek V4 Flash | delivery workflow | 14.50 | 0* | 10.50 | 7.25 | 11.00 | **43.25 (+3.25)** |
| DeepSeek V4 Pro | bare baseline | 18.00 | 0* | 6.75 | 3.75 | 12.50 | 41.00 |
| DeepSeek V4 Pro | delivery workflow | 14.50 | 0* | 7.25 | 11.00 | 11.50 | **44.25 (+3.25)** |

`*` In all four Q2 cells, the candidate returned zero and produced the required artifacts, but the
unchanged official evaluator exited with code 1 and produced no `evaluation.json`. The frozen strict
rule counts each evaluator error as zero. The other four tasks therefore provide a common 78-point
official denominator.

## Frozen protocol

- Model selectors: `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro`.
- Five QBench v2 Engineering tasks, Pi thinking level `high`, score@1, and the task metadata's
  original 120/180-minute limits.
- Baseline: the default single-session runner with no opt-in workflow flags.
- Treatment: delivery discipline, a public-contract ledger, isolated black-box challenge,
  independent contract review, bounded repair, and fail-closed evidence precedence.
- Every baseline cell completed before treatment began. Official results were not fed back into
  later task generation, and no task was rerun based on its score.
- Python 3.12.3, Qlib 0.9.7, and the 2026-07-30 data release with archive SHA-256
  `2dfa8be5c38513e67cc18d1208b535660be6bf1612e0f3d19638518e107b5761`.

The workflow did not modify QBench tasks, cases, data, completed submissions, or the official
evaluator, and it did not modify Veil core. All 20 runner tasks produced a submission and an official
`run_report.json`; 16 produced `evaluation.json`, with the four Q2 evaluator errors retained.

## Non-official compatibility diagnostic

The compatibility audit applies documented semantic-layout normalization while leaving numerical,
causal, risk, and portfolio checks unchanged. It is supplemental and does not replace the official
result.

| Model | Run | Compatible Q2 | Compatible Q4 | Compatible Q5 | Diagnostic aggregate |
| --- | --- | ---: | ---: | ---: | ---: |
| DeepSeek V4 Flash | bare baseline | 14.00 | 9.25 | 9.50 | 54.00 |
| DeepSeek V4 Flash | delivery workflow | 13.25 | 7.25 | 12.00 | 57.50 (+3.50) |
| DeepSeek V4 Pro | bare baseline | 14.75 | 9.00 | 15.75 | 64.25 |
| DeepSeek V4 Pro | delivery workflow | 10.00 | 11.00 | 12.50 | 55.25 (-9.00) |

The strict official gain replicated across both variants; the compatibility result did not. The
headline is therefore limited to the strict official aggregate.

## Runtime and limitations

| Model | Baseline runner time | Workflow runner time | Multiple |
| --- | ---: | ---: | ---: |
| DeepSeek V4 Flash | 2:45:28 | 6:24:02 | 2.32x |
| DeepSeek V4 Pro | 3:19:45 | 5:34:46 | 1.68x |

- The workflow traded substantial extra runtime for the official score gain.
- Hosted selectors can change behind stable display names, so the labels alone do not guarantee
  bit-for-bit reproduction.
- The result is a two-model score@1 replication, not a randomized estimate of average treatment
  effect.
- This snapshot is deliberately QBench-only and does not claim that the same workflow improves
  Veil-bench competence or every engineering benchmark.

## Integrity

- QBench runner SHA-256:
  `c354ca4957eea322d9f69ba4ca82a317fa3622815c61ef4653a253d5d55c0f85`.
- Delivery / review / ledger / challenge playbook SHA-256 values:
  `2d594be3477b0d92a83cc9a501cad821e6a6b0d5c6828f3bad703da12354d0e6`,
  `aff3dfb9f3f1c3c167e06d26e3c8f4d018fd65cadf45e0b2bbfe351b106b463f`,
  `a4565b051dd9c478b81d9c83be5824da3410ac9f1456128134ebb51ee2f26bd6`, and
  `9ce6c3aaeaac7224cf9a085d1d6f097db79bab6f90657959428d8de231e9ca9d`.
- The hashes were recorded before the treatment phase and matched again after evaluation.
