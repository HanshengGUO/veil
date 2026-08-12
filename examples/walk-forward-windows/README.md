# Walk-forward training windows

This cold example executes one packaged artifact over deterministic rolling training windows. An
in-memory custom backend demonstrates that orchestration depends only on `TemporalGuard`, a
normalized declaration, and an opaque `SourceBinding`—not on DuckDB, SQL, paths, or DSNs.

```text
explicit UTC schedule + artifact protocol
                  ↓
       rolling/expanding fold plan
                  ↓ each training cutoff
TemporalGuard → source read-set → replayable derived-window evidence
                                      ↓
                              clean framed child
                                      ↓
                       deterministic executed run record
```

Run it from the repository root:

```bash
npm run walk-forward:verify
```

The record status is deliberately `executed`, not `verified`. This Stage 2C-3 boundary proves the
training topology, evidence lineage, and child executions. OOS pricing, tradability-mask-first
evaluation, and citable metrics remain Stage 2C-4 work.
