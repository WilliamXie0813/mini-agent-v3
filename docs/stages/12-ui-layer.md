# 阶段 12 —— UI 层

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §3.1、§3.2(c)、§5 阶段 12、§7.1–7.4
> 计划：`docs/plans/2026-10-16-stage-12-ui-layer.md`
> 视觉基线：`docs/specs/2026-10-23-stage-12-ui-visual-design.md`（Quiet Observability、Light 三栏、Event Details modal）

## 这个阶段解决了什么问题

阶段 4 把 Agent 的内部循环拆成了分层事件流，阶段 9 又把每次运行写进了 append-only journal。但到目前为止，这些事实只有一个观察口：CLI 的单列滚动终端。CLI 的渲染模型是「事件到达即打印」——它只能给事件流一个视图，而且关掉终端，正在运行的 Agent 虽然继续工作，观察者却永远丢失了中间过程。

一个事件流天然有多个正交视图：按对话顺序的 Chat、按工具调用组织的卡片、按时间推进的 Timeline、累计的 token 用量。CLI 不足以同时承载它们；轮询 `agent.state` 看起来能补这个缺口，但它观察的是派生状态，不是事实。阶段 12 增加第三个包边界——`packages/protocol`（wire 类型与 runtime guards）、`packages/server`（localhost WebSocket 转发）、`packages/web`（React 工作台）——让同一个 `AgentSession` 同时拥有 CLI 与 Web 两个前端，共享同一条 core/provider/扩展装配链。

## Pi 的哪条决策是答案

对应 Pi `modes/interactive/interactive-mode.ts:3400`（`subscribeToAgent`）与 `:3406` 的大 switch：**UI 订阅事件流，不读 `Agent.state`**。本项目采用其决策，不抄 `pi-tui` 的差分渲染，也不抄 `packages/server` 的 CBOR 帧化——wire 层只用 JSON 文本帧。

### 1. UI 只订阅事实流，不读 `agent.state`

`Agent.state.messages` 是 journal 的内存投影：它是派生状态，只在 run settle 的瞬间与事实一致。UI 若读它，拿到的是「上一刻的完成态」——流式半截消息、正在执行的工具、尚未 journaled 的 submission 全部不可见，于是每个视图都要自己猜测「现在进行到哪了」。猜出来的状态再像也不是事实。

所以 Web 的事实源只有两个：`SessionSnapshot.entries`（journal 活跃祖先路径）与 `AgentEventEnvelope[]`（连接期间的 live 事件）。React 只保存这两样 raw 数据，Chat、tool cards、usage、Timeline、Event Details 全部是纯 selector（`buildChatView` / `buildToolCards` / `buildUsageTotals` / `buildTimeline`），组件里不允许维护第二份业务状态。delta 只更新当前 assistant draft，只有 `message_end` 或 journal `message` entry 是完成消息——40 个 `message_update` 仍然只产生 1 条 Chat 消息。

事件的排序只认 envelope：`sequence` 在单次 server 进程内从 0 严格递增，`elapsedMs` 用 `performance.now()` 相对当前操作起点计算，客户端**不按消息到达时间排序**。到达时间属于传输层，sequence 才是事实层的次序。

### 2. server 只做三件事：命令转发、event envelope、journal snapshot

`SessionHost` 长生命周期持有一个 `AgentSession`，与 socket 数量完全解耦。constructor 只订阅一次 session；`handle()` 把校验过的 `ClientCommand` 翻译成 `session.submit()` / `session.abort()` / `session.compact()`；`record()` 把每个 `AgentEvent` 包上 `sessionId + sequence + elapsedMs` 广播给已 attach 的 sink。**server 里没有业务逻辑**——这是阶段 4 事件分层的红利兑现点：理解事件的职责在 core，解释事件的职责在 Web 的 selector。

边界由 `packages/protocol` 的 runtime guards 把守：非法 JSON、缺字段、空 prompt、未知 command、active run 冲突都返回具名 `protocol.error`，不 crash server 也不静默忽略。服务只绑 `127.0.0.1`，upgrade path 固定 `/agent`，浏览器 Origin 只允许 `localhost` / `127.0.0.1`，单条 client payload 上限 64 KiB。浏览器侧的 `packages/web` 禁止 import `@mini-agent/core` / `ai` / `server` 或任何深层 workspace 路径——这条由 `no-runtime-boundary-imports` 测试强制。

### 3. live event 与 durable journal 必须分层，丢失的 delta 不能伪造成原始事件

这是本阶段最容易做错的一条。两种时间尺度的事实不能混在一条流里：

- **durable journal**（阶段 9）在 fsync 后才是事实：assistant 完成消息、toolResult、run_end、compaction entry。它回答「这次操作完成后，世界是什么样」。
- **live event** 是过程：delta 流、`tool_execution_update` 这样的半截更新、compaction_start 这样不落盘的过程事件。它回答「世界正在怎样变化」。

若把 delta 写进 journal，append-only 承诺就被传输层碎块污染；若把 live 事件当 durable 消费，断线丢失的半截 delta 就得靠客户端「补一个 message_end」收场——**伪造成原始事件**。这为什么是错的：伪造的 end 没有 usage、没有真实 stopReason、内容截断点由网络而非模型决定；它一旦进 selector，就与真消息无法区分，UI 展示的「完成」其实是「连接断了」。正确做法是分层兜底：丢失的 delta 只属于 live 层，durable 层始终能从 journal 重放出完整的已完成历史；当前操作的过程则由重连 snapshot 的 `transientEvents` 补齐。

### 4. 重连为什么需要 journal base + current-operation events 两层

重连时 client 收到一个新的 `SessionSnapshot`。若 snapshot 只发 journal，正在流式增长的 partial 就丢了；若把 active run 的 journal entries 和该 run 的 live 事件一起发，同一条 assistant/toolResult 会在两个通道各出现一次。**所以 snapshot 在操作中途只截止到该操作开始前的 leaf（`baseLeafId`），本次操作从开始到当前全部由 `transientEvents` 表示**——一层 durable base，一层瞬时增量，接缝处无重复、无缺口。

「操作开始前」由 server 的 operation 记账保证：begin 时先存 `baseLeafId` 再开时钟，`settle` 最后才清 operation；sequence 单调，`elapsedMs` 单调不减。浏览器中途断开、重连、 settle 后刷新，三个时刻看到的历史完全一致（验收时逐条核对：每条 USER 消息恰好一次、零 diagnostic）。

snapshot 的 `entries` 沿 `leafId` 的 `parentId` 祖先链构造 active path（`activeSessionPath`），**不能把物理 JSONL 行顺序当当前会话**——branch 之后旧分支的 descendants 仍在文件里，物理顺序混进来的话，Web 展示的历史与下一次模型请求的投影就不一致了。

### 5. 断线不 abort Agent；slow socket 不能成为 awaited listener

socket detach 只移除 sink，**不调用 `session.abort()`**。断开是浏览器的常态（关 tab、切网络、刷新），不是用户意图；active run 继续执行并照常持久化，重连由 snapshot 补偿。唯一允许 abort 的地方是 `SessionHost.close()`（server 停机），它 abort 后等 `session.waitForIdle()` 保证 journal 落盘再退出。

反向的约束同样硬：Agent 的 listener 是 awaited 的（阶段 4：listener 抛错会中断运行），所以 `SessionHost` 作为 listener 时**只做内存记录与非阻塞分发**——`ws.send` 不 await、sink 抛错只 detach 自己、observer promise 显式 `catch(() => {})`。慢浏览器若成为 awaited listener，整个 run 会被 socket 拖住；断开时 reject 还会杀死 run。可靠性由 journal snapshot 补偿，不由 listener 保证。core 已保证「内部持久化先于外部 listener」，server 不重复写 session、不复制恢复规则、不按错误文本猜测状态。

## 替代方案为什么更差

| 替代方案 | 失去什么 |
|---|---|
| 轮询 `agent.state` | 派生状态只在 settle 瞬间一致；流式、进行中的工具、未落盘 submission 不可见；N 个视图各自猜测，UI 事实与 core 事实脱钩 |
| 每个组件各自取数据 / 各自解释 | Chat 与 Timeline 对同一条消息长出两套语义；delta 被当成消息、usage 重复累计、tool card 按完成顺序重排——视图破坏消息与工具顺序语义 |
| socket 断开即 abort | 关 tab 变成杀死任务的按钮；刷新页面中断正在写的运行，违背 journal 存在的意义 |
| slow socket 作为 awaited listener | 慢浏览器给 Agent 施加 backpressure；listener rejection 杀死 run；传输层可靠性绑架业务层生命周期 |
| 把物理 JSONL 顺序当 active path | branch 后旧分支 descendants 混入 snapshot，Web 历史与下一次模型上下文不一致 |
| 把丢失 delta 补成 `message_end` 事件 | 伪造的完成消息没有 usage/stopReason，截断点由网络决定；UI 的「完成」不再是 core 的事实 |
| 显示未验证的成本数字 | 没有价格表时任何成本都是编造；宁可只显示 input/output/cache 计数也不写 0 |

## 决策点（供回测）

1. **为什么 UI 只订阅事实流，不读取 `agent.state`？** `agent.state` 是什么的投影、在什么瞬间才与事实一致？如果允许组件读它，哪些视图会各自长出「猜测逻辑」？
2. **重连时为什么需要 journal base + current-operation events 两层？** 只发 journal 会丢什么？把 active run 的 journal entries 与 live 事件一起发会重复什么？`baseLeafId` 为什么必须在操作开始时先存？
3. 断线为什么不 abort Agent？`SessionHost.close()` 与 socket detach 的区别是什么？
4. slow socket 为什么不能成为 awaited listener？可靠性为什么由 journal snapshot 补偿而不是由 listener 保证？
5. 为什么不能把丢失的 delta 伪造成原始 `message_end` 事件？durable 与 live 两层各回答什么问题？

## 实施边界与成本

三个新包 src 合计 **2591 行**、测试 3975 行：protocol（wire unions + runtime guards + type-only core 引用）、server（session-path / session-operations / session-host / create-runtime / websocket-server / index）、web（state selectors + reducer + ProtocolClient + useAgentSession + 三栏工作台组件与样式）。每个 src 文件 < 200 行，`session-host.ts` 超限后拆出 `session-operations.ts`（operation begin/settle 记账）再继续。

新增运行时依赖只在 server（`ws`）与 web（react / react-dom / vite 等）；`ai` / `core` / `extensions` / `cli` 零改动、零新依赖。运行期 client 状态增加 `agentActive` / `compactionActive` 两个标记：snapshot 的 `status` 只反映连接时刻，连接期间的 live status 由事件对推导（mid-run threshold compaction 期间 agent 仍 active，`compaction_end` 后回 running 而非 idle），Stop 按钮与 composer 禁用都依赖这条推导。

未实现（计划内边界）：Web 端 New session / 历史 session 列表 / session 切换（新会话仍由 server 启动参数 `--continue` 控制）；Dark 主题、文件树、编辑器、diff、内嵌终端、扩展管理页；CBOR / RPC / 插件协议 / 二进制帧；成本显示（待经验证的价格表）；阶段 13 的 `steer` / `followUp`、子 agent 与 parent/child UI。

开发入口：`pnpm dev:web` 并行拉起 server（`ws://127.0.0.1:8787/agent`）与 Vite（`http://localhost:5173/`）；继续已有 Web session 用两个终端：`pnpm --filter @mini-agent/server run dev -- --continue` + `pnpm --filter @mini-agent/web run dev`，避免把 `--continue` 误传给 Vite。

## 验收

`pnpm test` 与 `pnpm check` 全绿（protocol 19、server 37、web 83，ai/core/extensions/examples 无回归；CLI 类型检查通过）。覆盖：

- wire 边界：合法/非法命令、snapshot/envelope guards、protocol 对 core 只有 type-only import（测试强制）。
- server：active parent path 与坏 parent 防御、prompt/abort/compact 命令、detach/reconnect 不 abort、run 中途 snapshot 停在 base leaf 且 transientEvents 无重复无缺口、真实 ws client 的中途重连补齐、server 只用包根导入（测试强制）。
- web：delta 只更新 draft、`message_end` 才是完成消息、tool cards 按 assistant 源顺序、Timeline 按 envelope sequence、usage 只累计 input/output/cache 且不显示成本、manual/threshold/overflow compaction 形成 marker、live status 由事件对推导（含 mid-run compaction 回 running）。
- 浏览器实机（agent-browser 驱动真实 provider）：流式文本 + read 工具卡 + toolResult + 最终回答；usage 更新且无成本；Web Compact 按钮产生 live + journal 双通道 compaction marker；run 中途关闭 tab 不 abort，重连由 snapshot + transient events 补齐（每条 USER 恰好一次、零 diagnostic），settle 后刷新由 journal 恢复完整历史；并行 read 的 Chat 源顺序与 Timeline 完成顺序同时正确；Stop 产生 journal 级 `run_end: aborted` 与真实 aborted assistant；Event Details modal 展示 source / sequence / elapsedMs / 原始 JSON，支持 Esc、Previous / Next 与焦点返回。
