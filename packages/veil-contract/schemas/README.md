# Declaration formats

Wire formats for the declarations Veil reads. Adapter machine validation lives in
`@veilquant/contract`; normalized artifact identity and code-tree validation live in
`@veilquant/engine`. These annotated files remain the copyable human reference.

| File | Declares | Validation |
| --- | --- | --- |
| [`adapter.yaml`](./adapter.yaml) | What a dataset means in time, and what it can guarantee | Implemented: normalize, validate, derive semantics, hash |
| [`artifact.yaml`](./artifact.yaml) | What is being promoted: code, locked parameters, data semantics | Implemented: explicit code capture, normalize, verify, hash |
| [`hypothesis-registration.yaml`](./hypothesis-registration.yaml) | Which hypothesis existed when, and its durable source entry | Implemented: normalize, chronology checks, verify, hash |
| [`promotion-candidate.yaml`](./promotion-candidate.yaml) | C1-C4 evidence plus the C5/C6 boundary handoff to later gates | Implemented: contract-only admission, exploratory tier, verify, hash |
| [`pricing-evidence.yaml`](./pricing-evidence.yaml) | Candidate-bound metric and immutable trade/return/cost payload identities | Implemented: retained-evidence replay, deterministic OOS pricing, CostModel execution, verify, hash |
| [`gate-policy.yaml`](./gate-policy.yaml) | The complete cost and statistical gate set required for one evaluation | Implemented: strict coverage, normalize, verify, hash |
| [`trial-audit.yaml`](./trial-audit.yaml) | Declared, active-session, and same-family trial identities and the effective count | Implemented: observable floor, budget binding, normalize, verify, hash |
| [`gate-method-evidence.yaml`](./gate-method-evidence.yaml) | The statistics and dependencies behind one gate outcome | Implemented: standard eight-gate execution, normalize, verify, hash |
| [`gate-evaluation.yaml`](./gate-evaluation.yaml) | One policy result per gate, with an engine-derived verdict | Implemented: completeness, trial floor, verify, hash |
| [`experiment.yaml`](./experiment.yaml) | The only record that can carry citable metrics and a claim verdict | Implemented: safe issuance, full-chain replay, derived claim state, verify, hash |
| [`experiment-memory.yaml`](./experiment-memory.yaml) | Compact append-only family memory used for retrieval and trial accounting | Implemented: normalize, chronology, verify, hash |
| [`read-set-tombstone.yaml`](./read-set-tombstone.yaml) | Why retained snapshot bytes were removed and exact reproduction is unavailable | Implemented: immutable operator record and loud reproduction failure |

The bench task declaration (`trap.yaml`) lives with the tasks it belongs to:
[`bench/tasks/_TEMPLATE`](../../../bench/tasks/_TEMPLATE).

## The rule that shapes every format

A declaration is a **checkable promise**. Anything it asserts must be something the harness can
either verify or degrade. Unknown fields are rejected rather than ignored. Runtime credentials are
not declaration semantics and belong in an engine `SourceBinding`, never in these files.
