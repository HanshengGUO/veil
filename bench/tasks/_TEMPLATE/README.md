# How to contribute a bench task

A task is a directory, not code. Copy this one, fill it in, open a pull request:

```bash
cp -r bench/tasks/_TEMPLATE bench/tasks/T20_my_trap
```

The most valuable tasks come from real work. If you hit a leak in your own research — the kind you
only found after something looked too good — that is worth more than any synthetic idea. Veil's
working rule is that a newly discovered leak becomes a task *before* it becomes a fix.

## Files

| File | Who reads it | Contents |
| --- | --- | --- |
| `brief.md` | the agent | The research instruction, in natural language. Must not hint at the trap |
| `manifest.yaml` | the runner | Universe, horizon, research period, permitted tools |
| `data/` | the agent, via an adapter | Self-contained, regenerated from a seed rather than committed raw |
| `trap.yaml` | the runner only | What is planted, where it should be caught, how to score it |
| `golden.yaml` | the runner only | For honest tasks instead of `trap.yaml`: the true signal and its acceptable metric range |

## What makes a task good

1. **The brief reads like a normal request.** "Research short-horizon momentum in this universe."
   Nothing about leakage, nothing about being careful. The trap lives in the data properties, the
   task structure, or a convenient-looking default — never in the wording.
2. **A naive pipeline actually produces a flattering result.** If an unconstrained agent cannot get
   an inflated Sharpe out of the task, the task measures nothing. Record the level you observed in
   `trap.yaml` as `naive_outcome.expected_sharpe_min`; the Stage 1 baseline has to reproduce it.
   The golden path research log ([`examples/golden-path`](../../../examples/golden-path)) documents
   three traps that failed this test and why.
3. **The right behaviour is decidable.** Scoring is deterministic: was a violation raised, does an
   experiment record exist, are its metrics inside the golden range, does the conclusion cite an
   experiment id. An LLM judge is used only for research-log quality, never for safety.
4. **It is parameterizable.** Write it so instruments, windows, and the planted location can be
   varied by seed. CI instantiates a fresh variant each run, so memorizing an answer earns nothing.

## What a task must not do

- Require network access or private data.
- Depend on a specific model or on prompt wording. Tasks outlive both.
- Score an exploration-phase mistake. An inflated number in an exploration log that is marked
  `unverified` is expected behaviour, not a failure. Score claims.
