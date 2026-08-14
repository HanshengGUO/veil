---
name: veil-research-loop
description: Run an honest Veil single-agent research loop from a brief through guarded exploration, structural promotion, Stage 4 gates, Experiment memory, and reproduction. Use when researching a factor, preparing a promotion request, interpreting a Veil rejection, or writing a research log.
license: MIT
compatibility: Requires Pi with the veil-quant package and a project-local .veil/project.yaml.
---

# Veil research loop

Keep these boundaries visible:

- exploration is free and its numbers are unverified;
- a request without `stage4` ends at an unverified structural candidate;
- only a complete accepted Experiment carries a verified metric;
- degraded and rejected Experiments remain evidence and count toward later family trials.

## Workflow

1. Call `veil-memory` with `action: "status"`, then `family` for the active hypothesis. Reuse the
   reference only for the same falsifiable question; use `register_hypothesis` for a material change.
2. Inspect `.veil/project.yaml` without copying roots or environment values into notes. Confirm the
   requested cost model and null generator are registered before preparing a Stage 4 request.
3. Use `veil-data` with an explicit `as_of`. Point mode is guarded; panel mode remains
   exploration-grade. Request Arrow only when a durable local view is needed.
4. Explore normally. Label every return, Sharpe, threshold, and ranking unverified. Compare universe,
   label horizon, rebalance cadence, holding period, execution lag, masks, and return convention with
   the brief before promotion. A candidate cannot retroactively verify a differently timed metric.
5. Package a deterministic factor. For `veil-node`, start from `assets/factor.mjs` and export
   `compute(table, context)`. Return source-ordered `rowIndices` and derived columns. Do not load data,
   paths, credentials, environment variables, or future blocks inside the factor.
6. Copy `assets/promotion-request.yaml` and fill every field. Use only development read-set ids from
   the request's registered dataset. The decision schedule contains every ordered UTC session and has
   exactly `train_days + purge_days + embargo_days + folds * oos_days` entries.
7. Declare every explored candidate in `trials_declared`. Before the focal lock, plan and execute at
   least two truthful neighboring parameter locks under the same hypothesis; the required stability
   gate will reject incomplete neighborhoods. Do not manufacture neighbors after seeing the focal
   OOS outcome or loop until one passes.
8. In `stage4`, lock signal/price/market columns, annualization, portfolio kind, sizing, quantile,
   capacity assumptions, null method, trial budget, and model knowledge cutoff. Match a long-only
   brief with `long-only-quantile`. For equal sizing set `weight_column: null`; for trailing sizing,
   emit a strictly positive artifact-output weight derived only from trailing information and name
   it in `weight_column`. Use `null` for a method only when evidence is genuinely unavailable and
   accept the resulting degraded claim. `cost_model` is a logical registered id, never a path or
   locator.
9. Call `veil-backtest`. Apply a structured remedy only when it preserves the brief. If the requested
   protocol conflicts with C1-C4, preserve the rejection; never substitute a safer question or edit
   adapter guarantees merely to obtain a result.
10. Retrieve the resulting Experiment. `accepted / verified` may support only its exact net metric.
    Qualify `degraded`; treat `rejected` as negative evidence. Address the specific gate reason in the
    next preregistered trial, and remember that every complete attempt remains in the trial audit.
11. Run `/veil-reproduce <experimentId>` before citing an accepted result. Reproduction must match
    archived code, read-set, pricing, gate, and metric identities; it never falls back to current data.

## Promotion checklist

- Every Veil read used an explicit decision time.
- The hypothesis and idea-availability source predate verification.
- Data-derived constants and locked parameters are complete.
- `trials_declared` includes explored candidates, including unpromoted ones.
- Purge, embargo, holding, execution lag, and schedule length match the research protocol.
- Point-in-time, survivorship, and tradability guarantees are truthful.
- Every development read-set belongs to the single request dataset.
- Pricing columns exist; the portfolio kind matches the brief, an optional sizing column is positive
  and trailing-only, and market columns cover cost and capacity requirements.
- At least two distinct compatible parameter-lock Experiments exist for the required neighborhood.
- Cost, null, trial-budget, capacity, and knowledge-cutoff choices were locked before OOS results.
- The factor contains no data access or machine-local capabilities.
- The final statement cites an accepted Experiment id or clearly says why the result is degraded,
  rejected, or still unverified.

## Memory and reproduction

Use `veil-memory list_experiments`, `get_experiment`, `family`, and `trial_evidence` instead of relying
on chat recollection. The extension injects only a bounded latest-family summary into agent context;
the append-only Pi entries and project archives remain the source of truth. If reproduction reports
`READ_SET_UNAVAILABLE`, preserve the retention failure and describe the result as attested rather
than reproducible.
