# `veil-data` cold surface

This example exercises both minimum exploration reads in clean Node processes:

- `point` emits guarded Arrow for an explicit `as_of`;
- `panel` retains entity, event-time, availability-time, and any declared mask columns, labels the
  result `exploration-grade`, and emits an explicitly requested snapshot reference.

Run it from the repository root:

```bash
npm run veil-data:verify
```

The CLI core is dependency-injected. It receives an already configured backend registry, normalized
adapter declaration, and opaque source binding; it has no switches for DuckDB, another database,
SQL, a physical root, or credentials. This example's launcher chooses the default DuckDB file
backend only to provide a real CSV cold-start check. A database launcher can supply a different
backend and binding without changing `veil-data`.

Both child processes read the committed future-sentinel CSV. The point result is decoded directly
from Arrow IPC. The panel result is re-opened from its content-addressed snapshot, and the parent
checks that `FUTURE` is absent and the bitemporal structural columns are present. The temporary
snapshot store is removed afterward.
