# 阶段 4「事件分层与生命周期」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在无状态 `agentLoop` 外增加有状态 `Agent`，把 run / turn / message / tool execution 的完整生命周期统一编码为被顺序 `await` 的 `AgentEvent`，并让 CLI 只靠事件渲染与处理中止。

**Architecture:** provider 仍只产出 `AssistantMessageEvent`；`stream-assistant.ts` 把它翻译成 message 层事件，`agentLoop` 负责 run/turn/tool 层的编排，但只操作调用时拿到的上下文快照。`Agent` 持有真实状态，所有消息都经 `processEvents()` 回流进 `_state`；它先 reduce 状态，再顺序等待 listener，因此 `agent_end` listener settle 之前都不算 idle。

**Tech Stack:** TypeScript 5.9.3（`strict` + `erasableSyntaxOnly`）、Node 22+ / 当前 Node 24 `--experimental-strip-types`、pnpm workspaces、vitest 3。零新增运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md`（核心架构见 §3.2(c)、§3.3；阶段范围与验收见 §5「阶段 4 —— 事件分层与生命周期」）

## Global Constraints

- **零运行时依赖**。所有包 `dependencies` 保持不变（`core` 只有 `@mini-agent/ai` workspace 依赖，`cli` 只有两个 workspace 依赖）。
- **`erasableSyntaxOnly: true`**。禁止 `enum`、构造函数参数属性和 `namespace`；类型导入必须 `import type`。
- 跨包导入用包名；包内相对导入带 `.ts` 后缀。
- tab 缩进；每个 `src` 文件 < 200 行；注释解释「为什么」，不解释「是什么」。
- 本阶段唯一新概念是 **`AgentEvent` 三层生命周期 + `Agent` 单向数据流**。不提前实现阶段 5 的 `beforeToolCall` / `afterToolCall` / 工具 `onUpdate`，不实现阶段 6 并行工具，不实现阶段 13 队列。
- `tool_execution_update` 只定义类型；本阶段没有数据源，不发该事件。
- provider/runtime 失败在 `Agent` 公共 API 上变成 `stopReason: "error" | "aborted"` 的终止消息；listener 自己失败则原样 reject，不递归发 error 事件。
- `prompt()` single-flight；active 范围包含 `agent_end` 的异步 listener。完整历史在 `state.messages`，`agent_end.messages` 只含本轮新增消息。
- CLI 不读取 `agent.state`；渲染和 Ctrl+C 状态完全由订阅事件驱动。
- 保留阶段 1-3 的消息顺序、工具错误回喂、`length` 整批保护、串行工具与 delta 不进历史等既有行为；阶段 3 的低层 abort「静默 return」刻意升级为 Agent 层的 aborted 正常收尾。
- `grep -rn "fake\|anthropic" packages/core/src/` 必须为空。
- `pnpm test` 与 `pnpm check` 必须全绿；阶段源码增量目标约 300 行，硬上限 < 400 行（测试与文档不计）。

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/core/src/agent-event.ts` | 公共 `AgentEvent` 联合、`AgentEventSink`、`AgentEventListener` |
| `packages/core/src/stream-assistant.ts` | 把 `AssistantMessageEvent` 映射成 `message_start/update/end` |
| `packages/core/src/agent-loop.ts` | 无状态 run/turn 编排；维护本轮 `newMessages`，发 agent/turn/message 事件 |
| `packages/core/src/execute-tool-calls.ts` | 串行执行工具并发 `tool_execution_*` + toolResult message 生命周期 |
| `packages/core/src/agent-state.ts` | `AgentState`、初始数组复制、纯事件 reduce |
| `packages/core/src/agent.ts` | 有状态 facade：快照、reduce、订阅、single-flight、abort、idle、failure fallback |
| `packages/cli/src/index.ts` | 只订阅 `AgentEvent` 渲染；SIGINT 调 `agent.abort()` |

`agent-loop.ts` 当前 127 行，若把 provider 事件翻译也塞进去会越过 200 行；因此单独建立 `stream-assistant.ts`。`Agent` 的运行状态机放在 `agent.ts`，纯状态创建/归约放在 `agent-state.ts`，事件协议放在 `agent-event.ts`，避免任何一个文件变成类型与行为的混合仓库。

## Review Focus

1. **listener reject**：状态先 reduce，但事件交付失败；`prompt()` 应 reject，`isStreaming` 与 active run 必须清理，不能递归触发第二套 error 事件。→ Task 5。
2. **provider 无 `done` / 命中 `maxTurns`**：低层循环仍抛具名错误；`Agent` 应转成一条 `"error"` assistant 消息并补齐 terminal events，`prompt()` resolve。→ Task 5。
3. **`agent_end` listener 尚未 settle 时再次 `prompt()`**：仍属于 active run，第二次调用必须拒绝，`waitForIdle()` 也不能提前 resolve。→ Task 5。
4. **abort 落在流内或工具内**：半截 partial 不进历史；已经完成的工具结果保留；最终历史有 `"aborted"` assistant，公共 `prompt()` 不 reject。→ Task 5。
5. **工具在真正 `execute()` 前失败**（未知工具、参数错误、`length` 保护）：仍必须有成对的 start/end 与 toolResult message 事件，且 duration 使用单调时钟。→ Task 4。

---

### Task 1: 建立公共事件协议，并让 ai consumer 暴露完整流事件

**Files:**
- Create: `packages/core/src/agent-event.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/ai/src/stream-fn.ts`
- Modify: `packages/ai/src/index.ts`
- Test: `packages/ai/test/stream-fn.test.ts`

**Interfaces:**
- Produces in `@mini-agent/ai`:
  - `type AssistantMessageEventHandler = (event: AssistantMessageEvent) => void | Promise<void>`
  - `consumeAssistantMessage(stream: AssistantMessageEventStream, onEvent?: AssistantMessageEventHandler): Promise<AssistantMessage>`
- Produces in `@mini-agent/core`:
  - `type AgentEvent`：与 spec §3.2(c) 完全一致，`message_update` 字段是 `{ message, assistantMessageEvent }`
  - `type AgentEventSink = (event: AgentEvent) => void | Promise<void>`
  - `type AgentEventListener = AgentEventSink`
- Temporarily retains: `StreamDeltaHandler` 与 `AgentLoopOptions.onDelta`，仅作为阶段 3 CLI 的兼容适配；Task 6 切换 CLI 后删除。

- [ ] **Step 1: 写 `consumeAssistantMessage` 的失败测试**

在 `packages/ai/test/stream-fn.test.ts` 新增 describe，测试构造一个已入队的 `start → text_delta → done` stream，并给 handler 加短异步等待：

```ts
it("awaits each event handler before consuming the next event", async () => {
	let active = 0;
	let maxActive = 0;
	const seen: string[] = [];

	const message = textMessage("a");
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: pendingMessage() });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial: pendingMessage("a") });
	stream.push({ type: "done", message });
	stream.end(message);

	await expect(consumeAssistantMessage(stream, async (event) => {
		active++;
		maxActive = Math.max(maxActive, active);
		seen.push(event.type);
		await setTimeout(2);
		active--;
	})).resolves.toBe(message);

	expect(seen).toEqual(["start", "text_delta", "done"]);
	expect(maxActive).toBe(1);
	expect(active).toBe(0);
});
```

在测试文件内增加最小 `textMessage()` / `pendingMessage()` helper，不复用 fake provider，确保本测试只钉 consumer 契约。

- [ ] **Step 2: 跑测试确认旧的 delta-only handler 形状失败**

Run: `pnpm --filter @mini-agent/ai run test -- stream-fn`

Expected: FAIL——现有第二参数类型是 `(delta: string) => void`，测试传入的 handler 收不到事件对象。

- [ ] **Step 3: 修改 `consumeAssistantMessage`**

新增 `AssistantMessageEventHandler`，并把 `consumeAssistantMessage` 的第二参数改为该类型。`for await` 每拿到一条事件，先 `await onEvent?.(event)`，再对 `done` 保存权威消息；无 `done` 的具名错误保持不变。

这一顺序不能反过来：listener 必须看到事件对应的状态边界，且下一条 provider 事件的消费要被 listener backpressure。

- [ ] **Step 4: 给阶段 3 的 `onDelta` 加临时适配**

在 `agent-loop.ts` 现有调用点把 `options.onDelta` 包成事件 handler：

```ts
consumeAssistantMessage(streamFn(context, options.signal), async (event) => {
	if (event.type === "text_delta") options.onDelta?.(event.delta);
});
```

这一步只保持当前行为与绿灯，不发 `AgentEvent`；Task 6 切换 CLI 后删除该兼容层。

- [ ] **Step 5: 新建 `agent-event.ts` 并更新导出**

`AgentEvent` 使用 spec 的完整联合：

```ts
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: Message; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: Message; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown;
		isError: boolean; durationMs?: number };
```

从 `packages/core/src/index.ts` 导出 `AgentEvent`、`AgentEventSink`、`AgentEventListener`；从 `packages/ai/src/index.ts` 导出 `AssistantMessageEventHandler`。`StreamDeltaHandler` 暂时保留到 Task 6。

- [ ] **Step 6: 跑 ai 测试与全仓类型检查**

Run: `pnpm --filter @mini-agent/ai run test -- stream-fn && pnpm check`

Expected: ai 测试 PASS；`pnpm check` 全绿。不得提交一个依赖后续任务才能编译的中间状态。

- [ ] **Step 7: 提交**

```bash
git add packages/ai/src/stream-fn.ts packages/ai/src/index.ts packages/ai/test/stream-fn.test.ts \
  packages/core/src/agent-event.ts packages/core/src/agent-loop.ts packages/core/src/index.ts
git commit -m "feat(stage-4): define the AgentEvent protocol"
```

---

### Task 2: 把 provider 流翻译成 message 生命周期

**Files:**
- Create: `packages/core/src/stream-assistant.ts`
- Create: `packages/core/test/stream-assistant.test.ts`

**Interfaces:**
- Consumes: `consumeAssistantMessage()` 与 `AgentEventSink`（Task 1）
- Produces:
  - `streamAssistantMessage(stream: AssistantMessageEventStream, emit: AgentEventSink): Promise<AssistantMessage>`
- Event mapping:
  - `start` → `message_start`，顶层字段叫 `message`
  - `text_delta` → `message_update`，同时携带当前 `message` 与原始 `assistantMessageEvent`
  - `done` → `message_end`，使用 `done.message`

- [ ] **Step 1: 写翻译层失败测试**

创建 `packages/core/test/stream-assistant.test.ts`，用 `createFakeStreamFn(["ab"], { delayMs: 2 })` 取得 stream：

```ts
it("maps start/deltas/done to message lifecycle events", async () => {
	const events: AgentEvent[] = [];
	const message = await streamAssistantMessage(streamFor("ab"), async (event) => {
		events.push(event);
	});

	expect(events.map((event) => event.type)).toEqual([
		"message_start",
		"message_update",
		"message_update",
		"message_end",
	]);
	const updates = events.filter((event) => event.type === "message_update");
	expect(updates.map((event) => event.assistantMessageEvent.type))
		.toEqual(["text_delta", "text_delta"]);
	expect(textOf(updates.at(-1)!.message)).toBe(textOf(message));
	expect(events.at(-1)).toEqual({ type: "message_end", message });
});
```

再加一条 backpressure 测试：第一个 `message_update` listener 被 deferred gate 挡住时，第二个 `message_update` 尚未进入 sink；释放后才继续。

- [ ] **Step 2: 跑测试确认模块不存在**

Run: `pnpm --filter @mini-agent/core run test -- stream-assistant`

Expected: FAIL——无法解析 `../src/stream-assistant.ts`。

- [ ] **Step 3: 实现 `streamAssistantMessage`**

使用 Task 1 的 `consumeAssistantMessage(stream, async event => ...)`，对联合类型做穷尽 switch。`message_start` / `message_update` 使用 `{ ...event.partial }` 的顶层副本，`message_end` 使用 provider 的权威 `event.message`。

不深拷贝 `content`：阶段 3 已明确 `partial` 是 live object；本阶段的保证是 listener 在被 await 的消费边界上看到当前值，而不是把历史 delta 变成可持久化快照。

- [ ] **Step 4: 跑定向测试**

Run: `pnpm --filter @mini-agent/core run test -- stream-assistant`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/stream-assistant.ts packages/core/test/stream-assistant.test.ts
git commit -m "feat(stage-4): translate provider events into message lifecycle"
```

---

### Task 3: 让低层 loop 发 agent / turn / user / assistant 事件

**Files:**
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/test/agent-loop.test.ts`

**Interfaces:**
- `AgentLoopOptions` 新增 `emit?: AgentEventSink`
- 暂时保留 `onDelta?: StreamDeltaHandler`，只为让 stage 3 CLI 在 Task 6 切换前继续编译；新代码不得使用它
- `agentLoop(options): Promise<Message[]>` 继续返回并就地修改调用方传入的 `messages`
- Normal run events:
  - 首轮：`agent_start → turn_start → user message_start/end → assistant lifecycle → turn_end`
  - 后续模型轮：每轮先 `turn_start`
  - 正常结束：最后发 `agent_end`
- `agent_end.messages` 是本轮 `newMessages`；既有历史不重复包含。
- provider/loop 错误继续从低层抛出，不在这里伪造 `"error"`；Task 5 的 `Agent` 负责公共收尾。

- [ ] **Step 1: 把 stage 3 的 delta 测试改写成事件测试，并新增完整顺序测试**

在 `agent-loop.test.ts`：

1. 删除 `onDelta` 用例，改为从 `message_update.assistantMessageEvent` 收集 delta，仍断言拼接文本等于历史里的 assistant 文本。
2. 新增无工具 run 的精确顺序：

```ts
expect(events.map((event) => event.type)).toEqual([
	"agent_start",
	"turn_start",
	"message_start", // user
	"message_end",   // user
	"message_start", // assistant
	"message_update",
	"message_update",
	"message_end",   // assistant
	"turn_end",
	"agent_end",
]);
```

3. 给 `messages` 预放两条旧历史，断言 `agent_end.messages` 只含本轮 user + assistant，而 `agentLoop()` 返回值仍是原数组且含完整四条历史。
4. 加 awaited sink 测试：在 user `message_end` 上阻塞 listener，断言 `streamFn` 尚未被调用；释放后才开始模型请求。
5. 把阶段 3 的 mid-stream abort 低层测试改成 reject：低层 loop 不再静默 return；Agent 公共层的正常 aborted 收尾在 Task 5 测。

- [ ] **Step 2: 跑定向测试确认失败**

Run: `pnpm --filter @mini-agent/core run test -- agent-loop`

Expected: FAIL——`AgentLoopOptions` 尚无 `emit`，且没有生命周期事件。

- [ ] **Step 3: 实现 run/turn/message 编排**

在 `agentLoop` 内：

- 保留「已 aborted signal / 空白 prompt 在创建 user 消息前返回」的既有规则。
- 解析 `streamFn` 后定义 `emit = options.emit ?? (() => {})` 与 `newMessages: Message[] = []`。
- 发 `agent_start`、首个 `turn_start`，再把 user message 同时追加到 `options.messages` / `newMessages` 并发 `message_start/end`。
- 每次模型请求调用 Task 2 的 `streamAssistantMessage()`；返回的 final message 同时追加两份数组。
- 每轮工具处理完后发 `turn_end`；若仍需下一轮，在下一轮请求前发新的 `turn_start`。
- 正常收敛时发 `agent_end { messages: newMessages }`。
- 删除流内 abort 的「catch 后 return」；缺少 `done` 等错误继续抛给上层。
- 删除工具后的 silent return：当前 turn 先 `turn_end`；下一轮发 `turn_start` 后若 signal 已 aborted，抛 `new Error("agent loop aborted")`。这样低层不会在缺少 `agent_end` 的情况下伪装成功。
- 在传给 `streamAssistantMessage()` 的 sink 中先兼容调用 `options.onDelta`（仅 `text_delta`），再 `await emit(event)`；Task 6 删除这个临时分支。

`maxTurns` 错误保持原文案，不在抛错前发 `agent_end`；Task 5 会开 terminal turn 并正常收尾。

- [ ] **Step 4: 跑 agent-loop 测试**

Run: `pnpm --filter @mini-agent/core run test -- agent-loop`

Expected: PASS；原 stage 1/2 行为断言保持通过。工具事件的新增断言属于 Task 4。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/agent-loop.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(stage-4): emit agent turn and message lifecycles"
```

---

### Task 4: 给串行工具补齐执行与结果消息生命周期

**Files:**
- Modify: `packages/core/src/execute-tool-calls.ts`
- Modify: `packages/core/test/execute-tool-calls.test.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/test/agent-loop.test.ts`

**Interfaces:**
- `executeToolCalls(toolCalls: ContentBlock[], tools: ToolDef<any>[], signal?: AbortSignal, emit?: AgentEventSink): Promise<ExecutedToolBatch>`
- `failTruncatedToolCalls(toolCalls: ContentBlock[], emit?: AgentEventSink): Promise<ExecutedToolBatch>`（只供 `agent-loop.ts`，不从 package index 导出）
- `emit` 类型是 `AgentEventSink`
- 每个最终产生 toolResult 的调用：
  - `tool_execution_start`
  - `tool_execution_end`（`durationMs` 用 `performance.now()` 计算）
  - `message_start(toolResult)`
  - `message_end(toolResult)`
- `tool_execution_end.result` 使用归一化后的 `ToolResult`；`isError` 与最终 `ToolResultMessage.isError` 一致。
- signal 在下一个调用开始前已 aborted：保持阶段 2 的「后续调用不启动」，因此不发伪造 start/end。

- [ ] **Step 1: 写 execute-tool-calls 的事件失败测试**

新增以下用例：

1. 成功工具的事件类型严格为 `tool_execution_start → tool_execution_end → message_start → message_end`；start 的 id/name/args 正确，end 的 `durationMs` 是非负 number。
2. 未知工具与缺少必填参数也各自发完整四事件，且真实 `execute` 没被调用。
3. tool 抛错时 end 与 toolResult 都是 `isError: true`。
4. 第一个工具中止 signal 后，第二个工具没有任何 execution/message 事件。

- [ ] **Step 2: 跑工具测试确认失败**

Run: `pnpm --filter @mini-agent/core run test -- execute-tool-calls`

Expected: FAIL——函数尚不接收 sink，也没有事件。

- [ ] **Step 3: 实现工具事件**

把单个工具调用的内部结果保留为「归一化 `ToolResult` + `ToolResultMessage` + `durationMs`」，不要只留下 message。start 在查找工具/校验参数之前发，因此未知工具和参数错误也有可观测生命周期；end 在最终结果确定后发；随后才发 toolResult 的 message start/end。

用 `performance.now()`，不要用 `Date.now()`。本阶段不发 `tool_execution_update`。

- [ ] **Step 4: 让 `length` 整批保护走同样事件协议**

把 `agent-loop.ts` 的 `truncatedBatchFailures()` 移到 `execute-tool-calls.ts`，命名为 `failTruncatedToolCalls()`。它为每个被保护的 toolCall 发同样的 start/end + toolResult message 事件，仍然绝不调用工具；`durationMs` 复用正常路径的 private lifecycle helper，不硬编码 `0`。

`agentLoop` 把同一个 `emit` 传给正常工具执行和 length 失败路径；返回的 toolResult 仍按 assistant 源顺序追加到上下文。

- [ ] **Step 5: 加完整工具 run 顺序测试**

脚本使用「第一轮一个 echo toolCall，第二轮 `"done"`」，断言：

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
message_start(assistant text)
message_update...
message_end(assistant text)
turn_end
agent_end
```

同时断言第一条 `turn_end.toolResults` 含该 toolResult，第二条为空。

- [ ] **Step 6: 跑 core 全部测试**

Run: `pnpm --filter @mini-agent/core run test`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/execute-tool-calls.ts packages/core/test/execute-tool-calls.test.ts \
  packages/core/src/agent-loop.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(stage-4): emit tool execution lifecycles"
```

---

### Task 5: 实现有状态 `Agent`、awaited listeners 与 error/abort 收尾

**Files:**
- Create: `packages/core/src/agent.ts`
- Create: `packages/core/src/agent-state.ts`
- Create: `packages/core/test/agent.test.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

```ts
export interface AgentState {
	messages: Message[];
	tools: ToolDef<any>[];
	isStreaming: boolean;
}

// package-internal helpers from agent-state.ts
export function createAgentState(
	messages: Message[],
	tools: ToolDef<any>[],
): AgentState;
export function reduceAgentState(state: AgentState, event: AgentEvent): void;

export interface AgentOptions {
	system: string;
	messages?: Message[];
	tools?: ToolDef<any>[];
	streamFn?: StreamFn;
	maxTurns?: number;
}

export class Agent {
	constructor(options: AgentOptions);
	get state(): Readonly<AgentState>;
	prompt(prompt: string): Promise<void>;
	subscribe(listener: AgentEventListener): () => void;
	abort(): void;
	waitForIdle(): Promise<void>;
}
```

- `agent-state.ts` 导出 `AgentState`，并在包内导出 `createAgentState()` / `reduceAgentState()`；后两者不从 package index 导出。
- 构造时复制 `messages` / `tools` 顶层数组，并立即解析 `options.streamFn ?? getDefaultStreamFn()`；无实现时在生命周期开始前抛错。
- `createContextSnapshot()` 再复制两份数组交给 `agentLoop`。
- `processEvents()`：先 reduce，再按订阅顺序逐个 `await` listener。
- 只有 `message_end` 把消息推入 `_state.messages`；partial/update 不进历史。
- `isStreaming` 从 run 建立开始为 true，直到 `agent_end` listener settle 且 finally 清理后才 false。

- [ ] **Step 1: 写 Agent 正常状态流的失败测试**

创建 `agent.test.ts`，覆盖：

1. `prompt("hi")` 后 `state.messages` 是 user + assistant，构造时传入的原 messages 数组没有被 loop 就地修改。
2. listener 收到的完整无工具序列与 Task 3 相同；`agent_end.messages` 只含本轮消息。
3. `unsubscribe()` 后 listener 不再收到下一轮事件。
4. 空白 prompt 保持 no-op：无事件、历史不变。
5. 在 `message_end` listener 内读取 `agent.state.messages` 时，该消息已经存在（证明 reduce 先于 listener）；构造时传入的 tools 数组后续被外部修改，不影响 Agent 的工具快照。
6. 清空 default streamFn 后，`new Agent({ system: "s" })` 立即抛 `/no default stream fn/i`，且没有任何生命周期事件。

- [ ] **Step 2: 写 awaited listener / single-flight 失败测试**

用 deferred gate 卡住 `agent_end` listener：

- `agent.prompt("hi")` 与 `agent.waitForIdle()` 都未 settle；
- `state.isStreaming === true`；
- 此时第二次 `prompt()` reject `/already processing|active run/i`；
- 释放 gate 后第一个 prompt 和 idle 都 resolve，`state.isStreaming === false`。

再注册第二个 listener：第一 listener 的 gate 未释放前，第二 listener 不得收到 `agent_end`，证明 listener 按订阅顺序逐个 await。不要真的 sleep 3 秒；deferred gate 精确证明同一语义且测试更快。

- [ ] **Step 3: 写 runtime failure 与 listener failure 测试**

1. broken stream `end()` 不发 `done`：`prompt()` resolve；历史最后一条是 `stopReason: "error"` 且 text 包含 `without a done event`；事件尾部是 `message_start → message_end → turn_end → agent_end`。
2. `maxTurns: 1` 且 fake 永远发 toolCall：同样转成 `"error"` terminal message，且该 message 的 text content 包含 `maxTurns` 与最后工具名；不能把具名低层错误吞成空成功形状。
3. listener 在 `message_update` 抛 `"listener broke"`：`prompt()` reject 该错误；不再合成第二条 error assistant；finally 后 `isStreaming === false`，`waitForIdle()` resolve。
4. broken stream 触发 fallback 后，listener 在 synthetic `message_end` 抛错：同样原样 reject listener 错误，不再次进入 fallback。

在 `AssistantMessage` 上**不新增**阶段 7 才需要的 `errorMessage` 字段：synthetic `"error"` message 的 text content 写入 `error instanceof Error ? error.message : String(error)`；`"aborted"` message 使用空 text。这样错误可见但不提前扩展消息协议。

- [ ] **Step 4: 写 mid-stream abort 失败测试**

监听第一个 `message_update` 时调用 `agent.abort()`：

- `prompt()` resolve；
- delta 对应的半截 assistant 不在 `state.messages`；
- 历史是 user + 一条 `stopReason: "aborted"` assistant；
- 事件以 `message_end(aborted) → turn_end → agent_end` 收尾；
- `state.isStreaming === false`。

- [ ] **Step 5: 写 tool abort 失败测试**

fake 第一轮发一个工具调用；listener 收到 `tool_execution_start` 时 abort。工具若看到已 aborted signal 就抛 `AbortError`。

断言历史顺序：

```text
user
assistant(toolUse)
toolResult(isError: true)
assistant(aborted)
```

并断言原工具 turn 先 `turn_end`，随后新 `turn_start`，再发 terminal aborted assistant；已产生 toolResult 不丢失。

- [ ] **Step 6: 实现 `Agent` 状态机**

内部至少需要：

- `_state`
- `listeners: Set<AgentEventListener>`
- `activeRun?: { promise; resolve; abortController }`
- 本轮 `runMessages`
- `turnOpen`（让 failure fallback 只在前一 turn 已关闭时补 `turn_start`）
- `messageOpen`（mid-stream failure 已经有 `message_start` 时，fallback 只发配对的 `message_end`）

listener 错误用内部 wrapper 标记来源；`runWithLifecycle()` 对 executor 和 `handleRunFailure()` 两条路径都必须识别 wrapper 并原样 rethrow cause，其他 executor 错误才进入 fallback，避免 listener failure 递归生成事件。

`handleRunFailure()`：

1. 若 `turnOpen === false`，先发 `turn_start`；
2. 构造 assistant：aborted 使用空 text，error 使用原错误文本；`stopReason` 为 `"aborted"` 或 `"error"`；
3. 若 `messageOpen === false` 才发 `message_start`；随后总是发 `message_end`，让已经开始的 partial 生命周期被 synthetic final message 正常关闭；
4. 发 `turn_end`、`agent_end { messages: runMessages }`。

finally 才设置 `isStreaming = false`、resolve idle promise、清掉 active run。

- [ ] **Step 7: 更新导出并运行测试**

从 `packages/core/src/index.ts` 导出 `Agent`、`AgentOptions`、`AgentState`。

Run: `pnpm --filter @mini-agent/core run test && pnpm check`

Expected: PASS；所有包类型检查无输出。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/agent.ts packages/core/test/agent.test.ts \
  packages/core/src/agent-state.ts packages/core/src/agent-loop.ts packages/core/src/index.ts
git commit -m "feat(stage-4): add stateful Agent lifecycle"
```

---

### Task 6: CLI 改为纯事件渲染，并接入 Ctrl+C

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/ai/src/stream-fn.ts`
- Modify: `packages/ai/src/index.ts`

**Interfaces:**
- Consumes: `Agent`, `AgentEvent`
- Removes: CLI 对 `agentLoop`、共享 `messages` 数组、`onDelta` 的依赖
- Removes: 过渡期 `AgentLoopOptions.onDelta`、`StreamDeltaHandler` 与 ai/core re-export
- UI 状态仅为订阅事件归约出的局部标志：`running`、`streamed`、`aborted`

- [ ] **Step 1: 改组装根**

保留 `setDefaultStreamFn(createFakeStreamFn(...))`，随后：

```ts
const agent = new Agent({
	system: "You are a minimal teaching agent.",
	tools: createDefaultTools(),
});
```

banner 改为 `mini-agent (stage 4) — type /exit to quit`。

- [ ] **Step 2: 用单个 subscriber 渲染全部过程**

subscriber 只依据事件：

- `agent_start`：`running = true`，重置 `streamed` / `aborted`
- `message_update` 且内层是 `text_delta`：`stdout.write(delta)`，`streamed = true`
- `tool_execution_start`：打印 `→ <name> <args>`
- `message_end` 且 toolResult error：打印 `✗ <toolName>: <text>`
- `message_end` 且 assistant stopReason `"error"`：打印 `✗ <text>`，不能因没有 delta 而静默
- `message_end` 且 assistant stopReason `"aborted"`：`aborted = true`
- `agent_end`：`running = false`

readline 循环只做 `await agent.prompt(line)`；结束后若 aborted 打印 `^C` 并补换行，否则有 streamed 文本时补换行。不得读 `agent.state`。

- [ ] **Step 3: 接入 SIGINT**

注册 `rl.on("SIGINT", ...)`：

- `running === true`：调用 `agent.abort()`，不关闭进程；
- idle：`rl.close()`，沿用终端程序常见的 Ctrl+C 退出语义。

`running` 来自事件，不来自 state。

- [ ] **Step 4: 删除阶段 3 的 delta callback 兼容层**

从 `AgentLoopOptions`、`agent-loop.ts` 的 event sink wrapper、`ai/src/stream-fn.ts`、ai/core index 导出中删除 `onDelta` / `StreamDeltaHandler`。`AssistantMessageEventHandler` 与 `AgentEvent` 成为唯一流式出口。

- [ ] **Step 5: 静态验证 UI 边界**

Run:

```bash
grep -n "agent\\.state\\|agentLoop\\|onDelta" packages/cli/src/index.ts
grep -rn "StreamDeltaHandler\\|onDelta" packages/
```

Expected: 两条命令都无输出。

- [ ] **Step 6: 手动验证正常流**

Run: `printf 'hello\n/exit\n' | pnpm dev`

Expected: banner 为 stage 4，问候逐字输出一次，进程正常退出。

- [ ] **Step 7: 手动验证 Ctrl+C**

Run: `pnpm dev`

输入 `hello`，在问候尚未结束时按一次 Ctrl+C。

Expected: 已打印的半句保留，随后出现 `^C` 与新 prompt；进程不退出。再在 idle 时按 Ctrl+C，进程退出。

- [ ] **Step 8: 运行类型检查并提交**

Run: `pnpm check`

Expected: PASS；删除兼容类型后没有残余消费点。

```bash
git add packages/cli/src/index.ts packages/core/src/agent-loop.ts packages/core/src/index.ts \
  packages/ai/src/stream-fn.ts packages/ai/src/index.ts
git commit -m "feat(stage-4): render the CLI from AgentEvents"
```

---

### Task 7: 阶段文档与全量验收

**Files:**
- Create: `docs/stages/04-events-and-lifecycle.md`

**Interfaces:**
- Consumes: 本阶段全部代码与测试
- Produces: 阶段 4 学习文档；回测答案仍不在本任务编写

- [ ] **Step 1: 写阶段文档**

沿用阶段 1/3 的结构：

1. **这个阶段解决了什么问题**：loop 负责过程但不该持有跨 run 状态；UI 若同时读 state 与 delta callback 会出现双数据源。
2. **Pi 的哪条决策是答案**：`AgentEvent` 三层生命周期、context snapshot、`processEvents` 先 reduce 后 await listeners、single-flight active run。
3. **替代方案为什么更差**：loop 直接改 Agent state；listener fire-and-forget；UI 轮询 state；直接复用 `AssistantMessageEvent`。
4. **决策点（供回测）**：
   - 为什么 loop 无状态、状态在 Agent？
   - 为什么 listener 必须 await？
   - 为什么需要 agent / turn / message 三层，而不是只发 provider delta？
   - 为什么 `agent_end.messages` 是本轮增量而完整历史在 state？
5. **已知代价**：慢 listener 对整个 run 施加 backpressure；listener failure 会中断事件交付；本阶段的 `tool_execution_update` 只有类型没有事件。
6. **实施偏差与验收对照**：记录 spec 原工具顺序已在 `d348fbb` 修正。

- [ ] **Step 2: 全量自动验收**

```bash
pnpm test
pnpm check
grep -rn "fake\|anthropic" packages/core/src/
grep -n "agent\\.state\\|agentLoop\\|onDelta" packages/cli/src/index.ts
grep -rn "StreamDeltaHandler\\|onDelta" packages/
wc -l packages/core/src/agent-event.ts packages/core/src/stream-assistant.ts \
  packages/core/src/agent-loop.ts packages/core/src/execute-tool-calls.ts \
  packages/core/src/agent-state.ts packages/core/src/agent.ts packages/cli/src/index.ts
```

Expected:

- test/check 全绿；
- 三条 grep 都无输出；
- 每个 `src` 文件 < 200 行。

- [ ] **Step 3: 全量行为验收**

1. 正常无工具 prompt：事件顺序满足验收 #1。
2. 工具脚本：执行事件先于 toolResult message 事件，下一轮有新的 `turn_start`。
3. 慢 `agent_end` listener：`waitForIdle()` 与下一次 `prompt()` 都遵守 single-flight。
4. 流中 Ctrl+C：`state.isStreaming === false`，历史最后一条是 aborted assistant。
5. CLI 只靠事件完成流式文本、工具错误和 `^C` 渲染。

- [ ] **Step 4: 提交**

```bash
git add docs/stages/04-events-and-lifecycle.md
git commit -m "docs(stage-4): explain layered lifecycle events"
```

---

## 完成标准

- [ ] `AgentEvent` 完整联合存在，`message_update` 使用 `message + assistantMessageEvent`。
- [ ] `agentLoop` 仍无状态；`Agent` 每次传入 messages/tools 快照，真实状态只由 `processEvents()` 回流更新。
- [ ] listener 严格按订阅顺序被 await；`agent_end` listener settle 前 `isStreaming` 仍为 true、`waitForIdle()` 不 resolve。
- [ ] 正常 run 的事件顺序与 spec 阶段 4 验收 #1 一致。
- [ ] tool execution start/end 在 toolResult message start/end 之前；未知工具、参数错误、length 保护同样有平衡事件。
- [ ] `message_update.message` 在最后一条 delta 后与 `message_end.message` 内容一致。
- [ ] mid-stream / tool abort 不让 `Agent.prompt()` reject，半截 partial 不进历史，最终有 aborted assistant。
- [ ] provider 无 done / maxTurns 在 Agent 层成为 error assistant；listener failure 仍 reject 且清理运行状态。
- [ ] CLI 不读取 `agent.state`，只订阅事件；active Ctrl+C 中止，idle Ctrl+C 退出。
- [ ] `pnpm test`、`pnpm check` 全绿；core provider 边界 grep 为空；每个 src 文件 < 200 行。
- [ ] `docs/stages/04-events-and-lifecycle.md` 存在并留下四个回测问题。
