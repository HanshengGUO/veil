# CSV point-in-time view

This is the smallest cold entrypoint for the Stage 2 data path:

```text
adapter.yaml + SourceBinding
  → DuckDbFileBackend
  → Arrow IPC
  → mandatory TemporalGuard
```

Run it from the repository root:

```bash
npm run csv-pit:verify
```

The source contains one future sentinel. At `as_of: 2026-08-12`, only `PAST` and `BOUNDARY` are
visible. The declaration and caller do not contain SQL or a DuckDB connection; another backend can
implement the same structured read contract.
