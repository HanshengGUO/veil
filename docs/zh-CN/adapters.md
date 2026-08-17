# 数据集 Adapter

[English](../adapters.md) | 简体中文

Adapter 告诉 Veil 每一行数据在时间上代表什么。它把任意源字段映射到 contract 需要的四个部分：

```text
(entity, event_time, available_time, payload)
```

只需要声明一次；exploration、verification 和 reproduction 会使用同一套解释。

## 最小且诚实的 CSV 声明

如果数据源没有可信的 availability timestamp，就明确写出来。Veil 仍然可以按 `event_time` 过滤并用于
探索，但所有下游结果都会保留 `PIT_UNSAFE`。

```yaml
dataset: alt_news
version: "2026-08"
entity_key: ticker
event_time: published_at
available_time: null
source:
  type: csv
  locator: data/news.csv
```

未填写的 guarantee 使用保守默认值：没有 PIT 保证、没有 vintage history、survivorship 状态未知、没有
tradability mask、provenance 未认证。

## Point-in-time 数据

仅有 availability 字段还不够，还要声明它从哪里来：

```yaml
dataset: vendor_fundamentals
version: "2026-08"
entity_key: ticker
event_time: period_end
available_time: first_known_at
availability_basis:
  - until: 2026-08-07
    basis: reconstructed
    source: vendor publish_date
  - from: 2026-08-07
    basis: observed
guarantees:
  point_in_time: true
  vintage: true
  survivorship_free: true
provenance:
  certified: true
  lineage_ref: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
payload_schema:
  revenue: float64
  currency: utf8
source:
  type: parquet
  locator: fundamentals/quarterly.parquet
```

Segment 按 `event_time` 选择，采用 `[from, until)`：包含 `from`，不包含 `until`。只有日期时按 UTC
零点解释；完整 timestamp 必须带 timezone。相邻范围必须有序且连续。

| Basis | 含义 | 必需证据 | 后果 |
| --- | --- | --- | --- |
| `observed` | 确实在该时点收到 | Certified 数据会与 lineage 交叉检查 | 只有认证后才能获得完整 availability 信用 |
| `reconstructed` | 根据 vendor publication/effective date 重建 | `source` | `AVAILABILITY_RECONSTRUCTED` |
| `assumed` | 按选定 lag 推断 | ISO-8601 `lag` 与 `rationale` | `PIT_DEGRADED_ASSUMED` |

整个数据集都是真实观察时可以简写：

```yaml
availability_basis: observed
```

整个范围都依赖假设时必须说明证据：

```yaml
availability_basis:
  basis: assumed
  lag: P2D
  rationale: The vendor SLA promises delivery within two calendar days.
```

## Declaration 与连接配置必须分开

`adapter.yaml` 是 portable、可 hash、可以暴露给 agent 的语义声明。`source` 只保存格式与非敏感 locator：

```yaml
source:
  type: csv
  locator: data/prices.csv
```

绝对根目录、数据库 DSN、用户名、密码、token 和环境变量值属于 runtime `SourceBinding`。带 inline
credential 的 URL 或疑似 secret 的 query parameter 会被拒绝。这样同一份 adapter 可以在不同机器使用，
而 credential 不会进入 artifact、hash、log 或 model context。

`SourceBinding` 是 opaque capability。序列化和 inspect 结果只包含 binding id、backend id、option/secret
的**名字**，不包含值。只有被选中的 trusted backend 能在读取时解析它们。

默认文件 binding 使用一个绝对 `root`，它必须比 filesystem root 更窄。`source.locator` 在其下通过
realpath 解析，`..` 和逃逸 symlink 都不能越界。Glob 支持单个 segment 内的 `*` / `?`，以及作为完整
segment 的 `**`；不支持 bracket/brace expansion 或反斜杠 separator。

```yaml
source:
  type: parquet
  locator: fundamentals/year=*/part-*.parquet
```

Engine 自己枚举并排序文件，再把精确 path list 传给 DuckDB。Query 前后都会重新枚举和 hash 全部成员。
新增、删除、重命名或修改任一成员都会产生 `SOURCE_CHANGED`，不会返回混合版本 view。

```ts
import {
  BackendRegistry,
  createSourceBinding,
  createVeilData,
  DuckDbFileBackend,
  loadAdapterFile,
} from "@veilquant/engine";

const declaration = await loadAdapterFile("adapter.yaml");
const backend = new DuckDbFileBackend();
const registry = new BackendRegistry();
registry.register(backend);

const view = await createVeilData(registry).point({
  declaration,
  binding: createSourceBinding({
    id: "local-data",
    backend: backend.id,
    options: { root: "/absolute/data/root" },
  }),
  asOf: "2026-08-12",
  columns: ["ticker", "value"],
});
```

可以运行以下 committed examples：

```bash
npm run csv-pit:verify
npm run parquet-pit:verify
npm run multi-file-pit:verify
```

## 用自己的 CSV 试跑

按[快速开始](./quickstart.md)创建 adapter，然后从源码 checkout 运行 `npm run data:inspect`。成功不只是
“CSV 能加载”，还必须满足：decision time 和过滤字段明确、cutoff 后的行不可见、mask 仍在、degradation
清楚显示，并且 JSON report 不包含绝对 root 或 credential value。

## Backend 可以替换

Adapter 不生成 SQL。Engine 构造 `TemporalReadPlan`，其中包含 projection、`as_of` 和
`column <= as_of` predicate。`TemporalBackend` 可以把它翻译成 DuckDB、ClickHouse、DolphinDB、REST
extract 或内存读取，再返回 Arrow IPC。

Predicate pushdown 只是优化，不是保证。Common `TemporalGuard` 会解码每个 backend 的 Arrow 结果，并在
返回 view 前再次执行时间过滤。即使 backend 错误地声称完成 pushdown，也不能暴露 timestamp 正确但位于
未来的行。

DuckDB 只是默认 CSV/Parquet backend，不属于公共 contract。DuckDB 类型和 SQL fragment 都不会穿过
engine API。对于 CSV/Parquet，只有 guard column 不含 null 或无法解析的值时才允许下推；否则由 common
guard 按 C1 fail closed。

每次 guarded read 还会携带[read-set identity](./read-sets.md)。没有稳定 source version 的 backend 可以
提供安全的 point-in-time view，但无法支持可复现的 promotion claim。

## Validation 返回什么

Contract API 接收 YAML parser 产生的对象，返回 deeply frozen、camelCase declaration：

```ts
import {
  deriveDataSemantics,
  hashAdapterDeclaration,
  normalizeAdapterDeclaration,
} from "@veilquant/contract";

const declaration = normalizeAdapterDeclaration(parsedYaml);
const semantics = deriveDataSemantics(declaration);
const declarationHash = hashAdapterDeclaration(declaration);
```

`deriveDataSemantics()` 不把信任压缩成一个分数，而是分别保留 PIT mode、availability origin、
certification、vintage、survivorship 和 mask support，再生成明确的 engine obligation 与 degradation code。
YAML key 顺序或 whole-range shorthand 不影响 `sha256:` identity。

## Error 应该可以被工具直接修复

无效声明抛出 `AdapterDeclarationError`，与 runtime C1-C6 `ContractViolation` 分开。错误包含：

- `code`：如 `MISSING_EVIDENCE`、`INVALID_SEGMENTS`、`INLINE_SECRET`；
- `path`：如 `$.availability_basis[0].lag`；
- `remedy`：简短且可执行的修复建议。

未知字段会被拒绝，例如 `availble_time` 不会静默退化成更弱保证。

## 为什么 certified observed 数据必须有 lineage

`basis: observed` 不能自证。Vendor 第一次连接时可能交付十五年历史；把这些历史都标成 observed 会伪造
PIT evidence。

当 `certified: true` 时，`lineage_ref` 必填。Engine 会独立解析和 hash lineage summary，并确认 observed
row 没有声称早于 collection start 的 availability。矛盾 backfill 会被拒绝。没有 lineage 的数据仍可作为
uncertified data 使用，但不会获得 certified trust。

完整字段见带注释的 [`adapter.yaml`](../../packages/veil-contract/schemas/adapter.yaml)，规范 degradation 规则见
[Veil Contract](./contract.md)。
