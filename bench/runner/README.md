# Veil-bench runner

Drives a research session end to end and scores it. Task discovery, calibrated seed selection,
oracle-safe workspace materialization, structured submissions, Pi SDK sessions, complete event
capture, G1-G4 attribution, dual-axis aggregation, and multi-model baseline reports are implemented.

## Execution boundary

1. Instantiate a task from a logged seed selected deterministically from its calibrated seed bank.
   The agent workspace excludes `generate.ts`, `trap.yaml`, and `golden.yaml`.
2. Drive a Pi session with SDK `createAgentSession()` plus `session.subscribe()` and capture the full
   tool-call event stream. Streaming messages are stored as deltas with one authoritative final
   message, avoiding cumulative O(n²) logs. Extension, skill, prompt, project-context, credentials,
   model configuration, and model-cache discovery are isolated from user-level Pi state. File tools
   are confined to the workspace with symlink checks; shell children receive a credential-stripped
   environment plus per-run persistent HOME/TMP/XDG directories.
3. Require `submission.json`, then score deterministically. Bare runs require unverified metrics.
   The Stage 3 Veil profile additionally collects promotion violations and candidate evidence from
   the active Pi branch, requires honest submissions to cite an immutable run file, and rejects any
   premature Experiment id or verified metric. Stage 4 will activate Experiment-backed scoring.
   Free-form prose remains in `research.md` and is not used to decide safety.
4. Compare models through either the isolated `bare` or packaged `veil` profile and write a report
   under the requested run directory. Reviewed bare reports belong in
   [`../baselines`](../baselines); Stage 3 Veil output remains diagnostic until the deferred gates
   and external acceptance runs are complete.

Every run also writes an atomic phase checkpoint and a sorted, content-addressed manifest of copied
agent artifacts. A provider error after a valid terminal submission may be recovered only when the
input digest, submission schema, evidence paths, and deterministic scorer all pass; a timeout or an
incomplete terminal state remains a failure.

An LLM judge is used for one thing only: research-log quality. Everything that decides safety is a
deterministic check.

See [`../../docs/bench.md`](../../docs/bench.md) for commands, outputs, scoring, and task contribution.
Model-free commands support Node 20.10+; the pinned Pi SDK requires Node 22.19+ when starting a model
session.
