# 阶段 1 —— 一次往返

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 1
> 计划：`docs/plans/2026-10-09-stage-1-one-round-trip.md`

## 这个阶段解决了什么问题

在没有任何架构约束的情况下，"模型调用"会被直接写死在循环里：`while` 里 `fetch(anthropicUrl)`，第 7 阶段换真实 provider 时要动整个运行时，且循环从此无法脱离网络测试。本阶段把这条边界先立起来：**core 只认识一个函数签名，不认识任何 provider**。

交付物是一条能跑的最短链路：CLI 输入一句话 → `agentLoop` 追加 user 消息 → 通过 `StreamFn` 拿到 assistant 消息 → 追加进历史 → 打印。假模型提供确定性响应，整条链路不依赖网络。

## Pi 的哪条决策是答案

**`StreamFn` 是函数类型 + 模块级单例插槽，不是 `interface Provider`。**

对应 Pi `packages/agent/src/stream-fn.ts`（约 20 行）与 `packages/agent/src/types.ts:33`。本阶段的 `packages/ai/src/stream-fn.ts` 逐条复现：

- `StreamFn` 只是一个函数签名：`(context, signal?) => AsyncGenerator<AssistantMessageEvent>`。
- 模块级 `let` 持有默认实现，`setDefaultStreamFn` / `getDefaultStreamFn` 两个函数就是全部机制。
- 未安装时 `getDefaultStreamFn` 抛**具名错误**（"no default stream fn installed"），不是 `undefined is not a function`——忘记组装是使用者最可能犯的错，错误信息要指名道姓。

同时复现了另一条：**core 不 import 任何 provider**。`packages/core/src/` 里 grep 不到 `fake` 或 `anthropic`（已用命令验证，不是自觉）。假模型住在 `packages/ai/src/fake.ts`，由组装根（cli）通过插槽安装。

## 替代方案为什么更差

| 替代方案 | 差在哪 |
|---|---|
| `interface Provider` + 实现类 | 只有一个方法时，接口带来实现类、构造、注册表一串仪式；函数可以内联写（Pi 的 `coding-agent/src/core/sdk.ts:420` 就是内联 async 函数） |
| core 直接 import 假模型 | 第 7 阶段必须改 core；"换 provider 不动 core" 这个承诺就证伪了 |
| `streamFn` 作为 `agentLoop` 必填参数 | 每个调用点都要传；阶段 4 的 `Agent` 类构造参数会膨胀。本阶段选「可选、缺省 fallback 到插槽」，两头都留了 |

**本阶段新发现的决策点：假模型为什么住在 `packages/ai/src/fake.ts` 而不是 `packages/core/test/`？**

它是 `StreamFn` 的一个**合法实现**，与阶段 7 的 `anthropic.ts` 同层同契约，只是确定性。放在 `core/test/` 会：`pnpm dev`（生产入口）不得不 import 另一个包的测试目录；并掩盖关键事实——cli 与 core 都**不认识**任何 provider 实现，只通过插槽安装。假模型属于 provider 层，这是结构性的，不是权宜。

## 决策点（供回测）

1. 为什么 `StreamFn` 是函数而不是 `interface Provider`？
2. 为什么 core 不 `import` 任何 provider？（答案要能用 `grep` 证明，不是用嘴说）
3. 为什么假模型住在 `ai/src/fake.ts` 而不是 `core/test/`？
4. 为什么 `getDefaultStreamFn` 未安装时要抛具名错误，而不是返回 `undefined` 让下游炸？

## 已知代价（埋下记号，阶段 8 对照）

`SystemMessage.content` 现在是 `string`。阶段 8 会改写为增量段落数组（`sections` + `toolsAdded` / `toolsRemoved`）——**这是路线里唯一一次刻意回头改前面的代码**（spec §3.2b）。在第 8 阶段之前，`string` 在持久化、prompt cache、动态工具三处的痛点会先被亲身体会到，改写时才有判断依据。读 prompt 从 O(1) 变成 O(n) 重放的代价，到那时再结算。

## 实施中发现的计划/环境偏差（留档）

- **pnpm v12.3.4 不认 `onlyBuiltDependencies`**：安装时报 `ERR_PNPM_IGNORED_BUILDS` 并自动写入 `allowBuilds` 占位块。解法：`pnpm-workspace.yaml` 改用 `allowBuilds: { esbuild: true }`。
- **`readline/promises` 的 `question()` 不能配合一次性管道输入**：所有行在第一次 `question` 时一次性到达，未被等待的行被丢弃，随后挂起（unsettled TLA）。验证 CLI 时要逐行延时喂入，或用真实 TTY。
