# Complete Stage 4 agent loop

This model-free acceptance example exercises the default agent path rather than calling the gate
issuer directly. It creates a temporary CSV project, registers Stage 4 providers, runs three
parameter variants through `veil-backtest`, retrieves prior rejected Experiments as parameter-family
evidence, accepts the stable third variant, and reproduces it from archived code and guarded
read-set snapshots.

```bash
npm run stage4-agent:verify
```

The first two runs are expected to be rejected because the parameter neighborhood is incomplete.
Their negative results remain in append-only memory. The third run can pass only after pricing,
trial-budget, deflated-Sharpe, cost, null, parameter, walk-forward, and knowledge-cutoff gates all
produce explicit evidence.
