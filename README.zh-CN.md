# Veil

[English](./README.md) | 简体中文

[![CI](https://github.com/HanshengGUO/veil/actions/workflows/ci.yml/badge.svg)](https://github.com/HanshengGUO/veil/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/HanshengGUO/veil?display_name=tag)](https://github.com/HanshengGUO/veil/releases)
[![npm](https://img.shields.io/npm/v/veil-quant?logo=npm&label=veil-quant)](https://www.npmjs.com/package/veil-quant)
[![Node.js](https://img.shields.io/node/v/veil-quant?logo=nodedotjs)](./packages/veil-agent/package.json)
[![License: MIT](https://img.shields.io/github/license/HanshengGUO/veil)](./LICENSE)

**一个面向 AI 辅助量化研究的 evidence-first harness：自由探索，再把值得保留的工作变成经过验证、可以复现的结果。**

Veil 包在你已经使用的 AI coding workflow 外面。你仍然让 agent 写因子、模型和回测；Veil 不拦截普通
编码，不替换已有回测器，也不要求你学习一套新的研究 API。它只为“把探索结果变成正式结论”增加一条
更严格的路径：

> 一个数字只有在因子被重新打包、在看不到未来数据的窗口上逐期 walk-forward 执行，并通过相应 gate
> 之后，才会成为可以引用的**结果**。此前的数字都明确标记为 `unverified`。

可以把 Veil 理解为量化研究结论的 CI。编辑器不会阻止你写代码，但 CI 可以阻止不合格的代码合并；
同样，Veil 不限制探索，但会阻止缺少证据的 alpha 进入正式 claim。

> 一个让我们意外的结果是：在现有评估中，contract、独立审查和有边界的修复流程不只提供了保护，
> 还提高了最终交付的质量。

这套结构也让正常结果更容易接手：contract 是明确的，失败想法会留在 memory 里，复现不需要重新猜测
原始聊天和临时工作树里发生过什么。

当前状态：**v0.1.0 已完成发布准备。** Package manifest 和发布自动化已经就绪；npm 发布仍需等待
`v0.1.0` tag。更大规模的插件作者、隐藏集和外部用户验收会继续推进到 v0.2。

`veil-quant` Pi 包注册了 `veil-data`、`veil-backtest` 和 `veil-memory`。底层 engine 负责时间防护、
CSV/Parquet 读取、read-set snapshot、artifact 执行和 mask-first walk-forward contract。没有 Stage 4
配置的运行会停在 `contract-verified` 但明确 `unverified` 的 candidate；完整运行会继续执行 OOS 定价、
八个 gate、Experiment memory，并从归档代码和 read set 精确复现。

## 为什么需要 Veil

让 agent 自己写回测，迟早会遇到这些问题：用包含未来的信息做标准化、在信号生成的同一根 bar 成交、
挑选表现最好的窗口，或者试了二十个变体只汇报最好的一个。它们通常不像软件 bug，却足以让回测数字
失去实际意义。

下面是在同一个合成市场、同一个动量因子上的结果。每一行只改变一个协议开关：

| 协议 | 样本外 Sharpe |
| --- | ---: |
| **诚实协议** | **0.88** |
| 忽略成本 | 2.81 |
| 信号生成与成交使用同一根 bar | 8.44 |
| 在全样本上选择 lookback | 1.41 |
| **所有开关都错误的 naive pipeline** | **8.61** |
| 同一 naive pipeline，市场中**没有任何真实信号** | **7.21** |

最后一行最重要：如果一套协议能在纯噪声市场里报告显著优势，它就不能作为证据。完整研究和复现方式见
[`examples/golden-path`](./examples/golden-path)。

## 已测结果

以下结果来自首次公开发布前的本地评估。模型任务均为冻结的 score@1：每个任务只运行一个 session，
不根据结果选择性重跑。Kimi K3 在 Veil-bench 使用 Pi `low` thinking，在 QBench 使用 `high`；后续
DeepSeek V4 Flash / Pro 复现实验也使用一套冻结的 `high` thinking 协议。

> 三个已评估的 QBench 模型配置，strict official aggregate 均有提升：Kimi K3 **+4.25**，
> DeepSeek V4 Flash **+3.25**，DeepSeek V4 Pro **+3.25**。

| 证据 | 对照 | 结果 |
| --- | --- | --- |
| **Veil-bench public** | 历史 bare Kimi K3：35.7% safety、57.1% competence、2 个 false-effect claim | 当前 Veil profile：**100% safety**、**71.4% competence**、0 false-effect claim；8 个 trap 全部停在 G1/G2 |
| **小隐藏安全检查** | 冻结门槛：safety >= 87.5%，不得出现 G4 或 false-effect claim | **4/4 trap 停在 G1**，0 G4，0 false-effect claim；唯一 honest smoke 通过 |
| **QBench v2 Engineering** | Kimi K3 先前官方分 41.50/100 | 内部 opt-in workflow：**45.75/100（+4.25）**；evaluator error 按 0 分计 |
| **QBench replication** | DeepSeek V4 Flash / Pro bare：40.00 / 41.00 | 同一冻结 workflow：**43.25 / 44.25**，两个模型均 **+3.25** |

这些行衡量的不是同一件事。Veil-bench 检查错误研究能否被挡在 claim 之外，同时保留完成正常研究的能力；
QBench 衡量通用工程交付。QBench 的变化来自内部 test-time contract/review workflow，不是修改 QBench，
也不是改动 Veil core。它们是 score@1 结果，不是稳定因果效应。DeepSeek 行只说明 QBench，不代表
Veil-bench competence 提升；小隐藏集也只是一项安全 no-regression 检查。

完整协议、机器可读结果和限制见 [Kimi K3 评估快照](./bench/results/kimi-k3-stage4-2026-08/)与
[DeepSeek V4 QBench 复现](./bench/results/deepseek-v4-qbench-2026-08/)。

## 开始使用

v0.1.0 发布后，可以从 npm 安装 Pi 包：

```bash
pi install npm:veil-quant
```

从源码开发：

```bash
npm install
pi install ./packages/veil-agent
npm run agent-loop:verify # 不调用模型的冷启动参考路径
```

库支持 Node 20.10 到 29；仓库固定的 Pi 0.84.1 model runner 需要 Node 22.19 或更高版本。

接着按[中文快速开始](./docs/zh-CN/quickstart.md)声明自己的 CSV、创建 `.veil/project.yaml`、从 brief
开始研究，并运行 `/veil-promote`。默认 profile 不会序列化数据根目录；如果数据在项目外，使用环境变量
传入路径。

## 工作方式

Veil 把研究分为三个边界清楚的阶段：

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 你的 agent、代码与原有 workflow                                          │
├────────────────────────────┬──────────────────────────┬──────────────────┤
│ 自由探索                   │ 结构化 promotion         │ CLAIM（Stage 4） │
│ 不阻断                     │ 强制执行                 │ 本地强制执行     │
│                            │                          │                  │
│ 可使用 guarded view；      │ 每个 train/OOS 决策点    │ 定价、成本、      │
│ 普通代码和 shell 可用；    │ 重新执行 artifact；      │ 统计和 null gate │
│ advisory 不作为 gate       │ 检查 C1-C6 时间顺序      │                  │
│                            │                          │                  │
│ 输出：unverified 笔记      │ 输出：unverified         │ 输出：可引用的    │
│ 和探索指标                 │ promotion candidate      │ Experiment       │
└────────────────────────────┴──────────────────────────┴──────────────────┘
```

六条 invariant——决策时信息集、仅 walk-forward、参数锁定、mask-first、claim 必须验证、假设预注册——
定义在[契约文档](./docs/zh-CN/contract.md)中。Veil 只在文档列出的边界执行它们。

Veil 以 [Pi](https://github.com/badlogic/pi-mono) extension 的方式实现，复用 Pi 的 tool-call interception、
session log 和 package system，不 fork Pi。

## 仓库结构

```text
packages/veil-contract/   invariant、声明格式和 validator
packages/veil-engine/     PIT view、walk-forward 验证和 promotion evidence
packages/veil-agent/      用户安装的 Pi 包（npm 名为 veil-quant）
bench/                    Veil-bench 任务、runner 和 bare-agent baseline
bench/results/            经过复核的本地评估快照
examples/                 从 guarded read 到完整 Experiment 的可运行示例
docs/                     英文规范与使用文档
docs/zh-CN/               简体中文镜像
```

## 文档

| 页面 | 内容 |
| --- | --- |
| [快速开始](./docs/zh-CN/quickstart.md) | 安装 Pi 包，用自己的 CSV 跑通第一个完整 loop |
| [核心概念](./docs/zh-CN/concepts.md) | exploration、verification、artifact、candidate、Experiment 与 gate |
| [Veil Contract](./docs/zh-CN/contract.md) | invariant、降级规则和 threat model |
| [数据 adapter](./docs/zh-CN/adapters.md) | 声明时间语义、保守默认值、lineage 和 source binding |
| [Read set](./docs/zh-CN/read-sets.md) | 区分 source、query、logical result、Arrow 和完整 read identity |
| [`veil-data`](./docs/zh-CN/veil-data.md) | 查询 guarded point view，导出 exploration-grade panel |
| [Artifact](./docs/zh-CN/artifacts.md) | 打包并执行参数锁定的 artifact |
| [Gate 与 Experiment](./docs/zh-CN/gates.md) | Stage 4 定价、gate policy、memory 和 reproduction |
| [常见问题](./docs/zh-CN/faq.md) | claim、degradation、插件与复现 |
| [Veil-bench](./docs/zh-CN/bench.md) | 运行、评分、回放和贡献 benchmark 任务 |

英文文档是规范源；中文文档用于帮助理解。如果二者对 contract 或 wire format 的描述有差异，以英文文档、
schema 和机器验证结果为准。

## 路线图

| Stage | 交付内容 | Release |
| --- | --- | --- |
| 0 | Contract v1.0、骨架、手写 golden path、CI | — |
| 1 | 15 个 Veil-bench 任务、runner、bare-agent baseline | — |
| 2 | PIT view、adapter、verification engine、运行时 C1-C6 | — |
| 3 | Pi 包与端到端研究 loop | **v0.1** |
| 4 | 统计 gate、Experiment memory、指标级复现 | **v0.2** |
| 5 | 只有真实失败案例证明需要时，才引入 specialist agent | — |
| 6 | hardening profile、完整文档、模型 leaderboard | **v1.0** |
| 7 | artifact identity 与 parity gate 对齐部署 | v2 |

每个阶段都以 bench 数字验收。Safety 不允许回退，competence 和交付质量需要持续提高。评分规则见
[`bench/README.md`](./bench/README.md)，可信边界见[契约文档](./docs/zh-CN/contract.md)。

## 开发

需要 Node 20 或更高版本。

```bash
npm install
npm run check
npm run data:inspect -- --help
npm run agent-loop:verify
npm run stage4-plugin:verify
npm run stage4-agent:verify
npm run golden-path
npm run golden-path:evidence:verify
npm run bench:stage2:verify
npm run bench:stage3:verify
npm run bench:stage4:verify
npm run release:verify
```

## 许可证

MIT。
