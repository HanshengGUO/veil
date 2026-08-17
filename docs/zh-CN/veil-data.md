# `veil-data`

[English](../veil-data.md) | 简体中文

`veil-data` 为探索提供 point-in-time view。两种模式都要求显式 decision time，返回普通 Arrow 数据、
时间语义和稳定 read identity。

| Mode | 输出形状 | Label | 用途 |
| --- | --- | --- | --- |
| `point` | 某个 `as_of` 下的 projection，加声明的 tradability mask | `guarded` | 检查或计算当时可用的信息集 |
| `panel` | Projection，加 entity/event/availability/mask 字段 | `exploration-grade` | 导出 PIT-shaped panel 自由探索 |

`guarded` **不等于** verified。它只表示 common C1 guard 已物理移除 decision-time column 晚于 `as_of`
的行。可引用指标仍必须来自 walk-forward verification。没有可信 availability column 的数据继续标记为
`PIT_UNSAFE`；`veil-data` 不会提升其语义。

## API

```ts
import {
  BackendRegistry,
  createSourceBinding,
  createVeilData,
  DuckDbFileBackend,
  loadAdapterFile,
  openReadSetSnapshotStore,
  runVeilDataCli,
} from "@veilquant/engine";

const declaration = await loadAdapterFile("adapter.yaml");
const backend = new DuckDbFileBackend();
const registry = new BackendRegistry();
registry.register(backend);
const binding = createSourceBinding({
  id: "local-prices",
  backend: backend.id,
  options: { root: "/absolute/data/root" },
});

const data = createVeilData(registry);
const view = await data.point({
  declaration,
  binding,
  asOf: "2026-08-12",
  columns: ["ticker", "close"],
});

const guardedArrow = view.arrowIpc;
```

`asOf` 会在 runtime 检查，而不只依赖 TypeScript。缺失或空值会在任何 backend read 前抛出 C1；没有
“使用当前时钟”的默认值。Request 只接受 normalized declaration、opaque binding、`asOf` 和可选
projection，不接受 SQL、physical root 或 snapshot store。

返回 Arrow 是通过 `TemporalGuard` 的 bytes 副本。`readSet`、`semantics` 和 guard audit 作为
non-enumerable evidence property 保留。JSON / inspect 只显示不含路径的 summary，包括 decision time、
row count 和 content identity，不显示 Arrow row 或 binding value。

## Panel shape

Panel 会自动加入已声明的 entity key、event time、availability time 和 tradability mask，去重后再执行同一
backend-neutral guard。Point projection 也会保留 mask，避免调用方意外删掉 C4 输入。

```ts
const panel = await data.panel({
  declaration,
  binding,
  asOf: "2026-08-12",
  columns: ["value"],
});
// Arrow columns: ticker, event_time, available_time, [declared mask], value
```

省略 `columns` 会导出所有 guarded source columns。如果 adapter 声明 `available_time: null`，系统只能用
`event_time` 作为保守 fallback，不能凭空生成 availability column，`PIT_UNSAFE` 也会保留。

## 显式 snapshot

Read 本身没有持久化副作用。只有对已经 guarded 的 view 执行单独动作才会写 snapshot：

```ts
const store = await openReadSetSnapshotStore({ root: "/absolute/veil-snapshots" });
const written = await panel.writeSnapshot(store);
console.log(written.snapshot);
```

把 `snapshotStore` 放进 read request 会被当作未知字段拒绝。选择 Arrow output 时，即使 CLI 已配置 store
也不会写入。损坏 snapshot 不会通过新 query 自动修复；检查和 quarantine 见
[read-set 文档](./read-sets.md#只读检查与显式恢复)。

## Pi tool

`veil-quant` 注册同名 `veil-data` tool。Model-facing request 使用 snake_case，并从
`.veil/project.yaml` 选择 dataset：

```json
{
  "dataset": "my-prices",
  "mode": "panel",
  "as_of": "2026-08-12T00:00:00.000Z",
  "columns": ["ticker", "close"],
  "output": "arrow"
}
```

`tool_call` hook 会在执行前 normalize 并检查 `as_of`；缺失或格式错误按 C1 拒绝。

- `output: "summary"` 不写文件。
- `output: "arrow"` 显式写入 immutable `.veil/views/<read-set-id>.arrow`，并在当前 Pi branch 记录
  read-set identity。

物理数据 root 始终留在 opaque binding 内，不进入 response 或 ledger。

Guarded access 不代表 promotion eligibility。文件 profile 允许带 `PIT_UNSAFE`、assumed availability 或
survivorship degradation 的数据继续探索，但 `veil-backtest` 会在 promotion 时按 C1 拒绝这些关键语义。
应该修复 source evidence，不能为了得到 candidate 修改 guarantee。

## CLI core

Engine 提供 dependency-injected command runner，而不是数据库专用全局配置：

```ts
const result = await runVeilDataCli(
  ["panel", "--as-of", "2026-08-12", "--columns", "value", "--output", "arrow"],
  { registry, declaration, binding },
);
```

```text
veil-data <point|panel> --as-of <ISO-8601> [--columns a,b] --output <arrow|snapshot>
```

Launcher 负责注册 backend 与构造 binding，因此 CLI core 没有 DuckDB switch、SQL input、root argument、
DSN 或 credential parsing。File、DolphinDB、ClickHouse、API 或 in-memory launcher 都可以注入不同的
`TemporalBackend`；snapshot output 还需要显式传入 opened store。

源码 checkout 中，`npm run data:inspect` 是 file-specific launcher。它接收 adapter path、local root、明确
cutoff、可选 projection 和 opt-in row preview，然后输出不含 path 的 guarded panel summary。具体命令见
[快速开始](./quickstart.md)。

运行 `npm run veil-data:verify` 可以验证 clean-process CSV 示例、point Arrow、panel snapshot、bitemporal
字段以及 future sentinel 不可见。
