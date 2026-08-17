# Local evaluation snapshot — Kimi K3, August 2026

This is a reviewed aggregate of local, pre-release runs. It is evidence for the current development
snapshot, not a production guarantee, a claim about every model revision, or formal Stage 4 exit.
Raw model sessions remain local, and held-out task contents remain private.

Machine-readable values are in [`summary.json`](./summary.json). Veil-bench scoring is documented in
[`bench/README.md`](../../README.md) and [`docs/bench.md`](../../../docs/bench.md).

## Results

| Evaluation                     | Protocol                                                                                                                                                                 | Result                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Historical bare control        | Kimi K3, 14 public tasks (7 trap, 7 honest), bare profile, low thinking, 20-minute task limit, score@1                                                                   | Safety `0.357`; competence `4/7 = 0.571`; 2 false-effect claims                                                              |
| Current Veil public profile    | Kimi K3, 15 public tasks (8 trap, 7 honest), `veil-stage4`, seed 11, low thinking, 40-minute task limit, score@1                                                         | Safety `1.000`; all `8/8` traps stopped at G1/G2; competence `5/7 = 0.714`; 0 G4 and 0 false-effect claims; 1 runner timeout |
| Small held-out safety check    | Kimi K3, frozen v2 set (4 trap, 1 honest smoke), Veil profile, low thinking, 20-minute task limit, score@1                                                               | Safety `4/4 = 1.000`; all four traps stopped at G1; 0 G4 and 0 false-effect claims; honest smoke `1/1`; 0 runner failures    |
| QBench v2 Engineering baseline | Kimi K3, five independent tasks, high thinking, official evaluator                                                                                                       | `41.50/100` official                                                                                                         |
| QBench opt-in workflow         | Same model family, benchmark release and data fingerprint; internal contract-ledger, black-box challenge, independent review and repair workflow; high thinking, score@1 | `45.75/100` strict official aggregate, `+4.25`; Q2 evaluator error counted as zero                                           |

The tracked historical controls are available in
[`kimi-stage1-full-v1`](../../baselines/kimi-stage1-full-v1/) and
[`kimi-qbench-engineering-v1`](../../baselines/kimi-qbench-engineering-v1/).

## Interpretation

The public Veil-bench result is the product-facing signal. It tests two axes: whether planted false
alpha is kept out of the conclusion, and whether clean tasks still complete an honest research loop.
The current profile achieved full safety with every trap resolved by structural or statistical
enforcement rather than model reasoning alone, while competence increased from the historical bare
control's 57.1% to 71.4%.

The held-out run is a small safety no-regression check, not a general hidden competence estimate.
Its single honest task only confirms that one null-result workflow completed. An earlier v1 held-out
construct scored 3/4 on safety; that failure remains retained. The v2 set corrected one ambiguous
protocol contract before it was frozen and run once.

QBench is an external engineering diagnostic and does not contribute to Veil-bench safety or
competence. The follow-up workflow changed only test-time orchestration: it added a public-contract
ledger, isolated black-box challenge, independent review, bounded repair, and fail-closed evidence
precedence. It did not modify QBench tasks, cases, data, submissions after completion, or the official
evaluator, and it did not modify Veil core. The official score increased by 4.25 points even though
Q2's evaluator failure was scored as zero.

This was the first indication that the same structure could improve delivery quality rather than
merely protect the workflow. The later DeepSeek V4 replication moved the strict official aggregate
by another 3.25 points for each of two model variants; its separate snapshot retains that protocol
and its mixed compatibility diagnostic.

## Integrity and limitations

- Every scored row comes from one frozen score@1 session. Supplemental diagnostics were not
  backfilled or selected into the scores, and official evaluator results were not fed back into
  later task generation.
- The current public profile and historical bare control are useful development references, not a
  randomized A/B test. The current suite adds one trap and uses a 40-minute limit; the historical
  control used 14 tasks and a 20-minute limit. Both used the same seven honest tasks, the seven
  shared traps, the Kimi K3 display model and low thinking.
- Hosted model selectors can change behind a stable display name, so the model family label alone
  does not guarantee bit-for-bit reproduction.
- The current public task tree SHA-256 is
  `e2ccc24c3d12ae92b870286e2d0fc4c706095ec9ba02d1162a759ddbed3469cf`.
- The held-out task tree was unchanged before and after its formal run. Its SHA-256 is
  `a6080cb39634f350a0b76e5d0eeedf4d37e76823ef2581968299f77eefad3596`.
- QBench used the 2026-07-30 data release with archive SHA-256
  `2dfa8be5c38513e67cc18d1208b535660be6bf1612e0f3d19638518e107b5761`.
  Both runs used Qlib 0.9.7, but the prior baseline used Python 3.11 and the follow-up used Python
  3.12; the comparison is therefore not a bit-for-bit environment-controlled ablation.
  Its separate, non-official compatibility diagnostic moved from `68.00/100` to `63.00/100`, driven
  mainly by Q5. It does not replace the official score, and the official improvement is not claimed
  as a stable causal effect.
- External plugin-author, cross-OS user, release, and broader hidden-set acceptance remain pending.
