# 常见问题

[English](../faq.md) | 简体中文

## Veil 只是一个安全层吗？

不是。Veil 是一个带严格 claim boundary 的研究 harness。普通探索保持不变；当结果进入 promotion 时，
Veil 才加入 contract、gate、memory 和 reproduction。

在当前 QBench 运行中，contract/review/repair workflow 还提高了三个模型配置的 strict official
aggregate。这是这些冻结运行的证据，不表示每个模型都会更快或更好。详细协议见
[`bench/results`](../../bench/results/)。

## Veil 会阻止普通探索吗？

不会。Shell、notebook、脚本和探索指标都可以照常使用。Veil 把这些数字标记为 `unverified`，只有当结果
准备成为 claim 时才执行 contract。

## Candidate 和 Experiment 有什么区别？

Promotion candidate 证明 artifact 通过了 point-in-time、walk-forward、mask-first 和注册时间检查，
但其中没有绩效指标。Experiment 会进一步 replay retained evidence、计算交易和成本、执行全部统计 gate，
并生成 content id。只有 accepted Experiment 的 `claimStatus` 才是 `verified`。

## 为什么一个看起来很好的结果会被拒绝？

先看 gate 的 `reasonCode`。常见原因包括：双倍成本后优势消失、独立参数邻居不足、trial budget 用尽、
deflated Sharpe 低于 trials-aware 门槛，或收益集中在单一 fold。Rejection 会保留在 memory 中，避免同一个
失败想法被反复发现。

## 干净任务可以以“没有效应”正确结束吗？

可以。弱信号即使点估计为正，也可能无法通过预先锁定的统计 gate。此时引用 rejected Experiment 并报告
证据不足，是正确的研究结论。为了匹配期望区间而把结论改成“存在效应”不是。正向结论仍然必须引用
accepted、verified Experiment 里的精确指标。

## 为什么 Experiment 是 degraded，而不是 verified？

至少一个可选方法不可用，通常是 capacity、null generator 或 model knowledge cutoff。Degraded evidence
可以在说明限制后讨论，但不能支持没有限定条件的正向效应 claim。

## 必须使用内置 cost model 吗？

不需要。实现 typed `CostModelProvider`，或者从
[`examples/stage4-plugin`](../../examples/stage4-plugin) 开始。Provider 必须为每条 canonical trade 返回一个
有限、非负、以 NAV 为单位的成本；实现和配置 identity 会在 OOS 执行前锁定。

## `trials_declared` 应该统计什么？

同一研究 family 中探索过的所有 candidate，包括没有进入 promotion 的 candidate。Veil 会取声明值、当前
session 中可观察次数和同 family memory 次数的最大值，因此少报不会降低 effective trials。

## 数据变化后还能复现 Experiment 吗？

只要精确的 guarded read-set snapshot 仍然保留，就可以。`/veil-reproduce <experimentId>` 使用归档代码和
snapshot，并要求所有指标与 evidence identity 完全一致；它不会用新数据替换旧数据。若 retention 已删除
snapshot，会明确失败为 `READ_SET_UNAVAILABLE`。外部删除前应先用
`recordProjectReadSetRetentionDeletion()` 记录 operator、原因和时间。

## Content hash 能证明数据真实吗？

不能。Hash 只能证明已标识的 bytes 没有变化。数据可信度仍来自 adapter 语义、强制 temporal guard、
read-set capture 和 replay chain。未认证 provenance 会继续显示为 degradation。

## Knowledge-cutoff gate 能消除模型记忆吗？

不能。如果历史样本可能已进入模型训练数据，它会要求 post-cutoff evidence。这是缓解措施，无法证明一个
想法最初来自哪里。

## Veil 能防御故意恶意的 agent 吗？

这不在 v1 threat model 内。Veil 在 claim boundary 防止研究错误和统计上的自我欺骗，但不把 Pi 的普通
shell 描述成安全 sandbox。详见[契约的 threat model](./contract.md)。

## npm 版本已经可以安装了吗？

可以。v0.1.0 已通过跨平台 release smoke，并以 `veil-quant`、`@veilquant/engine` 和
`@veilquant/contract` 发布。Pi 包可用 `pi install npm:veil-quant` 安装。
