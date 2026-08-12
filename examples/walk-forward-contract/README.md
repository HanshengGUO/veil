# Walk-forward contract verification

This cold example runs one locked artifact at every training cutoff and every OOS decision time.
The custom in-memory backend is replaceable: all database-specific behavior stops at
`TemporalGuard`.

```text
explicit WFA schedule
        ↓ each train cutoff and OOS decision
TemporalGuard → fresh PIT read → bounded history → declared mask filter
                                                   ↓
                                             framed child
                                                   ↓
                         entity/event admission + current OOS slice
                                                   ↓
                              complete contract-verified record
                                                   ↓
                    preregistration chronology → promotion candidate
```

Run it from the repository root:

```bash
npm run walk-forward-contract:verify
```

The halted `BBB` row is absent before the OOS child starts, and only rows at the current decision
time are admitted from child output. The record binds C1-C4 evidence and the immutable parameter
lock. The example then binds a durable hypothesis registration that predates verification and emits
a `veil.promotion-candidate.v0`.

The candidate is still explicitly `unverified`: it contains no prices, returns, metrics, gates, or
experiment id. Missing registration is allowed only as `exploratory` with a higher future gate tier;
a late registration is rejected as C6. Pricing and statistical-gate stages must still issue the
eventual citable Experiment.
