---
name: veil-research-loop
description: Run an honest Veil single-agent research loop from a brief through guarded exploration and structural promotion. Use when researching a factor, preparing a promotion request, interpreting a Veil rejection, or writing a Stage 3 research log.
license: MIT
compatibility: Requires Pi with the veil-quant package and a project-local .veil/project.yaml.
---

# Veil research loop

Keep one distinction visible throughout the work:

- exploration is free and its numbers are unverified;
- promotion reruns a packaged artifact through the engine;
- a Stage 3 promotion success is still an unverified candidate, not an Experiment.

## Workflow

1. Call `veil-memory` with `action: "status"`. Reuse the current hypothesis reference, or use
   `register_hypothesis` before verification when the brief needs a more specific falsifiable claim.
2. Inspect `.veil/project.yaml` without copying private roots or environment values into notes.
3. Call `veil-data` with a registered dataset and an explicit `as_of`. Use `mode: "point"` for a
   guarded point query. Use `mode: "panel"` only as an exploration-grade panel.
4. If code needs a durable guarded Arrow input, explicitly request `output: "arrow"`. Reads with
   `output: "summary"` do not write a file.
5. Explore normally with Pi's coding tools. Label every exploratory return, Sharpe ratio, fitted
   threshold, and ranking as unverified. Advisory messages are heuristics, not failures.
6. Package the final factor as a small deterministic module. It may return Arrow IPC bytes, an Arrow
   `Table`, or `{ rowIndices, columns }`, and must use only the framed request metadata and guarded
   Arrow input supplied by Veil.
7. Copy `assets/promotion-request.yaml` into the project, then fill every field. Include only
   development read-set ids actually returned by `veil-data` on the active branch.
8. Call `veil-backtest` with the project-relative request file. Do not work around C1-C6 rejection;
   fix the adapter, protocol, artifact, or hypothesis chronology named by the structured remedy.
9. Report the returned run id and content hashes. If successful, say “contract-verified,
   unverified promotion candidate.” Never say “verified alpha,” “passed all gates,” or “Experiment.”

## Promotion checklist

- `as_of` was explicit for every Veil data read.
- The hypothesis reference exists on the active session branch.
- Data-derived constants are declared separately from locked parameters.
- `trials_declared` counts explored candidates honestly.
- The protocol uses positive purge, embargo, holding, and execution-lag semantics where required.
- The decision schedule is chronological and covers the requested folds.
- The adapter is genuinely point-in-time and survivorship-safe; do not edit guarantees to pass C1.
- The factor does not load data, paths, credentials, or environment variables itself.
- The research log names pricing, costs, and statistical gates as still required.

## Structural reproduction

Stage 3 can rerun the same request and compare artifact, plan, and contract hashes. Verify both
candidates independently; their hashes normally differ because each binds its own verification-start
entry. Stage 3 cannot reproduce or cite a performance metric because pricing and statistical gates
arrive in Stage 4. Preserve that limitation in every reproduction note.
