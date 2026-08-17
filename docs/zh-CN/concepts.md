# 核心概念

[English](../concepts.md) | 简体中文

Veil 把自由探索和正式 claim 分成两条规则不同的路径。下面八个概念描述了这条边界。

## Exploration surface

这就是平常的研究过程：agent 读数据、写代码、运行自己的回测并反复修改。Veil 不阻断这一层；否则研究员
只会绕过它。

Veil 会提供更安全的默认工具：`veil-data` 返回带 tradability mask 的 point-in-time view；当 tool output
看起来可能泄漏未来信息时，extension 会给出 advisory。Advisory 只是提醒，不是 gate。Pi 原有的 file 和
shell 工具仍然可用。

这一层产生的数字全部是 **`unverified`**。这不是对结果的评价，只是它当前所处的状态。

## Verification surface

当一个数字准备成为 claim 时，工作会进入 verification surface。`veil-backtest` 把因子重新打包成
artifact，并在每个 walk-forward 决策点重新执行。子进程启动前，该时点不可能知道的行已经从输入中移除。

因此，这里的防泄漏不是 code review 建议，而是输入结构本身的限制：不存在的数据不能参与全样本统计，
窗口中没有的 bar 也不能生成信号。结构验证通过后，结果才能继续进入 Stage 4 定价、trial accounting、
统计 gate 和归档。

## Artifact

Artifact 是跨过边界的执行单元：`compute(data_view)`、锁定的参数、依赖的数据语义和执行协议，并由
content hash 标识。

- 参数变化会产生不同 hash，因此看到 OOS 结果后再调参不能伪装成原 artifact。
- 研究和生产可以加载同一个执行单元，不需要维护两套因子实现。

把探索代码整理成 `compute(data_view)` 不是额外仪式；任何准备部署的代码本来就需要这个步骤。

## Promotion candidate

Artifact 完成所有 PIT、mask-first walk-forward 决策，且假设时间顺序通过检查后，会得到 promotion
candidate。它是后续定价和 gate 的输入，**不是结果**；其 claim status 仍为 `unverified`，candidate hash
也不能当作 experiment id 引用。

Candidate hash 还绑定该次运行的 verification-start entry。结构化重跑会比较 artifact、plan 和 contract
hash，并独立 replay-verify 新生成的 candidate。

## Research run

一次 promotion 尝试对应一条 append-only ledger 记录。它包含 Pi session 中持久化的开始 entry、
`researchRunId`，以及结构化 rejection 或 replay-verified candidate。完整 Stage 4 请求随后会写入另一条
Experiment memory。当前 Pi branch 决定这次运行的 ancestry。

Research run 不是 Experiment；Markdown log 只用于审计，不能提供可引用的绩效指标。

## Experiment record

Stage 4 在结构验证、定价、成本和统计 gate 全部完成后签发 Experiment。记录中包含指标、每个 gate 的
结果、artifact hash、数据集和保证、注册假设、verdict 与理由。

Experiment 是系统中唯一可以引用绩效指标的记录。结论如果引用一个没有 experiment id 的绩效数字，会被
拒绝而不是降级。正是这条规则让 exploration surface 可以保持自由。

## Evaporation

Evaporation 是探索时报告的结果与 verification 最终签发结果之间的差。

Stage 4 定价后可以把它读成：“因子经过检查后损失了多少 Sharpe。”手写 golden path 中，naive Sharpe
为 8.61，诚实结果为 0.88，evaporation 为 7.7。Stage 3 candidate 不包含绩效指标，因此不报告
evaporation。

## Gates

Gate 在结构 promotion 之后、Experiment verdict 之前执行，分为两类：

- **Mechanism** 不可配置：读取必须 point-in-time，评估必须 walk-forward，trial 数必须进入统计价格。
  这些规则与资产类别无关。
- **Method** 由项目选择：显著性统计量、null generator 和 cost model。它们通过插件按资产类别注册。

如果缺少可选方法，例如 capacity data 或 null generator，结果会明确标记为 `degraded`；缺少必需的成本
或稳定性证据则直接拒绝 Experiment。

## 一句话版本

探索方式不变；当一个结果值得保留时，Veil 用一套不能悄悄改写的协议把它变成可复核、可复现的
Experiment。
