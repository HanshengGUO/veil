# Golden path — research log and structural acceptance

`research.ts` remains the hand-written reference run: it does not call Veil and is the target Stage
3 asks an agent to reproduce. A separate `evidence.ts` harness now sends the honest candidate through
the implemented Stage 2 structural path. Keeping those implementations separate prevents the system
under test from becoming its own reference answer.

```bash
npm run golden-path          # regenerate data, run every protocol, rewrite results.json
npm run golden-path:verify   # same, but fail if any number moved
npm run golden-path:evidence:verify # full guard → contract → candidate structural acceptance
```

Data is synthetic and regenerated from a seed, so it is not committed. The structural command is a
full-scale acceptance run and intentionally remains separate from the fast cross-platform metric
check. Metrics are committed
([`results.json`](./results.json)) and CI checks them on Linux, macOS and Windows — identical
inputs must produce identical numbers.

---

## 1. Brief

> Does short-horizon cross-sectional price momentum select instruments in this universe, and does
> anything survive transaction costs?

## 2. Hypothesis, registered before looking at returns

**H1.** Instruments whose trailing 3-20 day return is high relative to their own history outperform
instruments whose trailing return is low, over a 5-day holding period, cross-sectionally and
dollar-neutral.

**Source of the idea:** the standard momentum literature, not this dataset. Registered before any
backtest was run — the point of C6 is that this sentence cannot be written after seeing the answer.

**Falsifiable prediction:** a long-short quintile portfolio earns a positive net Sharpe out of
sample, in the majority of out-of-sample blocks, not only in aggregate.

## 3. Data and declared guarantees

165 instruments, 2,347 trading days (2016-01-04 to 2024-12-31).

| Dataset | Rows | `event_time` | `available_time` | Guarantees |
| --- | --- | --- | --- | --- |
| `prices.csv` | 370,728 | bar date | bar date (close) | point-in-time, tradability mask present |
| `universe_history.csv` | 370,728 | date | date | survivorship-free membership |
| `universe_current.csv` | 150 | — | — | **survivor-only**, present to demonstrate the bias |
| `fundamentals.csv` | 7,426 | period end | publication date, 45-90 day lag | vintage: true (restatements kept) |

Deliberate defects, because real data has them: instruments halt (volume 0, not tradable, price
carried forward), 15 of 165 instruments delist mid-sample after drifting down, and fundamentals are
only knowable weeks after the period they describe, sometimes restated later.

The fundamentals feed is **not** used by the promoted factor. It exists so that Stage 2 can exercise
an adapter and a point-in-time join against a feed whose `available_time` genuinely differs from its
`event_time`.

## 4. Method — the honest protocol

| Choice | Value | Why |
| --- | --- | --- |
| Signal | trailing return over L days, standardized per instrument | scale differs across instruments |
| Standardization | **expanding window only** | a decision at t may use statistics computed from data up to t, and nothing else |
| Universe | point-in-time membership | today's index members are not what was investable in 2016 |
| Tradability | mask applied **before** ranking | a signal on a halted instrument is not a position |
| Parameter L | chosen in-sample per fold from {3, 5, 10, 20}, then locked | C3 |
| Evaluation | 6 expanding walk-forward folds, 252 out-of-sample days each | C2 |
| Purge + embargo | 10 days (5-day label horizon + 5 conservative) | C2 |
| Execution | signal from close t, position held from close t+1 | the decision cannot use the bar it trades on |
| Costs | 10 bps per unit of turnover, charged at rebalance | see §8 |

## 5. Engine structural acceptance

The engine harness does not reuse the reference backtest or import its metrics. It follows this
evidence chain:

```text
prices.csv → TemporalGuard ───────────┐
                                      ├→ replayable composite mask → TemporalGuard per decision
universe_history.csv → TemporalGuard ┘                         ↓
                        content-addressed momentum artifact → framed child
                                                               ↓
                           6 expanding folds × 252 OOS sessions
                                                               ↓
                         C1-C4 contract → unverified candidate
```

The two input adapters are explicit. Historical membership now carries an `in_universe` boolean;
the hand-written loader still uses the same entity/date rows, so this added evidence column does not
change reference pricing. The composite transform joins exact entity/date keys, derives availability
as the later of price and membership availability, and computes `eligible = tradable &&
in_universe`. Its manifest binds both guarded read sets and can be replayed without DuckDB or SQL.
The materialized result then goes behind a normal backend and through the mandatory guard again.

The artifact emits the four pre-registered momentum candidates with expanding statistics. Because
Stage 2 has no pricing/cost evidence contract, it does not pretend to select a winning lookback or
price a portfolio. The candidate set and the requirement that selection occur only inside training
folds are locked; the independent reference remains responsible for the per-fold selection and all
numbers below. Every train cutoff and all 1,512 OOS decisions execute in a framed child under the
same parameter-lock identity.

The resulting `veil.promotion-candidate.v0` is deliberately `unverified`. It contains structural
identities and future evidence requirements, but no price, return, metric, gate outcome, verdict, or
experiment id. Null and leaky protocols remain calibration references only.

## 6. Results

Out-of-sample, stitched across the six folds (1,512 trading days):

| Protocol | Sharpe | Return | Vol | Max DD | Turnover | L per fold |
| --- | --- | --- | --- | --- | --- | --- |
| **honest reference** | **0.88** | 3.8% | 4.3% | -8.0% | 80x | 5/3/3/3/3/3 |
| honest, costs off | 2.81 | 11.8% | 4.2% | -4.0% | 80x | 5/3/3/3/3/3 |
| leak: same-bar execution | 8.44 | 81.5% | 9.7% | -1.2% | 80x | 5/5/3/3/3/3 |
| leak: full-sample statistics | 0.63 | 2.7% | 4.3% | -8.6% | 80x | 5/3/3/3/3/3 |
| leak: no purge gap | 0.74 | 3.2% | 4.3% | -8.0% | 80x | 5/5/3/3/3/3 |
| leak: survivor-only universe | 0.82 | 3.6% | 4.3% | -8.1% | 80x | 5/5/3/3/3/3 |
| leak: parameters chosen on full sample | 1.41 | 6.1% | 4.3% | -7.4% | 80x | 3 |
| **naive pipeline (every switch flipped)** | **8.61** | 93.5% | 10.9% | -1.3% | 80x | 3 |

Each leak row flips exactly one switch away from the honest protocol, so the difference is
attributable to that switch.

**Per-fold out-of-sample Sharpe, honest protocol:** 1.88, 1.41, 0.61, 0.76, **-0.69**, 1.26.
Five of six folds positive. With 1,512 out-of-sample days the standard error of an annualized Sharpe
is about 0.41, so 0.88 corresponds to t ≈ 2.1.

**Null environment** — same generator, planted signal switched off:

| Protocol | Sharpe |
| --- | --- |
| honest | **-0.93** |
| naive pipeline | **7.21** |

## 7. Reference verdict

**H1 is supported weakly and survives costs, with two caveats recorded against it.**

Net out-of-sample Sharpe 0.88 (t ≈ 2.1), positive in five of six folds, maximum drawdown 8.0%.
Promote as a small allocation, subject to:

1. **Costs consume more than two thirds of the edge** (gross 2.81, net 0.88). Any degradation in
   execution quality removes the result entirely, so the cost assumption is a load-bearing part of
   the claim, not a footnote.
2. **One fold is negative** (-0.69). A single 252-day loss period is expected at this Sharpe, but it
   sets the sizing constraint, and the parameter-stability gate — the first fold picked L=5 where
   the rest picked L=3 — should be the binding check on any size increase.

This is the hand-written study's verdict, not a Veil Experiment verdict. The engine candidate above
cannot make this claim citable until the later pricing, cost, and statistical-gate stages exist.

## 8. What the leaks teach

1. **Same-bar execution is the catastrophic one.** Sharpe 0.88 becomes 8.44 from a single timestamp
   mistake, and the result *looks* like a discovery: 81% annual return, 1.2% drawdown. Nothing about
   the factor changed. This is why C1 is enforced by how verification windows are built, not by
   reviewing code.

2. **A naive pipeline reports 8.61 where the honest answer is 0.88 — and 7.21 on a market with no
   edge at all.** The second number is the one that matters: an evaluation protocol that produces an
   edge on pure noise cannot be evidence of anything. This is exactly what the null-environment gate
   tests for in Stage 4.

3. **The honest protocol loses money on a null market, and that is correct.** Sharpe -0.93 on noise
   is the transaction-cost drag showing through. A protocol that returned about zero on noise would
   be quietly ignoring costs somewhere.

4. **Costs change which parameter is optimal**, not just the final number. A cost model applied after
   parameter selection is a different model from one applied inside it, which is why `CostModel` is a
   required plugin invoked during verification rather than a reporting step afterwards.

5. **Not every leak flatters — but every leak invalidates.** Full-sample statistics, the survivor-only
   universe, and the missing purge gap all *lowered* Sharpe here. A researcher who only asks "is this
   number suspiciously good" catches none of those three; a system that asks "was this number
   produced under the declared protocol" catches all of them.

6. **Parameter snooping is the quiet one.** Choosing L on the full sample lifts 0.88 to 1.41 — a 60%
   inflation with no obviously wrong line of code anywhere. It is invisible to inspection and shows
   up only when the choice is forced to happen inside a fold.

## 9. Two bugs this log found in itself

Recorded because they are the reason per-fold reporting exists, and because Stage 3 should expect an
agent to hit the same class of problem:

- **A first version of the generator fed the planted effect back into its own trailing window.**
  Predictability compounded over time, so every protocol — including the leaky ones — improved
  monotonically across folds. The aggregate Sharpe looked fine; the fold table did not.
- **A first version of this study used 68 instruments over four years.** Per-fold Sharpe standard
  error was about 1.4, and the aggregate rested entirely on one lucky 126-day window. Running the
  same protocol on the null market — where the same hot fold appeared with no signal present —
  proved it was noise. The fix was more instruments and more folds, not a better factor.

Both were found by looking at dispersion rather than at the headline number, and the second was
found only because a null environment was available to compare against.

## 10. Implications for Veil-bench (Stage 1)

The leaks that did **not** inflate are the useful findings, because trap tasks have to actually bite:

- **T2 (no purge)** barely moves here: rebalance spacing equals the label horizon, so windows do not
  overlap. The task must use daily rebalancing with 5-day forward labels, where the overlap is real.
- **T4 (survivorship)** does not inflate a dollar-neutral long-short strategy — dropping dying names
  removes a loser and a short candidate together. The task must be long-only or long-biased.
- **T1 (full-sample normalization)** is weak when applied to per-instrument feature scaling. The task
  should plant it where it genuinely imports the future: standardizing the label, or sizing positions
  by full-sample volatility.
- **T5 (same-bar execution)** and **T6/T11 (parameter snooping)** work as designed and need no
  adjustment. T5 is the loudest trap; T6 is the one an unaided reader will miss.

Each of these becomes a `naive_outcome.expected_sharpe_min` the Stage 1 baseline must reproduce. If
the baseline cannot produce an inflated result on a task, the task measures nothing.

## 11. Reproduction

`results.json` records the seed, the row counts, and every metric above.
`npm run golden-path:verify` regenerates from the seed and fails on any difference — which is why
the generator avoids `exp`, `log` and `pow`: with only arithmetic and `sqrt`, results are
bit-identical across platforms.

`npm run golden-path:evidence:verify` separately reads all 370,728 price and membership rows,
replays the composite, executes the complete per-decision contract, independently verifies the
contract and candidate, and prints only content identities and structural row counts. Its output is
not added to `results.json`, because structural runtime identities and priced reference metrics have
different jobs.

This is the smallest useful version of metric-level reproduction. Stage 4 generalizes it:
content-addressed manifest, snapshot of the read set, replay, compare.
