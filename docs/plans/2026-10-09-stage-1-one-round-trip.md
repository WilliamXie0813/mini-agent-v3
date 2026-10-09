# 阶段 1「一次往返」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起零构建 pnpm workspace，交付一个能跑的 CLI——输入一句话，确定性的假模型回一句话，消息历史里留下 `[user, assistant]` 两条。

**Architecture:** 三个包，依赖方向严格单向 `cli → core → ai`。`ai` 定义消息 IR 与 `StreamFn` 函数类型，并在模块级单例插槽里被安装；`core` 的 `agentLoop` 只认识 `StreamFn` 这个签名，不认识任何 provider；`cli` 负责组装——把假模型通过插槽装进去。假模型是 `ai` 里的一个合法实现（与阶段 7 的 `anthropic.ts` 同层），不是测试目录里的替身。

**Tech Stack:** TypeScript 5.9.3（`strict` + `erasableSyntaxOnly`）、Node 24（`--experimental-strip-types`，零构建）、pnpm workspaces、vitest 3。零运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md`（阶段 1 见 §5「阶段 1 —— 一次往返」，目录结构见 §7.1）

## Global Constraints

从 spec 逐条抄录，每个任务都隐含包含本节：

- **零运行时依赖**。所有包 `dependencies` 为空；`devDependencies` 只有 `typescript@5.9.3`、`@types/node@22.19.19`、`vitest@^3`。验收第 4 条明确要求 `node_modules` 里没有任何运行时依赖。
- **`erasableSyntaxOnly: true`**。禁止 `enum`、构造函数参数属性（`constructor(private x: T)`、`constructor(readonly x: T)`）、`namespace`。类型导入必须用 `import type`。这是真实约束不是风格偏好——违反会在运行时直接报错。
- **可擦除语法下，跨包导入用包名，包内相对导入带 `.ts` 后缀**。`moduleResolution: NodeNext` + `allowImportingTsExtensions: true`。
- **tab 缩进**；每个 `src` 文件 < 200 行（超限是职责该拆的信号）。
- **注释解释「为什么」，不解释「是什么」**。
- **`pnpm dev` 必须走 `node --experimental-strip-types`，不走 vitest**——保留真实进程语义（阶段 4 要测 Ctrl+C，阶段 9 要 kill 进程测恢复）。
- **每阶段只加一个新概念**；不许提前实现下一阶段的内容。本阶段的新概念是「消息 IR + `StreamFn` 注入缝」。**本阶段不做**：工具调用、流式 delta、`Agent` 类、事件分层、错误编码为事件（阶段 1-3 的 LLM 错误直接抛）。
- **`pnpm test` 与 `pnpm check` 必须全绿**才算完成。
- 本阶段源码预算 ~250 行（含配置）。

## 已验证的环境假设

以下四条在本机（Node v24.14.1 / TypeScript 5.9.3）已实测通过。写进计划是因为它们决定了几处配置的写法，且**失败模式很不直观**：

| 假设 | 结论 | 若不成立会怎样 |
|---|---|---|
| `pnpm` 软链 + Node 解析 realpath，使跨包 TS 导入可用 | ✅ 通过 | — |
| Node 24 拒绝擦除**物理位于 `node_modules` 内**的 `.ts` 文件 | ✅ 确认（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`） | **`nodeLinker` 必须保持 pnpm 默认的 `symlinked`**。任何把包物化进 `node_modules` 的安装方式（npm、yarn 的 node-modules linker、pnpm `node-linker=hoisted`）会在第一次 import 时炸掉。不要加 `.npmrc` 改这个值 |
| vitest 3 能直接吃 workspace 里 `exports` 指向 `.ts` 的包 | ✅ 通过 | — |
| `tsc` NodeNext 能解析 `exports: { ".": "./src/index.ts" }` 的包名导入 | ✅ 通过 | — |

另有一处**坑**：各包 `tsconfig.json` 的 `include` 只覆盖自己，`tsc --noEmit` 因此**看不到别的包里的违规语法**。`erasableSyntaxOnly` 只在文件被包含时生效。所以 `pnpm check` 必须 `pnpm -r` 递归到每个包执行，而不是只在根跑一次。

## Review Focus

spec 是愿景文档，它没写的输入不等于可以崩。以下是本阶段最可能咬到使用者的五类，每一条都在下方对应任务的测试里钉住：

1. **插槽未安装就调用 `agentLoop`**——使用者忘了 `setDefaultStreamFn`。合理预期：抛出指名道姓的错误（"no default stream fn installed"），而不是 `undefined is not a function`。
2. **假模型脚本耗尽**——脚本比对话轮数短。合理预期：复用最后一条（可预测），而不是返回 `undefined` 让下游炸在 `content` 上。
3. **`AbortSignal` 已 aborted**——用户按了 Ctrl+C 但模型还在跑。合理预期：循环在调用模型**之前**就退出，不产生半条 assistant 消息。
4. **空输入 / 空白输入**——用户在 CLI 直接敲回车，或只敲空格。合理预期：不进入循环、不产生消息（否则历史里会出现 content 为空的 user 消息，污染后续轮次）。
5. **模型返回空 content 数组**——假模型脚本给了 `[]` 或空串。合理预期：仍产出一条 `stopReason` 为 `"stop"` 的 assistant 消息，历史长度照常为 2，而不是静默少一条让断言在别处炸。

---

### Task 1: workspace 骨架

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`（已存在，核对内容即可）

**Interfaces:**
- Consumes: 无（这是第一个任务）
- Produces: 三个根配置文件。后续任务依赖的事实：workspace 覆盖 `packages/*`；`tsconfig.base.json` 提供全部编译选项，各包 `tsconfig.json` 只 `extends` 它并声明自己的 `include`；根 scripts 用 `pnpm -r` 转发。

- [ ] **Step 1: 写根 `package.json`**

私有的、`"type": "module"`，scripts 按 spec §7.1 的分工表。`dev` 必须转发到 `cli` 而不是并行跑所有包——本阶段只有 `cli` 有 dev：

```json
{
	"name": "mini-agent-v3",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "pnpm --filter @mini-agent/cli run dev",
		"test": "pnpm -r run test",
		"check": "pnpm -r run check"
	}
}
```

- [ ] **Step 2: 写 `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
allowBuilds:
  esbuild: true
```

`allowBuilds` 里的 `esbuild` 是 vitest 的依赖（pnpm v12 语法）。**不要**加 `node-linker` 字段——见上方「已验证的环境假设」第二条。

- [ ] **Step 3: 写 `tsconfig.base.json`**

逐项抄自 spec §7.1 与 §2，不做增删：

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"lib": ["ES2023"],
		"strict": true,
		"noEmit": true,
		"erasableSyntaxOnly": true,
		"allowImportingTsExtensions": true,
		"skipLibCheck": true,
		"types": ["node"]
	}
}
```

`"types": ["node"]` 是必需的：假模型和 CLI 都要用全局的 `console` / `process`，而 `@types/node` 装在各个包里，不显式声明 `types` 时 `tsc` 会报 `Cannot find name 'console'`。

- [ ] **Step 4: 核对 `.gitignore`**

确认包含 `node_modules/`、`.env`、`.mini-agent/`（spec §7.1）。文件已在上次会话创建，读一遍核对即可，缺项则补。

- [ ] **Step 5: 验证 workspace 能装（此时还没有包，`pnpm install` 应该成功但什么都不装）**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm install
```

Expected: 成功退出。`node_modules` 可能不存在或只有一个空的 `.modules.yaml`——**这是正常的**，`packages/` 还是空的。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore
git commit -m "chore(stage-1): scaffold zero-build pnpm workspace"
```

---

### Task 2: `@mini-agent/ai` —— 消息 IR 与注入插槽

本阶段的核心。这个任务定下三个类型和两个函数，后续 12 个阶段都建立在它们之上。

**Files:**
- Create: `packages/ai/package.json`
- Create: `packages/ai/tsconfig.json`
- Create: `packages/ai/vitest.config.ts`
- Create: `packages/ai/src/types.ts`
- Create: `packages/ai/src/stream-fn.ts`
- Create: `packages/ai/src/fake.ts`
- Create: `packages/ai/src/index.ts`
- Test: `packages/ai/test/stream-fn.test.ts`
- Test: `packages/ai/test/fake.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `tsconfig.base.json`、workspace 配置
- Produces: 以下具名导出，Task 3 与 Task 4 直接使用，**签名逐字照抄**：

```ts
// types.ts
type ContentBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
type Role = "system" | "user" | "assistant" | "toolResult";

interface SystemMessage       { role: "system"; content: string }   // 阶段 8 改写为增量段落
interface UserMessage         { role: "user"; content: ContentBlock[] }
interface AssistantMessage    { role: "assistant"; content: ContentBlock[];
                                stopReason: StopReason; usage?: Usage; durationMs?: number }
interface ToolResultMessage   { role: "toolResult"; toolCallId: string; toolName: string;
                                content: ContentBlock[]; isError: boolean }
type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

interface Usage { inputTokens: number; outputTokens: number }

interface Tool {                                    // 本阶段只是声明，不实现执行
	name: string;
	description: string;
	parameters: Record<string, unknown>;            // JSON Schema；阶段 2 换成 JSONSchema 类型
}

interface StreamContext { system: SystemMessage; messages: Message[]; tools: Tool[] }

type AssistantMessageEvent =
	| { type: "start"; message: AssistantMessage }
	| { type: "done"; message: AssistantMessage };   // 阶段 3 插入 delta 变体

// stream-fn.ts
type StreamFn = (context: StreamContext, signal?: AbortSignal) => AsyncGenerator<AssistantMessageEvent>;
function setDefaultStreamFn(fn: StreamFn | undefined): void;
function getDefaultStreamFn(): StreamFn;             // 未设置时抛错

// fake.ts
function createFakeStreamFn(script: string[]): StreamFn;
```

- [ ] **Step 1: 写 `packages/ai/package.json`**

```json
{
	"name": "@mini-agent/ai",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"exports": { ".": "./src/index.ts" },
	"scripts": {
		"test": "vitest run",
		"check": "tsc --noEmit"
	},
	"devDependencies": {
		"@types/node": "22.19.19",
		"typescript": "5.9.3",
		"vitest": "^3"
	}
}
```

`dependencies` 字段**完全不出现**——不是空对象。这是「零运行时依赖」在结构上的可见性。

- [ ] **Step 2: 写 `packages/ai/tsconfig.json` 与 `packages/ai/vitest.config.ts`**

```json
// tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 3: 写 `packages/ai/src/types.ts`**

把 Interfaces 块里的类型全部落下来，加注释说明**为什么** `content` 是块数组而不是字符串（spec §4：一次响应里 text 与 toolCall 可以共存且顺序有意义），以及为什么 `StopReason` 从第 1 阶段就用全集（避免后续加分支）。

关键点：`StopReason` 的六个成员**全部**写上，即使本阶段只会产生 `"stop"`。spec §4 明确要求。

- [ ] **Step 4: 写失败测试 `packages/ai/test/stream-fn.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setDefaultStreamFn, getDefaultStreamFn } from "../src/stream-fn.ts";
import type { StreamFn } from "../src/stream-fn.ts";

describe("stream-fn slot", () => {
	beforeEach(() => setDefaultStreamFn(undefined));

	it("throws a named error when no implementation is installed", () => {
		expect(() => getDefaultStreamFn()).toThrow(/no default stream fn/i);
	});

	it("returns the installed implementation", () => {
		const fn: StreamFn = async function* () {};
		setDefaultStreamFn(fn);
		expect(getDefaultStreamFn()).toBe(fn);
	});

	it("can be cleared back to the uninstalled state", () => {
		setDefaultStreamFn(async function* () {});
		setDefaultStreamFn(undefined);
		expect(() => getDefaultStreamFn()).toThrow(/no default stream fn/i);
	});
});
```

- [ ] **Step 5: 运行测试确认失败**

Run: `cd packages/ai && pnpm test`
Expected: FAIL —— `Failed to resolve import "../src/stream-fn.ts"`（文件还不存在）。

- [ ] **Step 6: 写 `packages/ai/src/stream-fn.ts`**

模块级单例插槽。实现要点：

- 模块作用域一个 `let defaultStreamFn: StreamFn | undefined`。
- `setDefaultStreamFn` 直接赋值（接受 `undefined` 即清除）。
- `getDefaultStreamFn` 未安装时 `throw new Error("no default stream fn installed; call setDefaultStreamFn() at composition root")`——**错误信息必须含 "no default stream fn"**，Step 4 的测试正则依赖它。
- 用 `import type { ... } from "./types.ts"`（可擦除语法要求）。

这个文件应当在 20 行左右。**不要**在这里加注册表、优先级、多 provider 支持——那正是 spec §3.2(a) 用函数而非 `interface Provider` 要避开的一串仪式。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd packages/ai && pnpm test`
Expected: PASS，3 个测试全绿。

- [ ] **Step 8: 写失败测试 `packages/ai/test/fake.test.ts`**

覆盖 Review Focus 第 2、5 条：

```ts
import { describe, it, expect } from "vitest";
import { createFakeStreamFn } from "../src/fake.ts";
import type { AssistantMessage } from "../src/types.ts";

async function run(fn: ReturnType<typeof createFakeStreamFn>, round = 1) {
	const events = [];
	for await (const e of fn({ system: { role: "system", content: "s" }, messages: [], tools: [] }))
		events.push(e);
	return events;
}

describe("createFakeStreamFn", () => {
	it("yields start then done, in that order", async () => {
		const events = await run(createFakeStreamFn(["hi"]));
		expect(events.map((e) => e.type)).toEqual(["start", "done"]);
	});

	it("returns the script entry matching the conversation round", async () => {
		const fn = createFakeStreamFn(["first", "second"]);
		const r1 = await run(fn, 1);
		const r2 = await run(fn, 2);
		expect((r1.at(-1)!.message as AssistantMessage).content).toEqual([{ type: "text", text: "first" }]);
		expect((r2.at(-1)!.message as AssistantMessage).content).toEqual([{ type: "text", text: "second" }]);
	});

	it("reuses the last script entry once the script is exhausted", async () => {
		const fn = createFakeStreamFn(["only"]);
		const a = await run(fn, 1);
		const b = await run(fn, 5);
		expect((a.at(-1)!.message as AssistantMessage).content[0]).toMatchObject({ text: "only" });
		expect((b.at(-1)!.message as AssistantMessage).content[0]).toMatchObject({ text: "only" });
	});

	it("still produces a complete message when the script entry is an empty string", async () => {
		const events = await run(createFakeStreamFn([""]));
		const done = events.at(-1)!.message as AssistantMessage;
		expect(done.content).toEqual([{ type: "text", text: "" }]);
		expect(done.stopReason).toBe("stop");
	});
});
```

`round` 参数由测试自己传（`run(fn, 2)`）——假模型内部按**被调用次数**索引脚本，而不是真的去数 `messages` 长度。这样测试不必构造历史，第 2 阶段扩展成按轮次返回 toolCall 时也只改内部实现。

- [ ] **Step 9: 运行测试确认失败**

Run: `cd packages/ai && pnpm test`
Expected: FAIL —— `Failed to resolve import "../src/fake.ts"`。

- [ ] **Step 10: 写 `packages/ai/src/fake.ts`**

`createFakeStreamFn(script: string[]): StreamFn`。实现要点：

- 闭包内一个 `let callIndex = 0`。
- 取脚本条目：`script[Math.min(callIndex, script.length - 1)]`——这就是「脚本耗尽后复用最后一条」的实现，Review Focus 第 2 条。
- 先 `yield { type: "start", message: pending }`，再 `yield { type: "done", message: final }`。`pending` 与 `final` 都构造完整的 `AssistantMessage`，`stopReason: "stop"`，`content: [{ type: "text", text }]`。空字符串也照常产出（Review Focus 第 5 条）。
- `callIndex++` 放在 yield 之后（或之前，只要每次调用恰好加一次）。
- **不改 `context`、不读 `signal`**——本阶段没有可取消的等待。`signal` 参数保留在签名里以符合 `StreamFn`（不写参数名会导致 lint 噪音；用 `_signal` 前缀或直接省略均可，但**签名必须与类型兼容**）。

**不要**额外导出调用计数 getter（`getFakeStreamFnCallCount` 之类）。断言调用次数用行为即可——连续调用两次，第二次拿到「第二条 / 最后一条」就证明计数正确。多一个只为测试存在的 getter，就是往生产代码里塞测试脚手架。

- [ ] **Step 11: 写 `packages/ai/src/index.ts`**

re-export `./types.ts`、`./stream-fn.ts`、`./fake.ts` 的公共符号。`types.ts` 里全是类型，导出时用 `export type *` 或逐个 `export type`——**不能用 `export *` 导类型之外的东西再去 import type**，可擦除语法下类型和值要分清。

- [ ] **Step 12: 运行测试确认通过**

Run: `cd packages/ai && pnpm test`
Expected: PASS，共 7 个测试。

- [ ] **Step 13: 运行类型检查**

Run: `cd packages/ai && pnpm check`
Expected: 退出码 0，无输出。

若报 `Cannot find name 'console'` 或 `'process'`，说明 `tsconfig.base.json` 的 `"types": ["node"]` 漏了（Task 1 Step 3）。

- [ ] **Step 14: Commit**

```bash
git add packages/ai
git commit -m "feat(stage-1): message IR and StreamFn injection slot"
```

---

### Task 3: `@mini-agent/core` —— 极简 agent loop

只处理**无工具的单轮**。不写 `while` 双层循环、不读 `toolCalls`、不做事件分层——那些是阶段 2 和 4。

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/agent-loop.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-loop.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Message` / `AssistantMessage` / `StreamFn` / `StreamContext` / `getDefaultStreamFn` / `createFakeStreamFn`
- Produces: `agentLoop`，签名逐字如下，Task 4 使用：

```ts
interface AgentLoopOptions {
	prompt: string;
	messages: Message[];              // 已有历史，函数会就地追加
	system: string;                   // 本阶段是纯字符串；阶段 8 改为 SystemMessage
	streamFn?: StreamFn;              // 缺省 fallback 到 getDefaultStreamFn()
	signal?: AbortSignal;
}
function agentLoop(options: AgentLoopOptions): Promise<Message[]>;
```

返回追加后的完整数组（与传入的是同一个引用）。

- [ ] **Step 1: 写 `packages/core/package.json`**

与 Task 2 Step 1 同构，但**加上** `"dependencies": { "@mini-agent/ai": "workspace:*" }`，`exports` 同样指向 `./src/index.ts`，scripts 同样是 `vitest run` / `tsc --noEmit`。

- [ ] **Step 2: 写 `packages/core/tsconfig.json` 与 `packages/core/vitest.config.ts`**

内容与 Task 2 Step 2 完全一致（`include: ["src", "test"]`，vitest `include: ["test/**/*.test.ts"]`）。

- [ ] **Step 3: 写失败测试 `packages/core/test/agent-loop.test.ts`**

覆盖验收第 2 条 + Review Focus 第 1、3、4、5 条：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { setDefaultStreamFn, createFakeStreamFn } from "@mini-agent/ai";
import type { Message } from "@mini-agent/ai";

const base = { messages: [] as Message[], system: "you are a test" };

describe("agentLoop (stage 1: single round trip)", () => {
	beforeEach(() => setDefaultStreamFn(undefined));

	it("appends user then assistant, and stops with stopReason 'stop'", async () => {
		const messages = await agentLoop({ ...base, streamFn: createFakeStreamFn(["hello from fake"]) });
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "user" });
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("wraps the prompt as a single text content block", async () => {
		const messages = await agentLoop({ ...base, prompt: "ping", streamFn: createFakeStreamFn(["x"]) });
		expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "ping" }] });
	});

	it("falls back to the installed default stream fn", async () => {
		setDefaultStreamFn(createFakeStreamFn(["from slot"]));
		const messages = await agentLoop({ ...base, prompt: "hi" });
		expect(messages[1].content).toEqual([{ type: "text", text: "from slot" }]);
	});

	it("throws a named error when no stream fn is available at all", async () => {
		await expect(agentLoop({ ...base, prompt: "hi" })).rejects.toThrow(/no default stream fn/i);
	});

	it("appends to existing history instead of replacing it", async () => {
		const history: Message[] = [
			{ role: "user", content: [{ type: "text", text: "old" }] },
			{ role: "assistant", content: [{ type: "text", text: "old reply" }], stopReason: "stop" },
		];
		const messages = await agentLoop({ ...base, messages: history, prompt: "new",
			streamFn: createFakeStreamFn(["new reply"]) });
		expect(messages).toHaveLength(4);
		expect(messages).toBe(history);
	});

	it("returns without touching history when the signal is already aborted", async () => {
		const messages = await agentLoop({ ...base, prompt: "hi", signal: AbortSignal.abort(),
			streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toHaveLength(0);
	});

	it("returns without touching history for a whitespace-only prompt", async () => {
		const messages = await agentLoop({ ...base, prompt: "   ", streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toHaveLength(0);
	});

	it("still records an assistant message when the model returns empty text", async () => {
		const messages = await agentLoop({ ...base, prompt: "hi", streamFn: createFakeStreamFn([""]) });
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});
```

`AbortSignal.abort()` 是 Node 18+ 的静态方法，返回一个已 aborted 的 signal——不需要真的按 Ctrl+C。

- [ ] **Step 4: 运行测试确认失败**

Run: `cd packages/core && pnpm test`
Expected: FAIL —— `Failed to resolve import "../src/agent-loop.ts"`。

注意：此时 `packages/core/node_modules/@mini-agent/ai` 还不存在，需要先在仓库根跑一次 `pnpm install` 建立软链，否则报的是 `Cannot find package '@mini-agent/ai'`（这是**另一种**失败，别误判成前进了一步）。所以本步骤先 `cd D:/project/harness/mini-agent-v3 && pnpm install`，再跑测试。

- [ ] **Step 5: 写 `packages/core/src/agent-loop.ts`**

实现顺序：

1. **提前返回**：`if (options.signal?.aborted) return options.messages;` 和 `if (options.prompt.trim() === "") return options.messages;`。两条都在构造 user 消息**之前**（Review Focus 第 3、4 条）。
2. 解析 streamFn：`const streamFn = options.streamFn ?? getDefaultStreamFn();`。故意**不用** try/catch——未安装时让 `getDefaultStreamFn` 的错误直接冒泡，测试正则才能匹配到（Review Focus 第 1 条）。
3. 追加 user 消息：`{ role: "user", content: [{ type: "text", text: options.prompt }] }`。
4. 构造 `StreamContext`：`{ system: { role: "system", content: options.system }, messages: [...options.messages], tools: [] }`。`tools` 本阶段恒为 `[]`，但**必须传**——阶段 2 会往里填。
5. `for await` 遍历 `streamFn(context, options.signal)`，**只保留最后一个 `done` 事件**的消息。循环结束后把该消息 push 进 `options.messages`。
6. `return options.messages`。

关于第 5 步的一个设计点：本阶段 `start` 与 `done` 携带的消息内容相同，所以「取最后一个」和「取第一个」结果一样。仍写「取最后一个 `done`」是因为阶段 3 之后 `done` 才是权威（spec §7.3 记的 v1 约定：**只有 `done` 携带的完整消息进入历史**）。现在就把这条写对，阶段 3 不用改这里。

⚠️ 若循环里没有任何 `done` 事件（空生成器），第 5 步会 push `undefined`。**不要**为此加兜底分支——那会掩盖真实 bug。假模型总是发 `done`；真实适配器阶段 7 才来。

- [ ] **Step 6: 写 `packages/core/src/index.ts`**

re-export `./agent-loop.ts`。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd packages/core && pnpm test`
Expected: PASS，8 个测试全绿。

- [ ] **Step 8: 运行类型检查**

Run: `cd packages/core && pnpm check`
Expected: 退出码 0。

- [ ] **Step 9: 验证「core 不认识 provider」在结构上成立**

这一条是本阶段的**决策点**，值得用命令证明而不是靠自觉：

```bash
cd D:/project/harness/mini-agent-v3/packages/core && grep -rn "fake\|anthropic" src/ || echo "OK: core/src mentions no provider"
```

Expected: 输出 `OK: core/src mentions no provider`。

若 grep 有命中（测试文件不算，只看 `src/`），说明注入缝漏了——大概率是把 `createFakeStreamFn` 在 `src/` 里当默认值 import 了。**必须改成通过插槽**。

- [ ] **Step 10: Commit**

```bash
git add packages/core
git commit -m "feat(stage-1): minimal single-round agent loop"
```

---

### Task 4: `@mini-agent/cli` —— 终端入口

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`

无测试文件——CLI 是 I/O 接线层，它的逻辑（循环、历史累积）已在 Task 3 被测过。验收第 1 条用真实运行验证。

**Interfaces:**
- Consumes: Task 3 的 `agentLoop`；Task 2 的 `setDefaultStreamFn` / `createFakeStreamFn` / `Message`
- Produces: 可执行入口 `packages/cli/src/index.ts`，由根 `pnpm dev` 调用

- [ ] **Step 1: 写 `packages/cli/package.json`**

与 Task 3 Step 1 同构，`dependencies` 只写 `"@mini-agent/core": "workspace:*"`（**cli 不直接依赖 `ai`**——它通过 core 拿到类型，安装假模型时用的 `setDefaultStreamFn` 从哪来见 Step 3 说明）。`dev` script 按 spec §7.1：

```json
"scripts": {
	"dev": "node --experimental-strip-types src/index.ts",
	"check": "tsc --noEmit"
}
```

**没有 `test` script**——根 `pnpm test` 用 `pnpm -r run test`，`-r` 会跳过没有该 script 的包。这是刻意的：CLI 无单测。

- [ ] **Step 2: 写 `packages/cli/tsconfig.json`**

`{ "extends": "../../tsconfig.base.json", "include": ["src"] }`（无 `test`）。

- [ ] **Step 3: 写 `packages/cli/src/index.ts`**

组装根 + REPL。实现要点：

- **组装这一件事必须发生在文件顶部、任何循环之前**：`setDefaultStreamFn(createFakeStreamFn([...]))`。这就是 spec §3.2(a) 说的"组装方安装默认实现"——cli 是唯一知道用哪个 provider 的地方。
- ⚠️ **这里需要 import `@mini-agent/ai`**，但 cli 的 `dependencies` 里只有 `core`。两种做法，**选后者**：
  - (a) 在 cli 的 `dependencies` 里加 `@mini-agent/ai` —— 直接、诚实，cli 确实要用它。
  - (b) 让 core 的 `index.ts` 顺带 re-export `ai` 的类型和插槽函数 —— 省一个依赖项，但**掩盖了 cli 直接使用 provider 层的事实**，且让 core 的公共面变得含糊。

  **采用 (a)**：在 `dependencies` 里同时写 `@mini-agent/core` 与 `@mini-agent/ai`，两者都是 `workspace:*`。理由——cli 作为组装根，本来就同时认识 core 和 provider；把这条依赖藏起来只会让「谁负责组装」变模糊。注意这不违反依赖方向：`cli → ai` 与 `cli → core → ai` 并存，仍然是单向无环，spec §7.1 的 `cli → core → ai` 描述的是 core 不反向依赖 cli。
- readline 用 `node:readline/promises`（Node 18+ 内置，零依赖）：

```ts
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
```

- 打印一个提示符说明这是阶段 1（例如 `mini-agent (stage 1) — type /exit to quit`）。
- 循环体：读一行 → 若是 `"/exit"` 则 `break` → `await agentLoop({ prompt: line, messages, system, })` → 打印最后一条 assistant 消息的 text 块。
- `messages` 声明在循环外，跨轮累积——这样能**肉眼验证历史在增长**，也是阶段 9 持久化的雏形。
- 打印助手回复时提取 text 块：`message.content.filter(c => c.type === "text").map(c => c.text).join("")`。不要直接 `console.log(message.content)`（会打出对象）。
- `rl.close()` 放在 `finally` 里。
- 空行/空白行会被 `agentLoop` 提前返回（Task 3 Step 5 第 1 条），所以 CLI **不需要**自己判空——重复的判断会让两处规则有分叉的可能。

- [ ] **Step 4: 装依赖并跑通**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm install
```

Expected: 成功，且 `packages/cli/node_modules/@mini-agent/` 下出现 `core` 与 `ai` 两个软链。

- [ ] **Step 5: 手动验证验收第 1 条**

```bash
cd D:/project/harness/mini-agent-v3 && pnpm dev
```

输入 `你好`，回车。
Expected: 打印假模型的固定问候（`createFakeStreamFn` 脚本里那条），然后回到提示符。再输入一句，仍得到问候（脚本耗尽后复用最后一条）。输入 `/exit` 退出。

⚠️ 假模型的问候文案由 Task 4 Step 3 填的脚本决定。**用一句能一眼看出是假模型的话**（例如 `"Hello from the deterministic fake model."`），不要写成像真实回复的句子——否则阶段 7 接真实模型时，无法从输出判断到底切换成功了没有。

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(stage-1): readline CLI wiring the fake model through the slot"
```

---

### Task 5: 全量验收与阶段文档

**Files:**
- Create: `docs/stages/01-one-round-trip.md`
- Modify: 无（若前四个任务都干净）

**Interfaces:**
- Consumes: Task 1-4 的全部产物
- Produces: 阶段文档——spec §7.4 明确说这是**学习的主载体**

- [ ] **Step 1: 从仓库根跑全量测试**

Run: `cd D:/project/harness/mini-agent-v3 && pnpm test`
Expected: `ai` 7 个、`core` 8 个测试通过，`cli` 被跳过（无 test script）。**必须从根跑**——单包跑通不代表根跑通，`pnpm -r` 的转发本身也是首次验证。

- [ ] **Step 2: 从仓库根跑全量类型检查（验收第 3 条）**

Run: `cd D:/project/harness/mini-agent-v3 && pnpm check`
Expected: 三个包的 `tsc --noEmit` 全部退出 0。

若 `cli` 报错而单包时不报，检查 `include` 是否漏了 `src`。

- [ ] **Step 3: 验证零运行时依赖（验收第 4 条）**

```bash
cd D:/project/harness/mini-agent-v3 && cat packages/*/package.json | grep -A2 '"dependencies"'
```

Expected: 只有 `@mini-agent/ai` 和 `@mini-agent/core` 这两个 `workspace:*`，没有任何 registry 包。

更硬的一条检查——直接看安装树里有没有非 workspace 的**生产**依赖：

```bash
cd D:/project/harness/mini-agent-v3 && pnpm list -r --depth 0 --prod
```

Expected: 每个包下面只有指向 workspace 兄弟包的条目，没有 `vitest` / `typescript` / `@types/node`（它们应当只出现在 dev 那一栏）。

- [ ] **Step 4: 验证「只加一个新概念」——确认没有提前实现阶段 2**

```bash
cd D:/project/harness/mini-agent-v3 && grep -rn "toolCall\|while" packages/*/src/
```

Expected: `types.ts` 里有 `toolCall` 的**类型定义**（spec §4 要求 IR 完整），但**没有任何代码路径处理它**；没有 `while` 循环。

这是本阶段最重要的一次自我审查。看到 `agent-loop.ts` 里出现 `while` 或对 `toolCall` 的分支，就是越界了。

- [ ] **Step 5: 数源码行数（预算 ~250 行）**

```bash
cd D:/project/harness/mini-agent-v3 && wc -l packages/*/src/*.ts packages/*/test/*.ts
```

Expected: `src` 合计 ~250 行上下（含配置则略多）。同时确认**每个 `src` 文件 < 200 行**（spec §7.2）。本阶段文件都很小，若某个超了，说明职责划分有问题。

- [ ] **Step 6: 写 `docs/stages/01-one-round-trip.md`**

spec §7.4 规定这份文档回答四件事，逐条写：

1. **这个阶段解决了什么问题**——在没有任何架构约束的情况下，"模型调用"会被直接写死在循环里，第 7 阶段换真实 provider 时要动整个运行时。本阶段把这条边界先立起来。
2. **Pi 的哪条决策是答案**——`StreamFn` 是**函数类型**而非 `interface Provider`（`packages/agent/src/stream-fn.ts`，20 行）。只有一个方法时，接口会带来实现类、构造、注册表一串仪式；函数可以内联写。以及：core 不 import 任何 provider，靠模块级单例插槽注入。
3. **替代方案为什么更差**——三个替代：(a) `interface Provider` + 实现类，仪式成本；(b) core 直接 `import` 假模型，则第 7 阶段必须改 core；(c) 把 streamFn 作为 `agentLoop` 的**必填**参数，则每个调用点都要传，且阶段 4 的 `Agent` 类构造参数会膨胀——本计划选的是"可选、缺省 fallback 到插槽"，两头都留了。
4. **决策点**（供回测）——为什么 `StreamFn` 是函数而不是 `interface Provider`？为什么 core 不 `import` 任何 provider？**另外补一条本阶段新发现的**：为什么假模型住在 `packages/ai/src/fake.ts` 而不是 `packages/core/test/`？（答案见本计划头部与 spec §5 阶段 1 的补充说明：它是 provider 层的一个合法实现，与阶段 7 的 `anthropic.ts` 同层；放测试目录会让生产入口 import 测试目录，并掩盖"cli/core 都不认识 provider"这一事实。）

文档里同时记下 Phase 1 的已知代价：`SystemMessage.content` 现在是 `string`，阶段 8 会改写成增量段落数组。**这是路线里唯一一次刻意回头改前面的代码**（spec §3.2(b)），在这里先埋下记号，阶段 8 才有对照。

- [ ] **Step 7: Commit**

```bash
git add docs/stages/01-one-round-trip.md
git commit -m "docs(stage-1): why the StreamFn seam is a function in a slot"
```

---

## 完成标准

Task 5 的六步全绿后，阶段 1 达成：

- [ ] `pnpm dev` 输入一句话，假模型回一句固定问候（验收 1）
- [ ] 测试断言一轮后 `messages` 长度为 2 且 `stopReason === "stop"`（验收 2）
- [ ] `pnpm test` 与 `pnpm check` 从仓库根全绿（验收 3）
- [ ] 无任何运行时依赖（验收 4）
- [ ] `docs/stages/01-one-round-trip.md` 写完并提交（spec §7.4）
- [ ] 5 次 commit，message 形如 `feat(stage-1): ...`

**commit 数：5**（Task 1-5 各一次）。spec §7.4 写的是"每阶段一次 commit"——那是对**阶段**的粒度要求（一次功能提交 + 一次文档提交可接受），此处按任务的天然边界拆成 5 次，便于逐任务 review 与回退。

完成后交给用户回测：用户就「决策点」提问，回答不清的地方改文档。
