# Stage 4 claim path

This model-free acceptance example exercises the complete claim boundary:

```text
three locked parameter variants
  → retained walk-forward contract evidence
  → deterministic OOS pricing and 10 bps costs
  → trials-aware DSR, budget, fold/parameter stability, cost stress,
    knowledge-cutoff audit, and centered block-bootstrap null gate
  → accepted, verified Experiment
  → append-only memory archive
  → exact metric-level reproduction
```

Run it from the repository root:

```bash
npm run stage4-claim:verify
```

The example uses a small in-memory synthetic market and launches the same bounded artifact child as
real promotion. It writes its archive only inside a temporary project and removes that directory at
the end. The printed JSON contains portable content identities, gate reasons, verified metrics, and
reproduction status; it contains no root, credential, or runtime diagnostic.
