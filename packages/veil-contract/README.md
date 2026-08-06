# @veilquant/contract

The Veil Contract: the six invariants (C1-C6) that any claim must satisfy, the adapter and
guarantee declaration formats, and the validators that enforce them.

- Normative specification: [`docs/contract.md`](../../docs/contract.md)
- Declaration formats: [`schemas/`](./schemas)

Status: Stage 0 — the specification and schema drafts are the deliverable. Validators land in
Stage 2 (see the roadmap in the [README](../../README.md)).

## What lives here

| Concern | Notes |
| --- | --- |
| Invariant identifiers | `C1`-`C6`, stable across 0.x and 1.x |
| `ContractViolation` | Structured error carrying the invariant, dataset, and decision time |
| Adapter declarations | Loading, defaulting, and validation of `adapter.yaml` |
| Guarantee declarations | Capability flags that decide which gates apply and which results get degraded |

This package must stay free of I/O and of any dependency on a specific storage engine: it
describes and checks semantics, it does not read data.
