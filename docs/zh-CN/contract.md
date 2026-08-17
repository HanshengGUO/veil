# Veil Contract 1.0

[English](../contract.md) | 简体中文

> 本页是规范的中文参考译文。英文 [`contract.md`](../contract.md) 是唯一规范源；identifier、wire format、
> error shape 和机器行为以英文版本与 schema 为准。

Contract 规定两件事：什么条件下可以提出 claim，以及 data access、artifact execution、pricing、gate、
memory 和 reproduction 之间传递什么记录。

当前稳定性承诺：

- `C1`-`C6` identifier 从 v0.1 起稳定，是 error、audit record 和 bench task 的公共接口。
- C1-C5 的含义从 v0.1 起冻结，1.x 内不会改变；措辞仍可澄清。
- C6 与 degradation tier 在 v1.0 前仍为 provisional。
- 把 invariant 提前执行属于加强，不算语义变化。

## 1. Contract 解决什么问题

探索时出现泄漏不会立刻产生代价；当结果被相信或策略被部署时，代价才真正发生。这两种行为都是
claim，因此 Veil 约束 claim，而不是限制敲键盘。

| | Exploration surface | Verification surface |
| --- | --- | --- |
| 内容 | Agent 编写并运行自己的代码 | 将打包 artifact 按窗口 walk-forward 重新执行 |
| 是否阻断 | **从不阻断**，只有 advisory | 会阻断；违反规则抛出 `ContractViolation` |
| 数据形状 | 默认 PIT view，并带 tradability mask | 构造输入时就排除未来行 |
| 输出状态 | `unverified`，不能进入正式结论 | Experiment record，唯一可引用指标 |

连接两层的关键是 C5；其他 invariant 都是为了让 C5 值得信任。

## 2. 定义

- **decision time (`t`)**：一次计算被允许使用的信息集所对应的时点。
- **`event_time`**：被描述事件实际发生的时间。
- **`available_time`**：该信息最早可能被知道的时间，是 PIT 正确性的锚点。
- **artifact**：`compute(data_view)`、锁定参数和数据语义，由 content hash 标识。
- **experiment record**：verification engine 重跑 artifact 并执行 gate 后签发的记录。记录外指标不算结果。
- **claim**：任何“某个效应存在”的陈述，包括 conclusion、memory verdict、promotion 或 deployment。

## 3. Invariants

### C1 — Decision-time information set

> 对 decision time `t` 执行的计算，**不得**使用 `available_time > t` 的信息。

- PIT read 必须显式提供 `as_of`，没有默认当前时间。
- Verification window 在构造时就不包含 `available_time > t` 的行，而不是事后过滤。
- Backend 可以下推时间 predicate 来提高效率，但下推不是 trust boundary。所有 Arrow IPC 都必须再次通过
  common temporal guard。
- 覆盖 `t` 之后样本的全样本均值、波动率、quantile 或 fitted scaler 都违反 C1。
- Promotion protocol 用 decision session 显式声明 `executionLagDays`；零 lag 在读取数据或启动 child 前
  直接按 C1 拒绝。
- 有 `available_time` 不代表它可信；其来源必须通过 `availability_basis` 声明。

典型拒绝：全样本标准化、same-bar execution、前向填充 revision、只按 `event_time` 连接右表。

### C2 — Walk-forward only

> Verification 必须使用 rolling 或 expanding walk-forward，并包含 purge gap 和 embargo；不得提供随机
> cross-validation。

- Purge gap 至少等于 label horizon；feature/label 时间重叠时至少覆盖 overlap。
- Embargo 位于 purge 之后，默认非零。
- 参数和窗口写入 Experiment；修改后生成新记录，不能改写旧记录。

典型拒绝：时间序列 k-fold、训练与测试窗口紧邻、看到结果后再选择评估窗口。

### C3 — Parameter lock

> 参数必须在样本内锁定，样本外只读。修改任何参数都会生成新 artifact，并需要新的样本内窗口。

- Locked parameter 属于 artifact hash，改参不能冒充同一个 artifact。
- Artifact code 中来自数据的 numeric literal 也是参数，必须写入 `declaredLiterals`。交易日数、epsilon
  等结构常量可以豁免；未声明 literal 仍会被冻结并进入 hash。
- Promotion 必须通过 `trialsDeclared` 声明截至当前探索过的 candidate 总数。Effective trials 取声明值、
  当前 session 可观察下界和同 family 历史记录的最大值，并直接进入显著性检验。

典型拒绝：根据 OOS 调参、微调后沿用旧记录、只申报最终胜出的 candidate。

### C4 — Tradability mask first

> 在 `t` 时不可交易的 instrument，必须在形成信号之前排除，而不是形成信号后再过滤。

- View 携带 adapter 声明的 mask；verification 在 ranking、weighting、optimization 前应用。
- 用户可以增加 mask 规则，不能删除已有 mask。
- 研究对象本身就是停牌、复牌或退市事件时，可以显式声明 operator default exemption。它会进入 audit，
  所有结论都会带标记。但 C4 本身没有豁免：任何声称可交易收益的策略仍必须 mask-first。

典型拒绝：把停牌/未上市 instrument 参与横截面排名后才过滤。

### C5 — Claims must pass verification

> 进入 conclusion、memory verdict、promotion 或 deployment 的任何指标，都必须由 verification engine
> 作为 Experiment record 的一部分签发。

- Exploration output 始终标记为 `unverified`。
- Claim 没有 experiment id 时直接拒绝，不做 degradation。
- Engine 不向 agent 新增数据源凭据；用户原本在自己环境中拥有的访问权限不在此规则内。

`veil.walk-forward-contract.v0` 只证明 C1-C4 与 parameter lock，不包含 pricing、cost、metric、gate 或
verdict，因此不能满足 C5。`veil.promotion-candidate.v0` 是进入后续阶段的强制 handoff，但它本身仍为
`unverified`，candidate id 不是 experiment id。

Stage 4 的链路如下：

1. `veil.pricing-evidence.v0` 把 trade、gross return、cost、net return 和 aggregate metric 绑定到 replayed
   candidate；
2. `veil.gate-evaluation.v0` 覆盖 content-addressed policy 中的每个 gate；
3. 只有 `veil.experiment.v0` 可以携带可引用 metric 与 verdict。

安全签发函数依次为 `executeOosPricing()`、`executeStandardGateEvaluation()` 和 `executeExperiment()`。

### C6 — Hypothesis pre-registration

> Hypothesis 必须在验证结果之前完成注册，并记录时间戳和信息来源。

C6 分为 hard 与 soft 两部分：

- **Hard，机器执行。** Registration entry 必须在 verification run 之前存在；顺序从 session log 校验，
  不能事后补排。缺少 prior registration 的运行标记为 `exploratory`，采用更高 promotion 门槛。
- **Soft，明确承认限制。** Veil 自动捕获 session brief 和第一个假设以降低成本，但无法判断内容是否足够
  具体。“研究 momentum”可以适配任何结果，自动系统无法证明它是真正的预测。

记录还必须包含 idea 最早可用时间，用来跟踪 model training-period contamination。没有 prior
registration 的发现并非禁止，只是会被标记。Late 或与 artifact 不匹配的 registration 按 C6 拒绝。

## 4. Violation

Violation 抛出结构化 error，而不是 warning：

```ts
new ContractViolation("C1", "read at 2021-06-01 exposed rows available 2021-06-02", {
  dataset: "prices@v1",
  asOf: "2021-06-01",
  remedy: "pass as_of and re-run",
});
```

Audit log 会记录 invariant id、dataset 和 decision time；bench 将其计为 G1 structural catch。Validator
自身出错时 fail closed。

## 5. Guarantee declaration 与 degradation

不是每个数据集都能支持全部 invariant。Adapter 声明能力，harness 据此决定可执行的 gate 和结论需要的
标记。

| 声明 | 缺失或取值 | 后果 |
| --- | --- | --- |
| `available_time` | `null` | C1 只能按 `event_time` 过滤；标记 **PIT-unsafe**，提高显著性门槛 |
| `availability_basis` | `reconstructed` | 时间可信但非实时观察；结论带标记并提高一档门槛 |
| `availability_basis` | `assumed` | 由人为 lag 推断；按缺少 `available_time` 处理，标记 **PIT-degraded** |
| `vintage` | `false` | 对 revision 敏感的结论降级 |
| `survivorship_free` | `false` / `unknown` | universe 被视为可疑，long-biased 结论降级 |
| `tradability_mask` | `null` | 无法对该数据集执行 C4；所有派生结果记录此缺失 |
| `provenance.certified` | 缺失 / `false` | 不拒绝，但不能获得 guarantees 以外的认证信用 |
| C4 operator exemption | 已声明 | 仅适用于研究不可交易 instrument 本身；写入 audit 并标记结论 |

当前 Stage 4 deflated-Sharpe 的 standard / higher confidence 是 95% / 99%。关键 PIT 或 survivorship
degradation 会在 pricing 前拒绝，不能靠统计门槛“修复”。

`availability_basis` 用来处理常见 backfill：今天第一次拉取数据，却收到十五年历史。把所有历史
`available_time` 写成今天会让历史研究无法进行；把它伪装成 `event_time + guessed lag` 又是在制造 PIT
历史。诚实做法通常是：backfill 段标为 `reconstructed`，开始真实采集后的段标为 `observed`。

原则是：**明确降级，不静默接受；只有拒绝才诚实时才拒绝。**

### Adapter validation

Adapter 是 portable semantic declaration，不是 connection profile：

- `dataset`、`version`、`entity_key`、`event_time`、`available_time`、`source` 必填。
- 非空 `available_time` 必须有 `availability_basis`；空值则禁止 basis。
- Basis segment 按 `event_time` 选择，必须是有序、连续的 `[from, until)`。
- `point_in_time: true` 与 `available_time: null`、`certified: true` 与缺少 `lineage_ref` 都是矛盾声明。
- 未知字段直接报错，避免拼写错误静默削弱保证。
- `source.locator` 只能保存相对路径或逻辑表名；runtime path、DSN 和 credential 必须单独传给 engine。

即使声明为 `observed` 也不会自动获得信任。认证数据需要解析 `lineage_ref`，并把 observed row 与真实
collection boundary 交叉检查。

## 6. v1 Threat model

Veil v1 防御的是**疏忽、自我欺骗和协议诱发的 false discovery**，例如全样本标准化、same-bar fill、
第二十个终于成功的变体、事后改写 hypothesis，或 brief 直接要求证明某个结论。

Veil v1 不防御故意恶意的 agent 或用户：

- Exploration surface 没有 mount isolation；Pi 的 shell 不是 sandbox。Agent 可以读取原始文件，但不能把
  这些计算直接变成 verified claim。
- `tool_call` interception 无法静态判断任意 shell command 会访问什么；path allowlist 只用于审计。
- **Constant smuggling** 没有可靠静态防御。缓解措施包括 `declaredLiterals`、parameter lock、parameter
  stability 和 null-environment falsification。
- **Training-data contamination** 无法消除。Veil 记录 idea available time，并要求训练窗口之后的验证。

Container isolation、append-only hash-chained ledger 等对抗性 hardening 属于 Stage 6 显式 profile。

## 7. Contract 不做什么

它不替你 review 代码，不判断想法好坏，也不限制你研究什么数据。它只约束一件事：什么可以被称为结果。
