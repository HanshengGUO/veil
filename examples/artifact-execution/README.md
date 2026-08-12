# Framed artifact execution

This cold example promotes a one-file Node artifact from a real development read-set, constructs a
different guarded verification read-set, and executes the factor in a clean child process:

```text
TemporalGuard → verified read-set + Arrow
                         ↓
verified temporary code copy → logical runtime provider → framed child
                         ↓
              identity-bound Arrow result
```

Run it from the repository root:

```bash
npm run artifact-execution:verify
```

The Node runner is an example runtime adapter, not an engine dependency or a language restriction.
Its executable, loader path, and temporary code root stay in provider-private state. The wire
protocol carries only canonical immutable metadata and exact Arrow bytes; the child receives no
backend, source binding, source path, developer environment, or development read-set query handle.
