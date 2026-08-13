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
5. Explore normally with Pi's coding tools. Before reporting a metric, check that the implementation
   matches the brief's historical universe, label horizon, rebalance cadence, holding period,
   execution lag, masks, and return convention exactly. Label every exploratory return, Sharpe
   ratio, fitted threshold, and ranking as unverified. Write down this protocol comparison before
   promotion: a later candidate covers only its exact request and cannot retroactively validate a
   differently timed local metric. Advisory messages are heuristics, not failures.
6. Package the final factor as a small deterministic module. For `veil-node`, copy
   `assets/factor.mjs` as a starting point and export `compute(table, context)`. The runtime, not the
   factor, decodes Arrow IPC and supplies an Apache Arrow `Table`; do not open the `.arrow` file,
   write an IPC decoder, import `apache-arrow`, or install a dependency inside the factor. Use
   `table.numRows` and `table.getChild(name)`, then return `{ rowIndices, columns }` unless an
   advanced runtime-specific output is genuinely needed. `context.paramsLocked` and
   `context.declaredLiterals` are the immutable parameter maps. Keep `rowIndices` strictly
   increasing in source-table order; a `null` derived value is safer than regrouping or reordering
   source rows when a row has no signal.
7. Copy `assets/promotion-request.yaml` into the project, then fill every field. A Stage 3 promotion
   request names exactly one registered dataset. Include only development read-set ids returned by
   `veil-data` for that same `dataset` on the active branch; reads from other datasets may inform
   exploration but do not belong in this request. If the research metric uses multiple sources,
   state that the single-dataset candidate covers only its structural slice and does not verify the
   multi-source metric. Do not edit adapter guarantees or the project profile to force promotion.
   If the selected dataset lacks a truthful declared tradability mask, choose another already
   registered dataset for the structural slice or keep the result exploratory; never add a mask
   guarantee without source evidence. The decision schedule contains every ordered UTC session,
   not one timestamp per fold. Its exact length is
   `train_days + purge_days + embargo_days + folds * oos_days`; every `*days` field counts schedule
   entries rather than calendar days. Stage 3 promotion verifies structure but issues no performance
   metric, so begin with a bounded honest topology such as the asset's 2 folds and 20-session OOS
   blocks (42 artifact executions). Expand only when the structural question requires it.
   `cost_model` is a portable logical id, never a filesystem path or locator URI. Use
   `stage4-not-issued` until a later stage supplies a registered method reference; Stage 3 records
   that boundary but does not apply costs.
8. Call `veil-backtest` with the project-relative request file. Apply an exact structured remedy only
   when it truthfully preserves the registered inputs and the brief. If the brief's own protocol or
   a registered dataset guarantee conflicts with C1-C4, preserve that rejection and report the
   research as invalid or exploratory; do not silently substitute a safer research question, edit a
   guarantee, or loop over alternate requests merely to obtain a candidate. In particular, preserve
   an explicitly requested zero-lag execution rule so the engine can reject it as C1.
9. A successful `veil-backtest` completes the Stage 3 promotion loop. Record its run id, content
   hashes, immutable evidence reference, and required limitations, then stop. Likewise, after a
   terminal structural rejection has been recorded and no truthful in-scope remedy exists, report it
   and stop. Do not repeat the promotion, manually replay the artifact, or keep polishing already
   valid output. If successful, say “contract-verified, unverified promotion candidate.” Never say
   “verified alpha,” “passed all gates,” or “Experiment.” An unverified local metric may be recorded
   as an exploratory observation, but it cannot support an allocation recommendation.

## Promotion checklist

- `as_of` was explicit for every Veil data read.
- The hypothesis reference exists on the active session branch.
- Data-derived constants are declared separately from locked parameters.
- `trials_declared` counts explored candidates honestly.
- The protocol uses positive purge, embargo, holding, and execution-lag semantics where required.
- The decision schedule is chronological and has exactly
  `train_days + purge_days + embargo_days + folds * oos_days` entries.
- The adapter is genuinely point-in-time and survivorship-safe; do not edit guarantees to pass C1.
- Every development read-set belongs to the request's single dataset.
- `cost_model` is a logical id without a slash or locator URI; it does not claim costs were applied.
- The factor does not load data, paths, credentials, or environment variables itself.
- The research log names pricing, costs, and statistical gates as still required.
- Any local metric uses the same execution timing and evaluation protocol as the promoted request;
  otherwise keep it separate from the candidate and make no effect or allocation claim from it.

## Structural reproduction

Stage 3 can rerun the same request and compare artifact, plan, and contract hashes. Verify both
candidates independently; their hashes normally differ because each binds its own verification-start
entry. Stage 3 cannot reproduce or cite a performance metric because pricing and statistical gates
arrive in Stage 4. Preserve that limitation in every reproduction note.
