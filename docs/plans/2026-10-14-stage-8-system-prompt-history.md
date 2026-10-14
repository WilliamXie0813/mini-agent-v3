# 阶段 8「System prompt 即历史」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 system prompt 与模型可见工具集从易变参数改成 append-only transcript 中的 `SystemMessage` 增量记录，并在每次请求前通过重放得到当前状态。

**Architecture:** `AgentOptions.system` 继续作为新会话的组装层简写，但 `AgentState.messages` 中的 system 历史才是唯一权威来源。`agentLoop` 每轮从 transcript 重放出当前 system 快照与工具声明，再构造既有 `StreamContext`；`AgentState.tools` 只保留可执行的 `ToolDef` 注册表，不再充当模型可见工具集的第二份真相。

**Tech Stack:** Node 22+、TypeScript 5.9.3（`strict` + `erasableSyntaxOnly`）、pnpm workspaces、vitest 3、Anthropic Messages SSE 适配器。零新增运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md` §3.2(b)、§5 阶段 8、§7.1–7.4；前置实现见 `docs/stages/07-anthropic-sse.md`。

## Global Constraints

- **只加一个新概念**：`SystemMessage` 增量历史与重放。不得提前实现阶段 9 的 JSONL/session tree、阶段 10 的压缩 entry 或阶段 11 的扩展注册系统。
- **先写测试，再写实现**；阶段结束时 `pnpm test` 与 `pnpm check` 全绿。
- **源码总量增量 < 400 行**，目标约 250 行；每个 `src` 文件 < 200 行。
- **零新增运行时依赖**；重放、声明比较与复制使用语言/Node 标准能力。
- tab 缩进；ESM；包内相对导入带 `.ts` 后缀；跨包用包名；类型导入使用 `import type`。
- `strict: true`、`erasableSyntaxOnly: true`；禁止 `enum`、构造函数参数属性与 `namespace`。
- 本阶段严格采用已批准 spec 的简化形状：

```ts
export interface SystemSection {
	tag?: string;
	text: string;
}

export interface SystemMessage {
	role: "system";
	sections: SystemSection[];
	toolsAdded?: Tool[];
	toolsRemoved?: string[];
}
```

- 不照搬 Pi 后续版本的 `content`、命名 section patch、timestamp、`ToolReference` 或 branded context；这些不在本项目已批准的阶段 8 范围内。
- section 按 transcript 顺序只追加，不覆盖旧 section；`tag` 作为元数据原样保留，不自动写入 prompt 文本。wire system 文本只把非空 `section.text` 用 `"\n\n"` 连接。
- 同一条 system message 中先应用 `toolsRemoved`，再应用 `toolsAdded`；这样同名工具定义变化可表示为 remove + add。
- 所有旧 `SystemMessage`、section、tool declaration 都是 append-only 输入；重放和 diff helper 不得原地修改它们。
- `StreamContext` 保留当前公共形状 `{ system, messages, tools }`，但 `system` 与 `tools` 必须由 transcript 重放产生，不能直接从 `Agent` 字段复制。
- `AgentState.tools` 是执行注册表；provider 可见工具与本轮允许执行的工具都以重放结果为准。已从 transcript 移除的工具即使闭包仍在注册表里，也不能执行。
- 初始 system message 在 run 开始前写入 state，不发 `AgentEvent`；`agent_end.messages` 继续只包含本次 run 新增的 user/assistant/toolResult，不包含旧 system 历史。
- Anthropic wire 仍使用顶层 `system: string` 与 `tools`；transcript 中所有 system entries 不进入 wire `messages`。
- 相同 prompt、相同工具声明、相同历史重复请求时，不得追加 system message；稳定前缀是 prompt cache 能命中的前提。
- 执行时必须精确暂存，不得改动或夹带当前既有的 Stage 7 教学工作树变更：`docs/stages/07-anthropic-sse-explained.html`、`docs/stages/07-anthropic-sse.md`、`docs/stages/07-anthropic-state-machine-explained.html`、`packages/ai/test/state-machine-teaching.test.ts`。

## Review Focus

1. **已有 transcript 恢复**：`Agent` 收到已经包含 system entries 的 `messages` 时不能再 prepend 一份初始 prompt/tool 声明。→ Task 3。
2. **工具定义变化而非对象身份变化**：同内容的新对象不产生 delta；同名工具的 description/schema 变化必须产生 remove + add。→ Tasks 1、4。
3. **移除后的工具不能执行**：注册表里仍有闭包也不能让 provider 看见或让伪造/旧 toolCall 执行。→ Task 3。
4. **裁剪不能破坏重放**：丢弃旧 conversation messages、保留全部 system entries 后，prompt 与工具状态必须完全一致。→ Task 1。
5. **cache 前缀稳定**：连续两次 prompt 与重复设置等价工具都不能新增 system entry；section/tool 顺序必须确定。→ Tasks 3–5。

---

## 1. 当前改写面与锁定接口

当前直接持有或读取 `system: string` 的位置：

| 文件 | 当前行为 | 阶段 8 改写 |
|---|---|---|
| `packages/ai/src/types.ts` | `SystemMessage.content: string` | 改为 `sections` + tool deltas |
| `packages/ai/src/anthropic-messages.ts` | 直接读 `context.system.content` | 渲染重放后的 system snapshot |
| `packages/core/src/agent-options.ts` | `AgentOptions.system: string` | 保留为新会话简写，并补清晰语义注释 |
| `packages/core/src/agent.ts` | 私有保存 `system` 字符串 | 移除第二份状态；初始消息写入 transcript |
| `packages/core/src/agent-loop.ts` | 每轮重新包装 `{ role:"system", content }` | 从 `messages` 重放 `system` 与 active tools |
| ai/core 测试与 CLI | 构造 string system 或假设历史无 system | 改为 transcript 语义并保留既有行为断言 |

新增文件职责：

| 文件 | 职责 |
|---|---|
| `packages/ai/src/transcript.ts` | system 初始消息、prompt/tool 重放、工具声明 diff |
| `packages/ai/test/transcript.test.ts` | 增量、裁剪、声明变化、不可变性测试 |
| `docs/stages/08-system-prompt-history.md` | 阶段 8 教学主文档 |

共享签名如下；各任务不得自行另起同义 API：

```ts
// packages/ai/src/types.ts
export interface SystemSection {
	tag?: string;
	text: string;
}

export interface SystemMessage {
	role: "system";
	sections: SystemSection[];
	toolsAdded?: Tool[];
	toolsRemoved?: string[];
}

// StreamContext 形状不变，但字段语义变为 replay snapshot。
export interface StreamContext {
	system: SystemMessage;
	messages: Message[];
	tools: Tool[];
}

// packages/ai/src/transcript.ts
export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: string[];
}

export function createInitialSystemMessage(
	systemPrompt: string,
	tools?: readonly Tool[],
): SystemMessage | undefined;

export function getCurrentSystemMessage(
	messages: readonly Message[],
): SystemMessage;

export function getCurrentSystemPrompt(
	messages: readonly Message[],
): string;

export function getCurrentTools(
	messages: readonly Message[],
): Tool[];

export function getToolStateChanges(
	previous: readonly Tool[],
	current: readonly Tool[],
): ToolStateChanges;

export function toolDeclarationsEqual(
	left: Tool,
	right: Tool,
): boolean;

// packages/core/src/agent.ts
export class Agent {
	appendSystemSections(sections: readonly SystemSection[]): void;
	setTools(tools: ToolDef<any>[]): void;
}
```

`getCurrentSystemMessage()` 在没有 system entries 时返回 `{ role: "system", sections: [] }`，避免每个 provider 调用点重复处理 `undefined`。其 snapshot 只包含累计 sections 与当前 `toolsAdded`，不携带已消费的 `toolsRemoved`。

`AgentOptions.system` 继续是必填 string，以保持 CLI/使用方简洁。若 `messages` 已包含任意 system entry，则该 transcript 是权威，构造器不得再插入 `options.system`；阶段 9 resume 可直接复用这一规则。

---

### Task 1: 建立 SystemMessage IR 与纯重放函数

**Files:**
- Modify: `packages/ai/src/types.ts`
- Create: `packages/ai/src/transcript.ts`
- Modify: `packages/ai/src/index.ts`
- Create: `packages/ai/test/transcript.test.ts`

**Interfaces:**
- Produces: `SystemSection`、新 `SystemMessage`、`ToolStateChanges` 与上节全部 transcript helper。
- Consumers: Tasks 2–4 的 provider、loop、Agent state。

- [ ] **Step 1: 写失败测试 `replays_sections_and_tool_deltas_in_transcript_order`**

构造：

```ts
const read = {
	name: "read",
	description: "read a file",
	parameters: { type: "object" },
};
const edit = {
	name: "edit",
	description: "edit a file",
	parameters: { type: "object" },
};
const messages: Message[] = [
	{
		role: "system",
		sections: [{ tag: "base", text: "You are a coding agent." }],
		toolsAdded: [read],
	},
	{ role: "user", content: [{ type: "text", text: "hello" }] },
	{
		role: "system",
		sections: [{ tag: "workspace", text: "Work only in this repository." }],
		toolsRemoved: ["read"],
		toolsAdded: [edit],
	},
];
```

断言：

```ts
expect(getCurrentSystemPrompt(messages)).toBe(
	"You are a coding agent.\n\nWork only in this repository.",
);
expect(getCurrentTools(messages)).toEqual([edit]);
expect(getCurrentSystemMessage(messages)).toEqual({
	role: "system",
	sections: [
		{ tag: "base", text: "You are a coding agent." },
		{ tag: "workspace", text: "Work only in this repository." },
	],
	toolsAdded: [edit],
});
```

另覆盖：未知 `toolsRemoved` 是 no-op；同一消息 remove + add 同名工具时新定义生效；非 system 消息不影响重放。

- [ ] **Step 2: 写失败测试 `computes_minimal_model_visible_tool_changes`**

覆盖：

1. `previous` 与结构相同但引用不同的 `current` → 两个数组都空；
2. 新增工具 → 只在 `toolsAdded`；
3. 删除工具 → 只在 `toolsRemoved`；
4. 同名 description/schema 变化 → 同时 remove 旧名字并 add 新定义；
5. 输出 declaration 与输入不共享可变 `parameters` 引用。

`toolDeclarationsEqual()` 比较 model-visible 的 `name`、`description`、`parameters`；不得把 `ToolDef.execute`、`replay` 或 `executionMode` 混入声明比较。

- [ ] **Step 3: 写失败测试 `preserves_replay_after_conversation_trimming`**

在两个 system entries 之间插入多轮 user/assistant/toolResult。模拟裁剪时只删除早期 conversation entries，保留所有 system entries与最近一轮：

```ts
const trimmed = transcript.filter(
	(message, index) => message.role === "system" || index >= recentCut,
);
expect(getCurrentSystemPrompt(trimmed)).toBe(getCurrentSystemPrompt(transcript));
expect(getCurrentTools(trimmed)).toEqual(getCurrentTools(transcript));
```

这只是阶段 8 的纯函数验收，不创建 compaction entry、不做 token 阈值或摘要。

- [ ] **Step 4: 写不可变性与空输入测试**

冻结输入 transcript 后调用所有 helper 两次，断言输入未变且输出一致。空 transcript 应得到：

```ts
expect(getCurrentSystemMessage([])).toEqual({
	role: "system",
	sections: [],
});
expect(getCurrentSystemPrompt([])).toBe("");
expect(getCurrentTools([])).toEqual([]);
```

空 section 不进入拼接结果，section 自身的前后空白不被 trim。

- [ ] **Step 5: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/ai test -- transcript
```

Expected: `transcript.ts`/新类型/导出不存在而 FAIL。

- [ ] **Step 6: 实现类型与纯函数**

实现约束：

- `createInitialSystemMessage("", [])` 返回 `undefined`；有 prompt 或 tools 时返回一条 leading system message。
- tool declaration 复制只保留 `name`、`description`、`parameters`，`parameters` 用 `structuredClone`。
- `getCurrentTools()` 使用 name-keyed `Map`，按首次/重新加入顺序输出；每条消息先 delete 再 set。
- `getCurrentSystemPrompt()` 只连接非空 section text，不自动渲染 tag。
- 所有 helper 只读输入，返回新数组/对象。

- [ ] **Step 7: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/ai test -- transcript
pnpm --filter @mini-agent/ai check
```

Expected: PASS。

Commit:

```bash
git add packages/ai/src/types.ts packages/ai/src/transcript.ts \
  packages/ai/src/index.ts packages/ai/test/transcript.test.ts
git commit -m "feat(stage-8): replay system prompt and tool history"
```

---

### Task 2: 让 Anthropic 请求消费重放后的 system snapshot

**Files:**
- Modify: `packages/ai/src/anthropic-messages.ts`
- Modify: `packages/ai/test/anthropic-messages.test.ts`
- Modify: `packages/ai/test/anthropic.test.ts`
- Modify: `packages/ai/test/fake.test.ts`
- Modify: `packages/core/test/stream-assistant.test.ts`

**Interfaces:**
- Consumes: Task 1 的新 `SystemMessage` 与 replay helper。
- Produces: wire body 仍为 Anthropic 的 `system: string`、top-level `tools` 与无 system role 的 `messages`。

- [ ] **Step 1: 改写请求转换失败测试**

在 `anthropic-messages.test.ts` 用两条 system 历史构造 replay snapshot：

```ts
const transcript: Message[] = [
	{ role: "system", sections: [{ text: "base" }], toolsAdded: [read] },
	{ role: "user", content: [text("go")] },
	{ role: "system", sections: [{ text: "extra" }], toolsRemoved: ["read"], toolsAdded: [edit] },
];
const context: StreamContext = {
	system: getCurrentSystemMessage(transcript),
	messages: transcript,
	tools: getCurrentTools(transcript),
};
```

精确断言：

```ts
expect(toAnthropicRequest(context, settings)).toMatchObject({
	system: "base\n\nextra",
	tools: [{
		name: "edit",
		description: "edit a file",
		input_schema: { type: "object" },
	}],
	messages: [{ role: "user", content: [text("go")] }],
});
```

保留 Stage 7 的 mixed content、连续 toolResult 合并、interrupted tool pairing 与输入不可变性断言。

- [ ] **Step 2: 更新 HTTP body 与所有 AI StreamContext fixtures**

`anthropic.test.ts` 的 shared context 改为 `sections` 形状，并继续断言 POST body 的 system 文本为 `"test system"`。`fake.test.ts` 与 `stream-assistant.test.ts` 的手工 context 同样改形状；不得用 `as any` 绕过迁移。

新增 HTTP body 断言：`messages` 中即使存在多条 system entries，wire `messages` 也不包含 role system，且请求不出现 `sections`、`toolsAdded`、`toolsRemoved` 内部字段。

- [ ] **Step 3: 跑定向测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic-messages anthropic fake
pnpm --filter @mini-agent/core test -- stream-assistant
```

Expected: `content` 字段类型与 system 渲染断言 FAIL。

- [ ] **Step 4: 修改 Anthropic 转换**

`toAnthropicRequest()`：

- 从 `context.system.sections` 读取 text，过滤空 text 后以 `"\n\n"` 连接；
- `context.tools` 仍映射为 top-level `tools`；
- 遍历 `context.messages` 时继续跳过所有 system entries；
- 不在 provider 层重新解释 `toolsAdded/toolsRemoved`，因为 loop 已提供 replay snapshot；
- 不修改 Stage 7 的错误/中断历史修复逻辑。

- [ ] **Step 5: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic-messages anthropic fake
pnpm --filter @mini-agent/core test -- stream-assistant
pnpm --filter @mini-agent/ai check
pnpm --filter @mini-agent/core check
```

Expected: PASS。

Commit:

```bash
git add packages/ai/src/anthropic-messages.ts \
  packages/ai/test/anthropic-messages.test.ts \
  packages/ai/test/anthropic.test.ts packages/ai/test/fake.test.ts \
  packages/core/test/stream-assistant.test.ts
git commit -m "feat(stage-8): render replayed system state for Anthropic"
```

---

### Task 3: 让 Agent 与 loop 以 transcript 为唯一 system 真相

**Files:**
- Modify: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent-state.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/agent.test.ts`
- Modify: `packages/core/test/anthropic-integration.test.ts`

**Interfaces:**
- `AgentOptions.system: string` 保留。
- `AgentLoopOptions.system` 删除。
- `AgentState.messages` 从构造完成起就是完整 transcript，可包含 leading/later system entries。
- provider context 与本轮 active executable tools 均从 transcript replay 导出。

- [ ] **Step 1: 写 Agent 初始历史与 resume 失败测试**

新增：

```ts
it("stores one leading system message and never duplicates it across prompts", async () => {
	const agent = new Agent({
		system: "base",
		tools: [echoTool],
		streamFn: createFakeStreamFn(["one", "two"]),
	});
	await agent.prompt("first");
	await agent.prompt("second");
	expect(agent.state.messages.filter((message) => message.role === "system"))
		.toEqual([{
			role: "system",
			sections: [{ text: "base" }],
			toolsAdded: [expect.objectContaining({ name: "echo" })],
		}]);
});
```

另测：传入已含两条 system entries 的 `messages`，构造后数量仍为 2，`options.system` 不被 prepend；外部原数组保持不变。

- [ ] **Step 2: 写 loop replay 与 active tool 失败测试**

修改 `agent-loop.test.ts` 的 `base()`，让 `messages` 初始含：

```ts
createInitialSystemMessage("you are a test", [])!
```

用 spy `StreamFn` 捕获 context，断言：

1. `context.system` 是累计 snapshot；
2. `context.tools` 是 toolsAdded/toolsRemoved 后的当前声明；
3. `context.messages` 保留原始多条 system history，供阶段 9 持久化；
4. 两轮工具循环的每次 provider 调用都重新从当前 transcript 派生。

再构造 transcript：先 add `echo`，后 remove `echo`，但 `options.tools` 注册表仍含 `echoTool`。让 fake provider 返回 `echo` toolCall，断言 execute spy 为 0，历史得到 existing unknown-tool error result，而不是执行已移除闭包。

- [ ] **Step 3: 更新既有历史/长度断言**

所有过去只统计 conversation messages 的测试要明确表达语义：

- 若验证完整 transcript，期望 roles 以 `"system"` 开头；
- 若验证一轮对话，先过滤 `role !== "system"`；
- 已中止 signal/空白 prompt 返回的不是空数组，而是未改变的初始 system transcript；
- listener reject 后 state 仍保留 system + 已完成交付的 user；
- `agent_end.messages` 继续断言不含 system；
- toolResult 的相对顺序与 Stage 6/7 断言不变，不能靠错误 slice 掩盖索引偏移。

- [ ] **Step 4: 跑定向测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-loop agent anthropic-integration
```

Expected: `AgentLoopOptions.system`、历史长度或 context snapshot 断言 FAIL。

- [ ] **Step 5: 初始化 transcript-backed Agent state**

`createAgentState()` 增加 `system` 参数：

1. 复制传入 messages 与 tools；
2. 若 messages 已含任意 system entry，直接保留其历史；
3. 否则调用 `createInitialSystemMessage(system, toToolDeclarations(tools))`，有结果时 prepend；
4. 不修改调用方数组或 ToolDef。

`Agent` 删除 `private readonly system`。构造时只把 system 用于初始化 transcript；`prompt()` 不再向 loop 传字符串。

- [ ] **Step 6: 每轮从 transcript 派生 provider 与 execution 状态**

`agentLoop()` 在调用 `streamFn` 前：

```ts
const currentSystem = getCurrentSystemMessage(options.messages);
const currentTools = getCurrentTools(options.messages);
const activeTools = options.tools.filter((tool) =>
	currentTools.some((declaration) => toolDeclarationsEqual(tool, declaration)),
);
const context: StreamContext = {
	system: currentSystem,
	messages: [...options.messages],
	tools: currentTools,
};
```

`executeToolCalls()` 接收 `activeTools`，而不是完整 registry。unknown/removed/mismatched declaration 继续走既有 model-fixable error 路径。

不能把 replay 结果写回 transcript；snapshot 只存在于本次请求 context。

- [ ] **Step 7: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-loop agent anthropic-integration
pnpm --filter @mini-agent/core check
```

Expected: PASS；Stage 4 的 run-local events、Stage 6 双顺序、Stage 7 error/abort 语义保持。

Commit:

```bash
git add packages/core/src/agent-options.ts packages/core/src/agent-state.ts \
  packages/core/src/agent-loop.ts packages/core/src/agent.ts \
  packages/core/test/agent-loop.test.ts packages/core/test/agent.test.ts \
  packages/core/test/anthropic-integration.test.ts
git commit -m "feat(stage-8): make agent system state transcript-backed"
```

---

### Task 4: 把 prompt/tool 变化记录为增量 system messages

**Files:**
- Modify: `packages/core/src/agent-state.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/test/agent.test.ts`

**Interfaces:**
- Produces: `Agent.appendSystemSections()` 与 `Agent.setTools()`。
- Consumes: Task 1 的 `getCurrentTools()` / `getToolStateChanges()`。

- [ ] **Step 1: 写 append-only prompt 更新失败测试**

```ts
const agent = new Agent({
	system: "base",
	streamFn: captureContexts(["one", "two"]),
});
await agent.prompt("first");
const firstSystem = agent.state.messages[0];
agent.appendSystemSections([{ tag: "workspace", text: "repo only" }]);
await agent.prompt("second");

expect(agent.state.messages.filter((message) => message.role === "system"))
	.toHaveLength(2);
expect(agent.state.messages[0]).toBe(firstSystem);
expect(secondContext.system.sections).toEqual([
	{ text: "base" },
	{ tag: "workspace", text: "repo only" },
]);
```

冻结/外部修改传入 sections 后，历史内容仍保持调用时快照。空数组 no-op。

- [ ] **Step 2: 写工具变化与 cache 稳定失败测试**

覆盖：

1. `setTools([echoTool])` 与当前声明相同 → registry 可更新，但 system 数量不变；
2. 新增 read → 新 system entry 只有 `toolsAdded: [read]`；
3. 删除 echo → 下一条 entry 只有 `toolsRemoved: ["echo"]`；
4. 同名 echo schema/description 改变 → 同一 entry 同时 remove echo + add 新 echo；
5. 只替换 `execute` 闭包、model-visible declaration 不变 → 无 system delta，但下一次调用使用新闭包；
6. 输入 tools 数组后续被清空不影响 state。

- [ ] **Step 3: 写 active-run 保护测试**

用 deferred listener 或 provider 保持 run active；此时调用 `appendSystemSections()` / `setTools()` 都应抛具名错误，且 transcript 与 registry 完全不变。不能让单次 run 的 provider snapshot、工具执行表和历史中途分叉。

- [ ] **Step 4: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent
```

Expected: 两个新方法不存在或未记录 delta 而 FAIL。

- [ ] **Step 5: 实现 state helper 与 Agent 方法**

为保持 `agent.ts` < 200 行，把实际 mutation helper 放在 `agent-state.ts`：

```ts
export function appendSystemSections(
	state: AgentState,
	sections: readonly SystemSection[],
): void;

export function replaceAgentTools(
	state: AgentState,
	tools: ToolDef<any>[],
): void;
```

规则：

- helper 自己复制输入；
- `replaceAgentTools` 先 replay previous declarations，再计算最小 delta；
- delta 两边都空时不 append system message；
- 有变化时 append `{ role: "system", sections: [], ...changes }`；
- 最后替换执行 registry；
- `Agent` 在调用 helper 前检查 `activeRun`，错误信息包含 `active run` 与操作名。

- [ ] **Step 6: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent
pnpm --filter @mini-agent/core check
```

Expected: PASS。

Commit:

```bash
git add packages/core/src/agent-state.ts packages/core/src/agent.ts \
  packages/core/test/agent.test.ts
git commit -m "feat(stage-8): record system and tool changes in history"
```

---

### Task 5: 更新 CLI 与真实 provider 回归

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/ai/test/anthropic-cli.test.ts`
- Modify: `packages/core/test/anthropic-integration.test.ts`

**Interfaces:**
- CLI 继续传 `system: string` 与 executable tools。
- Agent 内部负责生成 leading SystemMessage；CLI 不手工维护 transcript。

- [ ] **Step 1: 写/更新 CLI 子进程失败测试**

保留 Stage 7 的本地 HTTP server + fixtures，不访问外网。断言：

- banner 为 `mini-agent (stage 8) — type /exit to quit`；
- 第一条 HTTP 请求的 `system` 仍是 `"You are a minimal teaching agent."`；
- wire `messages` 第一条是 user，不包含 system role；
- tools 仍只有 model-visible declaration；
- 一次工具调用与第二次最终回复完整收敛。

- [ ] **Step 2: 增加连续请求 cache 稳定集成断言**

用一个 Agent 连续 prompt 两次并收集两个 request body：

```ts
expect(requests[0].system).toBe(requests[1].system);
expect(requests[0].tools).toEqual(requests[1].tools);
expect(agent.state.messages.filter((message) => message.role === "system"))
	.toHaveLength(1);
```

第二次 wire messages 可以包含更多 conversation history，但 leading system text 与 tool declaration 顺序必须相同。

- [ ] **Step 3: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic-cli
pnpm --filter @mini-agent/core test -- anthropic-integration
```

Expected: stage 7 banner、旧历史长度或新 cache 断言 FAIL。

- [ ] **Step 4: 修改 CLI 组装根**

只改阶段标识；system string、provider 配置、SIGINT、错误渲染与工具日志保持不变。不得让 CLI 自己创建 `SystemMessage`，否则新会话规范化会在多个组装点复制。

- [ ] **Step 5: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic-cli
pnpm --filter @mini-agent/core test -- anthropic-integration
pnpm --filter @mini-agent/cli check
```

Expected: PASS。

Commit:

```bash
git add packages/cli/src/index.ts packages/ai/test/anthropic-cli.test.ts \
  packages/core/test/anthropic-integration.test.ts
git commit -m "feat(stage-8): wire transcript-backed prompts through the CLI"
```

---

### Task 6: 阶段文档、全量验收与边界检查

**Files:**
- Create: `docs/stages/08-system-prompt-history.md`

**Interfaces:**
- Consumes: Tasks 1–5 的实现与测试。
- Produces: 阶段 8 学习主文档；不代替用户写回测答案。

- [ ] **Step 1: 写阶段文档**

沿用既有四段结构：

1. **这个阶段解决了什么问题**：string 参数在 resume、prompt cache、动态工具三处产生第二份易变状态。
2. **Pi 的哪条决策是答案**：system/tool changes 是 transcript entries；读取当前状态需要 O(n) replay。
3. **替代方案为什么更差**：
   - 原地改 `Agent.system`；
   - 另存 current tools；
   - 每轮重复 prepend 全量 system；
   - 修改旧 system entry；
   - provider 各自实现一套 replay。
4. **决策点（供回测）**：
   - 为什么 prompt 从参数变成历史后，resume 不用另存 prompt？
   - 为什么同名工具定义变化要 remove + add？
   - 为什么 `AgentState.tools` 仍存在却不是模型工具状态真相？
   - 为什么 repeated prompt 不追加 system entry？
   - O(1) 读取变成 O(n) replay，为什么值得？

补充实施边界：本阶段只模拟裁剪，不实现阶段 10 compaction；只记录 tool deltas，不实现阶段 11 ExtensionAPI。

- [ ] **Step 2: 全量自动验收**

Run:

```bash
pnpm test
pnpm check
```

Expected: workspace 全绿。

- [ ] **Step 3: 结构边界检查**

Run:

```bash
git grep -n 'context\.system\.content' -- packages || true
git grep -n 'role: "system", content' -- packages || true
git grep -n 'system: options\.system' -- packages/core/src || true
git grep -n 'fake\|anthropic' -- packages/core/src || true
wc -l packages/ai/src/*.ts packages/core/src/*.ts packages/cli/src/*.ts
git diff --numstat bc342bb -- 'packages/*/src/*.ts'
```

Expected:

- 三条旧 string-system grep 无输出；
- core provider grep 无输出；
- 每个 `src` 文件 < 200 行；
- Stage 8 源码净增量 < 400 行。

- [ ] **Step 4: 行为验收**

1. 新 Agent transcript 以一条 SystemMessage 开头；
2. 多条 section 以稳定顺序重放；
3. toolsAdded/toolsRemoved 得到正确当前工具集；
4. removed tool 不发送、不执行；
5. conversation 裁剪后 prompt/tools replay 不变；
6. 连续两次 prompt 不新增 system entry；
7. `appendSystemSections` 与 `setTools` 只追加 delta，不改旧历史；
8. CLI 真实 provider 自动化回归仍完成 text/tool/result/final response。

- [ ] **Step 5: 提交阶段文档**

```bash
git add docs/stages/08-system-prompt-history.md
git commit -m "docs(stage-8): explain why system prompt is history"
```

每个 commit 结尾使用：

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## 完成标准

- [ ] `SystemMessage` 使用 `sections` / `toolsAdded` / `toolsRemoved`，仓库中无旧 `content: string` system 构造。
- [ ] prompt 与 active tools 都可由 transcript 纯重放得到，helper 不修改输入。
- [ ] `StreamContext.system` / `tools` 是 replay snapshot，不是 Agent 的第二份易变状态。
- [ ] 初始 system message 只写一次；已有 system history 的 resume 不重复 prepend。
- [ ] system section 与 tool declaration 更新只追加新 SystemMessage。
- [ ] 相同工具声明不追加 delta；同名声明变化使用 remove + add。
- [ ] removed/mismatched tool declaration 即使仍有执行闭包也不能执行。
- [ ] conversation 裁剪后保留 system entries，replay 结果不变。
- [ ] Anthropic wire system/tools 保持合法，system entries 不进入 wire messages。
- [ ] `agent_end.messages` 仍只含 run-local conversation messages。
- [ ] `pnpm test` / `pnpm check` 全绿；每个 src <200 行；源码净增量 <400 行。
- [ ] `docs/stages/08-system-prompt-history.md` 写完并留下可追问决策点。

执行顺序为 Tasks 1 → 2 → 3 → 4 → 5 → 6。Task 2 依赖 Task 1；Task 4 依赖 Task 3 的 transcript-backed state；其余任务按序推进，不需要并行工作流。
