# Artifact

[English](../artifacts.md) | 简体中文

Artifact 是从自由探索进入 verification 的 immutable unit：`compute(data_view)`、明确代码文件、锁定参数、
声明的数据派生 literal，以及它依赖的数据语义与协议。任何 identity-bearing input 变化都会生成新
artifact；可变 working-tree path 不能证明 identity。

当前已实现 `veil.artifact.v0`、runtime-neutral framed subprocess、deterministic training window 和逐决策
mask-first C1-C4 contract。Contract record 只是结构证据，不是 priced Experiment。完整 shape 见
[`artifact.yaml`](../../packages/veil-contract/schemas/artifact.yaml)。

## 构建 portable identity

```ts
import {
  captureArtifactCode,
  createArtifactManifest,
  verifyArtifactCode,
  verifyArtifactManifest,
} from "@veilquant/engine";

const code = await captureArtifactCode({
  root: "/absolute/project/factor",
  files: ["factor.py", "requirements.lock"],
});

const artifact = createArtifactManifest({
  factor: {
    runtime: { id: "python", constraint: ">=3.11,<4" },
    entry: { file: "factor.py", callable: "compute" },
    code,
  },
  paramsLocked: { lookbackDays: 20 },
  declaredLiterals: { selectedThreshold: 1.5 },
  trialsDeclared: 3,
  dataSemantics: {
    datasets: [{
      declaration,
      developmentReadSets: [guarded.readSet.manifestHash],
    }],
  },
  hypothesisRef: "momentum-v1",
  protocol: {
    mode: "expanding",
    folds: 6,
    trainDays: 504,
    oosDays: 63,
    purgeDays: 5,
    embargoDays: 2,
    holdDays: 5,
    executionLagDays: 1,
  },
  costModel: "equities-bps-v1",
});
```

代码成员必须显式列出；packaging 不会自动扫 checkout、cache、`.env` 或 `node_modules`。每个成员必须是
portable root-relative regular file。Symlink、parent traversal、filesystem root、大小写冲突和平台专用名称
都会被拒绝。Engine 两次捕获文件集合，并记录 length、每文件 SHA-256 和 aggregate tree hash；mtime、创建
顺序和绝对 root 不进入 identity。

`createArtifactManifest()` 会规范化并排序字段、重新 hash adapter declaration、验证 code tree，再 deeply
freeze 结果。Locked params / declared literals 只接受 canonical JSON。Credential-like field、inline secret、
绝对 runtime path、non-finite number、negative zero、cycle 或 class instance 都 fail closed。

需要进入 Stage 4 的 artifact 还要锁定 `declaredLiterals.oosPricing`：pricing method identity、signal/price
column、market column、periods per year、portfolio construction、可选 sizing column，以及 cost provider 的
version / implementation / config hash。`executeOosPricing()` 不接受运行后替换策略配置。

恢复后的 evidence 要独立验证：

```ts
const restored = verifyArtifactManifest(JSON.parse(serialized), {
  expectedArtifactHash,
  dataSemantics: {
    datasets: [{ declaration, developmentReadSets }],
  },
});
await verifyArtifactCode("/another/checkout/factor", restored.factor.code);
```

运行 `npm run artifact:verify` 可以验证不同 absolute root 和 mtime 下 identity 不变，并在 clean Node process
中重验。

## 执行一个 guarded window

Runtime provider 是注入 capability。Artifact 只命名 logical runtime 和 portable constraint；registry 选择
trusted provider。Executable、argv 和 environment 仍是 private runtime state。

```ts
const runtimes = new ArtifactRuntimeRegistry();
runtimes.register(createArtifactRuntimeProvider({
  id: "python",
  implementation: { name: "cpython", version: "3.12.7" },
  supports: (constraint) => constraint === ">=3.11,<4",
  launch: () => ({
    executable: absolutePythonPath,
    arguments: [absoluteRunnerPath],
  }),
}));

const executed = await executeArtifact({
  artifact,
  codeRoot: "/absolute/project/factor",
  readSet: verificationView.readSet,
  arrowIpc: verificationView.arrowIpc,
  runtimes,
  limits: { timeoutMs: 60_000 },
});
```

启动前，engine 独立验证 artifact、guarded read set、Arrow hash、dataset declaration 和 code tree。开发
read set 不能复用为 verification input。只有声明代码会被复制到新临时 root，再在 provider prepare 前后
hash。子进程使用 absolute executable、`shell: false`，不继承开发者环境；Windows 所需的少量 OS 变量由
engine 提供隔离值。

Stdin 恰好包含一个 versioned frame：magic、bounded canonical JSON control 和 exact guarded Arrow。
Request hash 绑定 artifact、code tree、runtime identity、entrypoint、dataset、read set、decision time、参数和
input Arrow。Stdout 也只能有一个 identity-bound frame。Partial、malformed、duplicate、unknown、oversized
或 trailing output 全部 fail closed。Stderr 只计数，不进入 public result/error；timeout、cancel、signal、
non-zero exit 和 output flood 都返回结构化脱敏错误。

Wire codec 是公开的，因此 Python、Rust 等语言可以实现 thin adapter。运行
`npm run artifact-execution:verify` 查看 clean Node 示例。

### v0.1 Pi runner

`veil-quant` 注册 `veil-node` capability。Runner 解码 guarded Arrow，并在 materialized artifact directory 中
调用 `compute(table, context)`。Callable 可以返回 Arrow IPC、Arrow `Table`，或
`{ rowIndices, columns }`；最后一种形式允许因子选择有序输入行并添加 bounded primitive column。

Runner 使用同一 framed protocol，不接收 binding 或 developer environment。只有
`.veil/project.yaml` 明确列出精确 runtime constraint 时才会选中它。

## 执行 deterministic training window

WFA planner 不猜交易日历。调用方必须提供 artifact protocol 所需的精确、有序 UTC session：

```ts
const run = await executeWalkForwardWindows({
  artifact,
  codeRoot: "/absolute/project/factor",
  decisionSchedule,
  declaration,
  guard,
  binding,
  runtimes,
  columns: ["ticker", "value"],
});
```

Schedule 长度必须等于：

```text
trainDays + purgeDays + embargoDays + folds * oosDays
```

Session 必须唯一且严格递增。每个 fold 记录 train、purge、embargo 和连续 OOS boundary。Purge 至少覆盖
holding horizon，embargo 必须非零，`executionLagDays` 至少一个 session。Topology error 在 data I/O 或
child launch 前按 C1/C2 返回。

每个 training cutoff 都生成新 guarded source read set，再按 fold range 派生
`veil.window-read-set.v0`。Verifier 必须拿原 source manifest 与 Arrow replay filter；内存 slice 不能冒充
source id。成功 fold 产生 `executed` record，完整 run 产生 `veil.walk-forward-run.v0`；任何 child failure
都会阻止 run record。

## 组合多个 guarded source

当前 contract executor 接受一个 dataset，但 factor 可能依赖多源义务。例如 golden path 同时需要 price
tradability 与 PIT universe membership。`createCompositeSource()` 在 artifact execution 前解决这个问题：

```ts
const composite = createCompositeSource({
  primary: { declaration: prices, readSet: priceRead.readSet, arrowIpc: priceRead.arrowIpc },
  membership: {
    declaration: universe,
    readSet: universeRead.readSet,
    arrowIpc: universeRead.arrowIpc,
  },
  outputDeclaration: researchPanel,
  membershipColumn: "in_universe",
  outputAvailableTimeColumn: "eligible_at",
  outputMembershipColumn: "in_universe",
  outputMaskColumn: "eligible",
});
```

两个输入必须已经是同一 `as_of` 下的 `TemporalGuard` read set。Transform 做 exact entity/event join，拒绝
duplicate 或 uncovered primary key，要求 strict boolean tradability / membership，并计算
`eligible = tradable && in_universe`。没有 SQL、connection 或 backend handle 进入这一步。

`veil.composite-source-manifest.v0` 绑定两个 declaration、read-set id、Arrow/result identity、join rule、
row audit 和 output identity。`verifyCompositeSource()` 会从两个 Arrow input replay join。

## 验证每个 train 与 OOS decision

`executeWalkForwardContract()` 执行 C1-C4：

```ts
const checked = await executeWalkForwardContract({
  artifact,
  codeRoot: "/absolute/project/factor",
  decisionSchedule,
  declaration,
  guard,
  binding,
  runtimes,
  columns: ["ticker", "value"],
  concurrency: 4,
  retainExecutionEvidence: false,
});

verifyWalkForwardContractRecord(checked.record, {
  artifact,
  plan: checked.plan,
  declaration,
  expectedHash: checked.record.contractHash,
});
```

Declaration 必须在 source I/O 前命名 tradability mask。Engine 对每个 fold 执行一次 training cutoff，并对
每个 OOS decision 单独执行：每次取得该 `as_of` 的新 guarded read，派生 bounded verification view，要求
strict boolean mask，并在 child 形成信号前删掉 false row。Child 看不到完整未来 OOS block，也看不到被
mask 的 row。

Child output 必须保留 entity/event key，且每一对都存在于 masked input。它不能重新引入 halt entity、
duplicate evidence 或 future row。OOS run 只接受当前 decision time 的 output，历史回显不能冒充当前信号。

- Invalid WFA topology / incomplete fold：C2。
- Parameter identity drift：C3。
- Mask 缺失、格式错误、应用过晚或被重新引入：C4。
- Future output：C1。

任何 partial failure 都不会返回 contract record。Concurrency 范围 1–32，不改变 schedule 或 content
identity。`retainExecutionEvidence: false` 只释放中间 Arrow，不能跳过 read、child、admission 或 record。

成功后 engine 签发 status 为 `contract-verified` 的 `veil.walk-forward-contract.v0`。它没有 pricing、cost、
return、metric、gate 或 verdict，因此不能满足 C5。运行 `npm run walk-forward-contract:verify` 查看冷启动
示例；完整 golden-path structural acceptance 使用 `npm run golden-path:evidence:verify`。

## 准备 promotion evidence，但不提出 claim

下一层只接受完整 contract record：

```ts
const registration = createHypothesisRegistration({
  hypothesisRef: artifact.hypothesisRef,
  statement: "Winners outperform cross-sectionally after costs.",
  ideaAvailableAt: "2025-01-01T00:00:00.000Z",
  registeredAt: "2026-08-12T09:00:00.000Z",
  source: { kind: "brief", reference: "session-entry-001" },
});

const candidate = createPromotionCandidate({
  artifact,
  plan: checked.plan,
  declaration,
  contractRecord: checked.record,
  verification: {
    startedAt: "2026-08-12T10:00:00.000Z",
    sourceReference: "verification-run-001",
  },
  registration,
});
```

`registeredAt` 必须严格早于 `verification.startedAt` 才能得到 `preregistered`。缺少 registration 时标为
`exploratory`，未来采用 higher significance tier；late、malformed 或 wrong-hypothesis registration 按 C6
拒绝。Low-level engine 只比较时间，不制造 trusted clock；Stage 3 必须从 durable Pi session entry 提供
timestamp 与 source reference。

`veil.promotion-candidate.v0` 只携带 identity 和未来 gate input：cost-model reference、trial count、
significance tier 与仍需补齐的 pricing/cost/statistical evidence。它没有 metric、verdict 或 experiment id。

## 不同 identity 各自负责什么

| Identity | 包含内容 |
| --- | --- |
| Artifact | Code tree、runtime/entrypoint、locked choice、adapter hash、development evidence、protocol |
| Window read set | Source read identity、plan/fold/range 与 derived Arrow |
| Executed run | Plan 与每个成功 training execution identity |
| Verification view | Fresh read、decision、bounded history、mask audit 与 Arrow |
| Contract record | Parameter lock 与全部 train/OOS evidence |
| Hypothesis registration | Statement、时间和 durable source entry |
| Promotion candidate | Contract/registration identity 与未来 gate input |
| Experiment | Artifact、window execution、metric、gate 与 verdict |

`developmentReadSets` 只记录哪些探索 evidence 导致 promotion，不能复用为 execution window，也不授权对
当前 source query。Training-only run 和 C1-C4 contract 都不改变 artifact identity；两者都不是最终
Experiment。

## Verification boundary

Veil 而不是 factor code 持有 source binding、backend handle、credential、schedule 和 decision-time read：

1. 从显式 UTC session schedule 推导 rolling/expanding boundary；
2. 每个 train cutoff 和 OOS decision 都通过同一 `TemporalGuard` 构造 fresh PIT read；
3. 派生 bounded history，并在 child 启动前删除 mask=false 的 row；
4. 只把 Arrow IPC 和 immutable artifact metadata 传给新 subprocess；
5. 校验 child entity/event membership，只接收当前 OOS decision slice；
6. 完整 topology 成功后才签发 contract record。

Subprocess 不会收到 raw source path、DSN、credential、backend object 或 current-query escape hatch。Framed
execution 证明一个 child 在一个精确 guarded input 上运行；contract record 进一步证明所有 OOS decision
使用 fresh PIT、mask-first view 与同一 parameter lock。任何这些 identity 都不包含 priced metric；只有
Experiment 完成 pricing、cost 和 gate 后，指标才可引用。
