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

The bench task declaration (`trap.yaml`) lives with the tasks it belongs to:
[`bench/tasks/_TEMPLATE`](../../../bench/tasks/_TEMPLATE).

## The rule that shapes all three

A declaration is a **checkable promise**. Anything it asserts must be something the harness can
either verify or degrade. Unknown fields are rejected rather than ignored. Runtime credentials are
not declaration semantics and belong in an engine `SourceBinding`, never in these files.
