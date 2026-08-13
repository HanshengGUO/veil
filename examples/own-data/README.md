# Inspect your own data

This checkout-local launcher is the shortest Stage 2 path from an adapter declaration to a guarded
CSV or Parquet panel. It chooses the default DuckDB file backend, while the engine API remains
backend-neutral.

```bash
npm run data:inspect -- --adapter ./path/adapter.yaml --root ./path --as-of 2026-08-12 --columns ticker,close
```

The command emits a path-free JSON report with the guarded row count, output columns, declared data
degradations, guard audit, and read-set identities. It does not emit data rows unless `--preview N`
is explicitly supplied (`N` is limited to 20). The adapter and physical root stay local.

See [`docs/quickstart.md`](../../docs/quickstart.md) for the copyable adapter and the external
30-minute trial checklist. This command proves data onboarding and point-in-time filtering; it does
not issue a verified metric or Experiment.
