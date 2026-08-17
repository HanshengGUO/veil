# Read-set Identity

[English](../read-sets.md) | 简体中文

每个 guarded Arrow view 都带一个 `veil.read-set.v0` manifest，说明数据从哪里来、执行了什么查询，以及
实际交付了哪些行。Manifest 把五种 identity 分开：

| Identity | 含义 |
| --- | --- |
| `declarationHash` | 规范化 adapter 语义，包括 portable source declaration |
| `source.fingerprint` | Backend 报告的物理输入版本；可带完整 source manifest；`null` 表示不可复现 |
| `queryHash` | Dataset、adapter version、规范化 `as_of`、projection、predicate 与 filter version |
| `result.resultHash` | Canonical schema 与 guarded Arrow row multiset |
| `result.arrowHash` | 本次读取实际交付的 Arrow IPC bytes |

这层分离让 reviewer 能判断两次运行之间究竟是声明、物理源、query、logical rows 还是 Arrow bytes 发生了
变化。`manifestHash` 再把这些 identity 与 engine、Arrow、backend 版本共同 content-address。

## Canonical result 规则

Read-set v0 按 column name 排序 schema field，在该 canonical column order 下 hash 每一行，再排序 row
hash 后计算 `resultHash`。重复行仍保留重复。因此 identity 不依赖物理 column order、输入 row order、
绝对路径或 Arrow IPC buffer layout。

返回给 factor code 的 Arrow view 不会被重排。`arrowHash` 仍然对顺序和 layout 敏感，用来证明交付的精确
bytes；指标级复现同时需要 logical `resultHash` 和 exact `arrowHash`。

Primitive scalar、null、binary、64-bit integer、timestamp、`NaN`、infinity 和 negative zero 都有明确
encoding。不支持的 nested value 以 `INVALID_READ_SET` fail closed，而不是生成不稳定 identity。

## 验证已保存 evidence

```ts
import { verifyReadSetManifest } from "@veilquant/engine";

const verified = verifyReadSetManifest(parsedManifest, {
  arrowIpc: storedArrowBytes,
  declaration,
  sourceFingerprint: replayedSourceFingerprint,
  expectedManifestHash: experiment.readSetId,
});
```

Verifier 会严格解析 manifest，重算 query/schema/result/manifest hash、精确 Arrow content hash，并比较调用方
提供的 declaration、source fingerprint 与 expected id。损坏 bytes、未知字段、row 变化、layout/order
变化或过期 identity 都以 `INVALID_READ_SET` 明确失败。

复现 Experiment 时必须传入已记录的 expected manifest id。Content hash 是地址，不是签名；只有和
Experiment 里原先记录的 id 比较，才能发现一个自洽但被整体替换的 manifest。`null` source fingerprint
可用于探索，不能支持可复现的 promotion claim。

## 多文件 source identity

默认文件 backend 在 fingerprint 中嵌入 `veil.source-manifest.v0`。每个 entry 只包含稳定物理证据：

```json
{
  "logicalName": "prices/year=2026/part-00.parquet",
  "byteLength": 12345,
  "contentHash": "sha256:..."
}
```

Logical name 相对于 opaque binding root，并统一使用 `/`。Entry 唯一且排序后再 hash。Verifier 独立检查
shape、顺序、hash encoding、manifest hash 和 fingerprint link。

每次 query 前后，默认 backend 都会捕获完整匹配集合并 hash 文件内容。新增、删除、重命名或替换任何成员
都会改变 source identity；读取过程中发生变化则抛出 `SOURCE_CHANGED`。把完全相同的 logical members
复制到另一个绝对 root、修改 mtime 或改变创建顺序，不影响 identity。

## Durable snapshot

`ReadSetSnapshotStore` 把已 guarded 的 manifest 和精确 Arrow IPC 保存成一个 content-addressed object。
Store 不知道 DuckDB、CSV、Parquet 或数据库连接，只处理 evidence。

```ts
import { openReadSetSnapshotStore } from "@veilquant/engine";

const store = await openReadSetSnapshotStore({ root: "/absolute/veil-snapshots" });
const written = await store.put(result.readSet, result.arrowIpc);

const replayed = await store.read(written.snapshot.id, {
  declaration,
  sourceFingerprint: result.sourceFingerprint,
});
```

Snapshot id 就是 read-set `manifestHash`。对象位于
`read-set-snapshots-v0/<first-two-hex>/<manifest-hex>/`，只包含 `manifest.json` 和 `data.arrow`。绝对 store
路径不进入 identity，因此复制到另一个 root 后 id 不变。

发布过程先在目标 shard 内写临时目录，sync file/directory metadata，再 atomic rename。并发写入同一 id
会收敛到同一个经过验证的对象。每次 cache hit 和 replay 都重新解析 manifest、验证 expected id 并重算
Arrow 与 logical hash；missing、extra、symlink、truncate 或 tamper 都会失败。

- `SNAPSHOT_NOT_FOUND`：整个对象不存在。
- `INVALID_SNAPSHOT`：对象存在，但无法证明请求的 evidence。

两者都不会触发对当前 source 的新 query，`put()` 也不会用新 bytes 覆盖损坏对象。

## 只读检查与显式恢复

`inspect()` 完整验证对象，但把预期的 operator 状态转换成结构结果：

```ts
const state = await store.inspect(snapshotId, {
  declaration,
  sourceFingerprint,
});
// state.status: "valid" | "missing" | "invalid"
```

Inspection 是只读操作。`invalid` 可能是调用方提供了错误 evidence，也可能是对象本身损坏；前者不能成为
修改 storage 的授权。因此 recovery 会在不使用 caller evidence 的情况下重新检查，并拒绝 quarantine
任何本身有效的对象。

Mutation capability 需要单独打开，并提供 operator identity 和可打印原因：

```ts
import { openReadSetSnapshotRecovery } from "@veilquant/engine";

const recovery = await openReadSetSnapshotRecovery({ root: "/absolute/veil-snapshots" });
const audit = await recovery.quarantine({
  snapshotId,
  actor: "alice.ops",
  reason: "data.arrow was truncated after a disk failure.",
});

await recovery.read(audit.operationId);
```

Quarantine 不是删除，也不是原地修复。它在 per-snapshot operator lock 下两次确认 intrinsic corruption，
持久化 intent，把原对象 atomic rename 到 `read-set-snapshot-quarantine-v0`，再写入 content-hashed completion
record。损坏 bytes 仍可取证，但不会出现在正常 read namespace。

恢复是另一个显式动作：从可信存储取得原 manifest 和 Arrow bytes，再调用 `store.put()`。Content id 必须
重新得到被 quarantine 的 `snapshotId`。系统没有自动 healing，也没有删除 quarantine evidence 的 API。

```bash
npm run snapshot-recovery:verify
npm run read-set:verify
```

## 当前限制

绝对 binding root、binding id、mtime、hostname、credential 和 secret reference 不进入 identity。默认文件
backend 支持一个文件或显式匹配的 CSV/Parquet 集合，不推断 partition semantics。v0 会在内存中 materialize
table 并排序 row hash；尚未声称支持 streaming canonicalization。Local snapshot store 也还没有 remote
transport、garbage collection、quarantine deletion 或自动 healing。`veil-data` 的使用方式见
[`veil-data`](./veil-data.md)。
