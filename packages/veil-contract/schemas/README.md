# Declaration formats

Draft schemas for the three declarations Veil reads. Machine validation lands in Stage 2
(`@veilquant/contract`); until then these files are the reference, and they are annotated so they can
be copied and filled in.

| File | Declares | Written by |
| --- | --- | --- |
| [`adapter.yaml`](./adapter.yaml) | What a dataset means in time, and what it can guarantee | You, once per dataset (an agent can draft it from the schema) |
| [`artifact.yaml`](./artifact.yaml) | What is being promoted: code, locked parameters, data semantics | Generated at promotion; you review it |

The bench task declaration (`trap.yaml`) lives with the tasks it belongs to:
[`bench/tasks/_TEMPLATE`](../../../bench/tasks/_TEMPLATE).

## The rule that shapes all three

A declaration is a **checkable promise**. Anything a declaration asserts must be something the
harness can either verify or degrade. Fields that could only ever be taken on trust do not belong
here — they belong in prose, in the research log.
