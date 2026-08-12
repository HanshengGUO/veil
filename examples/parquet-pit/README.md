# Parquet point-in-time view

This cold entrypoint runs the same guarded read contract as the CSV example through a Parquet
source:

```text
adapter.yaml + SourceBinding
  → DuckDbFileBackend
  → Arrow IPC
  → mandatory TemporalGuard
```

Run it from the repository root:

```bash
npm run parquet-pit:verify
```

The script deterministically generates a temporary Parquet file from the committed CSV sentinel
fixture, reorders its physical columns, and removes it after the read. At `as_of: 2026-08-12`, only
`PAST` and `BOUNDARY` are visible. No SQL, file path, or DuckDB connection crosses the backend
contract.

The current default file backend canonicalizes primitive scalar columns. Nested Parquet payload
types require an explicit canonical type adapter and fail closed until one is provided.
