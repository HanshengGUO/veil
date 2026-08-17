# Gate、Experiment 与 Reproduction

[English](../gates.md) | 简体中文

Stage 4 把一个结构验证通过的 promotion candidate 变成经过定价和 policy evaluation 的 Experiment。这是
Veil 第一次可以签发可引用绩效指标的地方。

Gate 会保留三种都有价值的结果：accepted work 成为可引用结果，degraded work 明确缺少什么，rejected
work 留作 negative evidence，避免以后重新发现同一个失败想法。

```text
guarded reads → artifact → walk-forward contract → promotion candidate
                                                       ↓
retained replay → trades → gross returns → costs → net returns
                                                       ↓
trial audit → eight-gate policy → Experiment → append-only memory
                                                       ↓
                  archived code + read sets → exact reproduction
```

源码 checkout 中可以运行：

```bash
npm run stage4-plugin:verify
npm run stage4-claim:verify
npm run stage4-agent:verify
npm run bench:stage4:verify
```

## 什么才算结果

Promotion candidate 仍是 `unverified`，仅完成 pricing 也仍是 `unverified`。只有完整
`veil.experiment.v0` 且 `claimStatus: verified` 才能支持没有限定条件的正向 claim。Rejected Experiment
仍是有价值的 negative evidence，会和 accepted work 一样进入 memory。

| Verdict | Claim status | 含义 |
| --- | --- | --- |
| `accepted` | `verified` | 所有 required 和 optional gate 都通过 |
| `degraded` | `degraded` | Required gate 通过，但至少一个 optional method 不可用 |
| `rejected` | `rejected` | Gate 失败或 required method 不可用 |

这个状态由 engine 推导。Caller 不能自行提供 verdict、删除不方便的 gate，或从手写 gate JSON 签发
Experiment。

## Immutable evidence

Portable chain 使用以下 content-addressed format：

| Format | Identity | 用途 |
| --- | --- | --- |
| `veil.pricing-evidence.v0` | `pricingHash` | 绑定 candidate 的 trade、gross/net return、cost 与 metric |
| `veil.trial-audit.v0` | `auditHash` | Declared、active-session 与 same-family trial identity |
| `veil.gate-method-evidence.v0` | `evidenceHash` | Method dependency、statistic、outcome 与 reason code |
| `veil.gate-policy.v0` | `policyHash` | 完整且有序的 gate policy |
| `veil.gate-evaluation.v0` | `gateEvaluationHash` | Policy 每个 entry 恰好一个结果 |
| `veil.experiment.v0` | `experimentId` | 可引用 metric 与最终 claim state |
| `veil.experiment-memory.v0` | `memoryHash` | Compact append-only family memory |

带注释 schema 位于 [`packages/veil-contract/schemas`](../../packages/veil-contract/schemas/README.md)。Public
verifier 会沿每条 link 回查 candidate、artifact、plan、contract、registration 和 adapter declaration。
SHA-256 只能检测变化，本身不证明 provenance。

## 配置默认项目

默认 loader 提供三种 audited cost model 和一个 deterministic null generator：

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

物理 root 与 provider config 留在本地 capability 中；portable evidence 只包含 logical reference 和 config
hash，不包含 root、credential、callback 或 child stderr。

## 请求完整 Stage 4 run

在 `veil.promotion-request.v0` 中加入严格的 `stage4` block：

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

只有 evidence 确实不存在时才使用 `capacity: null`、`null_generator: null` 或
`knowledge_cutoff: null`。它会让对应 optional gate 明确 unavailable，因此结果不能成为无条件 verified
claim。所有 pricing 和 gate identity 都会在 OOS 前写入 artifact parameter lock，看到结果后不能更改。

Signal / price column 必须是 numeric，`market_columns` 必须包含 cost/capacity method 需要的字段。Quantile
method 按 locked signal 排名，以 canonical entity identity 打破 tie，支持 gross-one long-only 或 0.5/0.5
long/short。Execution 会遵守 lag 和 holding period，在执行 session 重新应用 tradability mask；masked order
不成交，已有 masked position 继续持有，其余可执行部分按 locked gross exposure 重新缩放。

## 标准八个 gate

Threshold 属于标准 method implementation identity，不是 request parameter。

| Gate | Required | 当前规则 | 常见失败 |
| --- | --- | --- | --- |
| Capacity sensitivity | 否 | 最大交易 participation 不得超过锁定 NAV/volume limit | `capacity-participation-exceeded` |
| Cost sensitivity | 是 | 锁定成本和双倍成本下 net return、Sharpe 均为正 | `cost-stress-failed` |
| Hypothesis contamination | 否 | OOS 必须晚于 model knowledge cutoff，或提供独立 validation | `post-cutoff-validation-required` |
| Null falsification | 否 | One-sided plus-one empirical Sharpe p-value <= 0.05 | `null-falsification-failed` |
| Parameter stability | 是 | Base 加至少两个不同邻近参数，至少三分之二 return / Sharpe 为正 | `parameter-neighborhood-incomplete` |
| Trial budget | 是 | Effective trials 不得超过预锁定 budget | `trial-budget-exhausted` |
| Trials-aware deflated Sharpe | 是 | 至少 30 个 OOS observation；概率 >= 0.95，exploratory 为 0.99 | `deflated-sharpe-failed` |
| Walk-forward stability | 是 | 至少 3 folds、三分之二为正、单 fold 不超过 absolute return 的 60% | `walk-forward-concentration-failed` |

Capacity、knowledge cutoff 和 null generator 缺失属于 optional-method outcome；parameter stability 是
required，缺少邻近参数 evidence 会直接拒绝。

### Trial accounting

```text
max(trials_declared, active-session verification attempts + prior same-family Experiments)
```

Audit 保存精确 attempt id、Experiment id、session-ledger hash 和 family-snapshot hash。重复 rejected attempt
会提高而不是重置统计价格。v0 使用 count-based budget；future e-value policy 目前没有被暗中近似实现。

### Null evidence

内置 provider 先移除 observed return mean，再生成 deterministic circular fixed-length block bootstrap。
这样保留短期依赖，同时施加 zero-mean null。Gate 用 plus-one correction 比较 observed net Sharpe。资产专用
或生成式 null 应实现为 `NullGenerator` plugin。

### Knowledge contamination

`knowledge_cutoff` 表示 originating model 可能已经知道历史结果的最晚日期。如果 base OOS 没有超过它，
需要至少 30 observations、annual return 为正的 compatible post-cutoff pricing record。这只能缓解 LLM
memorization，不能证明 idea 未被模型见过。

## 编写插件

`CostModelProvider` 接收 canonical trade 和 execution-session market field，为每条 trade 返回一个非负
portfolio-NAV charge。`NullGeneratorProvider` 接收 immutable observed net-return series，返回 32–10,000
个长度相同的 finite sample。

```bash
cp -R examples/stage4-plugin my-plugin
npm run stage4-plugin:verify
```

模板位于 [`examples/stage4-plugin`](../../examples/stage4-plugin)。Provider error 会脱敏，private callback
diagnostic 不进入 Experiment evidence。默认 YAML loader 只接受 audited built-in；自定义 Pi 包可以包装
default loader 并注册 provider。Plugin 不能修改 walk-forward mechanism、删除 required gate、直接提供
aggregate metric 或在 artifact lock 后更换 identity。

## Memory 与精确复现

每个完整 accepted、degraded 或 rejected Experiment 都会追加到当前 Pi branch 和 project research log。
下一轮开始前，Veil 注入最近五个 same-family Experiment 的 bounded summary。`veil-memory` 提供
`list_experiments`、`get_experiment`、`family` 和 `trial_evidence`；`/veil-family` 总结当前 fork lineage。

Project archive 保存精确 artifact bytes、pricing/gate replay bundle 和所有 guarded read-set snapshot id：

```text
/veil-reproduce sha256:<experiment-id>
```

复现会在临时 root materialize 归档代码，从精确 snapshot 重跑 contract decision，重新定价和执行 gate，
并比较 Experiment、pricing、gate 与 metric identity。绝不会 fallback 到当前数据。Retention 删除 snapshot
后以 `READ_SET_UNAVAILABLE` 失败；结果仍有 attestation，但不再可复现。

## 解释失败

先查看结构化 `reasonCode`；execution failure 再查看 trusted runtime 的 private diagnostics。不要为了通过
claim 削弱 protocol 或修改 adapter guarantee。只有研究问题本身不变时才调整参数；否则注册新的 hypothesis
family。每次完整失败都会留在 memory 中，并计入未来 trial evidence。
