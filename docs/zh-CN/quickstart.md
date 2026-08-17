# 快速开始：第一个 Veil 研究 Loop

[English](../quickstart.md) | 简体中文

本指南把一个私有 CSV 接入 [Pi](https://github.com/badlogic/pi-mono)，并生成结构验证通过的 promotion
candidate。你仍然用普通 coding agent、文件和脚本探索；只有准备提出 claim 时，Veil 才会重新执行、定价
并检查打包后的 factor。

先记住一个边界：没有 `stage4` block 的请求只产生 **contract-verified、unverified promotion
candidate**。完整 Stage 4 请求还会给 OOS execution 定价、审计 trials、执行全部 gate，并归档可引用的
Experiment。

## 1. 安装

Veil library 需要 Node 20.10 或更高版本；仓库固定的 Pi 0.84.1 runner 需要 Node 22.19 或更高版本。
安装已经发布的 npm 包：

```bash
pi install npm:veil-quant
```

从源码 checkout 安装：

```bash
git clone https://github.com/HanshengGUO/veil.git
cd veil
npm install
pi install ./packages/veil-agent
```

Pi package 使用当前用户权限运行。安装第三方 extension 前应查看源码。Veil 不会给 shell 增加 sandbox；它的
安全边界是只有单独的 promotion surface 可以签发结构化 claim evidence。

## 2. 声明 CSV

在准备启动 Pi 的项目中创建 `adapters/prices.yaml`，按实际数据修改 dataset、字段名和文件名。不要写入
绝对路径、DSN、token 或 credential。

```yaml
dataset: my-prices
version: "1"
entity_key: ticker
event_time: date
available_time: null
frequency: 1d
guarantees:
  point_in_time: false
  survivorship_free: false
  tradability_mask: tradable
payload_schema:
  close: float64
  volume: float64
source:
  type: csv
  locator: prices.csv
```

如果下载历史没有可信的“首次可知时间”，这份保守声明仍可用于 guarded exploration。Veil 按
`event_time` 过滤并保留 `PIT_UNSAFE`；它不会假装数据具备 PIT 保证。Promotion 会按 C1 拒绝，因为后续
gate 无法修复缺失的 PIT 或 survivorship evidence。

如果文件确实记录每个值最早可知的时间，则诚实声明：

```yaml
available_time: first_known_at
availability_basis: observed
guarantees:
  point_in_time: true
  survivorship_free: true
  tradability_mask: tradable
```

只有 source 真实包含 point-in-time universe history 时才能设置 `survivorship_free: true`；当前成分列表不
够。一次性 backfill 的历史也不能仅凭一个日期字段标为 `observed`，请按[Adapter 文档](./adapters.md)使用
`reconstructed` 或 `assumed`。

## 3. 注册本地 capability

在 Pi working directory 创建 `.veil/project.yaml`：

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

启动 Pi 前设置环境变量。值可以指向项目外部，且不会被复制到 tool result、session ledger、run evidence
或 research log：

```bash
export VEIL_PRICES_ROOT=/private/path/to/csv-directory
pi
```

数据就在 adapter 旁边时使用 `root: .` 和 `root_env: null`；项目下更窄目录可以写相对 `root`。`root` 与
`root_env` 必须且只能选择一个。默认 profile 支持 CSV/Parquet；自定义 backend 通过 project-loader
interface 注入，不应把 SQL 或 DSN 加进 tool schema。

`.veil/views/`、`.veil/runs/`、`.veil/experiments/` 和 `.veil/research-log.md` 可能暴露研究 identity 或
笔记，即使其中没有 source path。按项目隐私规则把它们加入 ignore。

## 4. 从 brief 开始

在 Pi 中调用 packaged prompt：

```text
/veil-research-plan Test whether 20-session cross-sectional momentum survives a one-session execution lag.
```

Agent 开始前，Veil 会自动把第一个 brief 和 hypothesis 写入当前 Pi session branch。Durable entry id 与
timestamp 由 Pi 提供；tool argument 中手工输入的时间不能作为 chronology evidence。

可以要求 agent 对 `veil-memory` 调用：

```json
{ "action": "status" }
```

需要更具体的 registration 时使用：

```text
/veil-hypothesis momentum-20-v1 :: Past 20-session winners outperform losers after a one-session lag.
```

研究问题发生实质变化时必须使用新 reference。Pi session fork 只继承被选 ancestor branch 的 entry，
sibling research 不会悄悄变成 preregistration。

## 5. 读取和探索

让 agent 调用 `veil-data`，明确给出 cutoff：

```json
{
  "dataset": "my-prices",
  "mode": "panel",
  "as_of": "2026-08-12T00:00:00.000Z",
  "columns": ["ticker", "date", "close", "volume"],
  "output": "arrow"
}
```

- `output: "arrow"` 会显式创建 `.veil/views/<read-set-id>.arrow`。
- `output: "summary"` 不写文件。

两种模式都经过 mandatory temporal guard。Panel 是 `exploration-grade`；point read 是 `guarded`，但这仍
不表示 performance claim 已验证。

接下来照常探索。Pi 仍可读取文件、写脚本并运行任意分析。若 output 看起来包含全样本拟合、future
function 或当前成分股 universe，extension 会追加 advisory；它是 heuristic，不会改变 tool success。
所有探索指标都应标记为 `unverified`。

## 6. 打包一个 factor

内置 `veil-node` runner 以 `compute(table, context)` 调用 deterministic module。`table` 是某一个 train
cutoff 或 OOS decision 的 guarded Arrow table。`context` 包含 locked params、declared literals、dataset
identity、decision time 和 content hash，不包含 source binding、path、credential 或未来 block。

Callable 可以返回 Arrow IPC、Arrow `Table`，或 dependency-free row selection：

```js
// factor/factor.mjs
export function compute(table, context) {
  const close = table.getChild("close");
  if (close === null) throw new Error("close is missing");

  const rowIndices = Array.from({ length: table.numRows }, (_, row) => row);
  return {
    rowIndices,
    columns: {
      signal: rowIndices.map((row) => Number(close.get(row))),
    },
  };
}
```

Runner 会保留选中 source row 的原字段，并加入 derived column。Parent process 会再次拒绝任何重新引入
mask-first input 中不存在的 entity/event pair，或把历史 row 冒充当前 OOS signal 的 output。

`rowIndices` 必须按 source-table order 严格递增。没有 signal 的 source row 应使用 `null`，不要为了分组
重新排序。

## 7. 准备并执行 promotion

复制完整模板
[`promotion-request.yaml`](../../packages/veil-agent/skills/research-loop/assets/promotion-request.yaml)
到 `.veil/promotion.yaml`，并替换全部 placeholder。关键字段：

- `hypothesis_ref`：必须能在 `veil-memory status` 中找到；
- `development_read_sets`：当前 branch 上 `veil-data` 实际返回的 id；
- `factor.code_root` / `factor.files`：明确且 project-relative 的代码成员；
- `params_locked` / `declared_literals` / `trials_declared`：完整 searched artifact identity；
- `decision_schedule`：唯一且有序的 session，不是猜测 calendar；
- `protocol`：rolling/expanding fold、purge、embargo、holding 与 execution lag；
- `cost_model`：portable logical provider id，不能是 path 或 URI；
- `stage4`：锁定 pricing column、portfolio kind、sizing、capacity、null method、trial budget 与 model
  knowledge cutoff。只有明确只要 structural candidate 时才省略整个 block。

一个 promotion request 只能命名一个 registered dataset，且每个 development read-set id 必须来自同一
dataset。其他数据可参与探索，但在 session 前没有注册 composite source 时，candidate 只验证所选结构切片，
不能证明 multi-source metric。不得为了通过 promotion 修改 adapter guarantee。

Schedule 长度必须严格等于：

```text
train_days + purge_days + embargo_days + folds * oos_days
```

所有 `*days` 都按 schedule entry 计，不按自然日。标准 Stage 4 stability/significance gate 至少需要 3 个
OOS fold 和 30 个 OOS observation。每个 train cutoff 与 OOS decision 都会执行一次 artifact。

只有在不改变 registered input 和 research brief 时，才应用 structured remedy。如果 brief 指定的 protocol
或已有 dataset guarantee 与 C1-C4 本质冲突，应保留 rejection 并报告 invalid/exploratory，而不是悄悄改变
研究问题。Promotion 成功或得到诚实 terminal rejection 后，本轮就应停止，记录 evidence 与 limitation。

Promotion 前逐项比较本地计算与 request：universe、signal time、entry time、holding、rebalance、return
convention、mask 和 cost。Candidate 只验证该 request，不能为不同 timing 的 local metric 背书。只有
accepted Experiment 才能验证它自己的精确 metric。

```text
/veil-promote .veil/promotion.yaml
```

`veil-backtest` 会先写 durable verification-start entry，再做 semantic preflight：拒绝已知 PIT / survivorship
critical degradation，重新捕获代码，创建 artifact，对每个 train/OOS decision 执行 fresh guarded read 与
framed child，验证 C1-C4，再应用 C6 chronology。

Structural-only success 形状如下：

```json
{
  "ok": true,
  "status": "awaiting-pricing-and-gates",
  "structuralStatus": "contract-verified",
  "claimStatus": "unverified",
  "registrationStatus": "preregistered",
  "candidateHash": "sha256:...",
  "requiredEvidence": ["pricing", "costs", "statistical-gates"]
}
```

完整 Stage 4 success 会返回 `status: "complete"`、`experimentId`、`verdict: "accepted"`、
`claimStatus: "verified"`、net OOS metric 与每个 gate 的 reason。Degraded / rejected Experiment 也会
归档，不能隐藏或称为 verified。

完整 C1-C6 evidence 写入 `.veil/runs/`；Stage 4 archive 位于 `.veil/experiments/`；精确 guarded input
位于 `.veil/snapshots/`。Pi branch 和 `.veil/research-log.md` 只接收 compact memory，不含 private root。

```text
/veil-reproduce <experimentId>
```

Reproduction 会 materialize 归档 artifact、replay 精确 snapshot、重新 pricing 和执行 gate，并要求所有
Experiment/metric/pricing/gate identity 完全匹配。Snapshot 缺失时返回 `READ_SET_UNAVAILABLE`，绝不替换成
当前数据。

## 冷启动参考与 30 分钟试跑

源码 checkout 中运行：

```bash
npm run agent-loop:verify
npm run stage4-agent:verify
```

外部 usability trial 应由没有参与实现的人使用真实私有 CSV：

- [ ] 记录 Veil commit、OS、architecture、Node、npm 与 Pi 版本。
- [ ] 不修改源码安装 `veil-quant`。
- [ ] 创建 adapter 与 `.veil/project.yaml`，不嵌入 private root/credential。
- [ ] 完成一次 `veil-data` read，并能解释每个 degradation。
- [ ] 注册具体 hypothesis，打包一个 deterministic factor。
- [ ] 运行 `/veil-promote`；只有 PIT 与 survivorship evidence 真实充分时才得到 candidate，否则保留并解释
      C1 rejection。若配置 Stage 4，解释每个 gate 并按 id 复现 Experiment。
- [ ] 确认 tool output、session entry、run evidence 和 log 不含 private root。
- [ ] 30 分钟内完成；否则保留 exact blocked step 与 public error。

只记录 metadata，不记录 CSV、path、credential、环境变量值或 source row：

```text
Veil version / commit:
OS / architecture:
Node / npm / Pi:
Approximate CSV shape:
Minutes to first guarded read:
Minutes to promotion candidate / Experiment:
Unexpected public code and remedy:
First unclear documentation step:
Did any output expose a root or secret? yes/no
Could the user explain candidate vs Experiment? yes/no
Outcome: pass / blocked
```

外部 pass 衡量的是 usability，不能替代 contract test。Blocked outcome 也必须保留，并修复导致阻塞的说明
或 diagnostic。
