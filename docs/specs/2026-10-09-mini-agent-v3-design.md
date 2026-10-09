# mini-agent v3 设计文档

> 教学项目：以 Pi Agent Harness（`D:\project\harness\pi`）为唯一参照，从零重写一个最小 coding agent。
> 读者画像：前端工程师（TypeScript 背景），已手写过 v1（964 行、五文件）、v2（monorepo、Mock 核心 + 13 阶段路线图，完成到第 4 阶段）。
> 日期：2026-10-09

---

## 0. 为什么有 v3

v1 与 v2 都完成了各自的教学目标，但它们各有一处结构性问题，导致继续叠加课程的边际收益递减：

| | v1（`mini-agent`） | v2（`mini-agent-v2`） | v3 |
|---|---|---|---|
| 规模 | 964 行 / 5 文件 | monorepo / 4 包 | monorepo / 3 包起步，按阶段生长 |
| 核心形状 | `streamFn` 注入 ✅ | `StreamFn` 契约 ✅ | `StreamFn` 注入 + **函数而非接口** |
| system prompt | `systemPrompt: string` ❌ | `systemPrompt: string` ❌ | **transcript 里的增量段落** |
| 事件模型 | 扁平 `AgentEvent` ⚠️ | 扁平 + 事件分发器 ⚠️ | **三层生命周期**（agent / turn / message） |
| 中途插入的内容 | — | mock-llm、web-ui、deepseek 适配器设计并行 | **单线，每阶段只加一个概念** |
| 持久化 | 无 | JSONL（阶段 4） | JSONL + `replay` 语义（第 9 阶段） |
| provider | 裸写 Anthropic SSE | ai-sdk / deepseek 适配器 | 手写，不用 ai-sdk |

v3 的目标不是"再写一个更好的 agent"，而是**用一条单线、无分叉的课程，把 Pi 的架构决策逐条复现一遍**。判断标准不是代码量，而是：每阶段结束时，能否回答"Pi 为什么这样做"。

### 0.1 与 v1/v2 的关系

- **v3 是独立仓库**，不导入 v1/v2 的任何代码。
- v1/v2 保留为对照物：v1 用于看懂"最小可跑"的下限，v2 用于看懂"拆得太细会付出什么代价"。
- 允许随时打开 v1 的 `src/anthropic.ts` 查 SSE 解析细节，但**不复用代码**——第 7 阶段要求自己撞一遍。

### 0.2 分工契约（本次学习方式）

**用户主学设计思想，实现由 Claude 完成。** 具体到每阶段：

1. Claude 先讲清「这个阶段要解决什么问题、Pi 的哪条决策是答案、为什么其他方案更差」。
2. Claude 实现（含测试），用户旁读。
3. 用户用苏格拉底式提问回测决策点（"如果这里改成 X 会怎样"）。
4. 验收通过后进入下一阶段。

这意味着：**每个阶段必须留下一个可被追问的决策点**，而不是一堆没有取舍的代码。设计文档每阶段都标注了这个决策点。

---

## 1. 目标与范围

**目标**：从零构建一个能在终端真实干活的 code agent，逐阶段达到 Pi 的架构清晰度。

**最终形态**：单仓库 →（第 12 阶段）CLI + Web UI 双前端，共享同一份 core。

**明确不做**（v3 的 YAGNI 清单，逐条对应 Pi 的包）：

| 跳过 | 理由 |
|---|---|
| `durable`（20404 行） | 事件溯源 + task 状态机属于分布式正确性问题。第 9 阶段用 **级别 2** 持久化（轮边界 append + resume）+ **20 行接口**（`replay` 声明）学到它的核心规则，不实现它的实现 |
| `chord`（编排运行时） | 服务/RPC/插件框架，与 agent 概念无关 |
| `server` / `client` / `protocol` | Pi 里也是 experimental。第 12 阶段用**最朴素的 WebSocket + JSON**替代，不走 CBOR 帧化 |
| `env`（SSH 远程执行） | 需要真实远端环境，教学收益低 |
| `codemode` / `mcp` | 独立能力，不属于核心链路 |
| `tui`（差分渲染） | 第 4-11 阶段用朴素 stdout；第 12 阶段用 React。不做终端组件库 |
| `evals` | 第 1-13 阶段用 vitest 承担 |
| `package-manager` / `model-resolver` / `settings-manager` | 产品复杂度，非架构 |
| session 树形 UI（`/tree` 选择器） | 第 9 阶段实现树的**数据层**与 `branch(id)`，不做交互式选择器 |

**关于 ai-sdk**：全程不用。第 7 阶段手写 Anthropic SSE 适配器。理由见 §7.3。

---

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node 22+（内建 `fetch` / Web Streams / `AbortController` / **类型擦除**） | |
| 语言 | TypeScript，`strict: true`、`erasableSyntaxOnly: true` | 只能用可擦除语法（见 §7.1） |
| 模块 | ESM（`"type": "module"`），`moduleResolution: NodeNext` | |
| 工程 | pnpm workspaces（`packages/*`），**零构建**：脚本用 `node --experimental-strip-types` 直接跑 TS | 无 build 步骤，改完即跑 |
| 测试 | **vitest** | 自带 TS 转换（因此不需要 `tsx`）、内建 spy/mock（阶段 5 需要）、`--watch` 体验好 |
| 运行时依赖 | **零** | 教学原则：所有机制可见。`dependencies` 全空；devDependencies 只有 `typescript`、`@types/node`、`vitest` |
| Provider | Anthropic Messages API 协议，走 `ANTHROPIC_BASE_URL`（默认 `https://api.kimi.com/coding/`），模型 `kimi-for-coding` | 环境变量已配置可用；协议格式与 Pi 的 `AssistantMessageEvent` 映射天然对齐 |
| 编辑器风格 | tab 缩进；每个 `src` 文件 < 200 行 | 与 Pi 一致；超限即信号，说明职责该拆了 |

**为什么不用 ai-sdk / `@anthropic-ai/sdk`**：见 §7.3。一句话版本——第 7 阶段要撞的三个坑（流式 tool call 参数拼接、text 与 toolCall 同响应共存、`done` 才是完整消息）正是第 3、5、10 阶段的立论基础。抹平它们会让后面的课程变成凭空立法。

---

## 3. 核心架构

### 3.1 分层

```
┌─────────────────────────────────────────────────┐
│  第 12 阶段：UI 层                               │
│  cli（stdout）      →   Web UI（React + WS）     │
│         ↑ 都只订阅事件，不读内部状态              │
└─────────────────────────────────────────────────┘
                        │ AgentEvent（异步、被 await）
┌─────────────────────────────────────────────────┐
│  Agent（第 4 阶段起）                            │
│  · 持有 _state（messages / tools / isStreaming） │
│  · 单向数据流：快照 → loop → 事件 → 回流 _state   │
│  · prompt / continue / steer / followUp / abort  │
└─────────────────────────────────────────────────┘
                        │ AgentLoopConfig（六个 hook）
┌─────────────────────────────────────────────────┐
│  agentLoop（第 2 阶段起）                        │
│  · 双层 while                                       │
│  · 无状态：每次调用重新构造 currentContext        │
└─────────────────────────────────────────────────┘
                        │ StreamFn（第 1 阶段立起）
┌─────────────────────────────────────────────────┐
│  streamFn 实现                                    │
│  第 1-6 阶段：假模型   第 7 阶段起：Anthropic SSE │
└─────────────────────────────────────────────────┘
```

**依赖方向严格单向**：UI → Agent → loop → StreamFn。`loop` 不认识 provider，`Agent` 不认识 UI。

### 3.2 三个必须一开始就定对的接口

这三处如果事后加，要重写整个 runtime。它们是 v3 相对 v1/v2 的主要修正。

#### (a) `StreamFn` 是函数类型 + 模块级单例插槽

对应 `packages/agent/src/stream-fn.ts`（20 行）与 `packages/agent/src/types.ts:33`。

```ts
// 依赖注入缝：core 完全不知道 provider 存在
export type StreamFn = (
	context: { system: SystemMessage; messages: Message[]; tools: Tool[] },
	signal?: AbortSignal,
) => AsyncGenerator<AssistantMessageEvent>;

// stream-fn.ts：20 行的单例插槽，供组装方安装默认实现
export function setDefaultStreamFn(fn: StreamFn | undefined): void;
export function getDefaultStreamFn(): StreamFn; // 未设置时抛错

// Agent 的 streamFn 构造参数可选，缺省时 fallback 到 getDefaultStreamFn()
```

**Pi 的取舍**：用**函数**而不是 `interface Provider`。理由——只有一个方法时，接口会带来实现类、构造、注册表这一串仪式，而函数可以内联写（Pi 的 `coding-agent/src/core/sdk.ts:420` 就是一个内联 async 函数，里面做 cache warmer 启动 + 路由）。

**契约要求**：`StreamFn` **不抛异常**，失败编码为 `stopReason: "error" | "aborted"` 的终止事件（`packages/agent/src/types.ts:27-31`）。这条契约在第 4 阶段的事件模型里兑现。

#### (b) `SystemMessage` 是 transcript 的一部分，不是参数

对应 `packages/ai/src/types.ts:541`、重放函数 `packages/ai/src/utils/transcript.ts:99`。

```ts
interface SystemMessage {
	role: "system";
	sections: Array<{ tag?: string; text: string }>;  // 增量段落
	toolsAdded?: Tool[];      // 本次新增的工具声明
	toolsRemoved?: string[];  // 本次移除的工具名
}
```

**要拿到"当前 prompt"必须重放整条 transcript** 的 system 消息并累加 sections / 应用 toolsAdded、toolsRemoved。

**Pi 为什么这样做**：

1. **持久化免费**——不用另存"当时的 prompt"，它本来就在历史里，resume 时自动正确。
2. **prompt cache 友好**——只提交变化的那一段。Pi 的实现里 section 顺序稳定、只追加，provider 的 prompt cache 能命中前缀。
3. **压缩天然正确**——压缩点之后重放，prompt 自然是对的。
4. **工具集变更 тоже 是历史**——`toolsAdded`/`toolsRemoved` 记为事件，而不是"当前工具集"这个易变状态。这对第 9 阶段的 replay 和第 11 阶段的动态工具切换是前提。

**代价**：读 prompt 不是 O(1)。Pi 接受这个代价。

**v3 的安排**：**第 1 阶段先用最简单的 `system: string`，第 8 阶段改写为增量段落。** 这是路线里唯一一次"回头改前面的代码"，是刻意的——第 8 阶段之前你会先体会过 `string` 在持久化、缓存、动态工具三处的具体痛点，改写时才有判断依据。

#### (c) `AgentEvent` 是三层生命周期

对应 `packages/agent/src/types.ts:516-539`。

```ts
type AgentEvent =
	// 第一层：一次 run
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	// 第二层：一个 turn = 一次 assistant 响应 + 其工具调用与结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: Message; toolResults: ToolResultMessage[] }
	// 第三层：单条消息
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: Message; event: AssistantMessageEvent } // 仅 assistant 流式期间
	| { type: "message_end"; message: Message }
	// 第三层：单次工具执行
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown;
	    isError: boolean; durationMs?: number };
```

**关键约定**：

- `agent_end` 是最后一个事件，但 **idle 要等它的 listener 跑完**（listener 被 `await`，且计入本轮 settle）。这一条决定了第 13 阶段的 `waitForIdle()` 语义。
- `tool_execution_end` 的 `durationMs` 用**单调时钟**测量，不用 `Date.now()`（避免系统时钟调整导致负值）。
- 工具结果也走 `message_start` + `message_end` 发一遍，这样 UI 和持久化**不需要为工具结果写特判分支**。

**UI 白送**：第 12 阶段的 WebSocket 服务端几乎只是把事件 `JSON.stringify` 转发。

### 3.3 单向数据流

`Agent._state` 与 loop 内的 `currentContext` 是**分离的**（Pi：`agent.ts:460` 的 `createContextSnapshot()`）：

```
prompt()
  → createContextSnapshot()   对 _state.messages 做快照
  → agentLoop(snapshot, config)
      → emit(event)            每步向外发事件
  → processEvents(event)       reduce 进 _state，再 await 所有 listener
```

loop 从不直接改 `_state`；所有变更经由事件回流。好处：**UI 与内部状态永远不会不一致**，且 loop 可以被独立测试（不需要 Agent 类）。

---

## 4. 消息 IR

对应 `packages/ai/src/types.ts:541-639`。第 1 阶段先落最小版本，后续阶段按需生长。

```ts
// ── 内容块：content 是块数组，不是字符串 ──
type ContentBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

// ── 消息 ──
interface UserMessage       { role: "user"; content: ContentBlock[] }
interface AssistantMessage  { role: "assistant"; content: ContentBlock[];
                              stopReason: StopReason; usage?: Usage; durationMs?: number }
interface ToolResultMessage { role: "toolResult"; toolCallId: string; toolName: string;
                              content: ContentBlock[]; isError: boolean }
type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// Pi 的完整 stopReason，v3 从第 1 阶段就用全集，避免后续加分支
type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
```

**为什么 `content` 必须是块数组**：一次 assistant 响应里可以既有 text 又有 toolCall，且**顺序有意义**（模型先说"我要读文件"，再发 read 调用）。扁平化成字符串就丢了这个结构，第 5 阶段的 `prepare/execute/finalize` 三段式也就无处安放。

**`usage` 从第 7 阶段起填充**（token 计数 + 成本），第 10 阶段压缩阈值判定依赖它。

---

## 5. 阶段路线

13 个阶段，不合并。每阶段的硬性约束：

- **只加一个新概念**
- **不许提前实现下一阶段的内容**
- **先写测试，再写实现**
- **阶段结束时 `pnpm test` 与 `pnpm check` 全绿**
- **源码总量增量 < 400 行**（超了说明阶段切分不对）

每阶段标注：**新概念** / **Pi 对应** / **决策点**（供回测追问）/ **验收**。

---

### 第一幕：把接口立起来（阶段 1-4）

#### 阶段 1 —— 一次往返

| | |
|---|---|
| **新概念** | 消息 IR + `StreamFn` 注入缝 |
| **Pi 对应** | `ai/src/types.ts:541-639`；`agent/src/stream-fn.ts`（20 行）；`agent/src/types.ts:33` |
| **决策点** | 为什么 `StreamFn` 是函数而不是 `interface Provider`？为什么 core 不 `import` 任何 provider？ |

**范围**：建立 workspace（根 `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json`），创建三个包。`packages/ai`：`types.ts`（消息 IR 最小集）、`stream-fn.ts`（20 行插槽）、`fake.ts`（确定性假模型）。`packages/core`：`agent-loop.ts`（极简版，只处理无工具的单轮）。`packages/cli`：readline 循环（无流式）。

**假模型为什么住在 `ai` 而不是 `core/test`**：它是 `StreamFn` 的一个**合法实现**，与阶段 7 的 `anthropic.ts` 同层同契约，只是确定性。放在 `core/test/` 会让 `pnpm dev`（生产入口）不得不 import 另一个包的测试目录，并且掩盖了关键事实——`cli` 与 `core` 都**不认识**任何 provider 实现，只通过插槽安装。假模型属于 provider 层，这是结构性的，不是权宜。

**假模型的设计**：不是"随机返回文本"，而是**从预设脚本表读取事件序列**。调用 `streamFn` 时按 `messages` 的轮次索引返回对应脚本。这样测试完全确定，且第 2 阶段的工具调用能在同一机制上扩展。

**验收**：

1. `pnpm dev` 输入任意文本，假模型回一句固定问候，打印到终端。
2. 测试断言：调用一轮后 `messages` 长度为 2（user + assistant），assistant 的 `stopReason === "stop"`。
3. `pnpm test` 与 `pnpm check`（各包 `tsc --noEmit`）全绿。
4. `node_modules` 里没有任何运行时依赖（只有 `typescript` / `@types/node`）。

**源码预算**：约 250 行（含 workspace 配置）。

---

#### 阶段 2 —— 工具与循环

| | |
|---|---|
| **新概念** | toolCall 内容块 + 工具注册 + **串行**执行 + 循环终止条件 |
| **Pi 对应** | `agent-loop.ts:163-321`（`runLoop`）；`:530-584`（`executeToolCallsSequential`）；`:930-944`（`createToolResultMessage`） |
| **决策点** | 工具执行失败时，为什么是"回喂模型"而不是"抛给调用方"？ |

**范围**：`agent-loop.ts`（单层 while，先不做双层）、`tools.ts`（`read` / `edit` / `bash` 三个）、`ToolDef` 接口（含 `replay` 字段，本阶段为空占位）。

**工具定义**：

```ts
interface ToolDef<P = unknown> {
	name: string;
	description: string;
	parameters: JSONSchema;          // 手写 JSON Schema，不引 TypeBox（教学透明）
	/** 副作用安全性：进程崩溃后能否安全重跑。默认 "unsafe"。第 9 阶段启用。 */
	replay?: "safe" | "unsafe";
	execute: (params: P, signal?: AbortSignal) => Promise<ToolResult>;
}
interface ToolResult { content: ContentBlock[]; isError?: boolean }
```

**`replay` 字段现在就写进去、现在还是死代码**——这是刻意的前置投资。它是 §9 持久化那一课的全部内容所依赖的 20 行接口。

**错误处理原则**（贯穿全项目）：

> **模型能修的错误回喂模型；模型修不了的抛给人。**

| 错误 | 处理 |
|---|---|
| 工具执行失败 | `isError: true` 的 toolResult 回喂 → 模型自我纠错 |
| 未知工具 / 参数畸形 | 同上回喂 |
| `stopReason === "length"` | **整批工具不执行**，全部生成 `isError` 结果回喂 |
| LLM HTTP 错误 / 网络中断 | 第 4 阶段起编码为事件；阶段 1-3 暂抛 |
| Ctrl+C | `AbortSignal` 一路传到 fetch 和 bash |

**`stopReason === "length"` 的整批保护**（Pi `agent-loop.ts:267`）：参数 JSON 被 token 上限截断，半截 JSON 不能 `parse`，所以整批工具判失败。这一条在第 7 阶段手写 SSE 时会看到它的物理来源。

**关键约定**：**工具结果必须按模型原始调用顺序入历史**，不能按完成顺序。本阶段是串行所以自动满足；第 6 阶段的并行会让这条约定变成必须显式实现的规则。

**验收**：

1. 假模型脚本：第一次返回 2 个 toolCall（read + read），第二次返回文本答案。
2. 断言 `messages` 顺序为 `[user, assistant(toolCall×2), toolResult×2, assistant(text)]`。
3. 覆盖分支：未知工具、工具抛错、`stopReason: "length"` 三种情况均产生 `isError` 结果且循环继续。
4. `read` / `edit` / `bash` 各自测试：`edit` 的 `oldText` 出现 0 次或多次都要报错（唯一性校验）。

**源码预算**：约 350 行。

---

#### 阶段 3 —— 流式

| | |
|---|---|
| **新概念** | `AssistantMessageEvent` + **delta 与 done 的分离** |
| **Pi 对应** | `ai/src/types.ts:801-817`（12 个变体）；`ai/src/utils/event-stream.ts:26`、`:97` |
| **决策点** | 为什么 delta 事件不进消息历史，只有 `done` 携带的消息进？ |

**范围**：`EventStream<T, R>` 泛型（async-iterable + `push`/`end`/`result()`）、`AssistantMessageEvent`、假模型改造为发 delta 序列、CLI 改为逐字打印。

**核心约定**（v1 已确立，v3 保留）：

> **流式增量只用于 UI 即时显示；只有 `done` 携带的完整消息才进入历史。**

**理由**：delta 是**传输层的碎块**，不构成完整语义单元。一次响应可能发 40 个 delta，但它们共同描述的是 1 条 assistant 消息。若把 delta 入历史：消息数组会被碎片污染、持久化会写入大量无用记录、重放时无法区分"40 个碎块"和"用户真的发了 40 条消息"。

**`usage` 与 `durationMs` 在 `done` 时填充**——`EventStream` 用单调时钟在 `start` 打点、`done` 结算。

**验收**：

1. 终端能看到文本逐字出现（假模型故意每 delta 之间 `await` 一小段）。
2. 断言：一轮结束后 `messages` 里只有 1 条 assistant 消息（不是 40 条），且其 `content[0].text` 是完整文本。
3. 断言事件序列：`start` → `text_delta`×n → `done`，且 `done.message` 的文本等于所有 delta 拼接。
4. 断言 `message_update` 的 `partial` 在最后一条 delta 后与 `done.message` 一致。

**源码预算**：约 250 行。

---

#### 阶段 4 —— 事件分层与生命周期

| | |
|---|---|
| **新概念** | `AgentEvent` 三层生命周期 + `Agent` 类 + 单向数据流 |
| **Pi 对应** | `agent/src/types.ts:516-539`；`agent.ts:188`（`Agent`）、`:460`（快照）、`:565`（`processEvents`）、`:266`（`subscribe`） |
| **决策点** | 为什么 loop 无状态、状态在 `Agent` 类里？为什么 listener 是被 `await` 的？ |

**范围**：`Agent` 类（`prompt` / `subscribe` / `state` / `abort` / `waitForIdle`）、`AgentEvent` 全集、`processEvents` 做 reduce。

**关键实现**：

- `createContextSnapshot()` 对 `_state.messages` 做防御性复制后传给 loop。
- `processEvents(event)`：先 reduce 进 `_state`，**然后 `await` 所有订阅者**。
- `subscribe(listener)` 返回 `unsubscribe` 函数。
- `abort()` 只做一件事：`activeRun.abortController.abort()`。
- **中止不抛异常**：截断点变成 `isError: true` 的 toolResult，循环自然收敛；兜底构造一条 `stopReason: "aborted"` 的 assistant 消息并走完正常事件序列（Pi `agent.ts:532` 的 `handleRunFailure`）。

**为什么 listener 被 await**：`agent_end` 是最后一个事件，但它发出后 listener 可能还在写日志/落盘。若不等，`waitForIdle()` 会提前返回，第 9 阶段的持久化就会丢数据。**这是一个为了正确性牺牲吞吐的取舍，且必须在状态机语义里定死。**

**验收**：

1. 订阅者收到完整事件序列，顺序断言为：
   `agent_start → turn_start → message_start → message_update×n → message_end → message_start(toolResult) → message_end → tool_execution_* → turn_end → ... → agent_end`
2. `waitForIdle()` 在一个故意 `await` 3 秒的 listener 下会真的等满（用假时钟或宽松断言）。
3. Ctrl+C 后：`state.isStreaming === false`，且历史里有一条 `stopReason: "aborted"` 的 assistant 消息。
4. **UI 完全不读 `agent.state`**——只用事件就能渲染完整过程（这是本阶段最重要的验收）。

**源码预算**：约 300 行。

---

### 第二幕：把边界做扎实（阶段 5-8）

#### 阶段 5 —— 三段式工具调用与拦截

| | |
|---|---|
| **新概念** | `prepare` / `execute` / `finalize` 分离 + `beforeToolCall` 拦截 |
| **Pi 对应** | `agent-loop.ts:708`（`prepareToolCall`）、`:821`（`executePreparedToolCall`）、`:859`（`finalizeExecutedToolCall`）、`:728-756`（block 实现）；`agent/src/types.ts:66`（`BeforeToolCallResult`） |
| **决策点** | 为什么这三件事必须分开？混在一起写会失去什么能力？ |

**这是整个路线里最重要的一个阶段。**

**分离的理由**：`beforeToolCall` 可能弹一个权限对话框等待用户点击，这件事**必须发生在工具开始干活之前**。如果 prepare 和执行写在一起，唯一的拦截点就是"执行开始后"，那时文件已经被删了。

三段职责：

| 阶段 | 职责 | 可失败点 |
|---|---|---|
| **prepare** | 找工具、校验参数（JSON Schema）、跑 `beforeToolCall`、生成 `{ block }` 判定 | 未知工具、参数畸形、被 hook 拦住 |
| **execute** | 真正调用 `execute()`，接收 `onUpdate` 部分结果回调 | 工具抛错、被 abort |
| **finalize** | 统一生成 `toolResult` 消息、算 `durationMs`、透传 `terminate`、发 `tool_execution_end` | — |

**Pi 没有内置权限系统**——这是刻意的产品决策（`README.md` 有专节）。权限完全由扩展在 `beforeToolCall` 上承担。v3 在第 5 阶段实现机制，**不实现权限规则**（规则留到第 11 阶段作为扩展）。

**`BlockResult`**：

```ts
interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	terminate?: boolean;  // 透传到 toolResult，多个同时 terminate 则结束 run
}
```

被 block 时**不执行工具，但产生 `isError` 的 toolResult 回喂模型**——模型会知道"这一步被拒绝了"并换方案，而不是整个 run 崩掉。

**验收**：

1. 注册一个 `beforeToolCall`，对 `bash` 一律 block。断言：`execute` 从未被调用（用 spy），但历史里有 `isError` 的 toolResult，循环继续。
2. 参数校验失败时，`execute` 从未被调用，错误信息里包含 schema 违规详情。
3. `terminate: true` 时 run 结束且不再发下一次模型请求。
4. `onUpdate` 部分结果能通过 `tool_execution_update` 事件流到 UI。

**源码预算**：约 350 行。

---

#### 阶段 6 —— 并行工具

| | |
|---|---|
| **新概念** | prepare 串行 / execute 并行 / **结果按源序** + 同文件写入串行化 |
| **Pi 对应** | `agent-loop.ts:508-523`（分派）、`:586-660`（两阶段并行）；`core/tools/file-mutation-queue.ts`；`agent/src/types.ts:44-46`（顺序语义注释） |
| **决策点** | 为什么 prepare 必须串行而 execute 可以并行？`tool_execution_end` 和 toolResult 消息为什么用不同的顺序？ |

**分派规则**：

```ts
// 任何一个工具声明了 sequential，整批降级为串行
if (toolExecution === "sequential" || toolCalls.some(tc => findTool(tc.name)?.executionMode === "sequential"))
	return executeSequential(...);
return executeParallel(...);
```

**并行实现是两阶段的，顺序语义必须记准**：

1. **阶段一（同步、顺序）**：逐个跑 `prepare`（含 `beforeToolCall`），通过的包成 thunk 塞进数组。
2. **阶段二**：`Promise.all` 并发跑所有 thunk。
3. **事件顺序**：`tool_execution_end` 按**完成顺序**发（在 thunk 内）。
4. **消息顺序**：toolResult 消息按 **assistant 源顺序**发。

**为什么事件和消息用不同顺序**：事件是**给 UI 的实时反馈**，用户想看"哪个先跑完"；消息是**给模型的协议输入**，模型按自己发出的调用顺序理解结果。用同一顺序会破坏其中一方。

**`file-mutation-queue`**：按 `realpath` 建 `Map<string, Promise<void>>`，**同文件串行、跨文件并行**。这是并行执行下写入安全的必需件——没有它，两个 `edit` 同时改一个文件会互相覆盖。

**验收**：

1. 三个假工具，第一个故意慢 100ms。断言：总耗时 < 150ms（证明确实并行）；`tool_execution_end` 顺序是 `[2, 3, 1]`（完成顺序）；toolResult 消息顺序是 `[1, 2, 3]`（源顺序）。
2. 同文件两个 `edit` 并发时，串行队列保证不丢更新。
3. 声明 `executionMode: "sequential"` 的工具出现时，整批降级串行。
4. abort 在并行中途触发时，未开始的任务直接短路成 `"Operation aborted"` 错误结果。

**源码预算**：约 350 行。

---

#### 阶段 7 —— 真实 LLM 适配器（手写 SSE）

| | |
|---|---|
| **新概念** | 裸写 Anthropic Messages 适配器：消息转换 / SSE 解析 / 事件映射 |
| **Pi 对应** | `ai/src/types.ts:801`（`AssistantMessageEvent` 12 变体）；参考 v1 的 `src/anthropic.ts`（251 行）写法，**但不复用代码** |
| **决策点** | 为什么 `StreamFn` 契约要求"不抛异常，失败编码为 error 事件"？ |

**范围**：`anthropic.ts`，约 150 行。

**三个必须自己撞的坑**：

1. **tool call 参数是流式到达的**。Anthropic 发 `content_block_delta` + `input_json_delta`，参数是**字符串片段**，必须自己拼接、在 `message_stop` 才 `JSON.parse`。→ 这就是阶段 2 那条"`stopReason === "length"` 时整批工具判失败"规则的**物理来源**：截断时拼出来的 JSON 是半截的。
2. **一次响应可以既有 text 又有 tool call**，且顺序有意义。→ 印证阶段 1 里 `content` 必须是块数组。
3. **只有 `message_stop` 才知道响应结束了**。→ 印证阶段 3 的 delta/done 分离是照抄协议形状，不是设计选择。

**消息转换的两个约束**：

- `toolCall` → `tool_use` block；文本 block 直通。
- `ToolResultMessage` → 必须包进**下一条 `user` 消息**的 `tool_result` block 里（Anthropic 协议约束）。**连续的 toolResult 合并进同一条 user 消息**。

**错误处理**：HTTP 非 2xx / 流中断 → **不抛异常**，yield 一个 `stopReason: "error"` 的终止事件。这是 `StreamFn` 契约（`agent/src/types.ts:27-31`）的兑现点。

**测试策略**：用录制的 SSE fixtures 喂解析器，断言统一事件序列（v1 已验证此路可行）。**不打真实 API 的测试**——网络测试不可重复。

**真实联调**（手动，不进 CI）：环境变量已配置（`ANTHROPIC_BASE_URL=https://api.kimi.com/coding/`，模型 `kimi-for-coding`）。

**验收**：

1. fixtures 测试：`fixtures/text.sse`、`fixtures/toolcall.sse`、`fixtures/mixed.sse`（text + 2 个 tool call）、`fixtures/error.sse`、`fixtures/truncated.sse` 全部通过。
2. 断言 `truncated.sse` 的场景产生 `stopReason: "length"`，且循环把整批工具判失败。
3. 手动联调：`pnpm dev` 输入"读一下 package.json 然后总结"，能看到流式文本 + `read` 工具调用 + 最终总结。
4. 断言 `StreamFn` 在 HTTP 500 时**不抛异常**，而是 yield error 事件。

**源码预算**：约 300 行（含 fixtures 辅助）。

---

#### 阶段 8 —— System prompt 即历史

| | |
|---|---|
| **新概念** | `SystemMessage` 增量段落 + 重放 |
| **Pi 对应** | `ai/src/types.ts:531-557`；`ai/src/utils/transcript.ts:99`（`getCurrentSystemPrompt`）、`:150`（`getToolStateChanges`） |
| **决策点** | 把 prompt 从参数改成历史，具体买到了什么？O(1) 读变成 O(n) 重放，值吗？ |

**这是路线里唯一一次回头改前面的代码。**

**改写内容**：

- 阶段 1 的 `system: string` → `SystemMessage { sections, toolsAdded?, toolsRemoved? }`。
- 新增 `getCurrentSystemPrompt(messages)`：重放所有 system 消息，累加 sections，应用工具增减。
- 工具集变化时**追加一条新 system 消息**，而不是改"当前工具集"这个字段。
- 测试：原本直接读 `system` 的地方改为重放。

**具体买到的四件事**（第 8 阶段之前会先体会到痛点）：

1. **持久化免费**（阶段 9 会直接受益）：不用另存当时的 prompt，resume 时自动正确。
2. **prompt cache 命中**：只提交变化的那一段。
3. **压缩天然正确**（阶段 10）：压缩点之后重放，prompt 自然对。
4. **工具集变更是历史事件**：为阶段 11 的动态工具切换和阶段 9 的 replay 铺路。

**代价要诚实**：读 prompt 从 O(1) 变成 O(n) 重放。Pi 接受；v3 也接受，并在文档里注明这是取舍不是免费午餐。

**验收**：

1. 重放函数对三种情况正确：只有一条 system、多条 system 累加、有 toolsAdded/toolsRemoved 的工具集变化。
2. 压缩/裁剪后重放，prompt 仍然正确（本阶段用简单裁剪模拟）。
3. 断言：连续两次相同请求，第二次的 system 消息**没有新增**（因此 prompt 前缀稳定，cache 可命中）。

**源码预算**：约 250 行（含改写）。

---

### 第三幕：产品化（阶段 9-13）

#### 阶段 9 —— 会话持久化

| | |
|---|---|
| **新概念** | JSONL append-only + `id`/`parentId` 树 + **`replay` 语义** |
| **Pi 对应** | `core/session-manager.ts:1191`（`_appendEntry`）、`:57-62`（`id`/`parentId`）、`:1579`（`branch`）、`:183-196`（11 种 entry）；`durable/README` 的 replay 规则 |
| **决策点** | journal 里的记录为什么必须 append-only？commit 与 execute 的先后为什么不能颠倒？ |

**存储位置**：`.mini-agent/sessions/<timestamp>_<id>.jsonl`。

**格式**：首行 `SessionHeader`（含 `version`），其余每行一个 `SessionEntry`。

**两个核心设计**：

**(a) entry 靠 `id`/`parentId` 组成树。** 当前 `leafId` 决定活跃分支。`branch(fromId)` **只是把 `leafId` 移回某个早先 entry**——原地分支，不建新文件。`/fork` 才建新文件。

**(b) append-only。** 任何修正都是**追加一条新 entry**，不是改旧 entry。

**这一步是 `durable` 的核心规则，用 20 行接口学到**：

> **先 commit，再 execute。** 工具调用的**意图**在 `execute()` 之前就写进 journal。进程崩溃后重开：
> - 工具声明 `replay: "safe"` → **可以重跑**
> - 否则 → 模型收到 `interrupted` 错误结果 + 已经 committed 的部分输出

这就是阶段 2 那个 `replay` 字段的启用时刻。`read` 标 `safe`，`write` / `edit` / `bash` 标 `unsafe`。（对照 Pi `durable`：`read.ts` 216 行 vs `write.ts` 39 行——写操作不可重放，代码里全是这个约束。）

**幂等输入**：`submit({ requestId })` 同 id 重复提交返回既有 submission，不重复执行。

**恢复语义（级别 2）**：每**轮**结束 append，能 resume 到轮边界。**不做**级别 3（每步 checkpoint）、级别 4（完整的 task graph + 原子 commit 组）。理由见 §1 的 YAGNI 表。

**验收**：

1. 跑两轮对话 → kill 进程 → `--continue` → 历史完整恢复，能继续对话。
2. `branch(earlierEntryId)` 后继续对话，两条分支共存于同一文件。
3. **崩溃模拟**：在 `execute()` 中途抛错（用一个故意炸的假工具），重启后断言：`read` 被重跑（safe），`write` 收到 `interrupted` 错误结果而非重跑。
4. 同 `requestId` 提交两次，第二次返回既有 submission。
5. 断言 journal 文件在整轮结束后是**纯追加**的（对比写入前后行数，旧行字节不变）。

**源码预算**：约 400 行。

---

#### 阶段 10 —— 上下文压缩

| | |
|---|---|
| **新概念** | 阈值判定 + 切点查找 + **追加压缩 entry 而非删除** |
| **Pi 对应** | `compaction/compaction.ts:267`（`shouldCompact`）、`:446`（`findCutPoint`）、`:298`（`estimateTokens`）；`core/messages.ts:109`（`createCompactionSummaryMessage`） |
| **决策点** | 为什么压缩要生成新 entry，而不是真的把老消息删掉？ |

**核心语义**（Pi `docs/sessions.md`）：

> 压缩**不删除**任何 session entry，只**追加一条 `compaction` entry**。后续请求重建 context 时，用它替换更早的消息。

**为什么不能删**：删掉就没有"时间旅行"能力了——阶段 9 的 `branch(id)` 要求历史节点仍然存在。而且压缩是有损的，删了就再也拿不回原文。

**实现要点**：

- `shouldCompact(contextTokens, contextWindow, settings)` —— **纯函数、布尔返回**，最好测。
- `findCutPoint(entries, keepRecentTurns)` —— 找保留最近 N 轮的切点，纯函数。
- `estimateTokens(message)` —— 逐条粗估（字符数 / 4）。第 7 阶段起可用真实 `usage` 校准。
- 切点必须落在**完整的 turn 边界**上，不能切开一个含 toolCall 的 assistant 消息和它的 toolResult。
- 摘要生成：调 `StreamFn`，用单独的 summarization system prompt。

**触发路径**（Pi 有三种 reason：`"manual" | "threshold" | "overflow"`）：

- 阈值检查挂在 `prepareRequest` hook 上（调用模型前最后一次检查）。
- overflow（模型报超窗）→ 压缩后重试一次，用标志位防重入。

**验收**：

1. `shouldCompact` / `findCutPoint` 纯函数单测：边界值（刚好等于阈值、刚好差一个 token）、切点不切开 turn 对。
2. 超阈值时自动触发，事件序列含 `compaction_start` → `compaction_end`。
3. **断言 journal 里 entry 数量只增不减**，压缩前后旧 entry 字节完全不变。
4. 压缩后重放 context，模型看到的是「摘要 + 压缩点之后的消息」，且 system prompt 正确。
5. overflow 恢复：模拟模型报超窗 → 压缩 → 重试成功；再报一次则不再重试。

**源码预算**：约 380 行。

---

#### 阶段 11 —— 扩展系统

| | |
|---|---|
| **新概念** | `ExtensionAPI` + `on(event)` + 通过 hook 挂进 core，**不 import core** |
| **Pi 对应** | `core/extensions/types.ts:1564`（`ExtensionAPI`）、`:2017`（`ExtensionFactory`）；`runner.ts:1089`（通用 `emit`）；接线点 `core/agent-session.ts:652-655`、`:787`、`:887-904` |
| **决策点** | 扩展为什么不能直接 import core？六个 hook 为什么够了？ |

**挂载点**（Pi 的实际接线，v3 复现）：

| 挂载点 | 影响 |
|---|---|
| `agent.beforeToolCall` | 可 block —— **阶段 5 的机制在这里变成真实权限系统** |
| `agent.afterToolCall` | 可替换 content / details / isError |
| `agent.transformContext` | 改模型看到的消息（剪枝、注入外部上下文） |
| `agent.prepareRequest` | 请求前最后一次替换（阶段 10 的压缩判定挂这里） |
| `agent.finishTurn` | 决定 turn 后是否继续 |
| `agent.prepareNextTurnWithContext` | 基于已完成 turn 做决策 |

**为什么只有六个 hook 够了**：这六个覆盖了「模型请求前 / 工具执行前 / 工具执行后 / turn 结束后 / 下一轮开始前 / 上下文处理」——即**所有决策点**。再多就会开始侵入内部实现。

**扩展形态**：第 11 阶段只做**内联扩展**（编程式传入 `ExtensionFactory`）。文件扩展（`jiti` 动态加载）和 npm 包分发不做。

**本阶段的具体练习**：把阶段 7 的 `anthropic.ts` 换成一个「第二实现」——**用 ai-sdk 写一个 `StreamFn`**，作为扩展挂进去。此时有六个 hook、一个注册表、一个既有实现，正好回答扩展系统最该回答的问题：**同一个缝的第二种实现，需要改 core 吗？**（答案必须是不需要。）

**验收**：

1. 写一个内联扩展：注册一个自定义工具 + 一个 `beforeToolCall` 权限规则 + 一个 `transformContext` 剪枝钩子。**扩展文件里没有任何 `import` 来自 core**（除类型）。
2. 断言 `pi.on("tool_call", ...)` 返回 `{ block: true }` 时工具不执行（阶段 5 的验收在此复现，但走扩展路径）。
3. ai-sdk 的 `StreamFn` 作为第二个实现挂进去，**core 零改动**，测试全绿。
4. 扩展注册的工具能和内置工具共存、可被模型调用。

**源码预算**：约 400 行（含 ai-sdk 适配器，这是唯一的运行时依赖例外，且只存在于扩展侧）。

---

#### 阶段 12 —— UI 层

| | |
|---|---|
| **新概念** | 事件流序列化 + WebSocket 转发 + React 订阅 |
| **Pi 对应** | `modes/interactive/interactive-mode.ts:3400`（`subscribeToAgent`）、`:3406`（大 switch）；**明确不抄 `pi-tui` 的差分渲染，不抄 `packages/server` 的 CBOR 帧化** |
| **决策点** | 为什么 UI 只订阅事件、不读 `agent.state`？服务端为什么不需要理解业务？ |

**架构**：

```
core（阶段 1-11 的产物，零改动）
   ↑ 事件
cli（保留）        server（新增，~150 行）
                      ↑ WebSocket，JSON 序列化
                   web（新增，React）
```

**服务端职责**：接收 `prompt` 命令 → 转成 `agent.prompt()` → 把 `AgentEvent` 逐个 `JSON.stringify` 转发。**不含任何业务逻辑**——这是阶段 4 事件分层的红利兑现点。

**前端**（发挥你的前端背景）：

- 消息列表（user / assistant / toolResult 三种渲染）
- 工具调用卡片：名称、参数、耗时、折叠的结果
- token 用量与成本（从 `usage` 累计）
- 流式文本的逐字追加
- 压缩事件的时间线标记

**验收**：

1. 同一份 core，CLI 与 Web UI 同时可用，行为一致。
2. 浏览器里能看到完整的一次工具调用过程（流式文本 → 工具卡片 → 结果 → 最终答案）。
3. **服务端代码里没有任何 `import` 自 core 的内部模块**（只用 `Agent` 公共 API 与事件类型）。
4. 断开 WebSocket 后重连，能补齐缺失的事件（用阶段 9 的 journal 重放）。

**源码预算**：约 500 行（含前端）。

---

#### 阶段 13 —— 子 Agent 与中途插话

| | |
|---|---|
| **新概念** | `steer` / `followUp` 双队列 + `runToolCall` 独立入口 + 子 agent 隔离 |
| **Pi 对应** | `agent.ts:143-174`（`PendingMessageQueue`）、`:112`/`:117`（`steer`/`followUp`）；`agent-loop.ts:811`（`runToolCall` 导出）、`:179`/`:302-308`（双层循环的 follow-up 分支）；`agent/src/types.ts:55`（`QueueMode`） |
| **决策点** | 为什么 loop 需要**双层** while？`steer` 和 `followUp` 的区别是什么？ |

**双层循环**（阶段 2 只做了内层，现在补外层）：

```
外层 while (true):          处理 follow-up —— agent 本该停下时，队列有货就重进内层
  内层 while (有工具调用 || 有待处理消息):   处理 tool call 与 steering
```

**两个队列的区别**：

| | `steer` | `followUp` |
|---|---|---|
| 何时生效 | **运行中立即**——当前 turn 结束后、下一轮模型请求前插入 | **agent 本该停下来时**才注入 |
| 典型场景 | "别改那个文件，改这个" | "顺便再跑一下测试" |
| `QueueMode` | `"one-at-a-time"`（默认）或 `"all"` | 同 |

**`runToolCall()` 独立导出**（Pi `agent-loop.ts:811`）：单个工具调用可以脱离循环独立发起，走完全相同的 prepare/validate/hook/execute 流程，但不发事件、不写消息。用途：子 agent、后台任务、单次工具重试。

**子 agent 隔离**：每个子 agent 有自己的 `Agent` 实例和独立消息历史，**只把结果回给父**（不共享 messages 数组）。这样一个子 agent 的上下文爆炸不会拖垮父。

**验收**：

1. 运行中途 `steer("停一下")`，断言：当前 turn 完成后、下一次模型请求前，该消息出现在 context 里。
2. `followUp("再跑个测试")` 在 `agent_end` 之前注入，run 不结束。
3. 双层循环：假模型在第一轮就发 `finishTurn → { action: "end" }` 但 followUp 队列有货时，外层循环重启内层。
4. 子 agent：父调用一个「委派」工具，子 agent 独立跑完 N 轮，父只收到最终文本结果；断言父的 `messages` 里没有子的中间过程。
5. `runToolCall` 单独调用一个工具，断言不发事件、不进消息历史。

**源码预算**：约 350 行。

---

## 6. 阶段依赖图

```
1 一次往返
└─ 2 工具与循环
   └─ 3 流式
      └─ 4 事件分层
         ├─ 5 三段式 + 拦截
         │  └─ 6 并行工具
         │     └─ 7 真实 LLM（手写 SSE）
         │        └─ 8 system prompt 即历史
         │           └─ 9 会话持久化
         │              └─ 10 压缩
         │                 └─ 11 扩展系统
         │                    └─ 12 UI 层
         │                       └─ 13 子 agent + 插话
```

严格线性。**不允许跳阶段**——每个阶段的验收依赖前面阶段的能力。

---

## 7. 工程约定

### 7.1 目录结构（按阶段生长）

**pnpm workspaces，第 1 阶段就建立。** 但采用**零构建**配置（借自 v2，避免与学习目标无关的工程复杂度）：

```
mini-agent-v3/
  package.json            private；scripts 用 pnpm -r 转发
  pnpm-workspace.yaml     packages/*, onlyBuiltDependencies: [esbuild]
  tsconfig.base.json      target ES2022, strict, noEmit, erasableSyntaxOnly,
                          allowImportingTsExtensions, skipLibCheck
  .gitignore              node_modules, .env, .mini-agent/
  packages/
    ai/                   provider 抽象层
      package.json        @mini-agent/ai，exports "./src/index.ts"
      src/types.ts        消息 IR + AssistantMessageEvent + Tool 声明
      src/stream-fn.ts    20 行注入插槽（import type from ./types.ts）
      src/fake.ts         确定性假模型（阶段 1-6 的默认 provider）
      src/anthropic.ts    真实适配器（阶段 7 起，与 fake.ts 同层）
      test/
      fixtures/           SSE 录制样本（阶段 7）
    core/                 运行时
      package.json        @mini-agent/core，依赖 @mini-agent/ai
      src/agent-loop.ts   循环
      src/tools.ts        工具定义与实现
      src/agent.ts        Agent 类（阶段 4 起）
      test/*.test.ts      vitest 测试
    cli/                  终端入口
      package.json        @mini-agent/cli，依赖 core
      src/index.ts        readline + 事件渲染
  docs/specs/             本 spec
  docs/stages/            每阶段文档
```

**为什么阶段 1 就拆 `ai` 和 `core`**：`stream-fn.ts` 那 20 行插槽要 `import type { AssistantMessageEvent }`。如果类型和插槽在同一个包，插槽只是同包内的一个模块——**依赖反转就没有被证明**。拆开之后，"core 依赖 ai 的类型、不依赖 ai 的实现"这件事是**结构性可见**的，而第 7 阶段只是在 `ai` 里加一个实现文件。

依赖方向（与 Pi 同构，Pi 的 `agent → ai`）：

```
cli → core → ai
```

`ai` 零内部依赖。`core` 不认识任何 provider 实现。

**为什么不是"先单包，后面再拆"**：第 7 阶段才拆包的话，会同时发生两件事——加真实 provider + 改目录结构，两个变化叠在一起，看不出缝到底起没起作用。拆包成本在第 1 阶段几乎为零（三个 package.json + 一个 workspace 文件），越早越便宜。

**为什么用 vitest 而不是内建 runner**：vitest 自带 TS 转换，因此**不需要 `tsx`**——dev 与 test 两条路都零构建，依赖数并没有增加。更重要的是阶段 5 需要 `vi.fn()` 断言"`execute` 从未被调用"，手写计数器能做但啰嗦。Pi 也用 vitest，便于对照（`packages/*/vitest.config.ts`）。

**`pnpm test` / `pnpm check` / `pnpm dev` 的分工**：

| 命令 | 实现 |
|---|---|
| `pnpm test` | `vitest run`（各包；`pnpm -r run test`） |
| `pnpm check` | `tsc --noEmit`（各包） |
| `pnpm dev` | `node --experimental-strip-types src/index.ts`（不走 vitest，保持真实进程语义——阶段 9 要 kill 进程测恢复，阶段 4 要测 Ctrl+C） |

**`erasableSyntaxOnly` 的约束**：`node --experimental-strip-types` 只做类型擦除，不做转换。因此**禁止**：`enum`、构造函数参数属性（`constructor(private x: T)`）、`namespace`。必须用 `import type` 导入类型。**这一条是真实约束而非风格偏好**——违反会在运行时直接报错。第 7 阶段的 SSE 解析尤其要注意不能用 `enum` 表示状态，改用字符串联合类型。

**阶段 12 的增量**：新增 `packages/server`（WebSocket，~150 行）与 `packages/web`（React），`cli` 与 `web` 并列作为两个前端，共享 `core`。此时 workspace 配置已经就位，不需要重建工程。

### 7.2 代码风格

- tab 缩进（与 Pi 一致）
- **每个 `src` 文件 < 200 行**——超限是职责该拆的信号，不是加注释的理由
- 注释解释**为什么**，不解释**是什么**
- 类型优先：协议集中在 `types.ts`，其他文件 import 它

### 7.3 测试策略

| 层面 | 方法 |
|---|---|
| 循环 | 假模型脚本（确定性事件序列），断言消息数组与事件序列 |
| 工具 | 临时目录真实读写、真实跑命令；**重点测错误路径** |
| SSE 解析 | 录制的 fixtures，**不打真实 API** |
| 纯函数（压缩阈值、切点、重放） | 直接单测，含边界值 |
| 持久化 | 真实临时目录 + kill 进程模拟 |
| 真实 API 联调 | **手动，不进 CI**（网络测试不可重复） |

**vitest 配置**：每个包一个 `vitest.config.ts`，`include: ["test/**/*.test.ts"]`。用 `vi.fn()` 做 spy（阶段 5 的 `beforeToolCall` 拦截断言依赖它）；用 `vi.useFakeTimers()` 控制阶段 6 的并行时序断言（**只在必要时用**，优先靠确定性假工具的固定 sleep + 宽松阈值断言，避免过度工程）。

**每个阶段的"先写测试"指的是先写验收测试**——即 §5 里各阶段的"验收"条目，先写成失败的测试。

### 7.4 每阶段的交付物

1. 代码 + 测试（`pnpm test` 与 `pnpm check` 全绿）
2. `docs/stages/NN-<stage-name>.md`：**这个阶段解决了什么问题 / Pi 的哪条决策是答案 / 替代方案为什么更差 / 决策点是什么**
3. 一次 git commit，message 形如 `feat(stage-NN): <新概念>`

第 2 项是学习的主载体——**代码是我写的，但每阶段的"为什么"要写成你能追问的文档**。

---

## 8. 风险与已知取舍

| 风险 | 应对 |
|---|---|
| 第 8 阶段回头改消息层导致返工 | 刻意保留（§3.2b）。返工范围限于 `system` 字段的读写点，预计 < 10 处。若实际扩散超预期，说明阶段 1 的接口划错了——这本身是有价值的发现 |
| 13 阶段跨度过长，中途失去动力 | 每阶段都是可运行的完整程序（不是半成品），且阶段 4 结束时就已经有一个能用的 CLI agent。若觉得长，可在阶段 4/8/11 处重新评估 |
| 手写 SSE 遇到网关（Kimi）协议差异 | fixtures 优先——测试不依赖网络。真实联调只在阶段 7 结束前手动跑一次；有差异则记录到阶段文档，不影响测试 |
| `SystemMessage` 重放性能 | 教学规模下可忽略。文档注明 Pi 接受此代价，且真实瓶颈在 provider 网络延迟而非本地重放 |
| 并行工具的测试不确定性 | 用确定性假工具（固定 sleep 时长）+ 宽松断言（`< 150ms` 而非精确值）；不用假时钟，避免过度工程 |
| 阶段 11 引入 ai-sdk 破坏"零运行时依赖" | 依赖只存在于**扩展侧**，core 仍然零依赖。这正是扩展系统要证明的事——若不成立，说明缝划错了 |

---

## 9. 验收标准（整体）

1. 13 个阶段全部完成，每阶段一次 commit，`pnpm test` 与 `pnpm check` 全绿。
2. 最终能真实干活：在终端输入"读一下 package.json 然后总结这个项目"，能看到流式文本 + 工具调用 + 最终总结；`edit` / `bash` 各验证一次。
3. Web UI 可用，与 CLI 共享同一份 core。
4. 会话可持久化、可 resume、可 branch、可压缩。
5. 扩展系统可用：能注册工具、拦工具调用、改上下文，且扩展不 import core 内部。
6. **每个阶段都有一份讲清决策点的文档**——这是本项目的主要产出。

---

## 10. 实施顺序

严格按 §5 的阶段编号。每阶段流程：

1. 讲清问题、Pi 的决策、替代方案的代价（对应 §5 的「决策点」）
2. 写验收测试（失败）
3. 实现
4. 全绿 + 写阶段文档 + commit
5. 用户回测追问 → 澄清 → 必要时修正文档

**开始前需确认**：本 spec 通过后，用 writing-plans 技能生成阶段 1 的详细实施计划。
