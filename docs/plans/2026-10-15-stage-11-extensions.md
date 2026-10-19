# 阶段 11「扩展系统」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不导入任何 core 运行时代码的前提下，让内联扩展能注册工具、观察会话事件，并通过六个 hook 参与决策；同时用一个挂在扩展里的第二 `StreamFn` 实现证明替换 provider 不需要改 core。

**Architecture:** 新增 `packages/extensions`（`@mini-agent/extensions`），其中 `ExtensionRunner` 实现 `ExtensionAPI`（`on` / `registerTool` / `registerCommand`）。core 把阶段 5/10 的六个 hook 补齐为 `SessionHooks` 并全部下传：`transformContext` 在 `prepareRequest` 之后、`streamFn` 之前过滤消息；`afterToolCall` 在 `finalizeToolCall` 之后、`emitToolEnd` 之前改写结果；`finishTurn` 在 `turn_end` 之后决定收敛或续一轮；`prepareNextTurnWithContext` 在下一轮顶部追加一个真实 `SystemMessage`（因此进 journal、可 replay、保持 prompt 前缀稳定）。扩展只拿到 `import type` 的 core 类型，全部行为通过 `SessionHooks` 与既有 `AgentEvent` 流接入。

**Tech Stack:** Node 22+、TypeScript 5.9.3（strict + erasableSyntaxOnly）、pnpm workspaces、vitest 3、现有 `StreamFn` / `AssistantMessageEventStream` / `AgentEvent` / `AgentSession`。零新增运行时依赖（`@mini-agent/ai` 是工作区内既有包）。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md` §3.2(a)、§5 阶段 11、§7；前置能力见 `docs/stages/09-session-persistence.md`、`docs/stages/10-context-compaction.md`。

> **关于第二 StreamFn 实现（Task 8）**：spec §5 阶段 11 写的是「用 ai-sdk 做第二实现」，但 spec §2/§4 同时要求零运行时依赖，两者冲突。本计划按「自写第二实现」执行，并把 Task 8 做成**可整节替换**：只换 Task 8 的文件与测试，其余 8 个 Task 一字不动。若要改回 ai-sdk，把 `createSecondStreamFn` 换成基于 `@ai-sdk/anthropic` 的构造器即可，挂载方式（`getDefaultStreamFn()` 读取 + 包裹 + `setDefaultStreamFn()` 安装）完全相同。

## Global Constraints

- **只加一个新概念**：扩展系统。不得提前实现阶段 12 的 WebSocket/UI、阶段 13 的子 agent/双队列或 followUp 队列，不得实现文件式扩展加载（`jiti`、npm 分发、`inline`/`file` 双来源），不得实现 Pi 的 `registerShortcut` / `registerFlag` / `registerMessageRenderer` / `registerEntryRenderer` / `registerToolRenderer` / `registerMarkdownTransformer`。
- 先写失败测试，再写最小实现；每个任务独立提交。阶段结束时 `pnpm test` 与 `pnpm check` 全绿。
- **依赖方向单向**：`packages/extensions/src/**` 只允许 `import type` 引用 `@mini-agent/core`，禁止任何来自 core 的运行时导入、禁止深层路径导入（`@mini-agent/core/src/...`）。这是本阶段唯一的架构不变量，由结构性测试强制。测试文件（`packages/extensions/test/**`）不受此限。
- `@mini-agent/core` 放在 `packages/extensions/package.json` 的 `devDependencies` 而非 `dependencies`：类型可见、运行时不可依赖。`@mini-agent/ai` 放 `dependencies`。
- 零新增运行时依赖（工作区内的 `@mini-agent/ai` 不算）。禁止引入 `@ai-sdk/*`、`jiti`、`zod` 或任何 npm 包。
- tab 缩进；ESM；包内相对导入带 `.ts`；跨包用包名；类型导入用 `import type`。
- `strict: true`、`erasableSyntaxOnly: true`；禁止 `enum`、构造函数参数属性、`namespace` 和 `as any`。
- **六个 hook 就是全部接入面**：`beforeToolCall`、`afterToolCall`、`transformContext`、`prepareRequest`、`finishTurn`、`prepareNextTurnWithContext`。扩展不得要求 core 新增第七个 hook；`recoverContextOverflow` 与 `commitToolIntent` 仍是 `AgentSession` 内部所有权 hook，不进 `SessionHooks`。
- `AgentOptions` 继承 `SessionHooks`（六个 hook 保持扁平字段，阶段 5/10 的调用方式不变）；`AgentSessionOptions` 用 `Omit` 摘掉全部六个 hook，只允许通过 `hooks?: SessionHooks` 注入。core 的 hook 字段是**替换**语义，不允许调用方同时用扁平字段和 `hooks` 注入同一个 hook。
- **session 内部先跑，扩展后装饰**：`AgentSession` 的 threshold 压缩 `prepareRequest` 先执行并从 journal 重新投影，扩展的 `before_provider_request` 只拿到这个结果做二次加工。扩展不得绕过 journal。
- **hook 执行顺序固定**：`turn_start` → `prepareNextTurnWithContext`（仅第 2 轮起，返回值落成真实 `SystemMessage`）→ 从 transcript 重放 system/tools → `prepareRequest` → 按 prepared.tools 过滤 `activeTools` → **`transformContext`** → `streamFn` → `turn_end` → `finishTurn`。
- **`transformContext` 契约**：返回数组必须非空，且每个元素必须与入参数组中的某一元素**引用相同**（`input.includes(message)`）。删条目、重排、换顺序都允许；伪造新对象抛 `TypeError`，作为基础设施失败中止本次 run。这条防的是「扩展悄悄改写历史」，不是风格偏好。
- **`afterToolCall` 能力边界**：只能覆盖 `content` 与 `isError`。不得改 `durationMs`（core 用 `performance.now()` 单调时钟测量）、不得改 `terminate`（循环控制，同阶段 5 的 `beforeToolCall`）、不得让未执行的工具「复活」。`failTruncatedToolCalls` 路径**不调用** `afterToolCall`——截断信号必须可见。覆盖后的值必须同时进入 `tool_execution_end` 事件与 toolResult 消息（单次覆盖、两个消费者）。
- **`finishTurn` 能力边界**：只在模型正常收敛的两条分支被咨询（无 toolCall、工具结果之后）。`stopReason` 为 `error`/`aborted` 的轮次不咨询；工具返回 `terminate: true` 的硬停优先于 `finishTurn`，扩展不得复活。`{action:"continue"}` 从同一个 `maxTurns` 预算里再要一轮，预算耗尽时仍抛既有的 `hit maxTurns` 错误。本阶段**不实现** followUp 队列（阶段 13）。
- **`prepareNextTurnWithContext` 返回值必须是真历史**：`sections` / `toolsAdded` / `toolsRemoved` 三者全空时是 no-op（不发事件、不写 journal）；任一非空时追加一条 `role: "system"` 的 `SystemMessage` 到 transcript，走 `message_start` / `message_end` 两个事件，因此被 journal 持久化并可 replay。不得用易失快照替换 system prompt。
- **hook 失败方向按语义固定**，不得统一成一种：
  - `tool_call`（`beforeToolCall`）：handler 抛错 → 记录日志后重抛 → 被 `prepareToolCall` 转成该次工具调用的 error result（fail-closed：工具不执行，模型看到诊断，run 继续）。这是阶段 5 既有行为，不要改。
  - `context` / `before_provider_request` / `turn_end` / `next_turn` / `tool_result`：handler 抛错 → 冒泡为 `AgentInfrastructureFailure`，run 失败。决定分支的 hook 吞掉异常会让 core 静默走**相反**的分支（本该拦下的权限规则没拦下），失败必须见光。
  - 观察类事件（`session_start` / `message_end` / `tool_execution_*`）：handler 抛错 → 捕获、经 logger 记录、run 继续。渲染器和日志器崩掉不该杀死会话。
- hook 链式语义固定：`beforeToolCall` 与 `finishTurn` 是**短路**语义（首个非 `undefined` 返回值生效，后续 handler 不再运行）；`afterToolCall` / `transformContext` / `prepareRequest` 是**折叠**语义（逐个传递上一个的结果，全部运行，最后一个生效）；`prepareNextTurnWithContext` 是**合并**语义（sections 与 toolsAdded 拼接、toolsRemoved 去重，全部运行）。
- 未注册任何 handler 时 `sessionHooks()` 返回空对象（`{}`），缺失的 hook 字段不进入 `AgentOptions`：阶段 1–10 的行为与测试逐字不变。
- 扩展工具与内置工具同表共存；重名在 `registerTool()` 时抛具名错误，合并 `createDefaultTools()` 与 `runner.tools` 时用 `assertUniqueToolNames()` 再查一次。不得靠「后者覆盖前者」解决冲突。
- 扩展观察类事件零 core 改动：直接复用既有 `AgentEvent` 流（`session.subscribe`），`ExtensionRunner.notify()` 只识别 `session_start` / `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` 五种，其余事件类型静默丢弃。
- 所有实施 commits 必须带：

  ```text
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```

- 本计划基于阶段 10 完成点或其后继；执行时使用独立 `stage-11-extensions` 分支/工作树，不改写阶段 1–10 commits。

## Review Focus

1. **扩展绕过 journal 直接改 transcript**：`transformContext` 返回伪造消息对象，或 `prepareNextTurnWithContext` 的返回值不进 journal，都会让「transcript 是唯一事实源」这个从阶段 8 立起来的承诺失效。→ Task 5、Task 7。
2. **`afterToolCall` 覆盖了不该覆盖的字段**：`durationMs` 被改写会破坏阶段 5 的单调时钟承诺；`terminate` 被改写会让循环控制权外泄；截断路径被覆盖会让「参数可能不全」的告警消失。→ Task 4。
3. **`finishTurn` 造出无限循环或绕过硬停**：`{action:"continue"}` 不受 `maxTurns` 约束，或覆盖工具返回的 `terminate: true`，都会让一次 `submit()` 无限烧 token。→ Task 6。
4. **hook 失败方向反了**：决定类 hook 吞异常 → 权限规则静默失效；观察类 hook 抛异常 → 一个渲染 bug 打死整场会话。两边都会在「看起来正常」的情况下出错。→ Task 3、Task 6、Task 9。
5. **扩展悄悄依赖了 core 运行时**：`src/` 里出现 `import { ... } from "@mini-agent/core"`（非 `import type`）或深层路径导入，会让扩展与 core 内部实现耦合，本阶段的全部论证作废。→ Task 1。

---

## 1. 锁定的接口与文件职责

### 1.1 core 新增 hook 类型（`packages/core/src/agent-options.ts`）

```ts
export interface AfterToolCallContext {
	toolCall: ToolCall;
	tool?: ToolDef<any>; // 未找到 / 参数校验失败 / 被 block 时为 undefined
	args: Record<string, unknown>;
	result: ToolResult;
	isError: boolean;
	durationMs: number; // 只读：monotonic，覆盖它没有意义
	messages: readonly Message[];
}
export interface AfterToolCallResult {
	content?: ContentBlock[];
	isError?: boolean;
}
export type AfterToolCall = (
	context: AfterToolCallContext,
	signal?: AbortSignal,
) => AfterToolCallResult | void | Promise<AfterToolCallResult | void>;

export type TransformContext = (
	messages: readonly Message[],
	signal?: AbortSignal,
) => Message[] | Promise<Message[]>;

export interface FinishTurnContext {
	message: Message; // 本轮模型返回的 assistant 消息
	toolResults: ToolResultMessage[];
	messages: readonly Message[]; // 含本轮全部新增
	turn: number; // 0-based
}
export type FinishTurnResult = { action: "end" | "continue" };
export type FinishTurn = (
	context: FinishTurnContext,
	signal?: AbortSignal,
) => FinishTurnResult | void | Promise<FinishTurnResult | void>;

export interface PrepareNextTurnContext {
	messages: readonly Message[];
	turn: number; // 即将开始的轮次序号，>= 1
	signal: AbortSignal;
}
export interface PrepareNextTurnResult {
	sections?: SystemSection[];
	toolsAdded?: Tool[];
	toolsRemoved?: string[];
}
export type PrepareNextTurn = (
	context: PrepareNextTurnContext,
) => PrepareNextTurnResult | void | Promise<PrepareNextTurnResult | void>;

export interface SessionHooks {
	beforeToolCall?: BeforeToolCall;
	afterToolCall?: AfterToolCall;
	transformContext?: TransformContext;
	prepareRequest?: PrepareRequest;
	finishTurn?: FinishTurn;
	prepareNextTurnWithContext?: PrepareNextTurn;
}

export interface AgentOptions extends SessionHooks {
	system: string;
	messages?: Message[];
	tools?: ToolDef<any>[];
	streamFn?: StreamFn;
	maxTurns?: number;
	toolExecution?: ToolExecutionMode;
	commitToolIntent?: CommitToolIntent;
	recoverContextOverflow?: RecoverContextOverflow;
}
```

### 1.2 `AgentSessionOptions`（`packages/core/src/agent-session.ts`）

```ts
export type AgentSessionOptions = Omit<
	AgentOptions,
	| "messages"
	| "commitToolIntent"
	| "prepareRequest"
	| "recoverContextOverflow"
	| "beforeToolCall"
	| "afterToolCall"
	| "transformContext"
	| "finishTurn"
	| "prepareNextTurnWithContext"
> & {
	directory?: string;
	contextWindow?: number;
	compaction?: Partial<CompactionSettings>;
	hooks?: SessionHooks;
};
```

注释写清：六个 hook 与 `commitToolIntent` / `recoverContextOverflow` 一样是**编排所有权**字段，只能经 `hooks` 注入，这样 `createAgent()` 是唯一的合并点。

### 1.3 扩展包类型（`packages/extensions/src/types.ts`）

```ts
import type {
	AfterToolCallResult,
	AgentEvent,
	BeforeToolCallResult,
	FinishTurnResult,
	Message,
	PrepareNextTurnResult,
	SessionHooks,
	StreamContext,
	ToolCall,
	ToolDef,
	ToolExecutionMode,
	ToolResult,
} from "@mini-agent/core";
import type { StreamFn } from "@mini-agent/ai";

// 观察类：来自既有 AgentEvent 流 + CLI 合成的 session_start。
export type ObserverEvent =
	| { type: "session_start"; sessionId: string; filePath: string }
	| Extract<AgentEvent, { type: "message_end" }>
	| Extract<AgentEvent, { type: "tool_execution_start" }>
	| Extract<AgentEvent, { type: "tool_execution_update" }>
	| Extract<AgentEvent, { type: "tool_execution_end" }>;

// 决策类：与六个 core hook 一一对应，一个 hook 一个事件。
export interface DecisionEventHandlers {
	tool_call: (event: ToolCallEvent) => BeforeToolCallResult | void | Promise<BeforeToolCallResult | void>;
	tool_result: (event: ToolResultEvent) => AfterToolCallResult | void | Promise<AfterToolCallResult | void>;
	context: (event: ContextEvent) => Message[] | void | Promise<Message[] | void>;
	before_provider_request: (event: BeforeProviderRequestEvent) => StreamContext | void | Promise<StreamContext | void>;
	turn_end: (event: FinishTurnEvent) => FinishTurnResult | void | Promise<FinishTurnResult | void>;
	next_turn: (event: NextTurnEvent) => PrepareNextTurnResult | void | Promise<PrepareNextTurnResult | void>;
}

export interface ExtensionAPI {
	on<K extends keyof ObserverEventMap>(event: K, handler: (event: ObserverEventMap[K]) => void | Promise<void>): void;
	on<K extends keyof DecisionEventHandlers>(event: K, handler: DecisionEventHandlers[K]): void;
	registerTool<P extends Record<string, unknown>>(tool: ToolDef<P>): void;
	registerCommand(command: ExtensionCommand): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface Extension {
	name: string;
	factory: ExtensionFactory;
	hidden?: boolean;
}

export interface ExtensionContext {
	readonly log: (message: string) => void;
	getStreamFn(): StreamFn | undefined;
	setStreamFn(fn: StreamFn | undefined): void;
}
```

`ExtensionCommand = { name: string; description: string; run: (input: { args: string; context: ExtensionContext }) => void | Promise<void> }`。`ObserverEventMap` 是 `ObserverEvent` 按 `type` 字段建立的映射类型，`Extract` 让它在 `AgentEvent` 增删变体时自动跟随。

### 1.4 文件职责

| 文件 | 职责 |
|---|---|
| `packages/core/src/after-tool-call.ts` | 新建。`applyAfterToolCall(outcome, hook, context, signal)`：返回覆盖后的新 `FinalizedToolCallOutcome`，重建 `message`。不改 `durationMs` / `terminate`。 |
| `packages/core/src/agent-options.ts` | 修改。1.1 的全部类型定义；`AgentOptions extends SessionHooks`。 |
| `packages/core/src/agent-loop.ts` | 修改。`AgentLoopOptions` 增加四个新 hook 字段；`prepareNextTurnWithContext` 插在 `turn > 0` 的循环顶部；`transformContext` 插在 `prepareRequest` 之后、`streamAssistantMessage` 之前；`finishTurn` 插在 `terminate` 判断之后。 |
| `packages/core/src/agent.ts` | 修改。四个新 `public` hook 字段；在 `prompt()` 里与 `prepareRequest` 同款包装成 `AgentInfrastructureFailure`。 |
| `packages/core/src/execute-tool-calls.ts` | 修改。`ExecuteToolCallsOptions.afterToolCall`；顺序路径在 `finalizeToolCall` 后调用 `applyAfterToolCall`。 |
| `packages/core/src/execute-tool-calls-parallel.ts` | 修改。并行 thunk 内与 `finishImmediate` 内调用 `applyAfterToolCall`；保持「end 按完成序、result message 按源序」的阶段 6 规则。 |
| `packages/core/src/agent-session.ts` | 修改。1.2 的 `AgentSessionOptions`；`createAgent()` 合并 `hooks`：session 内部 `prepareRequest` 先跑，其余五个字段直传。 |
| `packages/core/src/index.ts` | 修改。导出新 hook 类型与 `applyAfterToolCall`。 |
| `packages/extensions/package.json` | 新建。`@mini-agent/extensions`，`@mini-agent/ai` 为 dependency，`@mini-agent/core` 为 devDependency，vitest 为 devDependency。 |
| `packages/extensions/tsconfig.json` | 新建。`{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`。 |
| `packages/extensions/vitest.config.ts` | 新建。`test: { include: ["test/**/*.test.ts"] }`。 |
| `packages/extensions/src/types.ts` | 新建。1.3 的全部类型。 |
| `packages/extensions/src/runner.ts` | 新建。`ExtensionRunner`：注册表、六个决策 hook 的组合、观察事件分发、`sessionHooks()`。 |
| `packages/extensions/src/tool-names.ts` | 新建。`assertUniqueToolNames(tools)`。 |
| `packages/extensions/src/second-stream-fn.ts` | 新建（Task 8，可整节替换）。`createSecondStreamFn(inner, options)`。 |
| `packages/extensions/src/demo.ts` | 新建（Task 9）。教学用内联扩展：`word_count` 工具、`bash` 权限规则、toolResult 剪枝 hook、`/demo` 命令。 |
| `packages/extensions/src/bootstrap.ts` | 新建（Task 9）。`bootstrapExtensions(options)`：组装根唯一接入面（`runner` / `hooks` / `tools` / `notify` / `installStreamFn`）。 |
| `packages/extensions/src/index.ts` | 新建。公开导出。 |
| `packages/extensions/test/no-core-runtime-imports.test.ts` | 新建。结构性测试，扫描 `src/**` 强制类型导入边界。 |
| `packages/extensions/test/runner.test.ts` | 新建。注册表、链式语义、失败方向、观察分发。 |
| `packages/extensions/test/second-stream-fn.test.ts` | 新建。第二实现契约。 |
| `packages/extensions/test/integration.test.ts` | 新建。端到端：扩展工具 + 权限规则 + 剪枝 + 第二 StreamFn，走真实 `AgentSession`。 |
| `packages/cli/src/index.ts` | 修改。组装根：创建 `ExtensionRunner`、`use(demo)`、合并工具表、`hooks: runner.sessionHooks()`、`session.subscribe((e) => runner.notify(e))`、`/ext` 列出已注册命令与工具。 |

---

## 2. 任务分解

### Task 1: core hook 类型 + extensions 包骨架 + 导入边界

**Files:**
- Modify: `packages/core/src/agent-options.ts`（在 `RecoverContextOverflow` 之后追加，`AgentOptions` 改为 `extends SessionHooks`）
- Modify: `packages/core/src/index.ts:2`（导出新类型）
- Create: `packages/extensions/package.json`
- Create: `packages/extensions/tsconfig.json`
- Create: `packages/extensions/vitest.config.ts`
- Create: `packages/extensions/src/types.ts`
- Create: `packages/extensions/src/tool-names.ts`
- Create: `packages/extensions/src/index.ts`
- Test: `packages/extensions/test/no-core-runtime-imports.test.ts`
- Test: `packages/extensions/test/tool-names.test.ts`

**Interfaces:**
- Consumes: 阶段 5/10 的 `BeforeToolCall` / `PrepareRequest` / `CommitToolIntent` / `RecoverContextOverflow`（`agent-options.ts`、`tool.ts` 既有定义）。
- Produces: `SessionHooks`、`AfterToolCall` / `AfterToolCallContext` / `AfterToolCallResult`、`TransformContext`、`FinishTurn` / `FinishTurnContext` / `FinishTurnResult`、`PrepareNextTurn` / `PrepareNextTurnContext` / `PrepareNextTurnResult`；`ExtensionAPI`、`ExtensionFactory`、`Extension`、`ExtensionContext`、`ObserverEvent`、`DecisionEventHandlers`、`assertUniqueToolNames`。

- [ ] **Step 1: 在 `packages/core/src/agent-options.ts` 写入 1.1 节的类型**

`AfterToolCallContext.messages` 与 `FinishTurnContext.messages` 都是 `readonly Message[]`（只读视图，扩展不得就地改历史）。`FinishTurnContext` 的 `toolResults` 用 `ToolResultMessage[]`（非 readonly）以匹配 `AgentEvent.turn_end` 的既有形状。`SessionHooks` 的六个字段全部可选。

- [ ] **Step 2: 生成 extensions 包骨架**

`packages/extensions/package.json`：

```json
{
	"name": "@mini-agent/extensions",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"exports": { ".": "./src/index.ts" },
	"scripts": {
		"test": "vitest run",
		"check": "tsc --noEmit"
	},
	"dependencies": {
		"@mini-agent/ai": "workspace:*"
	},
	"devDependencies": {
		"@mini-agent/core": "workspace:*",
		"@types/node": "22.19.19",
		"typescript": "5.9.3",
		"vitest": "^3"
	}
}
```

`@mini-agent/core` 必须在 `devDependencies`：类型可见、运行时不可依赖，这是 1.3 节边界的一半。

- [ ] **Step 3: 写失败的边界测试**

```ts
// packages/extensions/test/no-core-runtime-imports.test.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("extensions source boundary", () => {
	const files = sourceFiles(join(import.meta.dirname, "..", "src"));

	test("every @mini-agent/core import is type-only", () => {
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.includes('"@mini-agent/core"')) continue;
				expect(line, `${file}: ${line}`).toMatch(/^\s*import type\b/);
			}
		}
	});

	test("no deep imports and no third-party runtime deps", () => {
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			expect(text, file).not.toContain("@mini-agent/core/");
			expect(text, file).not.toMatch(/from\s+"@ai-sdk\//);
			expect(text, file).not.toMatch(/from\s+"jiti"/);
		}
	});
});
```

- [ ] **Step 4: 运行边界测试确认失败**

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: FAIL — `src/` 尚不存在，`sourceFiles` 返回空数组，`files.length` 断言失败（`expected 0 to be greater than 0`）。

- [ ] **Step 5: 写 `src/types.ts`（1.3 节全部类型）与 `src/tool-names.ts`**

`ObserverEventMap` 用映射类型从 `ObserverEvent` 派生，不要在 `ExtensionAPI.on()` 上写六个手写重载：

```ts
type ObserverEventMap = { [E in ObserverEvent as E["type"]]: E };
```

`DecisionEventHandlers` 是显式接口（不派生），因为决策事件的负载形状与 core hook 参数不同——多一层转换是刻意的，事件名是稳定契约，hook 签名可以演进。

`src/tool-names.ts`：

```ts
import type { ToolDef } from "@mini-agent/core";

export function assertUniqueToolNames(tools: readonly ToolDef<any>[]): void {
	const seen = new Set<string>();
	for (const tool of tools) {
		if (seen.has(tool.name))
			throw new Error(`duplicate tool name: "${tool.name}"`);
		seen.add(tool.name);
	}
}
```

`src/index.ts` 此时只导出 `types.ts` 与 `tool-names.ts` 的内容。

- [ ] **Step 6: 写失败的 `tool-names` 测试**

```ts
// packages/extensions/test/tool-names.test.ts
import { describe, expect, test } from "vitest";
import { assertUniqueToolNames } from "../src/tool-names.ts";

describe("assertUniqueToolNames", () => {
	test("accepts distinct names", () => {
		expect(() => assertUniqueToolNames([
			{ name: "read", description: "r", parameters: {}, execute: async () => ({ content: [] }) },
			{ name: "echo", description: "e", parameters: {}, execute: async () => ({ content: [] }) },
		])).not.toThrow();
	});

	test("rejects a duplicate and names the offender", () => {
		expect(() => assertUniqueToolNames([
			{ name: "echo", description: "a", parameters: {}, execute: async () => ({ content: [] }) },
			{ name: "echo", description: "b", parameters: {}, execute: async () => ({ content: [] }) },
		])).toThrowError('duplicate tool name: "echo"');
	});
});
```

- [ ] **Step 7: 运行两个测试确认通过**

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: PASS，4 个 test。

- [ ] **Step 8: 确认 core 未受影响**

Run: `pnpm test` 与 `pnpm check`
Expected: 全绿。core 的既有 test 一条不改、一条不减（本任务只加类型，无行为变化）；`@mini-agent/extensions` 加入 workspace 后 `pnpm -r run check` 覆盖到它。

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/agent-options.ts packages/core/src/index.ts packages/extensions
git commit -m "feat(stage-11): add session hook types and extensions package skeleton"
```

---

### Task 2: `ExtensionRunner` 注册表与观察事件分发

**Files:**
- Create: `packages/extensions/src/runner.ts`
- Modify: `packages/extensions/src/index.ts`
- Test: `packages/extensions/test/runner.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ExtensionAPI` / `Extension` / `ExtensionContext` / `ObserverEvent` / `DecisionEventHandlers` / `assertUniqueToolNames`；core 的 `AgentEvent`（type-only）、`ToolDef`、`SessionHooks`。
- Produces: `class ExtensionRunner`，方法签名——`use(extension: Extension): Promise<void>`、`get tools(): ToolDef<any>[]`、`get commands(): ExtensionCommand[]`、`notify(event: AgentEvent): Promise<void>`、`sessionHooks(): SessionHooks`；类型 `ExtensionLogger = (message: string) => void`、`ExtensionRunnerOptions = { log?: ExtensionLogger }`。

- [ ] **Step 1: 写失败的注册表与观察事件测试**

```ts
// packages/extensions/test/runner.test.ts
import { describe, expect, test, vi } from "vitest";
import { ExtensionRunner } from "../src/runner.ts";

const tool = (name: string) => ({
	name, description: name, parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: `${name} ran` }] }),
});

describe("ExtensionRunner registration", () => {
	test("runs factories in order and exposes their tools", async () => {
		const runner = new ExtensionRunner();
		const order: string[] = [];
		await runner.use({ name: "a", factory: () => { order.push("a"); } });
		await runner.use({ name: "b", factory: () => { order.push("b"); } });
		expect(order).toEqual(["a", "b"]);
		expect(runner.tools).toEqual([]);
	});

	test("collects registered tools and commands", async () => {
		const runner = new ExtensionRunner();
		await runner.use({
			name: "demo",
			factory: (api) => {
				api.registerTool(tool("echo"));
				api.registerCommand({ name: "hello", description: "say hi", run: () => {} });
			},
		});
		expect(runner.tools.map((t) => t.name)).toEqual(["echo"]);
		expect(runner.commands.map((c) => c.name)).toEqual(["hello"]);
	});

	test("rejects duplicate tool names at registration", async () => {
		const runner = new ExtensionRunner();
		runner.registerTool(tool("echo"));
		expect(() => runner.registerTool(tool("echo")))
			.toThrowError('duplicate tool name: "echo"');
	});

	test("rejects a duplicate command name", () => {
		const runner = new ExtensionRunner();
		runner.registerCommand({ name: "hello", description: "a", run: () => {} });
		expect(() => runner.registerCommand({ name: "hello", description: "b", run: () => {} }))
			.toThrowError('duplicate command name: "hello"');
	});

	test("a throwing factory names the extension and propagates", async () => {
		const runner = new ExtensionRunner();
		await expect(runner.use({
			name: "broken",
			factory: () => { throw new Error("boom"); },
		})).rejects.toThrowError('extension "broken" failed to initialize: boom');
	});
});

describe("ExtensionRunner.notify", () => {
	test("delivers observer events with the raw AgentEvent payload", async () => {
		const runner = new ExtensionRunner();
		const seen: string[] = [];
		await runner.use({
			name: "logger",
			factory: (api) => {
				api.on("message_end", (event) => { seen.push(`${event.message.role}:end`); });
				api.on("tool_execution_start", (event) => { seen.push(`tool:${event.toolName}`); });
			},
		});
		await runner.notify({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		});
		await runner.notify({
			type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {},
		});
		expect(seen).toEqual(["user:end", "tool:read"]);
	});

	test("ignores events it does not observe", async () => {
		const runner = new ExtensionRunner();
		const handler = vi.fn();
		await runner.use({ name: "all", factory: (api) => { api.on("message_end", handler); } });
		await runner.notify({ type: "turn_start" });
		await runner.notify({ type: "compaction_start", reason: "manual", contextTokens: 10 });
		expect(handler).not.toHaveBeenCalled();
	});

	test("a throwing observer is logged, isolated, and does not reject", async () => {
		const log = vi.fn();
		const runner = new ExtensionRunner({ log });
		const after = vi.fn();
		await runner.use({
			name: "a",
			factory: (api) => { api.on("message_end", () => { throw new Error("renderer bug"); }); },
		});
		await runner.use({ name: "b", factory: (api) => { api.on("message_end", after); } });
		await expect(runner.notify({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		})).resolves.toBeUndefined();
		expect(after).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith('extension "a" handler for "message_end" failed: renderer bug');
	});

	test("notify before any handler is registered is a no-op", async () => {
		const runner = new ExtensionRunner();
		await expect(runner.notify({ type: "agent_start" })).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @mini-agent/extensions exec vitest run test/runner.test.ts`
Expected: FAIL — `Cannot find module '../src/runner.ts'`。

- [ ] **Step 3: 实现 `ExtensionRunner`**

要点（四个都必须照做）：

1. 内部状态：`handlers: Map<string, Function[]>`（观察 + 决策同表，键是事件名）、`toolList: ToolDef<any>[]`、`commandList: ExtensionCommand[]`、`log: ExtensionLogger`、`streamFnSlot?: StreamFn`。
2. `ExtensionRunner` 自身实现 `ExtensionAPI`（`on` / `registerTool` / `registerCommand`），`use()` 时构造 `ExtensionContext` 并调用 `factory(this 的绑定视图)`。绑定视图用一个私有对象字面量，`this` 不能用箭头函数重绑定之外的花招。
3. `notify(event)`：只处理 `session_start` / `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` 五种；逐个 handler `try { await } catch` 后调 `this.log(...)`，**永不 rethrow**。
4. `sessionHooks()` 本任务返回 `{}`（决策 hook 在 Task 3–7 逐个接上）。

`log` 默认实现是 `console.error`（写 stderr，不污染 REPL 的 stdout 渲染）。

错误消息格式固定为两句话，测试逐字断言：`extension "${name}" handler for "${event}" failed: ${message}` 与 `extension "${name}" failed to initialize: ${message}`。handler 与 factory 的 name 从注册时记录到 handler 上（用 `Map<string, Function[]>` 旁边再存 `Map<Function, string>`，或在 `use()` 期间捕获当前扩展名变量）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: PASS，13 个 test。

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @mini-agent/extensions run check`
Expected: 无输出，退出码 0。

- [ ] **Step 6: Commit**

```bash
git add packages/extensions/src/runner.ts packages/extensions/src/index.ts packages/extensions/test/runner.test.ts
git commit -m "feat(stage-11): add extension runner registry and observer dispatch"
```

---

### Task 3: `tool_call` 决策 hook（fail-closed 短路）

**Files:**
- Modify: `packages/extensions/src/runner.ts`
- Test: `packages/extensions/test/runner.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 2 的 `ExtensionRunner`；core 的 `BeforeToolCallResult`、`BeforeToolCallContext`、`ToolCall`、`ToolDef`、`ToolResult`（type-only）；`Agent`、`createDefaultTools`（测试里用，来自 `@mini-agent/core` 运行时）。
- Produces: `sessionHooks().beforeToolCall`（短路语义）。后续 Task 9 的权限规则扩展依赖它。

- [ ] **Step 1: 写失败测试**

```ts
// packages/extensions/test/runner.test.ts 追加
import { Agent } from "@mini-agent/core";
import { createFakeStreamFn } from "@mini-agent/ai";

function callRead() {
	return [{ type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "a.txt" } }];
}

describe("tool_call decision hook", () => {
	test("blocks execution and surfaces the reason as an error result", async () => {
		const runner = new ExtensionRunner();
		const executed = vi.fn(async () => ({ content: [{ type: "text" as const, text: "file" }] }));
		await runner.use({
			name: "guard",
			factory: (api) => {
				api.on("tool_call", () => ({ block: true, reason: "read is disabled in this demo" }));
			},
		});
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: executed }],
			streamFn: createFakeStreamFn([callRead(), "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(executed).not.toHaveBeenCalled();
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true, toolName: "read" });
		expect(result?.role === "toolResult" && result.content[0]).toEqual({
			type: "text", text: "read is disabled in this demo",
		});
	});

	test("handlers short-circuit on the first non-undefined result", async () => {
		const runner = new ExtensionRunner();
		const second = vi.fn(() => undefined);
		await runner.use({
			name: "first",
			factory: (api) => { api.on("tool_call", () => ({ block: true, reason: "no" })); },
		});
		await runner.use({ name: "second", factory: (api) => { api.on("tool_call", second); } });
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([callRead(), "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(second).not.toHaveBeenCalled();
	});

	test("a handler returning undefined lets the call through to the next handler", async () => {
		const runner = new ExtensionRunner();
		const executed = vi.fn(async () => ({ content: [{ type: "text" as const, text: "file" }] }));
		const seen: string[] = [];
		await runner.use({ name: "a", factory: (api) => { api.on("tool_call", (e) => { seen.push(e.toolCall.name); }); } });
		await runner.use({ name: "b", factory: (api) => { api.on("tool_call", () => { seen.push("b"); }); } });
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: executed }],
			streamFn: createFakeStreamFn([callRead(), "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(seen).toEqual(["read", "b"]);
		expect(executed).toHaveBeenCalledTimes(1);
	});

	test("a throwing guard fails closed: tool does not run, run continues", async () => {
		const runner = new ExtensionRunner({ log: () => {} });
		const executed = vi.fn(async () => ({ content: [] }));
		await runner.use({
			name: "broken-guard",
			factory: (api) => { api.on("tool_call", () => { throw new Error("rule engine offline"); }); },
		});
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: executed }],
			streamFn: createFakeStreamFn([callRead(), "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(executed).not.toHaveBeenCalled();
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(result?.role === "toolResult" && result.content[0]).toEqual({
			type: "text", text: "rule engine offline",
		});
		expect(agent.state.messages.at(-1)?.role).toBe("assistant");
	});
});
```

第 2 个测试的 `{...runner.sessionHooks()}` 里 `beforeToolCall` 若是 `undefined`，`Agent` 会把 `beforeToolCall: undefined` 存下——`prepareToolCall` 用 `options.beforeToolCall?.(...)` 所以无害，但 Task 1 的 `sessionHooks()` 约定是「空时返回 `{}`」，这个测试同时验证了它（`beforeToolCall` 存在，第二个 handler 因短路未被调用）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @mini-agent/extensions exec vitest run test/runner.test.ts -t "tool_call decision hook"`
Expected: FAIL — `executed` 被调用（`expected "spy" to not be called`）。

- [ ] **Step 3: 实现 `beforeToolCall` 组合**

`sessionHooks()` 里 `beforeToolCall` 只在存在 handler 时挂上：

```ts
const handlers = this.handlersFor("tool_call");
if (handlers.length === 0) return {};
return {
	beforeToolCall: async (context, signal) => {
		for (const { name, handler } of handlers) {
			try {
				const result = await handler(context);
				if (result !== undefined) return result;
			} catch (error) {
				this.log(`extension "${name}" handler for "tool_call" failed: ${messageOf(error)}`);
				throw error;
			}
		}
		return undefined;
	},
};
```

`messageOf` 是包内私有工具：`error instanceof Error ? error.message : String(error)`。**不要**在这里把异常转成 `{block:true}`：`prepareToolCall` 已经把抛错转成 error result（阶段 5 既有行为），在这里再转一次会让扩展每次权限判定崩溃都看起来像「策略主动拒绝」。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @mini-agent/extensions exec vitest run test/runner.test.ts`
Expected: PASS，18 个 test。

- [ ] **Step 5: Commit**

```bash
git add packages/extensions/src/runner.ts packages/extensions/test/runner.test.ts
git commit -m "feat(stage-11): wire the tool_call decision hook"
```

---

### Task 4: `afterToolCall` 决策 hook（fold 语义，两个插入点）

**Files:**
- Create: `packages/core/src/after-tool-call.ts`
- Modify: `packages/core/src/execute-tool-calls.ts`（`ExecuteToolCallsOptions` 加字段；顺序路径插入调用）
- Modify: `packages/core/src/execute-tool-calls-parallel.ts`（thunk 内与 `finishImmediate` 内插入调用）
- Modify: `packages/core/src/agent-loop.ts`（`AgentLoopOptions.afterToolCall`，透传给 `executeToolCalls`）
- Modify: `packages/core/src/agent.ts` / `packages/core/src/index.ts`
- Modify: `packages/core/src/agent-options.ts`（上一个 Task 已加类型，本任务把它接到执行路径）
- Test: `packages/core/test/after-tool-call.test.ts`
- Test: `packages/extensions/test/runner.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `AfterToolCall` / `AfterToolCallContext` / `AfterToolCallResult`；既有 `FinalizedToolCallOutcome`、`ImmediateToolCallOutcome`。
- Produces: `applyAfterToolCall(outcome: FinalizedToolCallOutcome, hook: AfterToolCall | undefined, context: AfterToolCallContext, signal?: AbortSignal): Promise<FinalizedToolCallOutcome>`（core 导出）；`sessionHooks().afterToolCall`（fold 语义）。

- [ ] **Step 1: 写失败的 `applyAfterToolCall` 单测**

```ts
// packages/core/test/after-tool-call.test.ts
import { describe, expect, test, vi } from "vitest";
import { applyAfterToolCall } from "../src/after-tool-call.ts";
import type { FinalizedToolCallOutcome } from "../src/finalize-tool-call.ts";
import type { AfterToolCall } from "../src/agent-options.ts";

const toolCall = { id: "c1", name: "read", arguments: { path: "a.txt" } };
const outcome = (): FinalizedToolCallOutcome => ({
	toolCall,
	result: { content: [{ type: "text", text: "raw" }] },
	isError: false,
	durationMs: 42,
	message: {
		role: "toolResult", toolCallId: "c1", toolName: "read",
		content: [{ type: "text", text: "raw" }],
	},
});
const context = {
	toolCall, args: { path: "a.txt" }, result: outcome().result,
	isError: false, durationMs: 42, messages: [],
};

describe("applyAfterToolCall", () => {
	test("returns the outcome untouched when no hook is installed", async () => {
		const before = outcome();
		expect(await applyAfterToolCall(before, undefined, context)).toBe(before);
	});

	test("returns the outcome untouched when the hook returns void", async () => {
		const before = outcome();
		expect(await applyAfterToolCall(before, () => {}, context)).toBe(before);
	});

	test("rewrites content in both result and message", async () => {
		const next = await applyAfterToolCall(
			outcome(),
			() => ({ content: [{ type: "text", text: "redacted" }] }),
			context,
		);
		expect(next.result.content).toEqual([{ type: "text", text: "redacted" }]);
		expect(next.message.content).toEqual([{ type: "text", text: "redacted" }]);
	});

	test("rewrites isError in both result and message", async () => {
		const next = await applyAfterToolCall(outcome(), () => ({ isError: true }), context);
		expect(next.isError).toBe(true);
		expect(next.result.isError).toBe(true);
		expect(next.message.isError).toBe(true);
	});

	test("ignores attempts to change durationMs or terminate", async () => {
		const rogue = (() => ({ content: [], durationMs: 9999, terminate: true })) as unknown as AfterToolCall;
		const next = await applyAfterToolCall(outcome(), rogue, context);
		expect(next.durationMs).toBe(42);
		expect(next.result.terminate).toBeUndefined();
	});

	test("does not mutate the input outcome", async () => {
		const before = outcome();
		await applyAfterToolCall(before, () => ({ content: [] }), context);
		expect(before.result.content).toEqual([{ type: "text", text: "raw" }]);
	});

	test("a throwing hook propagates (decision hooks bubble)", async () => {
		await expect(
			applyAfterToolCall(outcome(), () => { throw new Error("formatter down"); }, context),
		).rejects.toThrowError("formatter down");
	});

	test("passes the real durationMs to the hook", async () => {
		const hook = vi.fn(() => {});
		await applyAfterToolCall(outcome(), hook, context);
		expect(hook).toHaveBeenCalledWith(context);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/after-tool-call.test.ts`
Expected: FAIL — `Cannot find module '../src/after-tool-call.ts'`。

- [ ] **Step 3: 实现 `applyAfterToolCall`**

```ts
// packages/core/src/after-tool-call.ts
export async function applyAfterToolCall(
	outcome: FinalizedToolCallOutcome,
	hook: AfterToolCall | undefined,
	context: AfterToolCallContext,
	signal?: AbortSignal,
): Promise<FinalizedToolCallOutcome> {
	if (!hook) return outcome;
	const override = await hook(context, signal);
	if (!override) return outcome;
	const content = override.content ?? outcome.result.content;
	const isError = override.isError ?? outcome.isError;
	return {
		...outcome, isError,
		result: { ...outcome.result, content, isError },
		message: { ...outcome.message, content, isError },
	};
}
```

关键是**重建**而不是就地改：`outcome.message.content` 与 `outcome.result.content` 必须指向同一个新数组，否则 `emitToolEnd` 与 `emitToolResultMessage` 会各自报出不同内容。`durationMs` 与 `terminate` 不进返回对象——类型上就不接受，运行期还被 `{...outcome}` 原值覆盖。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @mini-agent/core exec vitest run test/after-tool-call.test.ts`
Expected: PASS，8 个 test。

- [ ] **Step 5: 写失败的两个路径集成测试**

```ts
// packages/core/test/after-tool-call.test.ts 追加
import { Agent } from "../src/agent.ts";
import { createFakeStreamFn } from "@mini-agent/ai";

function callTwo() {
	return [{
		type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "a.txt" },
	}, {
		type: "toolCall" as const, id: "c2", name: "read", arguments: { path: "b.txt" },
	}];
}

describe("afterToolCall through the agent loop", () => {
	test("sequential path applies the hook to executed results", async () => {
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "secret" }] }) }],
			streamFn: createFakeStreamFn([callTwo(), "done"]),
			toolExecution: "sequential",
			afterToolCall: () => ({ content: [{ type: "text", text: "redacted" }] }),
		});
		await agent.prompt("go");
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.role === "toolResult" && result.content).toEqual([{ type: "text", text: "redacted" }]);
		}
	});

	test("parallel path applies the hook inside the thunk", async () => {
		const seen: string[] = [];
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async (args) => ({ content: [{ type: "text", text: String(args.path) }] }) }],
			streamFn: createFakeStreamFn([callTwo(), "done"]),
			afterToolCall: (ctx) => { seen.push(ctx.toolCall.id); return { isError: true }; },
		});
		await agent.prompt("go");
		expect(seen.sort()).toEqual(["c1", "c2"]);
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results.every((m) => m.role === "toolResult" && m.isError === true)).toBe(true);
	});

	test("parallel path applies the hook to blocked calls too (finishImmediate)", async () => {
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([callTwo(), "done"]),
			beforeToolCall: () => ({ block: true, reason: "nope" }),
			afterToolCall: () => ({ content: [{ type: "text", text: "blocked-and-rewritten" }] }),
		});
		await agent.prompt("go");
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results[0]?.role === "toolResult" && results[0].content[0]).toEqual({ type: "text", text: "blocked-and-rewritten" });
	});

	test("tool_execution_end reports the rewritten content and the original duration", async () => {
		const events: { isError: boolean; durationMs: number; result: unknown }[] = [];
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "secret" }] }) }],
			streamFn: createFakeStreamFn([callTwo(), "done"]),
			afterToolCall: () => ({ content: [{ type: "text", text: "redacted" }] }),
		});
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end")
				events.push({ isError: event.isError, durationMs: event.durationMs, result: event.result });
		});
		await agent.prompt("go");
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.result).toEqual({ content: [{ type: "text", text: "redacted" }], isError: false });
			expect(Number.isFinite(event.durationMs)).toBe(true);
		}
	});

	test("truncated calls are NOT passed through afterToolCall", async () => {
		const hook = vi.fn(() => ({}));
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([{ content: callTwo(), stopReason: "length" }, "done"]),
			afterToolCall: hook,
		});
		await agent.prompt("go");
		expect(hook).not.toHaveBeenCalled();
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results.every((m) => m.role === "toolResult" && m.isError === true)).toBe(true);
	});
});
```

- [ ] **Step 6: 运行确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/after-tool-call.test.ts -t "through the agent loop"`
Expected: FAIL — 5 个 test 全挂（hook 未接入，`redacted` 不出现）。

- [ ] **Step 7: 接入执行路径**

三个文件，四处改动：

1. `execute-tool-calls.ts`：`ExecuteToolCallsOptions` 加 `afterToolCall?: AfterToolCall;`；顺序路径先 `finalizeToolCall` 再 `applyAfterToolCall`，把结果存进一个局部变量供后续 `emitToolEnd` / `emitToolResultMessage` 使用：

```ts
const finalized = await applyAfterToolCall(
	finalizeToolCall(outcome),
	options.afterToolCall,
	toolCallContext(outcome, prepared, options.messages),
	options.signal,
);
```

`toolCallContext` 是一个同文件私有辅助，顺序与并行两条路径共用，避免两处把 `tool` / `args` 的取值规则写岔：

```ts
function toolCallContext(
	outcome: ExecutedToolCallOutcome | ImmediateToolCallOutcome,
	prepared: PreparedToolCall | undefined,
	finalized: FinalizedToolCallOutcome,
	messages: readonly Message[],
): AfterToolCallContext {
	return {
		toolCall: outcome.toolCall,
		tool: prepared?.tool,
		args: prepared?.args ?? outcome.toolCall.arguments,
		result: finalized.result,
		isError: finalized.isError,
		durationMs: finalized.durationMs,
		messages,
	};
}
```

签名里的 `finalized` 就是第一步 `finalizeToolCall` 的返回值——它必须传进来而不是在里面重算：`performance.now()` 调两次会得到不同值，测试会看到 `context.durationMs` 与 `tool_execution_end` 的 `durationMs` 不一致。`prepared` 为 `undefined` 时（工具未找到 / 校验失败 / 被 block / 已中止）`tool` 就是 `undefined`，与 1.1 节注释一致。

截断路径（`failTruncatedToolCalls`）**不加**这个调用。

2. `execute-tool-calls-parallel.ts`：thunk 里（现第 78 行 `finalizeToolCall` 之后、`emitToolEnd` 之前）与 `finishImmediate`（现第 111 行之后）各插一次，两处都是同一个形状——`const finalized = await applyAfterToolCall(finalizeToolCall(outcome), options.afterToolCall, toolCallContext(outcome, prepared, finalized…))` 需要把 `finalizeToolCall` 的结果先存下来，所以写成两行：先 `const base = finalizeToolCall(outcome);`，再 `const finalized = await applyAfterToolCall(base, options.afterToolCall, toolCallContext(outcome, prepared, base, options.messages), options.signal);`。thunk 里的 `prepared` 是闭包捕获的 `PreparedToolCall`，`finishImmediate` 里传 `undefined`（它只处理 immediate 结果）。`finishImmediate` 因此要多两个参数：`options: ExecuteToolCallsOptions` 与 `prepared?: PreparedToolCall`。

3. `agent-loop.ts`：`AgentLoopOptions.afterToolCall?: AfterToolCall;`，在 `executeToolCalls` 的 options 字面量里透传。

4. `agent.ts`：`public afterToolCall?: AfterToolCall;`，构造函数赋值，与 `prepareRequest` 同款 try/catch → `AgentInfrastructureFailure` 包装（决定类 hook 失败要冒泡，不是吞掉）。

`messages: options.messages` 传的是**可变引用**（`readonly Message[]` 只是类型视图）——扩展能改历史内容，但这是阶段 8 起就有的既成事实（`beforeToolCall` 的 `messages` 同款），本阶段不收紧。

- [ ] **Step 8: 运行确认通过**

Run: `pnpm --filter @mini-agent/core exec vitest run test/after-tool-call.test.ts`
Expected: PASS，13 个 test。

- [ ] **Step 9: 追加 `sessionHooks().afterToolCall` 的 fold 测试**

```ts
// packages/extensions/test/runner.test.ts 追加
describe("tool_result decision hook", () => {
	test("folds in registration order, last handler's fields win", async () => {
		const runner = new ExtensionRunner();
		await runner.use({
			name: "a",
			factory: (api) => { api.on("tool_result", (e) => ({ content: [{ type: "text", text: `a:${e.result.content.length}` }] })); },
		});
		await runner.use({
			name: "b",
			factory: (api) => { api.on("tool_result", () => ({ isError: true })); },
		});
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "x" }] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(result?.role === "toolResult" && result.content[0]).toEqual({ type: "text", text: "a:1" });
	});

	test("a handler returning void leaves the previous fields intact", async () => {
		const runner = new ExtensionRunner();
		await runner.use({ name: "a", factory: (api) => { api.on("tool_result", () => ({ content: [{ type: "text", text: "kept" }] })); } });
		await runner.use({ name: "b", factory: (api) => { api.on("tool_result", () => undefined); } });
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(result?.role === "toolResult" && result.content[0]).toEqual({ type: "text", text: "kept" });
	});
});
```

- [ ] **Step 10: 实现 fold 组合并运行**

`sessionHooks()` 里 `afterToolCall` 累积覆盖（不是短路）：

```ts
let accumulated: AfterToolCallResult = {};
for (const { name, handler } of handlers) {
	try {
		const partial = await handler(context);
		if (partial) accumulated = { ...accumulated, ...partial };
	} catch (error) {
		this.log(`extension "${name}" handler for "tool_result" failed: ${messageOf(error)}`);
		throw error;
	}
}
return accumulated;
```

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: PASS，20 个 test。

- [ ] **Step 11: 全量回归**

Run: `pnpm test`
Expected: 全绿。core 既有 test 一条不改——`afterToolCall` 未安装时 `applyAfterToolCall` 在第 7 行直接返回原对象。

- [ ] **Step 12: Commit**

```bash
git add packages/core/src packages/core/test/after-tool-call.test.ts packages/extensions
git commit -m "feat(stage-11): add afterToolCall hook to both execution paths"
```

---

### Task 5: `transformContext` 决策 hook（fold + 引用同一性）

**Files:**
- Modify: `packages/core/src/agent-loop.ts`（`prepareRequest` 之后、`streamAssistantMessage` 之前）
- Modify: `packages/core/src/agent.ts` / `packages/core/src/agent-options.ts`（接线）
- Test: `packages/core/test/transform-context.test.ts`
- Test: `packages/extensions/test/runner.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `TransformContext`；`PrepareRequest`（阶段 10）。
- Produces: `sessionHooks().transformContext`（fold 语义 + 引用同一性校验）。

- [ ] **Step 1: 写失败的顺序与同一性测试**

```ts
// packages/core/test/transform-context.test.ts
import { describe, expect, test, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { createFakeStreamFn } from "@mini-agent/ai";
import type { Message } from "@mini-agent/ai";

const seen: Message[][] = [];

describe("transformContext", () => {
	test("runs after prepareRequest: prepareRequest output is what transformContext sees", async () => {
		const sentinel: Message = { role: "user", content: [{ type: "text", text: "injected-by-prepareRequest" }] };
		const hook = vi.fn((messages: readonly Message[]) => [...messages, sentinel]);
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["done"]),
			prepareRequest: (input) => ({ ...input.context, messages: [...input.context.messages, sentinel] }),
			transformContext: hook,
		});
		await agent.prompt("go");
		expect(hook).toHaveBeenCalledTimes(1);
		const received = hook.mock.calls[0]![0] as Message[];
		expect(received.at(-1)).toBe(sentinel);
	});

	test("the transformed context is what the provider receives; transcript is untouched", async () => {
		const captured: Message[][] = [];
		const streamFn = createFakeStreamFn(["done"]);
		const agent = new Agent({
			system: "s",
			streamFn: (context, signal) => { captured.push([...context.messages]); return streamFn(context, signal); },
			transformContext: (messages) => messages.filter((m) => m.role !== "user"),
		});
		await agent.prompt("go");
		expect(captured[0]!.some((m) => m.role === "user")).toBe(false);
		expect(agent.state.messages.some((m) => m.role === "user")).toBe(true);
	});

	test("rejects a fabricated message object with a TypeError", async () => {
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["done"]),
			transformContext: () => [{ role: "user", content: [{ type: "text", text: "ghost" }] }],
		});
		await expect(agent.prompt("go")).rejects.toThrowError(TypeError);
		await expect(agent.prompt("go")).rejects.toThrowError(
			"transformContext must only filter or reorder the messages it received",
		);
	});

	test("rejects an empty result array", async () => {
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["done"]),
			transformContext: () => [],
		});
		await expect(agent.prompt("go")).rejects.toThrowError(
			"transformContext must return a non-empty message array",
		);
	});

	test("allows reordering existing messages", async () => {
		const first: Message = { role: "user", content: [{ type: "text", text: "1" }] };
		const second: Message = { role: "assistant", content: [{ type: "text", text: "2" }], stopReason: "stop" };
		const agent = new Agent({
			system: "s",
			messages: [first, second],
			streamFn: createFakeStreamFn(["done"]),
			transformContext: (messages) => [...messages].reverse(),
		});
		await agent.prompt("go");
		expect(agent.state.messages.slice(0, 2).map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	test("runs on every turn, not just the first", async () => {
		const calls: number[] = [];
		let turn = 0;
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			transformContext: (messages) => { calls.push(messages.length); return messages; },
		});
		await agent.prompt("go");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toBeLessThan(calls[1]!);
	});

	test("absent hook leaves the context object identical", async () => {
		const received: unknown[] = [];
		const streamFn = createFakeStreamFn(["done"]);
		const agent = new Agent({
			system: "s",
			streamFn: (context, signal) => { received.push(context); return streamFn(context, signal); },
		});
		await agent.prompt("go");
		expect(received).toHaveLength(1);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/transform-context.test.ts`
Expected: FAIL — `transformContext` 不被调用（`expected 1 to be 0` 之类），且不存在同一性校验。

- [ ] **Step 3: 在 `agent-loop.ts` 接入**

在 `prepared` 之后、`activeTools` 之前插入：

```ts
const messages = options.transformContext
	? await options.transformContext(prepared.messages, options.signal ?? runSignal)
	: prepared.messages;
if (options.transformContext) {
	if (messages.length === 0)
		throw new TypeError("transformContext must return a non-empty message array");
const known = new Set(prepared.messages);
for (const message of messages) {
	if (!known.has(message))
		throw new TypeError("transformContext must only filter or reorder the messages it received");
}
const request: StreamContext = { ...prepared, messages };
```

然后 `activeTools` 的 filter 与 `streamFn(request, options.signal)` 都改用这个对象。**`activeTools` 仍以 `prepared.tools` 为准**——`transformContext` 只改 messages，不改工具声明（改工具是 `prepareNextTurnWithContext` 的职责）。

两条错误信息用上面这两句，测试逐字断言；类型是 `TypeError` 而非 `Error`，因为它描述的是**调用方给的返回值不合法**。用 `Set` 而不是 `includes` 是为了 O(1) 且对 `readonly` 数组友好。

`agent.ts` 里 `transformContext` 与 `prepareRequest` 同款包装进 `AgentInfrastructureFailure`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @mini-agent/core exec vitest run test/transform-context.test.ts`
Expected: PASS，7 个 test。

- [ ] **Step 5: 追加扩展侧 fold 测试**

```ts
// packages/extensions/test/runner.test.ts 追加
describe("context decision hook", () => {
	test("folds across extensions: each sees the previous one's output", async () => {
		const runner = new ExtensionRunner();
		const sizes: number[] = [];
		await runner.use({ name: "drop-system", factory: (api) => { api.on("context", (m) => m.filter((x) => x.role !== "system")); } });
		await runner.use({ name: "count", factory: (api) => { api.on("context", (m) => { sizes.push(m.length); return m; }); } });
		const agent = new Agent({
			system: "s", streamFn: createFakeStreamFn(["done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(sizes).toEqual([1]);
	});

	test("a throwing handler rejects the prompt with the original error", async () => {
		const runner = new ExtensionRunner({ log: () => {} });
		await runner.use({ name: "boom", factory: (api) => { api.on("context", () => { throw new Error("pruner crashed"); }); } });
		const agent = new Agent({ system: "s", streamFn: createFakeStreamFn(["done"]), ...runner.sessionHooks() });
		await expect(agent.prompt("go")).rejects.toThrowError("pruner crashed");
	});
});
```

第 1 个测试的数字：transcript 是 `[system("s"), user("go")]`（2 条），`drop-system` 先把 system 去掉，`count` 看到 1 条。这正是本节要钉的失败模式——fold 顺序错了会看到 2。

- [ ] **Step 6: 实现 fold 组合并运行**

与 `afterToolCall` 同构，但每步的输出是下一步的输入，且第一步的输入是 core 传来的原始数组：

```ts
let current = [...messages];
for (const { name, handler } of handlers) {
	try {
		current = await handler(current, signal);
	} catch (error) {
		this.log(`extension "${name}" handler for "context" failed: ${messageOf(error)}`);
		throw error;
	}
}
return current;
```

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: PASS，22 个 test。

- [ ] **Step 7: 全量回归 + Commit**

Run: `pnpm test && pnpm check`
Expected: 全绿。

```bash
git add packages/core/src packages/core/test/transform-context.test.ts packages/extensions
git commit -m "feat(stage-11): add transformContext hook with identity enforcement"
```

---

### Task 6: `finishTurn` 决策 hook（短路 + 硬停优先）

**Files:**
- Modify: `packages/core/src/agent-loop.ts`（`turn_end` 与 abort 检查之后、`terminate` 判断之前）
- Modify: `packages/core/src/agent.ts` / `packages/core/src/agent-options.ts`（接线）
- Test: `packages/core/test/finish-turn.test.ts`
- Test: `packages/extensions/test/runner.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `FinishTurn` / `FinishTurnContext` / `FinishTurnResult`。
- Produces: `sessionHooks().finishTurn`（短路语义）——`turn_end` 观察事件之外的第二条「轮次结束」参与路径。

- [ ] **Step 1: 写失败的测试**

```ts
// packages/core/test/finish-turn.test.ts
import { describe, expect, test, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { createFakeStreamFn } from "@mini-agent/ai";

const readTool = {
	name: "read", description: "read", parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: "file" }] }),
};
const callRead = [{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }];

describe("finishTurn", () => {
	test("continue with no tool calls keeps the loop going", async () => {
		const contexts: { turn: number; toolResults: number }[] = [];
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["first", "second", "third"]),
			finishTurn: (context) => {
				contexts.push({ turn: context.turn, toolResults: context.toolResults.length });
				return { action: contexts.length < 3 ? "continue" : "end" };
			},
		});
		await agent.prompt("go");
		expect(contexts).toEqual([
			{ turn: 0, toolResults: 0 },
			{ turn: 1, toolResults: 0 },
			{ turn: 2, toolResults: 0 },
		]);
		const assistant = agent.state.messages.filter((m) => m.role === "assistant");
		expect(assistant.map((m) => m.role === "assistant" && m.content[0])).toEqual([
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
			{ type: "text", text: "third" },
		]);
	});

	test("continue draws from the same maxTurns budget", async () => {
		const agent = new Agent({
			system: "s",
			maxTurns: 3,
			streamFn: createFakeStreamFn(["x"]),
			finishTurn: () => ({ action: "continue" }),
		});
		await expect(agent.prompt("go")).rejects.toThrowError(
			"agent loop hit maxTurns (3) without the model stopping; last tool calls: unknown",
		);
	});

	test("end (or void) terminates the run as before", async () => {
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["only"]),
			finishTurn: () => ({ action: "end" }),
		});
		await agent.prompt("go");
		expect(agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
	});

	test("tool terminate:true wins over finishTurn continue", async () => {
		const hook = vi.fn(() => ({ action: "continue" as const }));
		const agent = new Agent({
			system: "s",
			tools: [{ ...readTool, execute: async () => ({ content: [], terminate: true }) }],
			streamFn: createFakeStreamFn([callRead, "never reached"]),
			finishTurn: hook,
		});
		await agent.prompt("go");
		expect(hook).not.toHaveBeenCalled();
		expect(agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
	});

	test("sees this turn's tool results and the turn number", async () => {
		const seen: number[] = [];
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			finishTurn: (context) => { seen.push(context.toolResults.length); },
		});
		await agent.prompt("go");
		expect(seen).toEqual([1, 0]);
	});

	test("fires after turn_end, so subscribers see the turn closed first", async () => {
		const order: string[] = [];
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["only"]),
			finishTurn: () => { order.push("finishTurn"); },
		});
		agent.subscribe((event) => { if (event.type === "turn_end") order.push("turn_end"); });
		await agent.prompt("go");
		expect(order).toEqual(["turn_end", "finishTurn"]);
	});

	test("a throwing hook bubbles and records an error assistant message", async () => {
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["only"]),
			finishTurn: () => { throw new Error("policy service down"); },
		});
		await expect(agent.prompt("go")).rejects.toThrowError("policy service down");
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/finish-turn.test.ts`
Expected: FAIL — `finishTurn` 从不被调用（`contexts` 为空 / `hook` 被调用）。

- [ ] **Step 3: 在 `agent-loop.ts` 接入**

`terminate` 判断之后、`for` 循环末尾插入：

```ts
if (terminate) {
	await emit({ type: "agent_end", messages: newMessages });
	return options.messages;
}
const decision = options.finishTurn
	? await options.finishTurn({
		message,
		toolResults,
		messages: options.messages,
		turn,
	}, options.signal)
	: undefined;
if (decision?.action === "continue") continue;
await emit({ type: "agent_end", messages: newMessages });
return options.messages;
```

三处必须照做：

1. 这段在 `terminate` 检查**之后**，所以命令式硬停优先——第 4 个测试钉的就是这个。
2. `continue` 不重置 `turn`——`for (let turn = 0; turn < maxTurns; turn++)` 的预算照扣，超出时同一条 `hit maxTurns` 错误抛出。**不要**为 `continue` 单独开一个计数器或 `while` 循环，那正是 Review Focus 第 3 条要防的无限循环。
3. 原本在 `turn_end` 之后无条件 `emit(agent_end)` 并 `return` 的两处（第 130-132 行的无工具分支、第 164-167 行的 terminate 分支）里，**只有无工具分支**改成走上面这段；terminate 分支保持原样直接返回。

注意 `message` 与 `toolResults` 在这个位置都还在作用域内；`messages` 传 `options.messages`（已含本轮全部新增）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @mini-agent/core exec vitest run test/finish-turn.test.ts`
Expected: PASS，7 个 test。

- [ ] **Step 5: 追加扩展侧短路测试**

```ts
// packages/extensions/test/runner.test.ts 追加
describe("turn_end decision hook", () => {
	test("short-circuits on the first non-void result", async () => {
		const runner = new ExtensionRunner();
		const second = vi.fn(() => ({ action: "end" as const }));
		await runner.use({ name: "a", factory: (api) => { api.on("turn_end", () => ({ action: "continue" })); } });
		await runner.use({ name: "b", factory: (api) => { api.on("turn_end", second); } });
		const agent = new Agent({
			system: "s", maxTurns: 2,
			streamFn: createFakeStreamFn(["x", "y"]),
			...runner.sessionHooks(),
		});
		agent.subscribe(() => {});
		const turnEnds: number[] = [];
		agent.subscribe((e) => { if (e.type === "turn_end") turnEnds.push(1); });
		await agent.prompt("go");
		expect(second).not.toHaveBeenCalled();
		expect(turnEnds).toHaveLength(2);
	});

	test("a handler returning void lets the loop stop normally", async () => {
		const runner = new ExtensionRunner();
		await runner.use({ name: "observer-ish", factory: (api) => { api.on("turn_end", () => undefined); } });
		const agent = new Agent({ system: "s", streamFn: createFakeStreamFn(["only"]), ...runner.sessionHooks() });
		await agent.prompt("go");
		expect(agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
	});
});
```

- [ ] **Step 6: 实现短路组合并运行**

与 Task 3 的 `tool_call` 同构，逐字复用那个 for 循环，只把事件名换成 `turn_end`（错误消息里的 `"tool_call"` 也换成 `"turn_end"`）。

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: PASS，24 个 test。

- [ ] **Step 7: 全量回归 + Commit**

Run: `pnpm test && pnpm check`
Expected: 全绿。

```bash
git add packages/core/src packages/core/test/finish-turn.test.ts packages/extensions
git commit -m "feat(stage-11): add finishTurn hook with terminate precedence"
```

---

### Task 7: `prepareNextTurnWithContext` 决策 hook（merge + 真 SystemMessage）

**Files:**
- Modify: `packages/core/src/agent-loop.ts`（`turn > 0` 的循环顶部，在 `getCurrentSystemMessage` 之前）
- Modify: `packages/core/src/agent.ts` / `packages/core/src/agent-options.ts`（接线）
- Modify: `packages/core/src/index.ts`（导出 `ApplyNextTurnResult` 类型别名）
- Test: `packages/core/test/prepare-next-turn.test.ts`
- Test: `packages/extensions/test/runner.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `PrepareNextTurn` / `PrepareNextTurnContext` / `PrepareNextTurnResult`；ai 包的 `getToolStateChanges`、`getCurrentSystemMessage`、`getCurrentTools`。
- Produces: `sessionHooks().prepareNextTurnWithContext`（merge 语义）。

- [ ] **Step 1: 写失败的测试**

```ts
// packages/core/test/prepare-next-turn.test.ts
import { describe, expect, test, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { createFakeStreamFn } from "@mini-agent/ai";
import type { StreamContext } from "@mini-agent/ai";

const readTool = {
	name: "read", description: "read", parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: "file" }] }),
};
const callRead = [{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }];

describe("prepareNextTurnWithContext", () => {
	test("is not called for turn 0 and is called with turn >= 1", async () => {
		const turns: number[] = [];
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: (context) => { turns.push(context.turn); },
		});
		await agent.prompt("go");
		expect(turns).toEqual([1]);
	});

	test("appended sections become part of the transcript and the next request", async () => {
		const seenSystem: string[] = [];
		const base = createFakeStreamFn([callRead, "done"]);
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: (context, signal) => { seenSystem.push(JSON.stringify(context.system)); return base(context, signal); },
			prepareNextTurnWithContext: () => ({
				sections: [{ content: "current time: 12:00", priority: 0 }],
			}),
		});
		await agent.prompt("go");
		expect(seenSystem).toHaveLength(2);
		expect(seenSystem[0]).not.toContain("current time");
		expect(seenSystem[1]).toContain("current time");
		// 真的进 transcript（system 消息可由 replay 重建），不是只改了本次请求
		const systemMessages = agent.state.messages.filter((m) => m.role === "system");
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages.at(-1)?.role === "system" && systemMessages.at(-1)!.sections[0]!.content).toBe("current time: 12:00");
	});

	test("toolsAdded and toolsRemoved are recorded as a SystemMessage too", async () => {
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: () => ({ toolsRemoved: ["read"] }),
		});
		await agent.prompt("go");
		const last = agent.state.messages.at(-1);
		expect(last?.role === "system" && last.toolsRemoved).toEqual(["read"]);
	});

	test("a void result appends nothing", async () => {
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: () => undefined,
		});
		await agent.prompt("go");
		expect(agent.state.messages.filter((m) => m.role === "system")).toHaveLength(1);
	});

	test("adds exactly one system message per turn even with all three fields", async () => {
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: () => ({
				sections: [{ content: "note", priority: 0 }],
				toolsAdded: [{ name: "echo", description: "e", parameters: {} }],
				toolsRemoved: ["read"],
			}),
		});
		await agent.prompt("go");
		const messages = agent.state.messages.filter((m) => m.role === "system");
		expect(messages).toHaveLength(2);
		expect(messages.at(-1)?.role === "system" && messages.at(-1)!.toolsAdded).toHaveLength(1);
	});

	test("a throwing hook bubbles", async () => {
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: () => { throw new Error("clock unavailable"); },
		});
		await expect(agent.prompt("go")).rejects.toThrowError("clock unavailable");
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @mini-agent/core exec vitest run test/prepare-next-turn.test.ts`
Expected: FAIL — hook 不被调用（`turns` 为空）。

- [ ] **Step 3: 在 `agent-loop.ts` 接入**

`for` 循环体内、`if (turn > 0) await emit({ type: "turn_start" })` 之后、`getCurrentSystemMessage` 之前插入：

```ts
if (turn > 0 && options.prepareNextTurnWithContext) {
	const result = await options.prepareNextTurnWithContext({
		messages: options.messages,
		turn,
		signal: options.signal ?? runSignal,
	});
	if (
		result &&
		(result.sections?.length ||
			result.toolsAdded?.length ||
			result.toolsRemoved?.length)
	) {
		const message: SystemMessage = {
			role: "system",
			sections: result.sections?.map((section) => ({ ...section })) ?? [],
			...(result.toolsRemoved?.length
				? { toolsRemoved: [...result.toolsRemoved] }
				: {}),
			...(result.toolsAdded?.length
				? { toolsAdded: [...result.toolsAdded] }
				: {}),
		};
		options.messages.push(message);
		newMessages.push(message);
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}
}
```

四个必须照做的点：

1. **必须 push 真 `SystemMessage` 并 emit `message_start`/`message_end`**，不能只改本轮的 `context`：`getCurrentSystemMessage`/`getCurrentTools` 的权威是 transcript 本身（阶段 8 的不变量），旁路修改会在下一轮被 replay 抹掉，也进不了 journal。
2. 三个字段**合并进一条**消息（第 5 个测试钉这个）——一次 `SystemMessage` 就是一次 system prompt 变更，拆成三条会让 `getCurrentSystemMessage` 的 replay 语义与 journal 阅读都变啰嗦。
3. `getToolStateChanges` 不需要在 core 侧校验：`toolsAdded`/`toolsRemoved` 是扩展给的声明，直接进 transcript；下一轮的 `getCurrentTools` 会照实重建。工具**执行表**的收窄由 `agent.ts` 在 `getToolsFromState` 时自然生效（`activeTools` 过滤用的是 `prepared.tools`）。
4. hook 在 `streamFn` 之前、`turn_start` 之后——`turn_start` 已经发出去了，这一轮的 system 变更因此**归属下一轮**，顺序与 pi 的 `prepareNextTurnWithContext` 一致。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @mini-agent/core exec vitest run test/prepare-next-turn.test.ts`
Expected: PASS，6 个 test。

- [ ] **Step 5: 追加扩展侧 merge 测试**

```ts
// packages/extensions/test/runner.test.ts 追加
describe("next_turn decision hook", () => {
	test("merges fields across extensions; later handlers win per field", async () => {
		const runner = new ExtensionRunner();
		await runner.use({
			name: "a",
			factory: (api) => { api.on("next_turn", () => ({ sections: [{ content: "clock", priority: 0 }] })); },
		});
		await runner.use({
			name: "b",
			factory: (api) => { api.on("next_turn", () => ({ toolsRemoved: ["read"] })); },
		});
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		const last = agent.state.messages.at(-1);
		expect(last?.role).toBe("system");
		expect(last?.role === "system" && last.sections[0]!.content).toBe("clock");
		expect(last?.role === "system" && last.toolsRemoved).toEqual(["read"]);
	});

	test("all handlers returning void appends nothing", async () => {
		const runner = new ExtensionRunner();
		await runner.use({ name: "noop", factory: (api) => { api.on("next_turn", () => undefined); } });
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(agent.state.messages.filter((m) => m.role === "system")).toHaveLength(1);
	});
});
```

- [ ] **Step 6: 实现 merge 组合并运行**

与折叠语义不同，合并是**跨扩展拼接**（Global Constraints 的「sections 与 toolsAdded 拼接、toolsRemoved 去重」）：

```ts
const sections: SystemSection[] = [];
const toolsAdded: Tool[] = [];
const toolsRemoved: string[] = [];
for (const { name, handler } of handlers) {
	try {
		const partial = await handler(context);
		if (!partial) continue;
		if (partial.sections) sections.push(...partial.sections);
		if (partial.toolsAdded) toolsAdded.push(...partial.toolsAdded);
		if (partial.toolsRemoved)
			for (const toolName of partial.toolsRemoved)
				if (!toolsRemoved.includes(toolName)) toolsRemoved.push(toolName);
	} catch (error) {
		this.log(`extension "${name}" handler for "next_turn" failed: ${messageOf(error)}`);
		throw error;
	}
}
return { sections, toolsAdded, toolsRemoved };
```

拼接而不是覆盖，是因为两个扩展各自想加的东西互不相干（一个报时钟、一个收窄工具表），覆盖会让注册顺序决定谁生效；`toolsRemoved` 去重保留首次出现的位置，便于读日志时对应到具体扩展。三个字段都为空时返回的对象仍然是真值，`agent-loop` 那一侧的空检查会把它当作 no-op —— 这正是 `void` 与 `{sections: []}` 被要求表现一致的地方。

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: PASS，26 个 test。

- [ ] **Step 7: 全量回归 + Commit**

Run: `pnpm test && pnpm check`
Expected: 全绿。

```bash
git add packages/core/src packages/core/test/prepare-next-turn.test.ts packages/extensions
git commit -m "feat(stage-11): add prepareNextTurnWithContext hook"
```

---

### Task 8: 第二个 `StreamFn` 实现（可整节替换）

**Files:**
- Create: `packages/extensions/src/second-stream-fn.ts`
- Modify: `packages/extensions/src/index.ts`
- Test: `packages/extensions/test/second-stream-fn.test.ts`

**Interfaces:**
- Consumes: ai 的 `StreamFn`、`StreamContext`、`AssistantMessageEventStream`、`getDefaultStreamFn`、`setDefaultStreamFn`。
- Produces: `createSecondStreamFn(inner: StreamFn, options?: SecondStreamFnOptions): StreamFn`；`SecondStreamFnOptions = { decorate?: (context, signal) => StreamContext | Promise<StreamContext>; onCall?: (record: StreamCallRecord) => void }`；`StreamCallRecord = { context: StreamContext; durationMs: number; ok: boolean }`。

**为什么要写第二个实现**：spec §3.2(a) 的论证是「`StreamFn` 是一个普通函数类型 + 一个模块级装配槽，所以换 provider 不需要改 core 一行」。这个论证只有真的写第二个 `StreamFn` 并且不碰 core 才能被验证。它同时是 Task 9 里 CLI 的挂载对象。

- [ ] **Step 1: 写失败测试**

```ts
// packages/extensions/test/second-stream-fn.test.ts
import { describe, expect, test, vi } from "vitest";
import { createFakeStreamFn } from "@mini-agent/ai";
import { consumeAssistantMessage } from "@mini-agent/ai";
import type { StreamContext } from "@mini-agent/ai";
import { createSecondStreamFn } from "../src/second-stream-fn.ts";

const context: StreamContext = {
	system: { role: "system", sections: [] },
	messages: [],
	tools: [],
};

describe("createSecondStreamFn", () => {
	test("delegates to the wrapped StreamFn and yields the same message", async () => {
		const inner = createFakeStreamFn([{ content: [{ type: "text", text: "from inner" }], stopReason: "stop" }]);
		const streamFn = createSecondStreamFn(inner);
		const message = await consumeAssistantMessage(streamFn(context));
		expect(message.role).toBe("assistant");
		expect(message.content).toEqual([{ type: "text", text: "from inner" }]);
		expect(message.stopReason).toBe("stop");
	});

	test("decorate rewrites the context the inner fn receives", async () => {
		const seen: StreamContext[] = [];
		const inner = vi.fn(createFakeStreamFn(["ok"]));
		const streamFn = createSecondStreamFn(inner, {
			decorate: (ctx) => ({ ...ctx, messages: [...ctx.messages, { role: "user", content: [{ type: "text", text: "prepended" }] }] }),
		});
		await consumeAssistantMessage(streamFn(context));
		expect(inner.mock.calls[0]![0].messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "prepended" }] });
	});

	test("decorate may be async", async () => {
		const inner = createFakeStreamFn(["ok"]);
		const seen: string[] = [];
		const streamFn = createSecondStreamFn(inner, {
			decorate: async (ctx) => { seen.push("decorated"); return ctx; },
		});
		await consumeAssistantMessage(streamFn(context));
		expect(seen).toEqual(["decorated"]);
	});

	test("onCall reports the pre-decoration context, duration, and success", async () => {
		const records: { messages: number; ok: boolean; finite: boolean }[] = [];
		const streamFn = createSecondStreamFn(createFakeStreamFn(["ok"]), {
			decorate: (ctx) => ({ ...ctx, messages: [...ctx.messages, { role: "user", content: [] }] }),
			onCall: (record) => records.push({
				messages: record.context.messages.length,
				ok: record.ok,
				finite: Number.isFinite(record.durationMs),
			}),
		});
		await consumeAssistantMessage(streamFn(context));
		expect(records).toEqual([{ messages: 0, ok: true, finite: true }]);
	});

	test("forwards the abort signal to the inner fn", async () => {
		const controller = new AbortController();
		const inner = vi.fn(createFakeStreamFn(["ok"]));
		await consumeAssistantMessage(createSecondStreamFn(inner)(context, controller.signal));
		expect(inner.mock.calls[0]![1]).toBe(controller.signal);
	});

	test("an error message from the inner fn still reports ok:false", async () => {
		const records: boolean[] = [];
		const streamFn = createSecondStreamFn(createFakeStreamFn([{ content: [{ type: "text", text: "boom" }], stopReason: "error" }]), {
			onCall: (record) => records.push(record.ok),
		});
		await consumeAssistantMessage(streamFn(context));
		expect(records).toEqual([false]);
	});

	test("is installable as the default and retrievable through getDefaultStreamFn", () => {
		const inner = createFakeStreamFn(["ok"]);
		const streamFn = createSecondStreamFn(inner);
		setDefaultStreamFn(streamFn);
		expect(getDefaultStreamFn()).toBe(streamFn);
	});
});
```

`ok` 的判定是「内层返回的消息 `stopReason` 不是 `"error"`」——`createSecondStreamFn` 不吞流，它包装后原样返回 `AssistantMessageEventStream`，所以要用 `consumeAssistantMessage` 读结果来记录 `ok`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @mini-agent/extensions exec vitest run test/second-stream-fn.test.ts`
Expected: FAIL — `Cannot find module '../src/second-stream-fn.ts'`。

- [ ] **Step 3: 实现**

```ts
// packages/extensions/src/second-stream-fn.ts
export function createSecondStreamFn(
	inner: StreamFn,
	options: SecondStreamFnOptions = {},
): StreamFn {
	return (context, signal) => {
		const startedAt = performance.now();
		const decorate = options.decorate;
		const stream = decorate
			? decorateThen(inner, context, signal, decorate, options.onCall, startedAt)
			: track(inner(context, signal), context, options.onCall, startedAt);
		return stream;
	};
}
```

两个辅助函数是**必需的**，因为返回类型是 `AssistantMessageEventStream` 而不是 `Promise<AssistantMessageEventStream>`——签名是同步的，异步的 `decorate` 只能在拿到 stream 之后、通过事件管道把耗时与 `ok` 记进去。实现要点：

1. `decorate` 存在时：先 `createAssistantMessageEventStream()` 建一个转发流，`void (async () => { const decorated = await decorate(context, signal); ... })()` 在内部把 `inner(decorated, signal)` 的每个事件 `for await` 转发出去，转发循环结束时按 `stopReason` 记 `onCall`。异步任务的 rejection 必须转成一个 `error` 事件投进转发流，否则错误会变成 unhandled rejection。
2. `decorate` 不存在时：直接 `inner(context, signal)`，用一个包装的异步循环转发事件并在结束时记 `onCall`。
3. `onCall` 报告的是**装饰前**的 context（测试第 4 条钉这个），否则「扩展改了什么」在日志里就看不出来了。
4. `ok` = 转发出去的最终消息 `stopReason !== "error"`。
5. 不要重复实现 SSE 解析——这个类的职责是**装饰与观测**，不是第二个 HTTP 客户端。真正的第二个 provider 客户端是可选扩展点，本阶段不做（spec 的意图是「换 provider 不必改 core」，装饰器足以验证这条）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: PASS，33 个 test。

- [ ] **Step 5: 边界测试仍需通过**

Run: `pnpm --filter @mini-agent/extensions exec vitest run test/no-core-runtime-imports.test.ts`
Expected: PASS。这个文件只 `import type` 加 `@mini-agent/ai` 的运行时导入，符合 Task 1 的边界。

- [ ] **Step 6: Commit**

```bash
git add packages/extensions/src/second-stream-fn.ts packages/extensions/src/index.ts packages/extensions/test/second-stream-fn.test.ts
git commit -m "feat(stage-11): add a second StreamFn implementation"
```

---

### Task 9: 组装——demo 扩展、`bootstrapExtensions` 与端到端测试

**Files:**
- Create: `packages/extensions/src/demo.ts`
- Create: `packages/extensions/src/bootstrap.ts`
- Modify: `packages/extensions/src/index.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json`（加 `@mini-agent/extensions` 依赖）
- Test: `packages/extensions/test/integration.test.ts`

**Interfaces:**
- Consumes: Task 1–8 的全部产物；core 的 `AgentSession`、`OpenAgentSessionOptions`；ai 的 `getDefaultStreamFn` / `setDefaultStreamFn` / `createInitialSystemMessage`。
- Produces: `createDemoExtension(options?): Extension`；`bootstrapExtensions(options): { runner: ExtensionRunner; hooks: SessionHooks; installStreamFn(): void; tools(base: ToolDef<any>[]): ToolDef<any>[]; notify(event: AgentEvent): Promise<void> }`。

- [ ] **Step 1: 写端到端失败测试**

```ts
// packages/extensions/test/integration.test.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AgentSession } from "@mini-agent/core";
import {
	createFakeStreamFn,
	getDefaultStreamFn,
	setDefaultStreamFn,
} from "@mini-agent/ai";
import type { StreamContext } from "@mini-agent/ai";
import { bootstrapExtensions } from "../src/bootstrap.ts";
import { createDemoExtension } from "../src/demo.ts";

const readTool = {
	name: "read", description: "read", parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: "file" }] }),
};
const callRead = [{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }];

function session(directory: string, streamFn = createFakeStreamFn([callRead, "done"])) {
	return AgentSession.create({ directory, system: "s", tools: [readTool], streamFn });
}

describe("extensions end to end", () => {
	test("an extension tool is callable through a real session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const extension = {
			name: "echo",
			factory: (api: any) => {
				api.registerTool({
					name: "echo", description: "echo", parameters: {},
					execute: async (args: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: String(args.text) }] }),
				});
			},
		};
		const { runner, hooks } = await bootstrapExtensions({ extensions: [extension] });
		const session = await AgentSession.create({
			directory, system: "s", tools: runner.tools, hooks,
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "echo", arguments: { text: "hi" } }], "done"]),
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		const result = session.state.messages.find((m) => m.role === "toolResult");
		expect(result?.role === "toolResult" && result.content[0]).toEqual({ type: "text", text: "hi" });
	});

	test("a transformContext prune reaches the provider but not the journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const seen: number[][] = [];
		const base = createFakeStreamFn([callRead, "done"]);
		const prune = {
			name: "prune",
			factory: (api: any) => { api.on("context", (messages: readonly { role: string }[]) => messages.filter((m) => m.role !== "toolResult")); },
		};
		const { hooks } = await bootstrapExtensions({ extensions: [prune] });
		const session = await AgentSession.create({
			directory, system: "s", tools: [readTool], hooks,
			streamFn: (context, signal) => { seen.push(context.messages.map((m) => m.role)); return base(context, signal); },
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		// 第二轮请求：provider 看不到 toolResult，而 transcript 里有——剪枝没污染事实源
		expect(seen[1]).toEqual(["system", "user", "assistant"]);
		expect(session.state.messages.some((m) => m.role === "toolResult")).toBe(true);
		expect(readFileSync(session.filePath, "utf8")).toContain("tool_outcome");
	});

	test("prepareNextTurnWithContext writes a real system entry into the journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const clock = {
			name: "clock",
			factory: (api: any) => { api.on("next_turn", () => ({ sections: [{ content: "time: 12:00", priority: 0 }] })); },
		};
		const { hooks } = await bootstrapExtensions({ extensions: [clock] });
		const session = await AgentSession.create({
			directory, system: "s", tools: [readTool], hooks,
			streamFn: createFakeStreamFn([callRead, "done"]),
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		const entries = session.entries.filter((entry) => entry.type === "message" && entry.message.role === "system");
		expect(entries).toHaveLength(2);
	});

	test("a blocked tool is journaled as a tool_outcome with isError", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const executed = vi.fn(async () => ({ content: [] }));
		const guard = {
			name: "guard",
			factory: (api: any) => { api.on("tool_call", () => ({ block: true, reason: "denied" })); },
		};
		const { hooks } = await bootstrapExtensions({ extensions: [guard] });
		const session = await AgentSession.create({
			directory, system: "s", hooks,
			tools: [{ name: "read", description: "read", parameters: {}, execute: executed }],
			streamFn: createFakeStreamFn([callRead, "done"]),
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(executed).not.toHaveBeenCalled();
		const entries = session.entries.filter((entry) => entry.type === "tool_outcome");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.type === "tool_outcome" && entries[0].isError).toBe(true);
	});

	test("observer handlers receive replayed events and cannot break the session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const observed: string[] = [];
		const noisy = {
			name: "noisy",
			factory: (api: any) => {
				api.on("message_end", () => { throw new Error("renderer offline"); });
			},
		};
		const quiet = {
			name: "quiet",
			factory: (api: any) => { api.on("tool_execution_end", (event: { toolName: string }) => { observed.push(event.toolName); }); },
		};
		const logs: string[] = [];
		const { runner, hooks } = await bootstrapExtensions({ extensions: [noisy, quiet], log: (m) => logs.push(m) });
		const session = await AgentSession.create({
			directory, system: "s", tools: [readTool], hooks,
			streamFn: createFakeStreamFn([callRead, "done"]),
		});
		session.subscribe((event) => { void runner.notify(event); });
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(observed).toEqual(["read"]);
		expect(logs).toEqual(['extension "noisy" handler for "message_end" failed: renderer offline']);
	});

	test("the demo extension registers a tool, a guard, and a command", async () => {
		const { runner, hooks } = await bootstrapExtensions({ extensions: [createDemoExtension()] });
		expect(runner.tools.map((tool) => tool.name)).toEqual(["word_count"]);
		expect(runner.commands.map((command) => command.name)).toEqual(["demo"]);
		expect(typeof hooks.beforeToolCall).toBe("function");
		expect(typeof hooks.transformContext).toBe("function");
	});

	test("installStreamFn wraps the current default without changing the call site", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const calls: string[] = [];
		const base = createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "word_count", arguments: { text: "a b c" } }], "done"]);
		setDefaultStreamFn((context, signal) => { calls.push(context.messages.at(-1)?.role ?? "none"); return base(context, signal); });
		const { runner, installStreamFn } = await bootstrapExtensions({ extensions: [createDemoExtension()] });
		installStreamFn();
		const session = await AgentSession.create({
			directory, system: "s", tools: runner.tools,
			streamFn: getDefaultStreamFn(),
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(calls).toHaveLength(2);
		const result = session.state.messages.find((m) => m.role === "toolResult");
		expect(result?.role === "toolResult" && result.content[0]).toEqual({ type: "text", text: "3" });
	});

	test("with zero extensions the session behaves exactly like stage 10", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const { hooks, tools } = await bootstrapExtensions({ extensions: [] });
		expect(hooks).toEqual({});
		expect(tools([readTool])).toEqual([readTool]);
		const session = await session(directory);
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(session.state.messages.some((m) => m.role === "toolResult")).toBe(true);
	});

	test("before_provider_request decorates the request without touching the journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const seen: string[] = [];
		const base = createFakeStreamFn([callRead, "done"]);
		const stamp = {
			name: "stamp",
			factory: (api: any) => {
				api.on("before_provider_request", (input: { context: StreamContext }) => ({
					...input.context,
					messages: [...input.context.messages, { role: "user", content: [{ type: "text", text: "stamped" }] }],
				}));
			},
		};
		const { hooks } = await bootstrapExtensions({ extensions: [stamp] });
		const session = await AgentSession.create({
			directory, system: "s", tools: [readTool], hooks,
			streamFn: (context, signal) => {
				seen.push(String(context.messages.at(-1)?.role === "user" && JSON.stringify(context.messages.at(-1))));
				return base(context, signal);
			},
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(seen[0]).toContain("stamped");
		const journal = readFileSync(session.filePath, "utf8");
		expect(journal).not.toContain("stamped");
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @mini-agent/extensions exec vitest run test/integration.test.ts`
Expected: FAIL — `Cannot find module '../src/bootstrap.ts'`。

- [ ] **Step 3: 写 `demo.ts` 与 `bootstrap.ts`**

`demo.ts` 的 `createDemoExtension()` 返回一个 `Extension`，factory 里做四件事，每件都对应本阶段的一个能力：

1. `api.registerTool(wordCountTool)` —— 自定义工具。`word_count`：参数 `{ text: string }`，返回 `text.trim().split(/\s+/).filter(Boolean).length` 的字符串。`replay: "safe"`（纯函数，重放安全，正好让阶段 9 的 `replay` 字段有第二个使用者）。
2. `api.on("tool_call", ...)` —— 权限规则：`bash` 工具永远 block，`reason` 是 `"demo extension: bash is disabled"`。
3. `api.on("context", ...)` —— 剪枝：丢掉 `role === "toolResult"` 且内容以 `"[truncated"` 开头的消息。
4. `api.registerCommand({ name: "demo", ... })` —— 打印自身已注册的工具名与规则。`run` 里用 `context.log`。

`bootstrap.ts` 的形状（这是 CLI 唯一的接入面）：

```ts
export interface BootstrapExtensionsOptions {
	extensions: Extension[];
	log?: ExtensionLogger;
}
export interface BootstrappedExtensions {
	runner: ExtensionRunner;
	hooks: SessionHooks;
	tools(base: ToolDef<any>[]): ToolDef<any>[];
	notify(event: AgentEvent): Promise<void>;
	installStreamFn(): void;
}

export async function bootstrapExtensions(
	options: BootstrapExtensionsOptions,
): Promise<BootstrappedExtensions> {
	const runner = new ExtensionRunner(options.log ? { log: options.log } : {});
	for (const extension of options.extensions) await runner.use(extension);
	return {
		runner,
		hooks: runner.sessionHooks(),
		tools: (base) => [...base, ...runner.tools],
		notify: (event) => runner.notify(event),
		installStreamFn: () => setDefaultStreamFn(createSecondStreamFn(getDefaultStreamFn())),
	};
}
```

`tools(base)` 必须是 `assertUniqueToolNames([...base, ...runner.tools])` 之后返回同一个数组：内置工具在前（它们有 journal 重放语义），扩展工具在后；同名时**抛错而不是静默覆盖**（阶段 5 起的约定）。

`sessionHooks()` 的第六个 hook —— `before_provider_request` 走 `prepareRequest`：`ExtensionRunner.sessionHooks()` 里若 `before_provider_request` 有 handler，就产出 `prepareRequest`，把它 fold 到同一个 `StreamContext` 上：

```ts
prepareRequest: async (input) => {
	let context = input.context;
	for (const { name, handler } of handlers) {
		try {
			context = await handler({ context, signal: input.signal });
		} catch (error) {
			this.log(`extension "${name}" handler for "before_provider_request" failed: ${messageOf(error)}`);
			throw error;
		}
	}
	return context;
},
```

顺序上与 `context` 事件的区别是刻意的：`before_provider_request` 拿到的是**会话编排已经定稿的请求**（`AgentSession.prepareRequest` 的产物，含 journal 重投影与阈值压缩结果），它只做最后一道请求装饰；`context` 拿到的是 loop 组装的原始 context，是剪枝/重排的地方。`AgentSession.createAgent()` 里 session 内部的 `prepareRequest` 先跑、扩展的 `prepareRequest` 在它之后跑——**不要**让扩展的版本覆盖 session 的（1.2 节的 `Omit` 就是防这个）。

`demo.ts` 只注册前四项；`before_provider_request` 由集成测试的内联扩展覆盖。

`installStreamFn` 读 `getDefaultStreamFn()` 而不是接受一个参数——组装根已经在启动时设过一次默认实现，这里只做「在其之上包一层」，这样 demo 与真实 Anthropic 实现走同一条路径（Review Focus 的第五个测试文件之外的验收点）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @mini-agent/extensions run test`
Expected: PASS，43 个 test（`installStreamFn` 的用例依赖 `setDefaultStreamFn` 先装好内层实现，模块级 singleton 在 vitest 的同一 worker 内共享，所以该用例必须自己设置而不要依赖别的用例的副作用）。

- [ ] **Step 5: 改 CLI**

`packages/cli/package.json` 的 `dependencies` 加 `"@mini-agent/extensions": "workspace:*"`。`packages/cli/src/index.ts` 四处改动：

1. 组装根：把现在的 `setDefaultStreamFn(createAnthropicStreamFn({...}))` 之后接上

```ts
const bootstrapped = await bootstrapExtensions({ extensions: [createDemoExtension()] });
bootstrapped.installStreamFn();
```

`ANTHROPIC_API_KEY` 的读取与 `baseUrl`/`model` 的推导一字不动——第二实现包在外面，不碰密钥处理。

2. `AgentSession.open/create` 的 options 加 `hooks: bootstrapped.hooks`、`tools: bootstrapped.tools(createDefaultTools())`。

3. `session.subscribe` 已有的事件打印保持不动，在它之后**追加一条**订阅把事件转给扩展：

```ts
const unsubscribeExtensions = session.subscribe((event) => {
	void bootstrapped.notify(event);
});
```

用 `void` 显式忽略 promise：观察者失败永远不会冒泡到 CLI 的事件循环。**不要** `await bootstrapped.notify(...)`——`deliverEvent` 里 `await listener(event)` 会把 reject 变成 `AgentInfrastructureFailure` 并 abort 当前 run，那就把「观察类 hook 软隔离」的承诺在组装层又撤销了。

4. 命令：输入循环里在 `/exit`、`/compact` 之后加 `/ext`，打印 `bootstrapped.runner.tools` 与 `bootstrapped.runner.commands` 的名字；扩展注册的命令（`demo`）按 `/demo` 匹配后调 `command.run({ args, context })`。banner 从 `"mini-agent (stage 10) — ..."` 改成 `"mini-agent (stage 11) — type /exit to quit, /compact to compact, /ext to list extensions"`。

- [ ] **Step 6: 手动冒烟**

Run: `pnpm dev`，然后输入 `say hi in three words`（真实网关），观察：模型正常回复、`/ext` 列出 `word_count` 与 `demo`、`bash` 调用被 block 并显示 `demo extension: bash is disabled`。`/exit` 退出。

- [ ] **Step 7: 全量回归 + Commit**

Run: `pnpm test && pnpm check`
Expected: 全绿。core 既有 test 原样通过，这是本阶段最重要的回归证据——`sessionHooks()` 空实现返回 `{}`，`AgentSessionOptions` 不传 `hooks` 时行为与阶段 10 逐字节一致。

```bash
git add packages/cli packages/extensions
git commit -m "feat(stage-11): assemble extensions into the CLI composition root"
```

---

## 完成标准

- [ ] `pnpm test` 全绿，且 core 的既有 test 一条未改、一条未删（空 `sessionHooks()` 与阶段 10 行为一致）
- [ ] `pnpm check` 全绿，`packages/extensions` 进入 workspace 的类型检查
- [ ] `packages/extensions` 的 `src/**` 对 `@mini-agent/core` 只有 `import type`，无深层路径导入 —— `no-core-runtime-imports.test.ts` 通过
- [ ] 六个 hook 全部接通并被测试覆盖：`tool_call`（Task 3）、`tool_result`（Task 4）、`context`（Task 5）、`turn_end`（Task 6）、`next_turn`（Task 7）、`before_provider_request`（本清单下一项）
- [ ] `before_provider_request` 复用阶段 10 的 `prepareRequest` seam：`AgentSessionOptions` 用 `Omit` 禁止调用方直接注入，只能在 `hooks` 里传；session 内部的 `prepareRequest`（journal 重投影 + 阈值压缩）先跑，扩展的装饰在其之后 —— Task 9 的 `before_provider_request` 集成用例钉住「装饰生效但 journal 里查不到装饰内容」
- [ ] 第二个 `StreamFn` 通过 `bootstrapExtensions().installStreamFn()` 挂载，调用点（`AgentSession` 与 `agentLoop`）零改动
- [ ] CLI 冒烟：`/ext` 列出注册项，`bash` 被 demo 权限规则拒绝，扩展工具可被模型调用
- [ ] 五个 Review Focus 失败模式各有一条失败测试钉住（Task 1、4、5、6、9）
- [ ] 分支 `stage-11-extensions` 上提交完成，commit trailer 为 `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

