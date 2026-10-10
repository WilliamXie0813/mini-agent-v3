# 阶段 2「工具与循环」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型能调用工具——加一个单层 `while`，模型发出 `toolCall` 时执行工具、把结果按**模型原始调用顺序**回喂，直到模型不再要求工具为止；同时交付 `read` / `edit` / `bash` 三个真工具。

**Architecture:** 循环仍然住在 `core/src/agent-loop.ts`，仍是**无状态函数**，仍然只认识 `StreamFn`（阶段 1 立起的缝不动）。新增的能力全在「模型输出里多了 `toolCall` 块」这一个事实上：循环看到 `toolCall` 就执行、把 `ToolResultMessage` 追加进历史、再问一次模型；看不到就结束。工具定义住在 `core/src/tool.ts`（接口）与 `core/src/tools.ts`（三个实现），**不放进 `ai`**——`ai` 是 provider 层，只描述模型在网上看到的东西（`Tool` 元数据），执行语义是运行时的事。本阶段是**串行**执行，并行是阶段 6。

**Tech Stack:** 同阶段 1（TypeScript 5.9.3 `strict` + `erasableSyntaxOnly`、Node 24 `--experimental-strip-types` 零构建、pnpm workspaces、vitest 3）。工具用 `node:fs/promises` 与 `node:child_process` 实现，**仍不引入任何运行时依赖**。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md`（阶段 2 见 §5「阶段 2 —— 工具与循环」，消息 IR 见 §4，目录见 §7.1）

## Global Constraints

从 spec 逐条抄录，每个任务都隐含包含本节：

- **零运行时依赖**。所有包 `dependencies` 为空；`read` / `edit` / `bash` 只用 `node:` 内建模块。
- **`erasableSyntaxOnly: true`**。禁止 `enum`、构造函数参数属性、`namespace`；类型导入必须 `import type`。**本阶段的 `ToolDef` 里 `replay?: "safe" | "unsafe"` 是字符串联合而不是 `enum`**——不是因为 enum 不够表达，而是它通不过类型擦除。
- **可擦除语法下，跨包导入用包名，包内相对导入带 `.ts` 后缀**。
- **tab 缩进**；每个 `src` 文件 < 200 行。
- **注释解释「为什么」，不解释「是什么」**。
- **`pnpm dev` 走 `node --experimental-strip-types`，不走 vitest**。
- **每阶段只加一个新概念**；不许提前实现下一阶段的内容。本阶段的新概念是「`toolCall` 内容块 + 工具注册 + 串行执行 + 循环终止条件」。**本阶段不做**：平行执行（阶段 6）、`prepare`/`execute`/`finalize` 三段式与 `beforeToolCall`（阶段 5）、JSON Schema 校验（阶段 5）、事件与 `Agent` 类（阶段 4）、流式 delta（阶段 3）、工具结果的 `onUpdate` 部分结果（阶段 5）、`replay` 字段的实际使用（阶段 9）。
- **`pnpm test` 与 `pnpm check` 必须全绿**才算完成。
- 本阶段源码预算 ~350 行（spec §5 阶段 2）。阶段增量 < 400 行。

## 阶段 1 留下的接口（本计划的起点）

这些已经在仓库里，本计划**不改它们的形状**，只加东西：

```ts
// packages/ai/src/types.ts —— 已存在
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
export interface ToolResultMessage {
	role: "toolResult"; toolCallId: string; toolName: string;
	content: ContentBlock[]; isError: boolean;
}
export interface Tool { name: string; description: string; parameters: Record<string, unknown> }
export interface StreamContext { system: SystemMessage; messages: Message[]; tools: Tool[] }
export type StreamFn = (context: StreamContext, signal?: AbortSignal) => AsyncGenerator<AssistantMessageEvent>;
```

阶段 1 的循环**已经**把 `tools: []` 传进 context、**已经**只把 `done` 携带的消息入历史、**已经**在构造 user 消息前做提前返回。本阶段继承这三条，不重写。

## 本阶段的三个关键决策（实现时必须体现在代码里）

### 决策 A：工具失败**回喂**，不抛

> **模型能修的错误回喂模型；模型修不了的抛给人。**

四类错误全部编码成 `isError: true` 的 `ToolResultMessage` 回喂，循环继续：

| 情况 | toolResult 内容 |
|---|---|
| 模型调了一个不存在的工具名 | `Tool "xxx" not found` |
| 模型给的参数缺必填项 / 类型不对 | 指名缺失的字段（**本阶段只查必填与顶层类型**；完整 JSON Schema 校验是阶段 5） |
| `execute` 抛异常 | 异常消息（`Error.message`，非 Error 则 `String(e)`） |
| `stopReason === "length"` | **整批不执行**，每个 toolCall 各得一条 `isError` 结果 |

反例（说明为什么不能抛）：工具抛出去，历史里就留下一条**没有对应 toolResult 的 assistant 消息**——下次请求时 provider 会拒绝（Anthropic 要求每个 `tool_use` 必须有配对的 `tool_result`），而模型自己永远不知道错在哪。抛给人只在「模型修不了」时才对：调用方写错了参数名（`agentLoop` 的签名问题）才是那类。

### 决策 B：结果按**模型原始调用顺序**入历史

串行执行时这条自动成立——循环按 `content` 顺序 `await`。**但要有测试钉住它**：阶段 6 改成并行后，完成顺序会与调用顺序分叉，那时这条约定要从「自动成立」变成「显式实现」。本阶段的测试是阶段 6 的护栏。

### 决策 C：`toolUse` 是 provider 说的事实，不是 core 推的

`stopReason` 由 `streamFn` 决定。假模型看到脚本项里有 `toolCall` 块就报 `"toolUse"`。**core 不靠"content 里有没有 toolCall"来推进循环**——它靠 content，但 `stopReason` 的语义归 provider。这条在第 7 阶段真实 SSE 解析时才会显出价值：那时 `stop_reason` 字段来自网络，而不是本地推断。

### 循环的终止条件（四条，全部要测）

```
while (true):
  1. 已 abort            → return（不追加任何消息）
  2. 达到 maxTurns       → throw 具名错误（组装错误，抛给人）
  3. content 里无 toolCall → return（正常结束）
  4. 有 toolCall         → 执行、追加 toolResult、continue
```

第 2 条用 `throw` 而不是「塞一条合成的 assistant 消息」：合成的消息会**污染历史**（一条模型从没说过的消息进了 transcript），而 `maxTurns` 属于组装者配置错误，模型修不了——按决策 A 该抛给人。

## Review Focus

spec 是愿景文档，它没写的输入不等于可以崩。以下是本阶段最可能咬到使用者的六类，每一条都在下方对应任务的测试里钉住：

1. **未知工具名**（模型幻觉出一个工具）——合理预期：一条 `isError` 结果回喂，模型下一轮自己改正，循环继续；而不是抛异常终结整个 run。
2. **工具抛错**（`bash` 命令不存在、`read` 文件不存在）——合理预期：同上。特别是 `bash` 的**非零退出码**必须算 `isError`，否则模型会把报错当成功结果继续往下走。
3. **`stopReason === "length"`**——参数 JSON 被 token 上限截断。合理预期：**整批工具一个都不执行**（半截 JSON 不能 parse，且「参数看起来合法但是不完整」正是 `edit` 会误删文件的情形）。
4. **`edit` 的 `oldText` 出现 0 次或多次**——合理预期：两种都报错，**且文件未被修改**。唯一性校验失败时若仍写入，用户会丢掉一个文件。
5. **`bash` 命令永不返回**（`sleep 10000` / 交互式命令等输入）——合理预期：超时后被杀，得到 `isError` 结果而不是挂死整个 CLI。
6. **`edit` 的 `newText` 中含 `$&` / `$'` 之类的替换模式**（如果实现用了 `String.replace`）——合理预期：原样写入。用 `indexOf` + 切片而不是 `replace`，这类问题从根上不存在。

---

### Task 1: 假模型支持 toolCall 脚本项

工具调用链路的测试全靠假模型驱动，所以第一个任务是把假模型的脚本从「字符串」放宽到「完整内容块数组」。

**Files:**
- Modify: `packages/ai/src/fake.ts`
- Modify: `packages/ai/test/fake.test.ts`

**Interfaces:**
- Consumes: `ContentBlock`、`AssistantMessage`、`StopReason`（都已在 `packages/ai/src/types.ts`）。
- Produces:
  - `export type FakeStep = string | ContentBlock[]`
  - `export function createFakeStreamFn(script: FakeStep[]): StreamFn` —— **签名参数类型变了，函数名与调用方式不变**（阶段 1 的 `createFakeStreamFn(["hi"])` 仍然合法，字符串被规范化为 `[{ type: "text", text: "hi" }]`）。
  - 事实（Task 2 起依赖）：脚本项含 `toolCall` 块时 `stopReason === "toolUse"`，否则 `"stop"`。
  - 刻意**不**提供 `textBlock` / `toolCall` 之类的构造快捷函数——脚本项是普通字面量，测试里直接写 `{ type: "toolCall", id: "c1", ... }` 比多一层间接更易读，也让 `ContentBlock` 的形状在测试里是可见的。

- [ ] **Step 1: 写失败的测试**

追加到 `packages/ai/test/fake.test.ts` 的 `createFakeStreamFn` describe 块内。文件头部的 import 要从 `../src/types.ts` 补进 `ContentBlock`（`AssistantMessage` / `AssistantMessageEvent` 已在）。

```ts
const readCall: ContentBlock = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } };

it("reports stopReason 'toolUse' when the script entry contains a toolCall block", async () => {
	const events = await run(createFakeStreamFn([[readCall]]));
	const done = events.at(-1)!.message as AssistantMessage;
	expect(done.stopReason).toBe("toolUse");
	expect(done.content).toEqual([readCall]);
});

it("reports stopReason 'stop' when the script entry only has text blocks", async () => {
	const events = await run(createFakeStreamFn([[{ type: "text", text: "done" }]]));
	expect((events.at(-1)!.message as AssistantMessage).stopReason).toBe("stop");
});

it("keeps a plain string script entry working, normalized to a text block", async () => {
	const events = await run(createFakeStreamFn(["legacy"]));
	expect((events.at(-1)!.message as AssistantMessage).content).toEqual([{ type: "text", text: "legacy" }]);
});

it("preserves text-then-toolCall order inside one entry", async () => {
	const events = await run(createFakeStreamFn([[
		{ type: "text", text: "let me look" },
		{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
	]]));
	const done = events.at(-1)!.message as AssistantMessage;
	expect(done.content.map((c) => c.type)).toEqual(["text", "toolCall"]);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm --filter @mini-agent/ai run test
```

Expected: FAIL。类型上 `string[]` 不接受数组项，且 `stopReason` 恒为 `"stop"`。

- [ ] **Step 3: 实现 `FakeStep` 与 `stopReason` 推导**

`packages/ai/src/fake.ts` 的改动只有两处：脚本项类型放宽、`stopReason` 由一个纯函数推导。`callIndex` 的索引逻辑与外层 `async function*` 结构**保持原样不动**（那是阶段 1 已验证的确定性来源）。

```ts
import type { AssistantMessage, AssistantMessageEvent, ContentBlock, StreamFn, StreamContext } from "./types.ts";

// 脚本项既可以是一句话，也可以是一整条 content 数组（含 toolCall）。
export type FakeStep = string | ContentBlock[];

// stopReason 的判据是「有没有要求模型停下」——只要有一条 toolCall，模型就是在等工具结果，
// 按 provider 契约报 toolUse；否则报 stop。core 不自行推断这件事。
function stopReasonFor(content: ContentBlock[]): "stop" | "toolUse" {
	return content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
}

function normalize(step: FakeStep): ContentBlock[] {
	return typeof step === "string" ? [{ type: "text", text: step }] : step;
}
```

`createFakeStreamFn` 体内构造消息时改为：

```ts
const content = normalize(text);
const message: AssistantMessage = { role: "assistant", content, stopReason: stopReasonFor(content) };
```

**注意**：`normalize` 返回的是脚本项里那个数组的**同一个引用**。这不是疏忽——但循环会把这条消息推进历史，测试若对同一脚本调用两次就会共享同一个数组对象。为消除这个隐患，`normalize` 对数组项返回**浅拷贝**：`step.map((c) => ({ ...c }))`。字符串分支无需拷贝（每次新建）。

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm --filter @mini-agent/ai run test
```

Expected: PASS，且阶段 1 的四个用例仍全绿（`string` 脚本项的回归保护就在那儿）。

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/fake.ts packages/ai/test/fake.test.ts
git commit -m "feat(stage-2): fake model can script toolCall blocks"
```

---

### Task 2: `ToolDef` 接口与执行函数

这个任务把「执行一批 toolCall」变成一个**可独立测试的纯函数**，此时循环还没改——`agentLoop` 仍然只跑一轮，`executeToolCalls` 只有测试在调用。这样 Task 3 改循环时，工具侧的 bug 已经被排除。

**Files:**
- Create: `packages/core/src/tool.ts`
- Create: `packages/core/src/execute-tool-calls.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/execute-tool-calls.test.ts`
- Modify: `packages/ai/src/types.ts`（只加一个 `JSONSchema` 别名）

**Interfaces:**
- Consumes: `ContentBlock`、`ToolResultMessage`、`Tool`、`AssistantMessage`（`@mini-agent/ai`）。
- Produces:
  - `packages/ai/src/types.ts`：`export type JSONSchema = Record<string, unknown>`（`Tool.parameters` 改用这个别名，形状不变）。
  - `packages/core/src/tool.ts`：
    ```ts
    export interface ToolDef<P = Record<string, unknown>> extends Tool {
    	/** 副作用安全性：进程崩溃后能否安全重跑。默认 "unsafe"。第 9 阶段启用。 */
    	replay?: "safe" | "unsafe";
    	execute: (params: P, signal?: AbortSignal) => Promise<ToolResult>;
    }
    export interface ToolResult { content: ContentBlock[]; isError?: boolean }
    export function toToolDeclarations(tools: ToolDef<any>[]): Tool[];
    ```
    `toToolDeclarations` 剥掉 `execute` 与 `replay`，只留 provider 该看到的三个字段（`name` / `description` / `parameters`）——**这是「模型在网上看到的东西」与「本地能执行的东西」的分界，必须有这条函数，不能直接把 `ToolDef[]` 传给 provider**。
  - `packages/core/src/execute-tool-calls.ts`：
    ```ts
    export interface ExecutedToolBatch { messages: ToolResultMessage[] }
    export async function executeToolCalls(
    	toolCalls: ContentBlock[],   // 调用方已 filter 过 type === "toolCall"
    	tools: ToolDef<any>[],
    	signal?: AbortSignal,
    ): Promise<ExecutedToolBatch>;
    ```
    `ContentBlock[]` 而不是 `ToolCallBlock[]` 是因为阶段 1 的 `ContentBlock` 是联合类型，没有导出收窄后的 `ToolCallBlock` 别名；函数内部第一件事就是窄化断言（见 Step 3）。**不要**为了这个参数去改 `ai` 的类型导出——那是把 core 的需求塞进 provider 层。

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/test/execute-tool-calls.test.ts`。测试工具全是**内存里的确定性工具**，不碰文件系统（真实工具在 Task 4 测）：

```ts
import { describe, it, expect } from "vitest";
import { executeToolCalls } from "../src/execute-tool-calls.ts";
import type { ToolDef } from "../src/tool.ts";
import type { ContentBlock } from "@mini-agent/ai";

// 每次调用记录一次，用于断言「按原始顺序执行」与「失败的不执行」。
function makeTools(log: string[]): ToolDef<any>[] {
	return [
		{
			name: "echo",
			description: "echo back",
			parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			execute: async (p: { text: string }) => {
				log.push(`echo:${p.text}`);
				return { content: [{ type: "text", text: p.text }] };
			},
		},
		{
			name: "boom",
			description: "always throws",
			parameters: { type: "object" },
			execute: async () => {
				log.push("boom");
				throw new Error("kaboom");
			},
		},
		{
			name: "fail",
			description: "returns an error result",
			parameters: { type: "object" },
			execute: async () => {
				log.push("fail");
				return { content: [{ type: "text", text: "bad input" }], isError: true };
			},
		},
	];
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): ContentBlock =>
	({ type: "toolCall", id, name, arguments: args });

describe("executeToolCalls (stage 2: serial)", () => {
	it("executes in the model's original call order and returns results in that same order", async () => {
		const log: string[] = [];
		const batch = await executeToolCalls(
			[call("c1", "echo", { text: "first" }), call("c2", "echo", { text: "second" })],
			makeTools(log),
		);
		expect(log).toEqual(["echo:first", "echo:second"]);
		expect(batch.messages.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
	});

	it("pairs each result with its toolCallId and toolName", async () => {
		const batch = await executeToolCalls([call("c1", "echo", { text: "x" })], makeTools([]));
		expect(batch.messages[0]).toMatchObject({
			role: "toolResult", toolCallId: "c1", toolName: "echo", isError: false,
		});
	});

	it("feeds back an error result for an unknown tool name instead of throwing", async () => {
		const log: string[] = [];
		const batch = await executeToolCalls([call("c1", "nonexistent")], makeTools(log));
		expect(log).toEqual([]);
		expect(batch.messages[0].isError).toBe(true);
		expect(toolResultText(batch.messages[0])).toMatch(/nonexistent.*not found|not found.*nonexistent/i);
	});

	it("converts a thrown error into an isError result", async () => {
		const batch = await executeToolCalls([call("c1", "boom")], makeTools([]));
		expect(batch.messages[0].isError).toBe(true);
		expect(toolResultText(batch.messages[0])).toBe("kaboom");
	});

	it("passes through an isError result from the tool itself", async () => {
		const batch = await executeToolCalls([call("c1", "fail")], makeTools([]));
		expect(batch.messages[0].isError).toBe(true);
		expect(toolResultText(batch.messages[0])).toBe("bad input");
	});

	it("reports a missing required parameter as an error result and never calls execute", async () => {
		const log: string[] = [];
		const batch = await executeToolCalls([call("c1", "echo", {})], makeTools(log));
		expect(log).toEqual([]);
		expect(batch.messages[0].isError).toBe(true);
		expect(toolResultText(batch.messages[0])).toContain("text");
	});

	it("produces one result per tool call, including mixed success and failure", async () => {
		const batch = await executeToolCalls(
			[call("c1", "echo", { text: "a" }), call("c2", "boom"), call("c3", "echo", { text: "b" })],
			makeTools([]),
		);
		expect(batch.messages).toHaveLength(3);
		expect(batch.messages.map((m) => m.isError)).toEqual([false, true, false]);
	});

	it("stops before later calls once the signal is aborted, and still pairs every executed call", async () => {
		const log: string[] = [];
		const controller = new AbortController();
		const tools = makeTools(log);
		// 第一个工具的中途 abort：结果必须成对（有 toolCall 就有 toolResult），不能半途而废。
		const original = tools[0].execute;
		tools[0] = { ...tools[0], execute: async (p, s) => { controller.abort(); return original(p, s); } };
		const batch = await executeToolCalls(
			[call("c1", "echo", { text: "a" }), call("c2", "echo", { text: "b" })],
			tools,
			controller.signal,
		);
		expect(log).toEqual(["echo:a"]);
		expect(batch.messages.map((m) => m.toolCallId)).toEqual(["c1"]);
	});
});

function toolResultText(message: { content: ContentBlock[] }): string {
	return message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}
```

最后一个用例（abort）是**本任务里最重要的一条**：它钉住了「已执行的每个 toolCall 必有配对结果」这个不变量。中止后不再启动后续调用，但**不合成**未执行调用的结果——合成会让模型以为那些工具跑过了。截断点由阶段 4 的事件层补一条 `aborted` 消息收尾。

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm --filter @mini-agent/core run test
```

Expected: FAIL，`Cannot find module '../src/execute-tool-calls.ts'`。

- [ ] **Step 3: 实现 `tool.ts` 与 `execute-tool-calls.ts`**

`packages/ai/src/types.ts` 只加一行别名（`Tool.parameters` 的类型换成它，形状不变）：

```ts
/** 手写 JSON Schema。本阶段只用到 required 与 properties 的 type 字段；完整校验在阶段 5。 */
export type JSONSchema = Record<string, unknown>;
```

`packages/core/src/tool.ts`：

```ts
import type { ContentBlock, JSONSchema, Tool } from "@mini-agent/ai";

// 本阶段三个工具都不需要泛型参数，`any` 用在注册表位置是刻意的：
// 工具表是异构的（read 收 { path }，bash 收 { command }），除 any 外只能靠类型擦除容不下的技巧。
export interface ToolDef<P = Record<string, unknown>> extends Tool {
	/** 副作用安全性：进程崩溃后能否安全重跑。默认 "unsafe"。第 9 阶段启用。 */
	replay?: "safe" | "unsafe";
	execute: (params: P, signal?: AbortSignal) => Promise<ToolResult>;
}

export interface ToolResult { content: ContentBlock[]; isError?: boolean }

// provider 只该看到 name/description/parameters。把 ToolDef 直接交给 streamFn 会
// 让 provider 层拿到 execute 闭包——那是运行时对象，不是协议的一部分。
export function toToolDeclarations(tools: ToolDef<any>[]): Tool[] {
	return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as JSONSchema }));
}
```

`packages/core/src/execute-tool-calls.ts`：结构是「逐条 prepare → 逐条 execute」，全部收在一个 `for` 里。**这一步刻意不拆成三段式**——那是阶段 5 的事，现在拆会让人以为分离是为并行服务的。

```ts
import type { ContentBlock, ToolResultMessage } from "@mini-agent/ai";
import type { ToolDef, ToolResult } from "./tool.ts";

export interface ExecutedToolBatch { messages: ToolResultMessage[] }

export async function executeToolCalls(
	toolCalls: ContentBlock[],
	tools: ToolDef<any>[],
	signal?: AbortSignal,
): Promise<ExecutedToolBatch> {
	const messages: ToolResultMessage[] = [];
	for (const block of toolCalls) {
		if (signal?.aborted) break; // 已执行的调用都已配对；未启动的不合成结果（见测试最后一条）
		if (block.type !== "toolCall") continue;
		messages.push(await executeOne(block, tools, signal));
	}
	return { messages };
}
```

`executeOne` 是一个内部 `async` 函数（不导出，避免阶段 5 的三段式出现两个入口）：

- 找工具：`tools.find((t) => t.name === block.name)`；找不到 → `errorMessage(\`Tool "${block.name}" not found\`)`。
- 校验：调 `findMissingRequired(tool, block.arguments)`（同文件内的内部函数），返回第一个缺失的必填字段名或 `undefined`；非 `undefined` → `errorMessage(\`Tool "${tool.name}" is missing required parameter "${missing}"\`)`。校验只做两件事：`parameters.required` 里的每个名字必须在 `arguments` 里存在；存在时其 `typeof` 要匹配 `parameters.properties[name].type` 里声明的类型（`"string" | "number" | "boolean" | "object" | "array"` 的映射用对象字面量，**不能用 enum**）。
- 执行：`await tool.execute(block.arguments, signal)`，包在 `try/catch` 里；catch 到 `e` → `errorMessage(e instanceof Error ? e.message : String(e))`。
- 归一化：`content: result.content ?? []`（工具可能返回 `{ content: undefined }`，不能让它进历史——阶段 1 的 `createToolResultMessage` 在 Pi 里做了同一件事）。`isError: result.isError === true`，即**缺省是 `false`**，不是 `undefined`。
- `errorMessage(text): ToolResultMessage` 内部函数：`{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: true }`。

`packages/core/src/index.ts` 追加导出：

```ts
export { executeToolCalls } from "./execute-tool-calls.ts";
export type { ExecutedToolBatch } from "./execute-tool-calls.ts";
export { toToolDeclarations } from "./tool.ts";
export type { ToolDef, ToolResult } from "./tool.ts";
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm --filter @mini-agent/core run test
```

Expected: PASS（8 个新用例 + 阶段 1 的 8 个仍绿）。

- [ ] **Step 5: 确认 core 仍然不认识任何 provider**

```bash
cd D:/project/harness/mini-agent-v3 && grep -rn "fake\|anthropic\|createFakeStreamFn" packages/core/src/
```

Expected: 无匹配。新文件只 import `@mini-agent/ai` 的**类型**——`execute-tool-calls.ts` 的两条 import 必须都是 `import type`。这是阶段 1 立下的边界，本阶段新增两个文件后要重新验一遍。

- [ ] **Step 6: Commit**

```bash
git add packages/ai/src/types.ts packages/core/src/tool.ts packages/core/src/execute-tool-calls.ts packages/core/src/index.ts packages/core/test/execute-tool-calls.test.ts
git commit -m "feat(stage-2): ToolDef contract and serial tool-call execution"
```

---

### Task 3: 循环加上 `while` 与终止条件

循环从「一次往返」变成「跑到模型不再要工具」。这是本阶段唯一动 `agent-loop.ts` 的任务。

**Files:**
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/index.ts`（`AgentLoopOptions` 变了吗？没变——但 `tools` 与 `maxTurns` 是新增字段，跟着 `AgentLoopOptions` 一起出去）
- Modify: `packages/core/test/agent-loop.test.ts`

**Interfaces:**
- Consumes: `executeToolCalls`、`toToolDeclarations`、`ToolDef`（Task 2）；`createFakeStreamFn`、`FakeStep`、`toolCall`、`textBlock`（Task 1）。
- Produces:
  ```ts
  export interface AgentLoopOptions {
  	prompt: string;
  	messages: Message[];
  	system: string;
  	streamFn?: StreamFn;
  	signal?: AbortSignal;
  	tools?: ToolDef<any>[];   // 新增，缺省 []
  	maxTurns?: number;        // 新增，缺省 10
  }
  export async function agentLoop(options: AgentLoopOptions): Promise<Message[]>;
  ```
  事实（Task 4 依赖）：`agentLoop` 返回时 `messages` 里的尾部序列是 `… assistant(toolCall) → toolResult×n → assistant(无 toolCall)`；CLI 靠这个形状渲染。

- [ ] **Step 1: 写失败的测试**

追加到 `packages/core/test/agent-loop.test.ts`（**保留**阶段 1 的 8 个用例——它们是回归保护）。文件头部的 import 要补两项：

```ts
import { createFakeStreamFn, setDefaultStreamFn } from "@mini-agent/ai";
import type { Message, ToolResultMessage } from "@mini-agent/ai";   // ToolResultMessage 是新增的
import type { ToolDef } from "../src/tool.ts";                   // 新增
```

已有的 `beforeEach(() => setDefaultStreamFn(undefined))` 保留——新用例都显式传 `streamFn`，它只当作「测试之间不泄漏插槽状态」的清理。测试用一个工具：

```ts
const echoTool: ToolDef<{ text: string }> = {
	name: "echo",
	description: "echo back",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: async (p) => ({ content: [{ type: "text", text: p.text }] }),
};
```

新 describe 块「agentLoop (stage 2: tool loop)」：

```ts
it("runs a full tool round and ends when the model stops asking for tools", async () => {
	const messages = await agentLoop({
		...base(), prompt: "read it", tools: [echoTool],
		streamFn: createFakeStreamFn([
			[{ type: "text", text: "looking" }, { type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } }],
			["I saw hi"],
		]),
	});
	expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
});

it("keeps the assistant toolCall message and its result adjacent, in call order", async () => {
	const messages = await agentLoop({
		...base(), prompt: "go", tools: [echoTool],
		streamFn: createFakeStreamFn([
			[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "first" } },
				{ type: "toolCall", id: "c2", name: "echo", arguments: { text: "second" } }],
			["done"],
		]),
	});
	expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "c1" });
	expect(messages[3]).toMatchObject({ role: "toolResult", toolCallId: "c2" });
	expect(messages[4]).toMatchObject({ role: "assistant", stopReason: "stop" });
});

it("records the intermediate assistant message with stopReason 'toolUse'", async () => {
	const messages = await agentLoop({
		...base(), prompt: "go", tools: [echoTool],
		streamFn: createFakeStreamFn([
			[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }], ["done"],
		]),
	});
	expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
});

**length 这一例需要假模型能声明「这一项以 `length` 结束」**。Task 1 的 `FakeStep` 只推导出 `stop` / `toolUse` 两种，所以这里要扩一次（见 Step 3）。**这不是提前实现阶段 3**——阶段 3 加的是 delta 事件，这里只是让假模型能表达 provider 本就能报的六种 `stopReason` 之一：

```ts
it("does not execute anything when stopReason is 'length' and feeds back one error per call", async () => {
	const log: string[] = [];
	const spy: ToolDef<any> = {
		...echoTool,
		execute: async (p: { text: string }) => { log.push("called"); return echoTool.execute(p); },
	};
	const messages = await agentLoop({
		...base(), prompt: "go", tools: [spy],
		streamFn: createFakeStreamFn([
			// length 场景：内容块仍是 toolCall（半截 JSON 被尽力解析出来），但 stopReason 是 length
			{ content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "a" } },
			            { type: "toolCall", id: "c2", name: "echo", arguments: { text: "b" } }],
			  stopReason: "length" },
			["recovered"],
		]),
	});
	expect(log).toEqual([]);                                   // 整批不执行
	expect(messages.slice(2, 4).map((m) => (m as ToolResultMessage).isError)).toEqual([true, true]);
	expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" }); // 循环继续并收敛
});
```

其余新用例：

```ts
it("feeds back an error and lets the model recover from an unknown tool", async () => {
	const messages = await agentLoop({
		...base(), prompt: "go", tools: [echoTool],
		streamFn: createFakeStreamFn([
			[{ type: "toolCall", id: "c1", name: "nope", arguments: {} }], ["sorry, retrying"],
		]),
	});
	expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "nope", isError: true });
	expect(messages).toHaveLength(4);
});

it("throws a named error when the model keeps calling tools past maxTurns", async () => {
	await expect(agentLoop({
		...base(), prompt: "go", tools: [echoTool], maxTurns: 3,
		streamFn: createFakeStreamFn([[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }]]),
	})).rejects.toThrow(/maxTurns/i);
});

it("returns immediately for a whitespace-only prompt without touching history", async () => {
	const messages = await agentLoop({ ...base(), prompt: "  ", tools: [echoTool],
		streamFn: createFakeStreamFn([["never"]]) });
	expect(messages).toHaveLength(0);
});

it("returns without touching history when the signal is already aborted", async () => {
	const messages = await agentLoop({ ...base(), prompt: "go", tools: [echoTool], signal: AbortSignal.abort(),
		streamFn: createFakeStreamFn([["never"]]) });
	expect(messages).toHaveLength(0);
});
```

`maxTurns` 用例能跑通的前提是脚本耗尽后**复用最后一项**（阶段 1 的行为），所以工具会被反复调用直到抛错——这条用例同时是「脚本复用」的集成保护。

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm --filter @mini-agent/core run test
```

Expected: FAIL。`tools` / `maxTurns` 不是已知属性（`tsc` 会先报），且角色序列断言拿到的是 `[user, assistant]`。

- [ ] **Step 3: 先扩假模型（Task 1 的补丁）**

`packages/ai/src/fake.ts` 的 `FakeStep` 放宽为：

```ts
export type FakeStep =
	| string
	| ContentBlock[]
	| { content: ContentBlock[]; stopReason: StopReason };
```

`normalize` 相应返回 `{ content, stopReason? }` 两个值；`stopReason` 的优先级是「脚本项显式声明 > 按 content 推导」。跑 `pnpm --filter @mini-agent/ai run test` 确认阶段 2 与阶段 1 的假模型测试全绿，**先 commit 这个小改动**（`feat(stage-2): fake model can script an explicit stopReason`），再动循环。

- [ ] **Step 4: 重写 `agentLoop`**

保持函数仍是无状态的、仍不 import 任何 provider。结构：

```ts
export async function agentLoop(options: AgentLoopOptions): Promise<Message[]> {
	// 提前返回都在构造 user 消息之前（阶段 1 的约定，不要动）：已中止的 signal 不产生半条消息；
	// 空白 prompt 不污染历史。
	if (options.signal?.aborted) return options.messages;
	if (options.prompt.trim() === "") return options.messages;

	const streamFn = options.streamFn ?? getDefaultStreamFn();
	const tools = options.tools ?? [];
	const maxTurns = options.maxTurns ?? 10;

	options.messages.push({ role: "user", content: [{ type: "text", text: options.prompt }] });

	for (let turn = 0; turn < maxTurns; turn++) {
		const context: StreamContext = {
			system: { role: "system", content: options.system },
			messages: [...options.messages],   // 快照：provider 拿到的是本次请求那一刻的历史
			tools: toToolDeclarations(tools),
		};

		// 只有 done 携带的完整消息才进历史（阶段 3 起 done 仍是权威）。
		let doneMessage: AssistantMessage | undefined;
		for await (const event of streamFn(context, options.signal)) {
			if (event.type === "done") doneMessage = event.message;
		}
		const message = doneMessage!;
		options.messages.push(message);

		// length 保护：参数 JSON 被 token 上限截断，半截参数「解析成功但不完整」，
		// 执行它可能删错文件。整批判失败回喂，模型可重发。
		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) return options.messages;
		if (message.stopReason === "length") {
			options.messages.push(...truncatedBatchFailures(toolCalls, tools));
			continue;
		}

		const batch = await executeToolCalls(toolCalls, tools, options.signal);
		options.messages.push(...batch.messages);
		if (options.signal?.aborted) return options.messages;
	}

	const last = options.messages.at(-1);
	const called = last?.role === "assistant"
		? last.content.filter((c) => c.type === "toolCall").map((c) => c.name).join(", ")
		: "unknown";
	throw new Error(`agent loop hit maxTurns (${maxTurns}) without the model stopping; last tool calls: ${called}`);
}
```

`truncatedBatchFailures(toolCalls, tools)` 是同文件的**非导出**小函数，为每个 toolCall 生成一条 `isError` 的 `ToolResultMessage`，文案：

```
Tool "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.
```

（逐字取自 Pi `agent-loop.ts:486-488`。**这条文案是给模型看的**，所以它必须包含「怎么办」——"Re-issue the tool call with complete arguments"。）

三处**必须刻意保留**的细节：

1. **`streamFn` 的 `for await` 块不看 delta**。阶段 3 会在这里加 `case "text_delta"`，本阶段循环体只有 `done` 一条分支。
2. **abort 的两处检查位置不同**：循环开头检查（用户在第一轮之前就按了 Ctrl+C）与工具执行后检查（工具跑的时候按了）。前者不产生任何消息，后者在工具结果之后返回——**中止不能让已经执行的工具结果丢失**。
3. **`throw` 的错误信息里带上最后一轮的工具名**，否则使用者看到 `hit maxTurns` 还得自己去翻历史才知道模型在反复调什么。

另有一处**容易写错**：`toolCalls` 是 `ContentBlock[]`，`executeToolCalls` 的形参也是 `ContentBlock[]`，但内部会再判一次 `type !== "toolCall"`。这个重复判断是刻意的——函数收的是「内容块数组」，不收窄断言，也不假设调用方已过滤（Task 2 的测试就依赖它能收任意块）。**不要**为了消除重复而改签名。

- [ ] **Step 5: 跑测试，确认通过**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm --filter @mini-agent/core run test && pnpm --filter @mini-agent/core run check
```

Expected: PASS。阶段 1 的 8 个用例仍绿——**这是本任务最重要的一条回归信号**：它们证明 `while` 的引入没有改变「无工具的一轮」的行为。

- [ ] **Step 6: 数循环层数**

```bash
cd D:/project/harness/mini-agent-v3 && grep -c "while\|for (let turn" packages/core/src/agent-loop.ts
```

Expected: 1。**只有一个循环层**——双层（外层等 follow-up，内层跑工具）是阶段 13 的事。出现两个就是越界。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent-loop.ts packages/core/src/index.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(stage-2): single-layer agent loop with tool execution"
```

---

### Task 4: 三个真工具

到这一步循环已经能跑工具了，但注册表是空的。这个任务交付 `read` / `edit` / `bash`，并按 spec §5 的验收第 4 条测 `edit` 的唯一性校验。

**Files:**
- Create: `packages/core/src/tools.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/tools.test.ts`

**Interfaces:**
- Consumes: `ToolDef`、`ToolResult`（Task 2）。
- Produces:
  ```ts
  export function createReadTool(): ToolDef<{ path: string; offset?: number; limit?: number }>;
  export function createEditTool(): ToolDef<{ path: string; oldText: string; newText: string }>;
  export function createBashTool(options?: { timeoutMs?: number }): ToolDef<{ command: string }>;
  export function createDefaultTools(): ToolDef<any>[];   // [read, edit, bash]
  ```
  `replay` 的分工：`read` → `"safe"`；`edit` / `bash` → `"unsafe"`（默认值，显式写出来是为了阶段 9 一眼可读）。**本阶段无人读这个字段**。

  **`createBashTool` 的 `options` 参数是 spec 没写的、计划自己加的一处形参**：spec §5 只写「`bash` 超时」没写多久。加它是因为超时路径必须被测试（Review Focus 第 5 条），而 30 秒的超时没法在单测里等。取舍：为可测性开一个口子，而不是把常量写死再在测试里 `vi.useFakeTimers()` 绕开——后者会把 `spawn` 的真实子进程行为一起假掉，测的就不是超时了。**只暴露 `timeoutMs` 一项**，不要再加 `cwd` / `env` / `maxOutput` 之类的旋钮。

三条设计约束，三个工具都适用：

- **参数相对 `process.cwd()` 解析**。工具收的是模型给的路径，模型不知道进程在哪；不做路径逃逸防护（那是阶段 11 扩展/权限的事，spec §5 阶段 5 明说「不实现权限规则」）。
- **工具抛异常是允许的**（`executeToolCalls` 会转成 `isError`），但**能预判的失败应返回 `isError` 结果而不是抛**——`read` 的文件不存在属于能预判的，文案由工具自己写好（`ENOENT` 的系统文案对模型没有信息量）。
- **输出要小**。工具结果会进历史，进历史就要进下一次请求。`read` 默认最多 200 行、`bash` 超时 30 秒且结果截断到 10000 字符，截断时在末尾加一行 `[output truncated]`。

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/test/tools.test.ts`。用真实临时目录（spec §7.3 的测试策略：「工具：临时目录真实读写、真实跑命令」）：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool, createEditTool, createBashTool } from "../src/tools.ts";
import type { ContentBlock } from "@mini-agent/ai";
```

`beforeEach` 建临时目录并 `process.chdir(dir)`，`afterEach` 还原 cwd 并删目录——工具的路径解析依赖 cwd，测试必须控制它。`text(result)` 辅助函数同 Task 2 的 `toolResultText`。

`read` 的三个用例：

```ts
it("returns the file with 1-based line numbers", async () => {
	await writeFile("a.txt", "one\ntwo\n");
	const r = await createReadTool().execute({ path: "a.txt" });
	expect(r.isError).toBeFalsy();
	expect(text(r)).toBe("     1\tone\n     2\ttwo");
});

it("honors offset and limit", async () => {
	await writeFile("a.txt", "1\n2\n3\n4\n5\n");
	const r = await createReadTool().execute({ path: "a.txt", offset: 2, limit: 2 });
	expect(text(r)).toBe("     2\t2\n     3\t3");
});

it("returns an error result, not a throw, for a missing file", async () => {
	const r = await createReadTool().execute({ path: "nope.txt" });
	expect(r.isError).toBe(true);
	expect(text(r)).toMatch(/nope\.txt/);
});
```

行号格式用 `String(n).padStart(6)` + tab，与 `cat -n` 同形——模型见过这个格式太多次了，改格式是白白增加不确定性。末尾不加换行（断言里就是那个形状）。

`edit` 的四个用例（**本任务的核心**）：

```ts
it("replaces a unique occurrence", async () => {
	await writeFile("a.txt", "hello world\n");
	const r = await createEditTool().execute({ path: "a.txt", oldText: "world", newText: "there" });
	expect(r.isError).toBeFalsy();
	expect(await readFile("a.txt", "utf8")).toBe("hello there\n");
});

it("errors and leaves the file untouched when oldText appears zero times", async () => {
	await writeFile("a.txt", "hello\n");
	const r = await createEditTool().execute({ path: "a.txt", oldText: "absent", newText: "x" });
	expect(r.isError).toBe(true);
	expect(text(r)).toMatch(/0 times|not found/i);
	expect(await readFile("a.txt", "utf8")).toBe("hello\n");
});

it("errors and leaves the file untouched when oldText appears more than once", async () => {
	await writeFile("a.txt", "x\nx\n");
	const r = await createEditTool().execute({ path: "a.txt", oldText: "x", newText: "y" });
	expect(r.isError).toBe(true);
	expect(text(r)).toMatch(/2 times|multiple/i);
	expect(await readFile("a.txt", "utf8")).toBe("x\nx\n");
});

it("writes newText literally, without interpreting $& or other replacement patterns", async () => {
	await writeFile("a.txt", "value\n");
	const r = await createEditTool().execute({ path: "a.txt", oldText: "value", newText: "$& and $' literal" });
	expect(r.isError).toBeFalsy();
	expect(await readFile("a.txt", "utf8")).toBe("$& and $' literal\n");
});
```

最后一个用例是 Review Focus 第 6 条：它会把任何 `String.prototype.replace` 的实现钉在墙上。**实现必须用 `indexOf` + 切片。**

`bash` 的四个用例：

```ts
it("returns stdout for a successful command", async () => {
	const r = await createBashTool().execute({ command: "echo hi" });
	expect(r.isError).toBeFalsy();
	expect(text(r)).toContain("hi");
});

it("marks a non-zero exit code as an error result, including stderr", async () => {
	const r = await createBashTool().execute({ command: "node -e \"console.error('bad'); process.exit(3)\"" });
	expect(r.isError).toBe(true);
	expect(text(r)).toContain("bad");
	expect(text(r)).toContain("3");
});

it("kills a command that outlives the timeout instead of hanging", async () => {
	const r = await createBashTool({ timeoutMs: 300 }).execute({ command: "node -e \"setTimeout(()=>{}, 60000)\"" });
	expect(r.isError).toBe(true);
	expect(text(r)).toMatch(/timed out|timeout/i);
}, 5000);

it("is aborted by the signal", async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const r = await createBashTool().execute({ command: "node -e \"setTimeout(()=>{}, 60000)\"" }, controller.signal);
	expect(r.isError).toBe(true);
}, 5000);
```

两个超时用例都声明了 vitest 的 per-test 超时（第三个参数 `5000`）——默认 5 秒在这里恰好在边界上，不写会偶发失败。

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm --filter @mini-agent/core run test
```

Expected: FAIL，`Cannot find module '../src/tools.ts'`。

- [ ] **Step 3: 实现 `read`**

`parameters` 手写（spec 明确不引 TypeBox）：

```ts
{
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file, relative to the working directory." },
		offset: { type: "number", description: "1-based line number to start from." },
		limit: { type: "number", description: "Maximum number of lines to return. Defaults to 200." },
	},
	required: ["path"],
}
```

实现要点：`await readFile(path, "utf8")` 包在 try/catch 里，`ENOENT` → `isError` 并给出 `File not found: <path>`（**不要**把系统错误原文丢给模型，它不含「路径解析在 cwd」这个信息）。分割用 `split("\n")`；文件末尾的空行**不产生**一行（断言里 `"one\ntwo\n"` → 两行）。行号 `String(i + 1).padStart(6)` + `"\t"`。默认 `limit = 200`，超出时在末尾追加一行 `` `[truncated: showing lines ${start+1}-${end} of ${total}]` ``。

- [ ] **Step 4: 实现 `edit`**

```ts
const before = await readFile(path, "utf8");
const first = before.indexOf(oldText);
const count = first === -1 ? 0 : before.split(oldText).length - 1;
if (count === 0) return { content: [{ type: "text", text: `oldText not found in ${path}. Read the file first; the text must match exactly, including whitespace.` }], isError: true };
if (count > 1) return { content: [{ type: "text", text: `oldText appears ${count} times in ${path}. Include more surrounding context so it is unique.` }], isError: true };
await writeFile(path, before.slice(0, first) + newText + before.slice(first + oldText.length), "utf8");
```

两条错误文案都**给出修复动作**（「先读文件」「多带点上下文」）——这是决策 A 的落地：错误信息的读者是模型，它需要知道下一步做什么。`count` 用 `split(oldText).length - 1` 数，不用正则（`oldText` 里的 `*` / `(` 会炸正则）。`count > 1` 时**不写文件**（Review Focus 第 4 条）。

- [ ] **Step 5: 实现 `bash`**

用 `node:child_process` 的 `spawn`（不是 `exec`——`exec` 的 `maxBuffer` 默认 1MB，且它把 stdout/stderr 拼在一起）：

```ts
export function createBashTool(options: { timeoutMs?: number } = {}): ToolDef<{ command: string }> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	// 有 shell 才有管道与重定向；模型给的命令是 shell 语法。
	return {
		name: "bash", description: "...", replay: "unsafe",
		parameters: { type: "object", properties: { command: { type: "string", description: "Shell command to run." } }, required: ["command"] },
		execute: (params, signal) => runShell(params.command, timeoutMs, signal),
	};
}
```

`runShell` 是内部函数：`spawn(command, { shell: true, signal, timeout: timeoutMs, killSignal: "SIGKILL" })`——`spawn` 内建支持 `signal` 与 `timeout`，**不要手写 `setTimeout(() => child.kill())`**（那会漏掉 `close` 事件的竞态）。收集 `stdout` / `stderr` 的 `data` 事件，在 `close` 事件里结算：

- 拼 `[stdout]` 与 `[stderr]` 两段（空的不输出），非零退出码追加 `[exit code: N]`。
- `signal` 或 `timeout` 导致终止时，`close` 的 code 是 `null` 而 `signal` 有值 → 文案 `Command timed out after ${timeoutMs}ms and was killed.` 或 `Command aborted.`，`isError: true`。
- 退出码 0 → `isError` 缺席（false）。
- 输出超 10000 字符截断并加 `[output truncated]`。

`spawn` 的 `error` 事件（命令不存在 / shell 起不来）也要接：`isError: true`，文案用 `e.message`。

- [ ] **Step 6: 加 `createDefaultTools` 并从 index 导出**

```ts
export function createDefaultTools(): ToolDef<any>[] {
	return [createReadTool(), createEditTool(), createBashTool()];
}
```

`packages/core/src/index.ts` 追加 `export { createReadTool, createEditTool, createBashTool, createDefaultTools } from "./tools.ts";`

- [ ] **Step 7: 跑测试，确认通过**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm --filter @mini-agent/core run test && pnpm --filter @mini-agent/core run check
```

Expected: PASS。若 bash 的两个超时用例偶发失败，检查是不是漏了 `killSignal: "SIGKILL"`——默认的 `SIGTERM` 对 `node -e "setTimeout(...)"` 立即可用，但对真有信号处理器的进程会拖到超时。

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tools.ts packages/core/src/index.ts packages/core/test/tools.test.ts
git commit -m "feat(stage-2): read, edit, and bash tools"
```

---

### Task 5: CLI 渲染工具过程 + 阶段文档

把工具接进组装根，顺手交付阶段文档。

**Files:**
- Modify: `packages/cli/src/index.ts`
- Create: `docs/stages/02-tools-and-loop.md`

**Interfaces:**
- Consumes: `createDefaultTools`、`agentLoop`、`ToolDef`。
- Produces: 无下游消费者（这是路线的末端）——但产生一个**可验证的事实**：`pnpm dev` 里能看到工具调用与结果。

- [ ] **Step 1: 改 CLI 渲染**

阶段 1 的 `if (messages.length > before && last?.role === "assistant")` 只处理「最后一条是 assistant」。工具场景下要多打两类东西：**发送的 toolCall** 与**回来的 toolResult**。渲染的范围是**本轮新增的消息**：

```ts
const before = messages.length;
await agentLoop({ prompt: line, messages, system, tools: createDefaultTools() });

for (const message of messages.slice(before)) {
	if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type === "text") process.stdout.write(block.text);
			if (block.type === "toolCall") console.log(`\n→ ${block.name} ${JSON.stringify(block.arguments)}`);
		}
		if (message.content.some((c) => c.type === "text")) console.log();
	}
	if (message.role === "toolResult" && message.isError) {
		console.log(`✗ ${message.toolName}: ${textOf(message.content)}`);
	}
}
```

`textOf` 是同文件的小辅助函数（`content.filter(c => c.type === "text").map(c => c.text).join("")`）——**它已经在阶段 1 内联在那一行里了，本步把它提成函数**，因为现在有三处要用。

**成功的工具结果不打印**——`read` 会把整个文件打屏，`bash` 会把构建日志打屏，终端会被冲掉。只打失败（`isError`）与工具名，成功的结果靠模型下一轮的文字体现。这条判断和阶段 12 的 UI 层一致：**终端不需要看到模型能看到的一切**。

保留原有的「空白输入不重印上一轮回复」行为——`messages.slice(before)` 在 `before === messages.length` 时是空数组，天然满足。

- [ ] **Step 2: 手动验证（`pnpm dev`）**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm dev
```

假模型固定回一句话，所以**这里看不到工具调用**。要看到，需要临时把脚本改成带 toolCall 的一次性验证——在 `setDefaultStreamFn(...)` 那一行上面加一个临时注释块：

```ts
// 临时验证（验证完删掉）：写入一个文件再读回来。
// setDefaultStreamFn(createFakeStreamFn([
//   [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hello > /tmp/stage2.txt" } }],
//   [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "/tmp/stage2.txt" } }],
//   ["done"],
// ]));
```

Expected: 终端依次出现 `→ bash {"command":"echo hello > /tmp/stage2.txt"}`、`→ read {"path":"/tmp/stage2.txt"}`、`done`；`/tmp/stage2.txt` 存在且内容为 `hello`。**这四行输出就是阶段 2 的验收第 1、2 条的肉眼版本。** 验证完**删掉**临时注释块（保持 `pnpm dev` 的默认行为是阶段 1 的固定问候——那是阶段 7 判断「有没有切到真模型」的标记）。

- [ ] **Step 3: 全量验证**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm test && pnpm check
```

Expected: 三个包的 test 与 check 全绿（cli 无 test 脚本，`pnpm -r` 会跳过并不报错）。同时确认：

```bash
wc -l packages/*/src/*.ts
```

每个 `src` 文件 < 200 行；`src` 总量相对阶段 1 的 168 行增量 < 400。

- [ ] **Step 4: 写 `docs/stages/02-tools-and-loop.md`**

按 spec §7.4 的四段结构（与阶段 1 的文档同形）：

1. **这个阶段解决了什么问题**——一轮往返只能聊天。工具是 agent 与 chatbot 的分界：模型输出从「给人看的文本」变成「给人看的文本 + 给运行时看的指令」。本阶段让那条指令有地方去、有结果回。
2. **Pi 的哪条决策是答案**——三条，各自带 Pi 行号：
   - `agent-loop.ts:267` 的 `stopReason === "length"` 整批保护（半截 JSON 不能信）。
   - `agent-loop.ts:530-584` 的 `executeToolCallsSequential`：串行、逐条 `await`、逐条 emit，**结果顺序即调用顺序**。
   - `agent-loop.ts:930-944` 的 `createToolResultMessage`：把 `toolCallId` / `toolName` / `content` / `isError` 装进一条独立消息类型，而不是往 assistant 消息里塞字段。
3. **替代方案为什么更差**——表格：
   | 替代方案 | 差在哪 |
   |---|---|
   | 工具失败时抛给调用方 | 历史里留下没有配对 toolResult 的 assistant 消息，下次请求被 provider 拒绝；且模型永远学不到错在哪 |
   | 把工具结果拼成一条 text 追加给 user | 丢失 `toolCallId` 配对，provider 无法校验；模型分不清「用户说的话」和「工具的输出」 |
   | 按完成顺序入历史 | 串行时无害，阶段 6 并行后必然错位——所以本阶段就写测试钉住 |
   | `stopReason === "length"` 时尽力执行能解析的那些 | 「解析成功但不完整」的参数正是 `edit` 会误删文件的情形 |
4. **决策点（供回测）**——四个问题：
   1. 工具执行失败时，为什么是「回喂模型」而不是「抛给调用方」？判据是什么？
   2. 「结果必须按模型原始调用顺序入历史」这条约定，在串行时代价是零——那**为什么**现在就要写测试钉住它？
   3. `stopReason === "length"` 时为什么**整批**不执行，而不是跳过解析失败的那几个、执行其余？
   4. `ToolDef` 的 `replay` 字段现在完全是死代码（没有任何代码读它）。为什么现在写进去？

   同时记下**已知代价**：本阶段没有 JSON Schema 校验（只查必填与顶层类型），模型给一个 `offset: "abc"` 会一路走到 `readFile` 才炸——阶段 5 补上；`bash` 无输出上限的实时流（`onUpdate`）也留到阶段 5。

- [ ] **Step 5: 提交文档**

```bash
git add docs/stages/02-tools-and-loop.md
git commit -m "docs(stage-2): why tool errors go back to the model"
```

---

## 完成标准

Task 5 的五步全绿后，阶段 2 达成（对照 spec §5 阶段 2 的四条验收）：

- [ ] 假模型脚本「第一次 2 个 toolCall，第二次文本答案」时，`messages` 顺序为 `[user, assistant(toolCall×2), toolResult×2, assistant(text)]`（验收 1、2）
- [ ] 未知工具、工具抛错、`stopReason: "length"` 三种分支都产生 `isError` 结果**且循环继续**（验收 3）
- [ ] `read` / `edit` / `bash` 各有测试；`edit` 的 `oldText` 出现 0 次与多次都报错**且文件未被修改**（验收 4）
- [ ] `pnpm test` 与 `pnpm check` 从仓库根全绿，`cli` 无 test 脚本不报错
- [ ] 每个 `src` 文件 < 200 行；`src` 增量 < 400 行
- [ ] `grep -rn "fake\|anthropic" packages/core/src/` 仍无匹配（阶段 1 的边界没被破坏）
- [ ] 循环只有**一层**（`grep -c "while\|for (let turn" packages/core/src/agent-loop.ts` 为 1）
- [ ] `docs/stages/02-tools-and-loop.md` 写完并提交
- [ ] 6 次 commit，message 形如 `feat(stage-2): ...` / `docs(stage-2): ...`

**commit 数：6**（Task 1 一次、Task 2 一次、Task 3 两次——假模型的 `stopReason` 扩展单独一次便于回退、Task 4 一次、Task 5 两次——代码与文档分开，与阶段 1 的做法一致）。

完成后交给用户回测：用户就「决策点」的四问提问，回答不清的地方改文档。
