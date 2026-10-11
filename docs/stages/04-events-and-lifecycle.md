# 阶段 4 —— 事件分层与生命周期

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §3.2(c)、§3.3、§5 阶段 4
> 计划：`docs/plans/2026-10-11-stage-4-events-and-lifecycle.md`

## 这个阶段解决了什么问题

阶段 3 已经能逐字显示回答，但当时只有两个出口：

- `agentLoop()` 返回并修改消息数组；
- `onDelta` 把文本碎片交给 CLI。

这会形成两个数据源：UI 一边接收 delta，一边又要读消息数组，自己猜「一轮何时开始、工具何时执行、何时真正结束」。一旦加入异步日志、持久化或 Web UI，这种猜测很容易让 UI 与内部状态不同步。

阶段 4 把过程统一成一条被 `await` 的事件流：

```text
Agent._state
    │ createContextSnapshot()
    ▼
agentLoop(snapshot)
    │ emit(AgentEvent)
    ▼
Agent.processEvents()
    ├─ 先 reduce 到真实 state
    └─ 再按订阅顺序 await listeners
```

因此职责被拆开：

| 部件 | 负责什么 | 不负责什么 |
|---|---|---|
| `agentLoop` | 一次 run 内的模型请求、工具循环和事件顺序 | 不持有跨 run 状态 |
| `Agent` | messages/tools/isStreaming、single-flight、abort、idle | 不认识 CLI |
| CLI | 订阅事件并渲染 | 不读 `agent.state`，不拼内部状态 |

## Pi 的哪条决策是答案

### 1. `AgentEvent` 分成三层生命周期

Pi 的联合类型位于 `packages/agent/src/types.ts:516-539`。v3 复现了同一层次：

```text
agent_start / agent_end
    └─ turn_start / turn_end
           ├─ message_start / message_update / message_end
           └─ tool_execution_start / update / end
```

三层表达的是三种不同问题：

- **agent 层**：这一整个 `prompt()` run 是否还在工作？
- **turn 层**：这一次 assistant 响应及其工具结果是否完整结束？
- **message 层**：UI 现在该创建、更新还是封口哪一条消息？

provider 的 `AssistantMessageEvent` 只回答第三层里「assistant 正在怎样增长」，它不知道 user 消息、toolResult、turn 或整个 run，因此不能直接充当 `AgentEvent`。

### 2. loop 使用快照，真实状态只通过事件回流

Pi 的 `Agent.createContextSnapshot()` 在 `agent.ts:460` 附近。v3 的 `Agent` 每次调用 loop 时复制：

```ts
messages: this._state.messages.slice()
tools: this._state.tools.slice()
```

loop 可以自由追加自己的 `currentContext`，但不能直接碰 `_state`。真实状态只在 `processEvents()` 收到 `message_end` 后更新。

这是一条单向数据流：

```text
state → snapshot → loop → event → reducer → state
```

若 loop 与 Agent 同时写同一个数组，就会出现两条写入路径；以后加入持久化 listener 时，很难证明「内存里有的消息一定已经发过事件」。

### 3. listener 必须被 `await`

Pi 的 `processEvents()` 在 `agent.ts:565` 附近：先更新状态，再逐个 `await` listener。

v3 因此保证：

1. listener 收到 `message_end` 时，`agent.state.messages` 已包含该消息；
2. 第一个 listener 未完成，第二个 listener 不会越过它；
3. `agent_end` 已发出不等于已经 idle；
4. `waitForIdle()` 要等 `agent_end` 的所有 listener settle。

第 9 阶段会让 listener 写 JSONL。若这里 fire-and-forget，`waitForIdle()` 可能先返回、进程随后退出，最后几条事件就没有落盘。

### 4. `Agent` 是 single-flight

从 `agent_start` 到最后一个 `agent_end` listener 完成，`activeRun` 一直存在。此时再次调用 `prompt()` 会抛具名错误，而不是并行改同一份历史。

`abort()` 也只做一件事：

```ts
activeRun.abortController.abort()
```

流内半截 partial 不进历史；Agent 用一条 `stopReason: "aborted"` 的完整 assistant 消息关闭当前生命周期。若工具已经产生结果，该 toolResult 会先保留，再开启 terminal turn 写入 aborted assistant。

## 一次完整事件序列

一个「调用工具后再回答」的 run：

```text
agent_start
turn_start
message_start(user)
message_end(user)
message_start(assistant toolCall)
message_end(assistant toolCall)
tool_execution_start
tool_execution_end
message_start(toolResult)
message_end(toolResult)
turn_end
turn_start
message_start(assistant)
message_update × n
message_end(assistant)
turn_end
agent_end
```

工具必须先执行结束，随后才能产生 toolResult 消息。原 spec 曾把这两个顺序写反，已在 `d348fbb` 修正。

## 替代方案为什么更差

| 替代方案 | 代价 |
|---|---|
| loop 直接修改 `Agent._state` | loop 不再能脱离 Agent 独立测试；UI 事件与状态写入可能来自不同路径 |
| listener 不 await，直接 fire-and-forget | `waitForIdle()` 会提前返回；日志、持久化和 UI 更新可能落后甚至丢失 |
| UI 定时读取 `agent.state` | 只能看到结果，看不到事件顺序；流式文本和工具耗时仍要另开通道 |
| 直接把 `AssistantMessageEvent` 给所有 UI | 它只描述 provider 响应，无法表达 user、toolResult、turn 和 run |
| `agent_end.messages` 每次发送完整历史 | 每轮重复发送所有旧消息；订阅者还要区分哪些是本轮新增 |

## 决策点（供回测）

1. 为什么 `agentLoop` 必须无状态，而状态要放在 `Agent` 类里？
2. 为什么 listener 必须被 `await`，即使这会让慢 listener 拖慢整个 run？
3. 为什么需要 agent / turn / message 三层事件，不能只复用 `AssistantMessageEvent`？
4. 为什么 `agent_end.messages` 只包含本轮增量，而完整历史放在 `agent.state.messages`？

## 已知代价

- **慢 listener 会形成 backpressure。** 这是用吞吐换顺序与持久化正确性。
- **listener 抛错会中断事件交付。** 它属于宿主基础设施故障，不会被伪装成模型的 error 消息。
- **状态更新发生在 listener 之前。** listener 失败时，内存状态可能已经推进，但 run 会明确 reject，不会假装成功。
- **`tool_execution_update` 本阶段只有类型。** 工具还没有 `onUpdate` 数据源；阶段 5 才真正发该事件。
- **低层 loop 的 abort 会 reject。** 只有公共 `Agent.prompt()` 把它翻译成正常的 aborted 生命周期。

## 验收对照

1. ✅ 完整事件顺序：`core/test/agent-loop.test.ts` 覆盖无工具与工具两轮。
2. ✅ awaited listener 与 idle：`core/test/agent.test.ts` 用 deferred gate 证明 listener 顺序、single-flight 和 `waitForIdle()`。
3. ✅ Ctrl+C：流内与工具内 abort 都以 aborted assistant 收尾，`isStreaming === false`。
4. ✅ UI 只订阅事件：CLI 已删除 `agentLoop`、共享 messages 与 `onDelta`。
5. ✅ 最后一条 `message_update.message` 与 `message_end.message` 文本一致：`core/test/stream-assistant.test.ts`。
6. ✅ 工具生命周期使用单调时钟，且未知工具、参数错误、length 保护都有平衡事件。

## 实施中发现的偏差（留档）

- 全局 pnpm registry 指向不可达的 `npm.corp.ebay.com`；只在本次依赖恢复命令中临时指定 `https://registry.npmjs.org/`，没有修改用户配置。
- `AgentEvent.message_update.message` 的静态类型按 spec 保持为 `Message`；测试读取 text block 前必须先按 `role === "assistant"` 收窄。
- 阶段 3 的低层 abort 测试原本要求静默 return。阶段 4 将「不抛」责任上移到 `Agent.prompt()`，所以低层测试改为期待 reject，同时继续断言没有额外模型请求且已有工具结果不丢失。
- runtime error 暂时写进 synthetic assistant 的 text content；没有提前加入阶段 7 才需要的 `errorMessage` 字段。
