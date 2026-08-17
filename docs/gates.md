# Gates, Experiments, and reproduction

English | [简体中文](./zh-CN/gates.md)

Stage 4 turns one structurally verified promotion candidate into a priced and policy-evaluated
Experiment. It is the first point where Veil can issue a citable performance metric.

Gates record all three useful outcomes. Accepted work becomes a citable result, degraded work says
what is missing, and rejected work is kept as negative evidence instead of being rediscovered later.

```text
guarded reads → artifact → walk-forward contract → promotion candidate
                                                       ↓
retained replay → trades → gross returns → costs → net returns
                                                       ↓
trial audit → eight-gate policy → Experiment → append-only memory
                                                       ↓
                  archived code + read sets → exact reproduction
```

Run the model-free acceptance paths from a source checkout:

```bash
npm run stage4-plugin:verify # custom provider conformance surface
npm run stage4-claim:verify  # direct engine issuance, memory, and reproduction
npm run stage4-agent:verify  # default Pi tool path, rejections, archive, and replay
npm run bench:stage4:verify  # T6/T7 G2 attribution plus the agent path
```

## What counts as a result

The promotion candidate remains `unverified`. Pricing alone remains `unverified`. Only a complete
`veil.experiment.v0` with `claimStatus: verified` supports an unqualified positive claim. A rejected
Experiment is still valuable negative evidence and is retained in the same memory as accepted work.

| Verdict | Claim status | Meaning |
| --- | --- | --- |
| `accepted` | `verified` | Every required and optional gate passed |
| `degraded` | `degraded` | Required gates passed, but at least one optional method was unavailable |
| `rejected` | `rejected` | A gate failed, or a required method was unavailable |

The engine derives this state. Callers cannot supply a verdict, omit an inconvenient gate, or issue
an Experiment from hand-built gate JSON.

## Immutable evidence

The portable chain uses these content-addressed formats:

| Format | Identity | Purpose |
| --- | --- | --- |
| `veil.pricing-evidence.v0` | `pricingHash` | Candidate-bound trades, gross returns, costs, net returns, and metrics |
| `veil.trial-audit.v0` | `auditHash` | Declared, active-session, and same-family trial identities |
| `veil.gate-method-evidence.v0` | `evidenceHash` | Method dependencies, statistics, outcome, and reason code |
| `veil.gate-policy.v0` | `policyHash` | The complete ordered gate policy |
| `veil.gate-evaluation.v0` | `gateEvaluationHash` | Exactly one result for every policy entry |
| `veil.experiment.v0` | `experimentId` | The citable metrics and final claim state |
| `veil.experiment-memory.v0` | `memoryHash` | Compact append-only family memory |

Annotated records live in
[`packages/veil-contract/schemas`](../packages/veil-contract/schemas/README.md). Public verifiers
follow every link back through the candidate, artifact, plan, contract, registration, and adapter
declaration. A SHA-256 string detects mutation; it is not provenance by itself.

## Configure the default project

The default loader provides three audited cost-model kinds and one deterministic null generator:

```yaml
# .veil/project.yaml
format: veil.project.v0
datasets:
  - dataset: my-prices
    adapter: adapters/prices.yaml
    root: null
    root_env: VEIL_PRICES_ROOT
runtimes:
  - id: veil-node
    constraints: [">=20.10.0,<30"]
promotion_concurrency: 2
stage4:
  cost_models:
    - kind: linear-bps
      reference: equities-10bps
      basis_points: 10
    - kind: hong-kong-equity
      reference: hk-equities-v1
      commission_bps: 3
      trading_fee_bps: 0.05
      transaction_levy_bps: 0.027
      stamp_duty_bps: 10
    - kind: crypto-futures
      reference: crypto-taker-v1
      taker_fee_bps: 4
      slippage_bps: 2
  null_generators:
    - kind: centered-block-bootstrap
      reference: daily-centered-blocks
      replications: 1024
      block_length: 5
      seed: 20260813
```

Physical roots and provider configuration remain local capabilities. Portable evidence contains
logical references and configuration hashes, never a root, credential, callback, or child stderr.

## Request a complete Stage 4 run

Add a strict `stage4` block to `veil.promotion-request.v0`:

```yaml
cost_model: equities-10bps
stage4:
  signal_column: score
  price_column: close
  market_columns: [volume]
  periods_per_year: 252
  portfolio_kind: long-short-quantile
  quantile: 0.2
  weight_column: null
  capacity:
    portfolio_nav: 1000000
    volume_column: volume
    maximum_participation_rate: 0.05
  null_generator: daily-centered-blocks
  trial_budget: 12
  knowledge_cutoff: 2025-12-31T00:00:00.000Z
```

Use `capacity: null`, `null_generator: null`, or `knowledge_cutoff: null` only when that evidence is
genuinely unavailable. Each makes its optional gate explicitly unavailable and therefore prevents
an unqualified verified claim. The complete pricing and gate identities are copied into the
artifact's parameter lock before OOS execution; they cannot be changed after results are visible.

The signal and price columns must be numeric. `market_columns` must include every field required by
the cost and capacity methods. The quantile method ranks by the locked signal, breaks ties by
canonical entity identity, and supports either a gross-one long-only book or a 0.5/0.5 long/short
book. Equal sizing uses `weight_column: null`; otherwise the named artifact-output column must carry
strictly positive trailing-information sizes, normalized within each selected side. The method
starts every fold flat, respects the artifact's execution lag and holding period, and fails instead
of inventing missing prices. It
reapplies the adapter's tradability mask at the execution session: masked orders are not filled,
existing masked positions are carried, and the executable part of each side is rescaled to preserve
the locked gross-exposure limit.

## The standard eight gates

Thresholds are part of the standard method implementation identity, not request parameters.

| Gate | Required | Current rule | Common failure |
| --- | --- | --- | --- |
| Capacity sensitivity | no | Maximum trade participation must not exceed the locked NAV/volume limit | `capacity-participation-exceeded` |
| Cost sensitivity | yes | Net return and Sharpe stay positive under locked costs and doubled costs | `cost-stress-failed` |
| Hypothesis contamination | no | OOS observations must postdate the locked model-knowledge cutoff, directly or in separate validation | `post-cutoff-validation-required` |
| Null falsification | no | One-sided plus-one empirical Sharpe p-value is at most 0.05 | `null-falsification-failed` |
| Parameter stability | yes | Base plus at least two distinct neighboring locks; at least two-thirds have positive return and Sharpe | `parameter-neighborhood-incomplete` |
| Trial budget | yes | Effective trials do not exceed the pre-locked count budget | `trial-budget-exhausted` |
| Trials-aware deflated Sharpe | yes | At least 30 OOS observations; probability at least 0.95, or 0.99 for exploratory registration | `deflated-sharpe-failed` |
| Walk-forward stability | yes | At least three folds, at least two-thirds positive, no fold above 60% of absolute return | `walk-forward-concentration-failed` |

`capacity-configuration-unavailable`, `knowledge-cutoff-unavailable`, and
`null-generator-not-locked` are explicit optional-method outcomes. `parameter-stability` is required,
so missing neighbor evidence rejects rather than degrades.

### Trial accounting

The effective count is:

```text
max(trials_declared, active-session verification attempts + prior same-family Experiments)
```

The audit stores the exact attempt ids, Experiment ids, session-ledger hash, and family-snapshot
hash. Repeating a rejected attempt therefore tightens, rather than resets, the statistical price.
The v0 policy uses count-based budgeting. An always-valid/e-value pricing policy is a reserved future
extension; it is not silently approximated by the current executor.

### Null evidence

The built-in provider removes the observed return mean and generates deterministic circular fixed
length block-bootstrap samples. This preserves short-range return dependence while imposing a
zero-mean return null. The gate compares the observed net Sharpe with those samples using the
plus-one correction. Asset-specific or generative nulls belong in a `NullGenerator` plugin.

### Knowledge contamination

`knowledge_cutoff` records the latest date at which the originating model could already have known
the historical result. If the base OOS period does not extend beyond it, the run needs a compatible
post-cutoff pricing record with at least 30 observations and positive annual return. This mitigates
LLM memorization; it cannot prove that an idea was unknown.

## Write a plugin

`CostModelProvider` receives canonical trades plus execution-session market fields and must return
exactly one non-negative portfolio-NAV charge for every trade. `NullGeneratorProvider` receives the
immutable observed net-return series and must return 32–10,000 finite, same-length samples.

Start from the runnable template:

```bash
cp -R examples/stage4-plugin my-plugin
npm run stage4-plugin:verify
```

The full source is in [`examples/stage4-plugin`](../examples/stage4-plugin). Its conformance script
calls `executeRegisteredCostModel()` and `executeRegisteredNullGenerator()`, the same validated
surfaces used by pricing and gates. Provider errors are sanitized; private callback diagnostics do
not enter Experiment evidence.

The default YAML loader accepts only audited built-ins. A custom Pi package can wrap the default
loader and register its providers without changing any tool contract:

```ts
import { createVeilExtension, loadVeilProject } from "veil-quant";
import { createExampleEquityCostModel } from "./plugin.js";

export default createVeilExtension({
  projectLoader: async (cwd) => {
    const project = await loadVeilProject(cwd);
    project.costModels?.register(createExampleEquityCostModel());
    return project;
  },
});
```

A provider is domain methodology, not a bypass. It cannot change the walk-forward mechanism, omit a
required gate, supply an aggregate metric, or replace its identity after the artifact is locked.

## Memory and exact reproduction

Every complete accepted, degraded, or rejected Experiment is appended to Pi's active branch and to
the project research log. Before a new turn, Veil injects a bounded summary of the latest five
same-family Experiments. `veil-memory` exposes `list_experiments`, `get_experiment`, `family`, and
`trial_evidence`; `/veil-family` asks the agent to summarize the active fork lineage.

The project archive stores the exact artifact bytes, pricing/gate replay bundle, and the content ids
of all guarded read-set snapshots. Reproduce one result from Pi with:

```text
/veil-reproduce sha256:<experiment-id>
```

Reproduction materializes the archived code in a temporary root, reruns every contract decision from
the exact snapshots, reprices it with the registered provider identity, reruns every gate, and
compares Experiment, pricing, gate, and metric identities. It never falls back to current data. If a
snapshot was deleted under a retention policy, the operation fails with `READ_SET_UNAVAILABLE`; the
result remains attested, not reproducible. A retention operator records the immutable deletion first
with `recordProjectReadSetRetentionDeletion()`; that helper does not delete bytes or choose policy.

## Interpreting failures

First use the structured `reasonCode`, then inspect private trusted-runtime diagnostics when the code
is an execution failure. Do not weaken the protocol or edit an adapter guarantee to make a claim
pass. Change a hypothesis or parameter only when it remains the same declared research question;
otherwise register a new hypothesis family. Every failed complete run remains in memory and counts
toward future trial evidence.
