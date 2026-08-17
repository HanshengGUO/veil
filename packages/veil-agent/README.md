# veil-quant

[English documentation](https://github.com/HanshengGUO/veil/blob/master/README.md) |
[简体中文](https://github.com/HanshengGUO/veil/blob/master/README.zh-CN.md)

Veil is a quant research harness for Pi. It leaves ordinary coding alone, then adds a contract,
evidence, gates, memory, and reproduction when a result is promoted.

The aim is simple: a researcher should be able to inspect and continue the work without reverse
engineering the original chat and working tree.

Registry install after publication: `pi install npm:veil-quant`. During source development, run
`npm install` at the repository root and use `pi install ./packages/veil-agent` instead.

Veil libraries support Node 20.10 through 29. The repository-pinned Pi 0.84.1 model runner requires
Node 22.19 or newer.

## What it adds

| Surface | Behavior |
| --- | --- |
| `veil-data` | Requires `as_of`, reads registered CSV/Parquet through the mandatory temporal guard, and optionally exports guarded Arrow |
| `veil-backtest` | Runs structural promotion and, when requested, pricing, the eight gates, and Experiment archival |
| `veil-memory` | Registers hypotheses and retrieves runs, Experiments, families, and trial evidence |
| `tool_call` | Fails safe for malformed calls entering Veil's data or promotion surfaces |
| `tool_result` | Appends non-blocking full-sample, future-function, and survivorship advisories |
| Commands | `/veil-brief`, `/veil-hypothesis`, `/veil-promote`, `/veil-reproduce`, `/veil-family` |
| Resources | `veil-research-loop` skill, factor/promotion templates, and research-plan/log prompts |

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
stage4:
  cost_models:
    - kind: linear-bps
      reference: equities-10bps
      basis_points: 10
  null_generators:
    - kind: centered-block-bootstrap
      reference: daily-centered-blocks
      replications: 1024
      block_length: 5
      seed: 20260813
```

Physical roots remain local capabilities. Tool results, Pi entries, run evidence, and Markdown logs
contain only project-relative references and content identities. The default loader supports CSV and
Parquet; use `root: .` with `root_env: null` when the locator is relative to the project itself.
Custom backends can supply a `VeilProjectLoader` without changing tool contracts.

## Claim boundary

A request without `stage4` writes a `researchRunId`, complete structural evidence, and an explicitly
`unverified` promotion candidate. A complete request additionally replays retained evidence, prices
the locked method and cost model, audits trials, runs the standard policy, archives exact code and
read sets, and appends accepted, degraded, or rejected Experiment memory.

The Stage 4 request locks a long-only or long/short quantile portfolio. Equal sizing uses no weight
column; trailing-information sizing names a strictly positive artifact-output column, so portfolio
construction cannot be substituted after OOS results are visible.

Known `PIT_UNSAFE`, unverified point-in-time, assumed-availability, and survivorship-biased or
unknown declarations remain available for exploration but are rejected at promotion with C1. Do not
change an adapter guarantee merely to pass that boundary.

The engine freezes this chain before a metric can become a claim:

```text
guarded read → artifact → per-decision contract → registration chronology
             → unverified candidate → pricing/gates → Experiment → exact reproduction
```

See the repository
[quickstart](https://github.com/HanshengGUO/veil/blob/master/docs/quickstart.md) and cold
[single-agent example](https://github.com/HanshengGUO/veil/tree/master/examples/agent-loop), and
[Stage 4 agent example](https://github.com/HanshengGUO/veil/tree/master/examples/stage4-agent-loop).

## Extension boundary

Veil does not fork Pi. If an invariant cannot be enforced from an extension, the enforcement belongs
in `@veilquant/engine`. Exploration heuristics never become blockers, and the extension does not
claim to sandbox a user's shell or defend against a deliberately malicious agent.
