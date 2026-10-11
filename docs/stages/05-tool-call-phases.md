# 阶段 5 —— 三段式工具调用与拦截

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 5
> 计划：`docs/plans/2026-10-11-stage-5-tool-call-phases.md`

## 这个阶段解决了什么问题

阶段 4 已经能观察工具的 start/end，但工具调用内部仍是一整块：

```text
找工具 → 粗略校验 → execute → 捕获错误 → 生成 toolResult
```

这条路径没有一个可靠的「副作用发生前」拦截点。若以后权限扩展想询问用户「允许执行这个 bash 吗？」，把 hook 塞进 `execute()` 内部就太晚了：一旦调用工具，文件或进程可能已经发生变化。

阶段 5 把一次 tool call 拆成三个可独立测试的阶段：

```text
prepare
  找工具 → JSON Schema 校验 → beforeToolCall → block/allow

execute
  调用 tool.execute → 收集 onUpdate → 捕获工具错误

finalize
  归一化结果 → 算 duration → 生成 ToolResultMessage
```

外层 `executeToolCalls()` 只负责按模型原始顺序串行编排三段，并发送 AgentEvent。

## Pi 的哪条决策是答案

### 1. prepare 必须发生在副作用之前

Pi 的对应实现位于 `agent-loop.ts:708` 附近的 `prepareToolCall()`。

prepare 只做四件事：

1. 根据 tool name 找到定义；
2. 用 JSON Schema 校验 arguments；
3. 调用 `beforeToolCall`；
4. 返回「prepared」或「immediate error」。

prepared 结果只是一个数据包：

```ts
{
	kind: "prepared",
	toolCall,
	tool,
	args,
	startedAt,
}
```

它没有执行副作用。权限 UI 可以慢慢等待用户点击；只有返回 allow 后，execute 阶段才会调用工具。

### 2. 被 block 不是宿主异常，而是模型可理解的结果

Pi 的 block 路径在 `agent-loop.ts:728-756` 附近。v3 保留同一原则：

```text
beforeToolCall → { block: true, reason: "Denied" }
              ↓
tool_execution_end(isError=true)
              ↓
ToolResultMessage("Denied")
              ↓
下一轮模型请求
```

模型可以看到「这一步被拒绝」，然后选择读文件、缩小命令或请求其他方案。若直接 throw 到 `Agent.prompt()`，模型失去自我修复机会，整个 run 也会被误判为 runtime failure。

权限规则本身没有写进 core。core 只提供 hook；阶段 11 的扩展再决定哪些命令需要询问或拒绝。

### 3. execute 只关心工具与 update

Pi 的 `executePreparedToolCall()` 位于 `agent-loop.ts:821` 附近。工具拿到第三个参数：

```ts
onUpdate?.({
	content: [{ type: "text", text: "downloaded 20%" }],
});
```

runtime 把每次 update 转成：

```ts
{
	type: "tool_execution_update",
	toolCallId,
	toolName,
	args,
	partialResult,
}
```

update listener 可能是异步的，因此 runtime 会收集它们的 promises，并在 `tool_execution_end` 之前全部等待完成。否则 UI 可能先看到「工具已结束」，随后才收到「20%」。

工具 promise settle 后再调用旧 callback 的 late update 会被忽略，避免后台 timer 污染下一轮事件。

### 4. finalize 统一所有出口

Pi 的 `finalizeExecutedToolCall()` 位于 `agent-loop.ts:859` 附近。

无论结果来自：

- 正常 execute；
- 工具 throw；
- unknown tool；
- schema invalid；
- before hook block；
- hook 自己 throw；

最终都经过同一 finalize，得到：

```text
result + isError + durationMs + ToolResultMessage
```

因此外层事件顺序始终平衡：

```text
tool_execution_start
tool_execution_update × n
tool_execution_end
message_start(toolResult)
message_end(toolResult)
```

## JSON Schema 的范围

项目继续保持零运行时依赖。本阶段实现递归结构子集：

| 类别 | 支持 |
|---|---|
| 通用 | `type`、`enum`、`const` |
| object | `properties`、`required`、`additionalProperties: false` |
| array | `items`、`minItems`、`maxItems` |
| string | `minLength`、`maxLength`、`pattern` |
| number | `minimum`、`maximum`、`integer` |

不支持的 `oneOf` / `$ref` 等关键字不会被静默忽略，而是形成 validation error。错误包含完整路径：

```text
arguments.options.mode: expected one of ["safe","fast"]
arguments.tags[1]: expected string, got number
```

模型因此知道具体要修哪个参数。

## terminate 为什么是 batch 聚合

一个 assistant message 可以同时发多个 toolCall。即使第一个结果带 `terminate: true`，本阶段仍会完成当前 batch 的其余调用。

batch 只有在以下条件成立时才终止 run：

```ts
outcomes.length > 0 &&
outcomes.every((outcome) => outcome.result.terminate === true)
```

原因是 assistant 已经一次性提交了整个调用序列；执行到第一个 true 就停，会让后续 toolCall 永远没有 toolResult。

user abort 的优先级更高。即使工具返回 terminate，只要 signal 已 aborted，Agent 最终仍以 `stopReason: "aborted"` 收尾，不能把用户中止伪装成正常结束。

## 替代方案为什么更差

| 替代方案 | 代价 |
|---|---|
| 在 `execute()` 内找工具和校验 | hook 无法在统一位置拦截；每个工具重复实现相同边界 |
| 工具开始后再询问权限 | 权限对话框出现时副作用可能已经发生 |
| blocked 直接 throw | 模型看不到拒绝原因，无法换方案；run 被误判为 runtime error |
| update fire-and-forget | `tool_execution_end` 可能先于旧 update 到达 UI |
| 首个 terminate 立即 break | 同 batch 后续 toolCall 没有配对结果，协议历史悬空 |

## 决策点（供回测）

1. 为什么 prepare 必须与 execute 分离，不能都写在一个函数里？
2. 为什么被 block 要生成 isError toolResult 回喂模型，而不是终止整个 run？
3. 为什么 accepted update promises 必须在 `tool_execution_end` 前全部 settle？
4. 为什么 terminate 要按整个 batch 聚合，而不是遇到第一个 true 就停止？

## 已知代价

- **schema 不是完整 JSON Schema 标准。** 零依赖换来机制透明；不支持关键字会响亮报错。
- **before hook 会形成 backpressure。** 权限 UI 等多久，工具调用就等多久，这是安全拦截的必要代价。
- **update 也会形成 backpressure。** 慢 UI 会推迟 tool end，但保证事件顺序。
- **late update 被直接忽略。** 工具作者必须在 promise settle 前完成所有有效进度通知。
- **本阶段仍是串行。** 三段式的并行收益要到阶段 6 才兑现。

## 验收对照

1. ✅ block bash：execute 从未调用，历史有 isError toolResult，模型进入下一轮恢复。
2. ✅ schema invalid：hook/execute 均未调用，错误包含嵌套路径。
3. ✅ terminate：全部结果 terminate 时不再请求模型；混合结果继续。
4. ✅ onUpdate：事件位于 start/end 之间，异步 listener settle 后才发 end。
5. ✅ hook throw：变成模型可见 toolResult，`Agent.prompt()` 不 reject。
6. ✅ abort 优先：terminating tool 同时收到 abort 时，历史最终是 aborted assistant。

## 实施中发现的偏差（留档）

- validator 初版与 JSON value helper 合计 234 行；为满足每文件 < 200 与阶段净增量 < 400，最终压缩为一个 179 行的 focused module。
- `tool-call.ts` 加入三段实现后接近上限，因此 finalize 位于独立的 `finalize-tool-call.ts`，但仍从 `tool-call.ts` re-export。
- 新 options-object orchestrator 在 Task 4 就最小接入 `agentLoop`，否则中间提交无法通过类型检查；hook/terminate 行为仍在 Task 5 才启用。
- 原计划把 `AgentOptions` 移到独立文件；真实 Git diff 计入该未跟踪文件后会超过预算，因此最终保留在 `agent.ts` 并压缩公共类型声明。
- 阶段源码净增量最终为 386 行，低于 spec 的 400 行硬上限。
