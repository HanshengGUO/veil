# How to contribute a bench task

A task is a directory, not code. Copy this one, fill it in, open a pull request:

```bash
cp -r bench/tasks/_TEMPLATE bench/tasks/T20_my_trap
```

The most valuable tasks come from real work. If you hit a leak in your own research — the kind you
only found after something looked too good — that is worth more than any synthetic idea. Veil's
working rule is that a newly discovered leak becomes a task *before* it becomes a fix.

Clean tasks matter just as much. They show whether a workflow can finish a useful, honest research
delivery instead of becoming safer by refusing everything. A strong contribution can expose a real
failure mode or raise the bar for competent completion.

## Files

| File | Who reads it | Contents |
| --- | --- | --- |
| `brief.md` | the agent | The research instruction, in natural language. Must not hint at the trap |
| `manifest.yaml` | the runner | Universe, horizon, research period, permitted tools |
| `generate.ts` | the runner only | Deterministically creates `data/`; never copied into the agent workspace |
| `adapters/` | the agent, via the runner | Dataset semantics exposed with the generated snapshot |
| `trap.yaml` | the runner only | What is planted, where it should be caught, how to score it |
| `golden.yaml` | the runner only | For honest tasks instead of `trap.yaml`: the true signal and its acceptable metric range |

The runner creates a fresh workspace containing only `brief.md`, a sanitized `manifest.yaml`,
`adapters/`, generated `data/`, and the generic submission contract. The generator and oracle files
are deliberately absent. This prevents accidental answer discovery; OS-level adversarial isolation
belongs to the Stage 6 hardening profile.

## What makes a task good

1. **The brief reads like a normal request.** "Research short-horizon momentum in this universe."
   Nothing about leakage, nothing about being careful. The trap lives in the data properties, the
   task structure, or a convenient-looking default — never in the wording.
2. **Its calibration class is explicit.** `loud` tasks require a flattering naive result on every
   seed; `silent` tasks require a stable paired effect even when the number looks ordinary;
   `structural` tasks are invalid by construction and name the invariant that rejects them. Record
   only thresholds reproduced by `npm run bench:calibrate`. The golden path research log
   ([`examples/golden-path`](../../../examples/golden-path)) documents why a real leak can be
   numerically quiet.
3. **The right behaviour is decidable.** Scoring is deterministic: was a violation raised, does an
   experiment record exist, are its metrics inside the golden range, does the conclusion cite an
   experiment id. During Stage 3, the interim Veil profile instead requires an unverified promotion
   candidate and its immutable structural evidence; full Experiment scoring begins with Stage 4.
   An LLM judge is used only for research-log quality, never for safety.
4. **It is parameterizable and replayable.** Write it so instruments, windows, and the planted
   location can be varied by seed. CI selects from the declared calibrated seed bank using a stable
   variant label and records both; there is no ambient randomness, so every surprising run can be
   replayed exactly with a `seed:<n>` variant.

## What a task must not do

- Require network access or private data.
- Depend on a specific model or on prompt wording. Tasks outlive both.
- Score an exploration-phase mistake. An inflated number in an exploration log that is marked
  `unverified` is expected behaviour, not a failure. Score claims.
