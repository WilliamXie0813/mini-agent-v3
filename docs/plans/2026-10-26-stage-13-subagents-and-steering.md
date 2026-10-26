# 阶段 13「子 Agent 与中途插话」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一次 Agent run 内加入 `steer` / `followUp` 双队列和全局轮次预算，提供不发事件、不写历史的 `runToolCall()`，并用隔离的子 Agent 委派工具证明父 Agent 只接收最终文本。

**Architecture:** `PendingMessageQueue` 分别保存 steering 与 follow-up；`agentLoop` 拆出请求准备和单轮执行后改为双层循环，内层处理工具与 steering，外层只在正常收敛时处理 follow-up，整次 run 仍只有一对 `agent_start` / `agent_end`。`AgentSession` 复用同一事件流持久化插话产生的 user 消息；独立工具调用复用 prepare / execute / finalize / afterToolCall，但不接事件或 journal；委派工具每次新建子 `Agent`，不共享消息、事件或默认委派能力。

**Tech Stack:** Node 22+、TypeScript 5.9.3（strict + erasableSyntaxOnly）、pnpm workspaces、vitest 3、现有 `Agent` / `AgentSession` / `StreamFn` / `ToolDef`。零新增运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md` §3.1、§3.2(c)、§5 阶段 13、§6、§7；前置边界见 `docs/stages/12-ui-layer.md` 与 `docs/handoffs/2026-10-24-stage-12-ui-layer.md`。

## Global Constraints

- **只加阶段 13 的概念**：`steer` / `followUp`、双层 loop、`runToolCall`、子 Agent 隔离。不实现 WebSocket 新命令、React parent/child UI、CLI 新命令、后台任务管理器、独立子 Agent journal 或默认递归委派。
- 先写失败测试，再写最小实现；每个任务独立提交。阶段结束时 `pnpm test` 与 `pnpm check` 全绿。阶段 13 源码预算约 350 行，**源码总量净增量 `< 400` 行**；超出时先重新拆分或缩小实现，不直接宣布验收。
- tab 缩进；ESM；包内相对导入带 `.ts`；跨包用包名；类型导入用 `import type`；禁止 `enum`、构造函数参数属性、`namespace`。
- 新增源码文件及本阶段拆出的 loop 文件各 `< 200` 行。`agent.ts` / `agent-session.ts` 已有既有超限债务，本阶段只做小接线，不借机重写；阶段文档如实记录，不声称它们已降到 200 行以下。
- `prompt()` 继续 single-flight。一次 prompt 及其所有 steering/follow-up 属于同一 run：`agent_start` 与 `agent_end` 各一次，`agent_end.messages` 包含本次新增的全部 user/assistant/system/toolResult。
- **steering 时机**：当前 assistant 响应及其工具批处理完整结束、`turn_end` 完成后，在下一次模型请求前注入；不截断当前响应。steering 存在时，即使模型本轮原本会停，也继续内层循环。
- **follow-up 时机**：只在模型正常收敛或 `finishTurn` 请求结束时注入。`error` / `aborted` / `terminate: true` / `maxTurns` 不消费 follow-up 来复活 run。
- `maxTurns` 是一次 run 的**全局 provider 请求预算**，内层、overflow 重试、`finishTurn: continue` 和外层 follow-up 共用；不得在外层重置。
- `QueueMode` 为 `"one-at-a-time" | "all"`，默认 `"one-at-a-time"`；混合队列由**队首条目的 mode**决定本次 drain 一条还是全部，始终保持 FIFO。
- `Agent.steer()` / `Agent.followUp()` 只接受 active 且尚未发出最终 `agent_end` 的 run；非空白迟到调用抛具名错误，空白输入 no-op。run 结束清空未消费队列，不泄漏到下一 run。
- 插话仍走普通 `message_start` / `message_end(user)`，不增加 `AgentEvent` 变体，UI 不读内部队列。
- `AgentSession` 的初始 prompt 仍只由 `submission` 重建，避免重复；同 run 后续 user 消息必须 append 为 `message` entry，resume / branch / Web snapshot 才能重放。
- `runToolCall()` 不提供 `emit`、`toolExecution` 或 `commitToolIntent` 参数，不写消息或 journal。需要 durable recovery 的调用必须走 `AgentSession`，避免只有 intent 没有 outcome 的半持久化调用。
- 子 Agent 每次执行都新建 `Agent` 和新 transcript；只显式传入子工具，不继承父消息、父事件 listener 或 delegate 工具。父 abort 必须传播给子 Agent；父只收到最后一个 assistant 的文本结果。
- 所有实施 commit 以 `feat(stage-13): ...`、`fix(stage-13): ...` 或 `docs(stage-13): ...` 开头，并以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。
- 执行时使用独立 `stage-13-subagents-and-steering` 分支/工作树，不带入无关的未提交 UI 调整；每个 commit 只添加本任务列出的文件。

## Review Focus

1. **最后收敛与入队竞争**：`turn_end` listener 中到达的 follow-up 必须在最终 `agent_end` 前被消费一次，不能丢失、重复或另起 run。→ Task 4 的事件门控测试。
2. **硬停被队列复活**：abort/error/terminate 后若仍消费队列，会再次请求模型或把陈旧输入带入下一 run。→ Task 4 的硬停与队列清理测试。
3. **外层循环绕过预算**：每个 follow-up 若重置 turn，会持续烧 token。→ Task 4 的 `maxTurns: 2` 测试。
4. **journal 丢失或重复 user**：初始 prompt 同时写 submission 和 message 会重复；插话仍忽略 user 会在 resume 后消失。→ Task 5 的 reopen 投影测试。
5. **子 Agent 隔离或 abort 断裂**：共享 transcript/listener 会污染父历史与 UI；不链接 signal 会让父 Stop 后子任务继续运行。→ Task 7 的隔离与 abort 测试。

---

## 1. 锁定的接口与文件职责

### 1.1 双队列

`packages/core/src/pending-message-queue.ts`：

```ts
export type QueueMode = "one-at-a-time" | "all";

export class PendingMessageQueue {
	enqueue(message: UserMessage, mode?: QueueMode): void;
	drain(): UserMessage[];
	clear(): void;
	get size(): number;
}
```

`Agent` 新增：

```ts
steer(prompt: string, mode?: QueueMode): void;
followUp(prompt: string, mode?: QueueMode): void;
```

`AgentLoopOptions` 新增 `steeringQueue?: PendingMessageQueue` 与 `followUpQueue?: PendingMessageQueue`。缺省时各建一个空队列，保持直接调用 `agentLoop()` 的旧用法。

### 1.2 单轮拆分

`AgentLoopOptions` 移到 `agent-options.ts`，`agent-loop.ts` 继续 re-export，包根 API 不变。

```ts
export interface AgentTurnState {
	turn: number;
	overflowRecovered: boolean;
	newMessages: Message[];
}

export type AgentTurnResult = "continue" | "stop" | "terminal";

export type AgentTurnOptions = Omit<
	AgentLoopOptions,
	| "prompt"
	| "maxTurns"
	| "streamFn"
	| "tools"
	| "emit"
	| "steeringQueue"
	| "followUpQueue"
> & {
	streamFn: StreamFn;
	tools: ToolDef<any>[];
	emit: AgentEventSink;
	state: AgentTurnState;
};

export function prepareAgentTurn(
	options: AgentTurnOptions,
): Promise<{ request: StreamContext; activeTools: ToolDef<any>[] }>;

export function runAgentTurn(
	options: AgentTurnOptions,
): Promise<AgentTurnResult>;
```

`prepareAgentTurn` 负责 next-turn system entry、transcript replay、prepareRequest、transformContext 与 activeTools。`runAgentTurn` 负责 provider、工具、overflow、turn_end 和 finishTurn；`terminal` 只表示 error/aborted/terminate，`stop` 表示可咨询 follow-up 的正常收敛，`continue` 表示内层继续。

### 1.3 独立工具与子 Agent

```ts
export interface RunToolCallOptions {
	assistantMessage: AssistantMessage;
	messages: readonly Message[];
	tools: readonly ToolDef<any>[];
	signal?: AbortSignal;
	beforeToolCall?: BeforeToolCall;
	afterToolCall?: AfterToolCall;
}

export function runToolCall(
	toolCall: ToolCall,
	options: RunToolCallOptions,
): Promise<FinalizedToolCallOutcome>;

export interface SubagentToolOptions {
	system: string;
	streamFn: StreamFn;
	tools?: ToolDef<any>[];
	maxTurns?: number;
	name?: string; // 默认 "delegate"
	description?: string;
}

export function createSubagentTool(
	options: SubagentToolOptions,
): ToolDef<{ task: string }>;
```

`createSubagentTool` 固定 `replay: "unsafe"`，参数 schema 为 `{ type: "object", properties: { task: { type: "string" } }, required: ["task"] }`。

### 1.4 文件职责

| 文件 | 职责 |
|---|---|
| `packages/core/src/pending-message-queue.ts` | 新建。FIFO、QueueMode、drain、clear。 |
| `packages/core/src/agent-options.ts` | 修改。承接 `AgentLoopOptions`，不改变 `AgentOptions` 的公开字段。 |
| `packages/core/src/prepare-agent-turn.ts` | 新建。从现有 loop 原样提取每轮请求准备。 |
| `packages/core/src/agent-turn.ts` | 新建。从现有 loop 原样提取单轮 provider/工具执行。 |
| `packages/core/src/agent-loop.ts` | 修改。run 生命周期、全局预算、user 注入和双层循环。 |
| `packages/core/src/agent.ts` | 修改。持有双队列、公开 steer/followUp、run 结束清理。 |
| `packages/core/src/agent-session.ts` | 修改。转发 steer/followUp；持久化同 run 后续 user。 |
| `packages/core/src/run-tool-call.ts` | 新建。单个工具的无事件、无历史执行入口。 |
| `packages/core/src/subagent-tool.ts` | 新建。隔离子 Agent、结果提取、abort 链接。 |
| `packages/core/src/index.ts` | 修改。只导出新增公共 API 与类型。 |
| `packages/core/test/pending-message-queue.test.ts` | 新建。队列 FIFO/mode/clear。 |
| `packages/core/test/agent-steering.test.ts` | 新建。steering 时机、事件与公开 API。 |
| `packages/core/test/agent-follow-up.test.ts` | 新建。外层循环、硬停和全局预算。 |
| `packages/core/test/session-queued-messages.test.ts` | 新建。session API、journal 与 reopen。 |
| `packages/core/test/run-tool-call.test.ts` | 新建。独立工具契约。 |
| `packages/core/test/subagent-tool.test.ts` | 新建。父子隔离与 abort。 |
| `docs/stages/13-subagents-and-steering.md` | 新建。阶段决策、替代方案、验收与成本。 |

---

## 2. 任务分解

### Task 1: `PendingMessageQueue` 与 QueueMode

**Files:**
- Create: `packages/core/src/pending-message-queue.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/pending-message-queue.test.ts`

**Interfaces:**
- Consumes: ai 包既有 `UserMessage`。
- Produces: 1.1 的 `QueueMode` 与 `PendingMessageQueue`；Task 3/4 依赖其 FIFO drain 语义。

- [ ] **Step 1: 写失败的队列测试**

用三个不同文本的 `UserMessage`（`u1` / `u2` / `u3`）覆盖：

```ts
it("drains one FIFO message per checkpoint by default", () => {
	queue.enqueue(u1); queue.enqueue(u2);
	expect(queue.drain()).toEqual([u1]);
	expect(queue.drain()).toEqual([u2]);
	expect(queue.drain()).toEqual([]);
});

it("drains the whole FIFO batch when the first entry uses all", () => {
	queue.enqueue(u1, "all"); queue.enqueue(u2); queue.enqueue(u3);
	expect(queue.drain()).toEqual([u1, u2, u3]);
	expect(queue.size).toBe(0);
});

it("uses the current head mode for mixed batches", () => {
	queue.enqueue(u1); queue.enqueue(u2, "all"); queue.enqueue(u3);
	expect(queue.drain()).toEqual([u1]);
	expect(queue.drain()).toEqual([u2, u3]);
});

it("clear drops every pending message", () => {
	queue.enqueue(u1); queue.clear();
	expect(queue.size).toBe(0);
	expect(queue.drain()).toEqual([]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/pending-message-queue.test.ts`
Expected: FAIL — 找不到 `../src/pending-message-queue.ts`。

- [ ] **Step 3: 实现队列并导出**

内部条目类型为 `{ message: UserMessage; mode: QueueMode }`。`drain()` 先移除队首；队首为 `one-at-a-time` 时只返回它，为 `all` 时再 splice 剩余全部并按 FIFO 返回。不要按队尾 mode、调用方最后使用的 mode 或文本合并消息。

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm --filter @mini-agent/core exec vitest run test/pending-message-queue.test.ts && pnpm --filter @mini-agent/core run check`
Expected: 4 tests PASS；tsc 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pending-message-queue.ts packages/core/src/index.ts packages/core/test/pending-message-queue.test.ts
git commit -m "feat(stage-13): add pending message queues" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 提取请求准备与单轮执行，保持旧行为

**Files:**
- Modify: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/prepare-agent-turn.ts`
- Create: `packages/core/src/agent-turn.ts`
- Test: 既有 `packages/core/test/agent-loop.test.ts`、`agent.test.ts`、`finish-turn.test.ts`、`prepare-next-turn.test.ts`、`compaction.test.ts`

**Interfaces:**
- Consumes: 阶段 1–12 的 loop、hooks、事件与工具执行 API。
- Produces: 1.2 的 `AgentTurnState` / `AgentTurnOptions` / `AgentTurnResult` / `prepareAgentTurn` / `runAgentTurn`；`agentLoop` 包根签名不变。

- [ ] **Step 1: 先运行现有行为基线**

Run: `pnpm --filter @mini-agent/core exec vitest run test/agent-loop.test.ts test/agent.test.ts test/finish-turn.test.ts test/prepare-next-turn.test.ts test/compaction.test.ts`
Expected: 全部 PASS；若有失败，先停止并确认是否与工作区无关改动有关，不把旧失败当作本阶段预期。

- [ ] **Step 2: 原样提取实现**

将 `AgentLoopOptions` 移到 `agent-options.ts` 并在旧位置 re-export。`agentLoop` 仍解析默认 streamFn/tools/maxTurns、持有 `overflowRecovered` 和 `newMessages`，每轮调用 `runAgentTurn` 后递增 `state.turn`。

`prepareAgentTurn` 对应现 `agent-loop.ts:77-155`；`runAgentTurn` 对应 `:157-259`。保留所有事件顺序、错误文本、turn_end 时机、terminate 优先级、afterToolCall、截断保护、overflow 只恢复一次及 abort 收尾。此任务不添加队列字段或新行为。

- [ ] **Step 3: 运行相同测试确认无回归**

Run: 同 Step 1。
Expected: 与基线完全相同的测试数和结果，不修改既有断言来适应事件变化。

- [ ] **Step 4: 全量 core 回归与文件大小检查**

Run: `pnpm --filter @mini-agent/core run test && pnpm --filter @mini-agent/core run check && wc -l packages/core/src/agent-loop.ts packages/core/src/agent-turn.ts packages/core/src/prepare-agent-turn.ts`
Expected: 全绿；三个 loop 相关文件各 `< 200` 行。若超限，按现有职责继续拆纯辅助函数，不把逻辑塞回 `agent-loop.ts`。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-options.ts packages/core/src/agent-loop.ts packages/core/src/prepare-agent-turn.ts packages/core/src/agent-turn.ts packages/core/src/index.ts
git commit -m "refactor(stage-13): extract single-turn loop machinery" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `Agent.steer()` 与内层 steering 循环

**Files:**
- Modify: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-steering.test.ts`

**Interfaces:**
- Consumes: Task 1 的 steering queue；Task 2 的 `runAgentTurn` 和 `AgentTurnState`。
- Produces: `Agent.steer(prompt, mode?)`；`AgentLoopOptions.steeringQueue`。Task 5 的 session 转发依赖此 API。

- [ ] **Step 1: 写 steering 时机与事件测试**

使用 echo 工具和脚本 `[toolCall("c1"), "middle", "final"]`。在第一次 `tool_execution_end` listener 中调用 `agent.steer("改这个")`，捕获 provider contexts，断言：

```ts
expect(contexts).toHaveLength(2);
expect(agent.state.messages.map((m) => m.role)).toEqual([
	"system", "user", "assistant", "toolResult", "user", "assistant",
]);
expect(contexts[1]!.messages.at(-1)).toMatchObject({
	role: "user", content: [{ type: "text", text: "改这个" }],
});
expect(events.filter((e) => e.type === "agent_start")).toHaveLength(1);
expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
```

另断言第一个 `turn_end` 早于 steering user 的 `message_start`，且 steering user 早于第二次 provider 调用；`agent_end.messages` 含这条 steering user。

- [ ] **Step 2: 写 QueueMode、空输入和生命周期测试**

- 两条默认 steering 在两个检查点分别注入，三次 provider context 的最后一条新 user 依次是 `"one"` / `"two"`。
- 无工具脚本 `["first", "second"]` 中，在第一轮 `message_update` 时 steer：第一轮仍完整结束，但不得直接 `agent_end`；第二次 provider context 必须含该 steering user。
- 一次 `steer("one", "all")` 后再 `steer("two")`，下一次请求前按 FIFO 注入两条 user。
- active run 中 `steer("   ")` 不增加消息。
- idle 时 `steer("x")` 抛 `/Cannot steer.*active run/`；`agent_end` listener 中的迟到调用也抛错，但不能使 `prompt()` reject（测试捕获该错误，不向 listener 外抛）。

- [ ] **Step 3: 运行新测试确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/agent-steering.test.ts`
Expected: FAIL — `agent.steer is not a function`，且队列尚未进入 loop。

- [ ] **Step 4: 实现公开 API 与内层循环**

`Agent` 持有 `steeringQueue` 和 `acceptingQueueMessages`。prompt 开始允许入队，`deliverEvent(agent_end)` 在调用 listener 前停止接受，finally 清队列。非空白 steer 构造 `{ role: "user", content: [{ type: "text", text: prompt }] }` 后入队。

`agentLoop` 改为以 `state.turn` 为全局预算的内层 while：每次 `runAgentTurn` 后，terminal 直接结束；否则先 drain steering，有消息则在下一 `turn_start` 后逐条 emit 并 append，再继续内层。只有没有 steering 且单轮结果为 stop 时才允许结束；follow-up 在 Task 4 才接。

- [ ] **Step 5: 运行新旧测试**

Run: `pnpm --filter @mini-agent/core exec vitest run test/agent-steering.test.ts test/agent-loop.test.ts test/agent.test.ts test/finish-turn.test.ts && pnpm --filter @mini-agent/core run check`
Expected: 全绿；无队列的既有事件序列不变。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent-options.ts packages/core/src/agent-loop.ts packages/core/src/agent.ts packages/core/src/index.ts packages/core/test/agent-steering.test.ts
git commit -m "feat(stage-13): steer the next model turn" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `Agent.followUp()` 与外层循环

**Files:**
- Modify: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-follow-up.test.ts`

**Interfaces:**
- Consumes: Task 1 的 follow-up queue；Task 2 的 `AgentTurnResult`；Task 3 的入队生命周期。
- Produces: `Agent.followUp(prompt, mode?)`；`AgentLoopOptions.followUpQueue`；完整双层 loop。

- [ ] **Step 1: 写正常 follow-up 与双层循环验收**

脚本 `["first", "second"]`，在第一次 `turn_end` listener 中调用 `followUp("再跑个测试")`。断言 provider 调用 2 次、同一 run 只有一对 agent 事件、最终历史为 `system,user,assistant,user,assistant`，第二个 context 含 follow-up，且其 message_end 在唯一 `agent_end` 前。

再加 `finishTurn: () => ({ action: "end" })` 的独立用例：即使第一轮被要求 end，已排队 follow-up 仍让外层重进内层并调用第二次模型。这对应 spec 验收 #2/#3。

- [ ] **Step 2: 写 steering/follow-up 区别测试**

脚本 `[toolCall("c1"), "middle", "final"]`，第一次 `tool_execution_end` 时只调用 `followUp("later")`。第二次 provider context 不得含 `"later"`；第二轮正常停止后外层才注入它，第三次 context 必须含它。证明 follow-up 不抢在工具驱动的下一轮之前。

- [ ] **Step 3: 写硬停、迟到输入与全局预算测试**

分别覆盖：

1. `terminate: true`、provider error、abort：turn_end 时排入 follow-up，provider 不再被调用，history 不含该 follow-up；随后一次新 prompt 的 context 也不含旧输入。
2. `maxTurns: 2`，第一轮后排入一个 follow-up：第二轮结束后外层尝试续 run，但第三次 provider 请求被预算阻止；最终 assistant 为 `stopReason: "error"` 且文本含 `maxTurns (2)`，provider spy 恰好 2 次。
3. 最终 `agent_end` listener 中及 idle 后的非空白 followUp 均抛 `/Cannot followUp.*active run/`；空白输入 no-op。

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/agent-follow-up.test.ts`
Expected: FAIL — `agent.followUp is not a function`，且外层尚不能续 run。

- [ ] **Step 5: 实现外层 follow-up 循环**

内层只在 `runAgentTurn` 返回 stop 且 steering 已排空时退出。外层随后 drain follow-up：为空才发最终 `agent_end`；非空则在下一 outer segment 的 `turn_start` 后逐条 append/emit，再重进内层。`state.turn` 与 `overflowRecovered` 不重置。terminal 不经过 follow-up drain；maxTurns 抛出后不得继续 drain 或消费后续队列。

- [ ] **Step 6: 全量 core 回归**

Run: `pnpm --filter @mini-agent/core run test && pnpm --filter @mini-agent/core run check`
Expected: 全绿；既有 `finishTurn`、overflow、abort 和 listener settle 测试无回归。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent-options.ts packages/core/src/agent-loop.ts packages/core/src/agent.ts packages/core/src/index.ts packages/core/test/agent-follow-up.test.ts
git commit -m "feat(stage-13): continue normal stops with follow-up messages" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `AgentSession` 转发与插话持久化

**Files:**
- Modify: `packages/core/src/agent-session.ts`
- Test: `packages/core/test/session-queued-messages.test.ts`

**Interfaces:**
- Consumes: Task 3/4 的 `Agent.steer` / `followUp`；既有 `message` / `submission` journal entries 和 `messagesFromSessionPath`。
- Produces: 同签名 `AgentSession.steer()` / `followUp()`；同 run 后续 user 的 durable replay。

- [ ] **Step 1: 写 session reopen 失败测试**

在临时目录创建 session，脚本 `[toolCall("c1"), "middle", "final"]`。第一次 `tool_execution_end` 调 `session.steer("change")`，第二次 `turn_end` 调 `session.followUp("again")`，然后 await `submit({ requestId: "r1", prompt: "go" })`。

用相同 tools/streamFn `AgentSession.open({ path, ... })` 重开，断言：

```ts
expect(reopened.state.messages.map((m) => m.role)).toEqual([
	"system", "user", "assistant", "toolResult", "user", "assistant",
	"user", "assistant",
]);
expect(userTexts(reopened.state.messages)).toEqual(["go", "change", "again"]);
expect(reopened.entries.filter((e) => e.type === "submission")).toHaveLength(1);
expect(reopened.entries.filter((e) => e.type === "run_end")).toHaveLength(1);
```

直接检查 journal：初始 `"go"` 只能来自 submission，不得另有重复 user message entry；`"change"` / `"again"` 各有一条 `type: "message"`。另测 idle 时两个 API 都抛 active-run 错误。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/session-queued-messages.test.ts`
Expected: FAIL — session 没有 steer/followUp；若只临时转发 API，reopen 仍因缺 user message entries 失败。

- [ ] **Step 3: 实现转发和 user 持久化**

两个 session 方法仅委托当前 agent，不建立第二份队列。`runSubmission` 在 `agent.prompt()` 前设置 `skipNextSubmissionUser = true`，finally 复位。`persistEvent(message_end)` 遇到首个 user 时清除标记并保持旧的 submission 去重行为；同 run 后续 user 一律 `journal.append({ type: "message", message })`。不改 session version、entry union 或 Web protocol。

- [ ] **Step 4: 运行 session 与全套测试**

Run: `pnpm --filter @mini-agent/core exec vitest run test/session-queued-messages.test.ts test/agent-session.test.ts test/session-context.test.ts test/session-recovery.test.ts && pnpm test && pnpm check`
Expected: 全绿；旧 submission 重建不重复，新增 user 可 replay；protocol/server/web 零改动也通过。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-session.ts packages/core/test/session-queued-messages.test.ts
git commit -m "feat(stage-13): persist queued session messages" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: `runToolCall()` 独立入口

**Files:**
- Create: `packages/core/src/run-tool-call.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/run-tool-call.test.ts`

**Interfaces:**
- Consumes: 既有 `prepareToolCall`、`executePreparedToolCall`、`finalizeToolCall`、`applyAfterToolCall`、`toolCallContext`。
- Produces: 1.3 的 `RunToolCallOptions` / `runToolCall`，返回与批处理相同的 `FinalizedToolCallOutcome`。

- [ ] **Step 1: 写无事件、无历史与完整管道测试**

成功用例的 tool 在 execute 中调用一次 `onUpdate`，messages 为含一条 user 的数组。把额外 `emit` spy 放在单独的 options 变量中，避免对象字面量的 excess-property 检查；实现仍必须忽略它。断言：

```ts
const before = structuredClone(messages);
const optionsWithEmit = { ...options, emit };
const outcome = await runToolCall(call, optionsWithEmit);
expect(emit).not.toHaveBeenCalled();
expect(messages).toEqual(before);
expect(outcome.result).toMatchObject({ isError: false });
expect(outcome.message).toMatchObject({ role: "toolResult", toolCallId: "c1" });
expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
```

另覆盖：unknown/invalid/blocked 时 execute 不运行且返回 `isError: true`；工具抛错转成错误结果；afterToolCall 同时改写 result/message；预先 aborted 时 execute 不运行且文本为 `"Operation aborted"`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/run-tool-call.test.ts`
Expected: FAIL — 找不到 `../src/run-tool-call.ts`。

- [ ] **Step 3: 实现单工具执行**

记录 `startedAt = performance.now()`，调用 prepare；prepared 分支直接 execute（onUpdate sink 为空函数），immediate 分支跳过 execute；随后走同一 finalize 和 afterToolCall。不要调用 `executeToolCalls`，因为它会发 start/end/message 事件；不要添加 commitToolIntent 或写 options.messages。

- [ ] **Step 4: 运行测试与 core 回归**

Run: `pnpm --filter @mini-agent/core exec vitest run test/run-tool-call.test.ts test/tool-call.test.ts test/execute-tool-calls.test.ts test/after-tool-call.test.ts && pnpm --filter @mini-agent/core run check`
Expected: 全绿；既有批处理顺序语义不变。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run-tool-call.ts packages/core/src/index.ts packages/core/test/run-tool-call.test.ts
git commit -m "feat(stage-13): run one tool without emitting history" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 隔离的子 Agent 委派工具

**Files:**
- Create: `packages/core/src/subagent-tool.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/subagent-tool.test.ts`

**Interfaces:**
- Consumes: `Agent`、`ToolDef`、`StreamFn`；子工具内部仍使用普通 Agent loop，不需要把子事件接到父。
- Produces: 1.3 的 `SubagentToolOptions` / `createSubagentTool`，默认工具名 `delegate`。

- [ ] **Step 1: 写父子 N 轮隔离验收**

父脚本为 `[delegate(task=" investigate "), "parent done"]`；子脚本为 `[echo(toolCall), "child final"]`。父只注册 delegate，子只注册 echo。await 父 prompt 后断言：

```ts
expect(parent.state.messages.map((m) => m.role)).toEqual([
	"system", "user", "assistant", "toolResult", "assistant",
]);
expect(parentToolResultText(parent.state.messages)).toBe("child final");
expect(parent.state.messages.some((m) =>
	m.role === "toolResult" && m.toolName === "echo"
)).toBe(false);
expect(parentEvents.filter((e) => e.type === "tool_execution_start")
	.map((e) => e.toolName)).toEqual(["delegate"]);
```

捕获子的首次 provider context：只能含子的 system 与 task user，不含父 prompt/history；tools 只有 echo，不含 delegate。子必须实际跑过 echo + 最终回答两轮，而不是由父工具伪造文本。

- [ ] **Step 2: 写新实例、错误与 abort 测试**

- 同一 delegate 连续 execute 两次，第二次子的初始 context 不含第一次的 child final。
- 子最后 assistant 为 error 时，delegate 返回 `isError: true` 并保留 errorMessage/text；空白 task 返回 `isError: true`，不调用 child provider。
- 用 deferred 等子 provider 开始后 abort 父 signal：子 stream 收到 abort，delegate 返回 `isError: true`，无文本时返回 `"Operation aborted"`；abort listener 必须移除。
- 断言 `delegate.replay === "unsafe"`，防止崩溃恢复自动重跑整个子任务。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/subagent-tool.test.ts`
Expected: FAIL — 找不到 `../src/subagent-tool.ts`。

- [ ] **Step 4: 实现委派工具**

每次 execute 新建 `Agent({ system, messages: [], streamFn, tools: [...childTools], maxTurns })`。默认 childTools 为 `[]`，不自动继承父工具或 delegate。用父 signal 的 abort listener 调 `child.abort()`，finally 移除；await `child.prompt(task)` 后取最后一个 assistant，拼接其中 text blocks。error/aborted/length 标记 isError，文本依次取 text、errorMessage、aborted 时的 `"Operation aborted"`。不转发 child event，不把 child messages 加进父数组。

- [ ] **Step 5: 运行测试和全量 core 回归**

Run: `pnpm --filter @mini-agent/core exec vitest run test/subagent-tool.test.ts test/agent-follow-up.test.ts && pnpm --filter @mini-agent/core run test && pnpm --filter @mini-agent/core run check`
Expected: 全绿；父历史只有 delegate 结果，abort 后无遗留 child run。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/subagent-tool.ts packages/core/src/index.ts packages/core/test/subagent-tool.test.ts
git commit -m "feat(stage-13): delegate tasks to isolated subagents" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: 阶段文档与整体验收

**Files:**
- Create: `docs/stages/13-subagents-and-steering.md`

**Interfaces:**
- Consumes: Task 1–7 的实现与测试证据。
- Produces: spec §7.4 要求的阶段学习文档；不写实现代码，不新增 teaching HTML。

- [ ] **Step 1: 写阶段文档**

包含：这个阶段解决的问题；Pi 的双层 loop / PendingMessageQueue / runToolCall / 子 Agent 隔离决策；共享 messages、单队列、递归调用 runToolCall 代替 loop、直接转发子事件等替代方案为何更差；steer 与 followUp 的时序表；全局 maxTurns；硬停优先级；session user 持久化；非目标；源码行数与既有超限债务；至少五个回测问题。

- [ ] **Step 2: 对照 spec 五项验收逐项核实**

确认测试分别证明：

1. steer 在当前 turn 后、下一 provider 前进入 context。
2. followUp 在唯一 agent_end 前注入并延续同一 run。
3. `finishTurn: end` 后 followUp 能经外层循环重启内层。
4. 子 Agent 独立跑 N 轮，父只收最终文本且无子的中间消息。
5. runToolCall 走同一工具管道但不发事件、不改消息历史。

- [ ] **Step 3: 运行最终验证**

```bash
pnpm test
pnpm check
pnpm list -r --depth 0 --prod
wc -l packages/core/src/pending-message-queue.ts packages/core/src/agent-loop.ts packages/core/src/prepare-agent-turn.ts packages/core/src/agent-turn.ts packages/core/src/run-tool-call.ts packages/core/src/subagent-tool.ts
git diff --numstat master...HEAD -- packages/core/src
git diff --check
```

Expected: 全部测试和 8 个 package 的 TypeScript 检查通过；core 无新增 runtime dependency；新增/拆出的六个文件各 `< 200` 行；`git diff --numstat` 的 additions − deletions `< 400` 且阶段文档记录实际值；无 whitespace error。真实 provider 不作为 CI 验收；若手动联调，记录实际模型与结果，不把未运行的联调写成已通过。

- [ ] **Step 4: Commit**

```bash
git add docs/stages/13-subagents-and-steering.md
git commit -m "docs(stage-13): explain isolated agents and queued interruptions" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 5: 最终审查边界**

运行 fresh whole-branch review，Critical/Important finding 必须先用回归测试复现再修复。确认 `packages/ai`、`packages/protocol`、`packages/server`、`packages/web`、`packages/cli` 没有阶段 13 实现改动，journal version 未变；执行工作树干净，原工作区的无关改动未被触碰。
