# @veilquant/contract

The Veil Contract: the six invariants (C1-C6) that any claim must satisfy, the adapter and
guarantee declaration formats, and the validators that enforce them.

- Normative specification:
  [`docs/contract.md`](https://github.com/HanshengGUO/veil/blob/master/docs/contract.md)
- Declaration formats: [`schemas/`](./schemas)

Status: v0.1 — adapter declaration normalization, semantic validation, conservative degradation
derivation, lineage cross-checking, and content identity are implemented. Backend-neutral temporal
reads, their mandatory Arrow guard, and artifact identity/execution live in
`@veilquant/engine`. Storage and runtime providers remain outside this pure semantic package.

## What lives here

| Concern | Notes |
| --- | --- |
| Invariant identifiers | `C1`-`C6`, stable across 0.x and 1.x |
| `ContractViolation` | Structured error carrying the invariant, dataset, and decision time |
| Adapter declarations | Normalization, conservative defaulting, and validation of `adapter.yaml` |
| Guarantee declarations | Capability flags that decide which gates apply and which results get degraded |

## Adapter API

```ts
import {
  deriveDataSemantics,
  hashAdapterDeclaration,
  normalizeAdapterDeclaration,
} from "@veilquant/contract";

const declaration = normalizeAdapterDeclaration(parsedYaml);
const semantics = deriveDataSemantics(declaration);
const identity = hashAdapterDeclaration(declaration);
```

- Input uses the snake-case YAML fields documented in [`schemas/adapter.yaml`](./schemas/adapter.yaml).
- Output is normalized, deeply frozen, and uses camel-case TypeScript properties.
- Unknown fields fail closed with `AdapterDeclarationError`, including a stable `code`, field
  `path`, and actionable `remedy`.
- `availability_basis` segments use `event_time` and `[from, until)` boundaries. Date-only bounds are
  midnight UTC.
- `deriveDataSemantics()` keeps availability, certification, vintage, survivorship, and mask status
  separate, then emits explicit engine obligations and degradation codes.
- `hashAdapterDeclaration()` hashes canonical normalized semantics with a versioned domain prefix;
  YAML key order and equivalent shorthand do not change the identity.
- `normalizeLineageSummary()` and `validateLineageClaim()` provide the Stage 2 registration boundary
  that catches observed timestamps predating their collection evidence.

This package must stay free of I/O and of any dependency on a specific storage engine: it
describes and checks semantics, it does not read data.
