# veil-quant

The Pi package that adds Veil's single-agent research loop without replacing Pi or blocking normal
coding work.

```bash
pi install npm:veil-quant@0.1.0
```

The npm command becomes available when the v0.1 tag is published. During source development, run
`npm install` at the repository root and use `pi install ./packages/veil-agent`.

Veil libraries support Node 20.10 through 29. The repository-pinned Pi 0.84.1 model runner requires
Node 22.19 or newer.

## What it adds

| Surface | Behavior |
| --- | --- |
| `veil-data` | Requires `as_of`, reads registered CSV/Parquet through the mandatory temporal guard, and optionally exports guarded Arrow |
| `veil-backtest` | Packages code and performs fresh per-decision WFA C1-C4 execution plus C6 chronology |
| `veil-memory` | Registers hypotheses and inspects the active branch's append-only research-run ledger |
| `tool_call` | Fails safe for malformed calls entering Veil's data or promotion surfaces |
| `tool_result` | Appends non-blocking full-sample, future-function, and survivorship advisories |
| Commands | `/veil-brief`, `/veil-hypothesis`, `/veil-promote`, `/veil-reproduce` |
| Resources | `veil-research-loop` skill and research-plan/log prompt templates |

The extension auto-captures the first brief and hypothesis with Pi's durable session entry id and
timestamp. It restores only entries on the active branch, so Pi forks naturally become research
lineage.

## Project profile

The default v0.1 file profile reads `.veil/project.yaml` from Pi's working directory:

```yaml
format: veil.project.v0
datasets:
  - dataset: my-prices
    adapter: adapters/prices.yaml
    root: null
    root_env: VEIL_PRICES_ROOT
runtimes:
  - id: veil-node
    constraints:
      - ">=20.10.0,<30"
promotion_concurrency: 2
```

Physical roots remain local capabilities. Tool results, Pi entries, run evidence, and Markdown logs
contain only project-relative references and content identities. The default loader supports CSV and
Parquet; use `root: .` with `root_env: null` when the locator is relative to the project itself.
Custom backends can supply a `VeilProjectLoader` without changing tool contracts.

## Claim boundary

v0.1 writes a `researchRunId`, complete structural evidence, and an explicitly `unverified`
promotion candidate. It does **not** issue an Experiment, verified performance metric, pricing
result, cost audit, gate verdict, or evaporation statistic. Those arrive with Stage 4.

Known `PIT_UNSAFE`, unverified point-in-time, assumed-availability, and survivorship-biased or
unknown declarations remain available for exploration but are rejected at promotion with C1. Do not
change an adapter guarantee merely to pass that boundary.

This is intentional. `@veilquant/engine` already freezes the trustworthy chain:

```text
guarded read → artifact → per-decision contract → registration chronology
             → unverified candidate → future pricing/gates → Experiment
```

See the repository
[quickstart](https://github.com/HanshengGUO/veil/blob/master/docs/quickstart.md) and cold
[single-agent example](https://github.com/HanshengGUO/veil/tree/master/examples/agent-loop).

## Extension boundary

Veil does not fork Pi. If an invariant cannot be enforced from an extension, the enforcement belongs
in `@veilquant/engine`. Exploration heuristics never become blockers, and the extension does not
claim to sandbox a user's shell or defend against a deliberately malicious agent.
