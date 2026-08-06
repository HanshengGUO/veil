# Veil-bench runner

Drives a research session end to end and scores it. Status: Stage 0 — skeleton; the runner is the
Stage 1 deliverable.

## How it will work

1. Instantiate a task template with a random seed (so "remembering the answer" does not score).
2. Drive a Pi session programmatically — SDK `createAgentSession()` plus `session.subscribe()`, or
   `pi --mode rpc` — and capture the full tool-call event stream.
3. Score deterministically: was a `ContractViolation` raised, does an experiment record exist, do
   its metrics fall inside the golden range, does the conclusion cite an experiment id, and at
   which layer (G1-G4) was the trap caught.
4. Compare against the bare-agent baseline in [`../baselines`](../baselines).

An LLM judge is used for one thing only: research-log quality. Everything that decides safety is a
deterministic check.
