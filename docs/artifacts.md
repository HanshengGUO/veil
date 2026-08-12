# Artifacts

An artifact is the immutable unit that crosses from free exploration into verification:
`compute(data_view)`, its code, locked parameters, declared data-derived literals, and the data
semantics it expects. Changing any identity-bearing input creates a different artifact; a mutable
working-tree path is never sufficient evidence of identity.

Status: the guarded Arrow/read-set boundary described here is implemented. Artifact packaging,
subprocess execution, and walk-forward orchestration begin in Stage 2C and are not yet available as
a public API. The annotated [`artifact.yaml`](../packages/veil-contract/schemas/artifact.yaml) is a
design input, not a currently accepted runtime format.

## The verification boundary

Veil, not factor code, owns source bindings, backend handles, credentials, and decision-time reads.
For each verification window the engine will:

1. construct the point-in-time view through the same backend-neutral temporal guard used by
   `veil-data`;
2. apply the declared tradability mask before signal formation;
3. pass only guarded Arrow IPC and immutable run metadata to an artifact subprocess;
4. validate the subprocess output before it can contribute to an experiment record.

The subprocess receives no raw source path, DSN, credential, backend object, or escape hatch to a
current query. A backend may be DuckDB, another database, a service, or an in-memory implementation;
that choice ends at the guard and is absent from the artifact protocol.

```text
SourceBinding + TemporalBackend
             |
       TemporalGuard(as_of)
             |
    guarded Arrow + read-set
             |
     artifact subprocess
             |
      validated factor output
```

## What is locked

The v0 manifest will make at least these distinctions explicit:

- executable code and entrypoint;
- runtime requirements;
- `params_locked` and data-derived `declared_literals`;
- required datasets and their declared temporal semantics;
- the registered hypothesis and declared trial count;
- walk-forward, purge, embargo, holding-period, and cost-model choices.

Parameters are read-only out of sample. Protocol choices are recorded rather than selected after an
outcome is visible. Read-set identities record the exact guarded inputs used by an execution; the
artifact and resulting experiment retain their own content identities so code, data, and outcome
cannot be silently substituted for one another.

## What Stage 2C must prove

The first implementation is complete only when tests demonstrate that:

- future rows remain physically absent in the child process;
- the child can run without a source binding or backend dependency;
- parameters cannot be changed between out-of-sample windows;
- rolling/expanding windows enforce purge and non-zero embargo rules;
- malformed, oversized, timed-out, or partial child output fails closed;
- content identity is stable across clean processes and absolute checkout paths;
- serialized manifests, control messages, logs, and errors contain no credentials or runtime roots.

Until those checks exist, an exploration script or `veil-data` result remains unverified even when
it follows the intended `compute(data_view)` shape.
