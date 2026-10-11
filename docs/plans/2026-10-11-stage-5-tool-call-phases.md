# 阶段 5「三段式工具调用与拦截」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把串行工具调用拆成可独立测试的 `prepare → execute → finalize` 三段，在真正执行副作用之前加入 `beforeToolCall` 拦截，并让工具部分结果通过 `tool_execution_update` 进入同一条 AgentEvent 流。

**Architecture:** `prepareToolCall()` 只负责工具解析、递归 schema 校验和拦截决策；`executePreparedToolCall()` 只负责调用工具、收集 update 与捕获工具错误；`finalizeToolCall()` 统一生成 toolResult、duration 与 terminate 元数据。`executeToolCalls()` 保持串行，只负责编排三段和事件顺序；`Agent`/`agentLoop` 只传 hook 与上下文，不认识权限规则。

**Tech Stack:** TypeScript 5.9.3（`strict` + `erasableSyntaxOnly`）、Node 22+ / 当前 Node 24 `--experimental-strip-types`、pnpm workspaces、vitest 3。零新增运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md`（阶段 5 见 §5「阶段 5 —— 三段式工具调用与拦截」；工具 IR 见 §4；扩展挂载点见阶段 11）

## Global Constraints

- **零运行时依赖**。JSON Schema 校验手写，不引入 TypeBox、Ajv 或 SDK。
- **`erasableSyntaxOnly: true`**。禁止 `enum`、构造函数参数属性和 `namespace`；类型导入必须 `import type`。
- 跨包导入用包名；包内相对导入带 `.ts` 后缀；tab 缩进。
- 每个 `src` 文件 < 200 行；注释解释「为什么」，不解释「是什么」。
- 本阶段唯一新概念是 **prepare / execute / finalize + `beforeToolCall`**。不提前实现阶段 6 的并行调度、`executionMode` 与文件写队列，也不实现阶段 11 的扩展注册系统或 `afterToolCall`。
- `tool_execution_start` 在 prepare 之前发：它表示「一个工具调用生命周期开始」，不是「副作用已经执行」。未知、非法、blocked 调用仍有平衡的 start/end。
- blocked/未知/非法/hook 抛错都变成 `isError: true` toolResult 回喂模型；只有 listener/emit 失败继续作为宿主故障冒泡。
- `beforeToolCall` 只在参数校验成功后调用，接收只读消息快照与已验证参数；本阶段不做参数 coercion。
- `terminate` 可来自 blocked 结果或工具结果；一个 batch 只有**每个 finalized outcome** 都是 `terminate: true` 才终止 run。混合 true/false 继续询问模型。
- 工具 `onUpdate` 是 void callback；runtime 收集对应的异步 emit promises，在 `tool_execution_end` 前全部 await。工具 promise settle 后的 late update 被忽略。
- `durationMs` 用 `performance.now()`，测量从 `tool_execution_start` 前到 finalize 的完整调用生命周期，包括 schema/hook 等待。
- `grep -rn "fake\|anthropic" packages/core/src/` 必须为空。
- `pnpm test` 与 `pnpm check` 必须全绿；阶段源码增量目标约 350 行，硬上限 < 400 行（测试与文档不计）。

## JSON Schema Contract

v3 继续保持零依赖，因此本阶段实现「项目可声明的递归结构子集」，而不是暗中假装覆盖整个 JSON Schema 标准：

| 类别 | 支持关键字 |
|---|---|
| 通用 | `type`、`enum`、`const` |
| object | `properties`、`required`、`additionalProperties: false` |
| array | `items`、`minItems`、`maxItems` |
| string | `minLength`、`maxLength`、`pattern` |
| number/integer | `minimum`、`maximum` |
| annotation（忽略） | `description`、`title`、`default` |

`anyOf` / `oneOf` / `allOf` / `$ref` 等不支持的验证关键字必须产生具名 validation issue，不能静默跳过。错误路径从 `arguments` 开始，例如：

```text
arguments.path: expected string, got number
arguments.options.mode: expected one of ["fast", "safe"]
arguments.tags[1]: expected string, got number
```

`enum` / `const` 对 JSON value 做递归结构相等比较，不依赖对象属性插入顺序。`additionalProperties` 只支持缺省/`true`/`false`；传 schema object 时按不支持关键字报错。

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/core/src/tool.ts` | 公共 ToolCall / hook / update / terminate 协议 |
| `packages/core/src/json-schema.ts` | 纯递归 schema validator，只返回结构化 issues |
| `packages/core/src/tool-call.ts` | `prepareToolCall` / `executePreparedToolCall` / `finalizeToolCall` |
| `packages/core/src/execute-tool-calls.ts` | 串行 orchestration、事件发送、batch terminate |
| `packages/core/src/agent-loop.ts` | 把 assistant/context/hook 传给 orchestrator，消费 terminate |
| `packages/core/src/agent-options.ts` | `AgentOptions`（从已 197 行的 `agent.ts` 移出，给 hook 留出空间） |
| `packages/core/src/agent.ts` | 保存 `beforeToolCall` 并传入 loop；状态机语义不变 |

`agent.ts` 当前 197 行，不能继续塞公共配置类型；本阶段先把 `AgentOptions` 移到 `agent-options.ts`。`execute-tool-calls.ts` 当前 138 行，三段式实现必须放到独立 `tool-call.ts`，否则会越过 200 行且职责混杂。

## Review Focus

1. **schema 校验后才拦截**：非法参数不能进入 hook 或 execute；错误必须带精确嵌套路径，模型才能修。→ Tasks 1-2。
2. **blocked/hook throw 不能伪装成宿主崩溃**：必须形成平衡 tool lifecycle 与 isError toolResult，循环继续；但 emit/listener reject 必须继续冒泡。→ Tasks 2、4、5。
3. **异步 update ordering**：所有已接受 update 的 listener promises 必须在 `tool_execution_end` 前 settle；工具完成后的 late update 必须被忽略。→ Tasks 3-4。
4. **terminate 聚合与 abort 优先级**：单个 terminate 不能跳过同 batch 的其他调用；只有全部 finalized outcome terminate 才可结束 run，但 user abort 必须优先收尾为 aborted。→ Tasks 4-5。
5. **abort 与 update 竞态**：工具因 abort 抛错时，已发 update 保留且先于 end；未开始的后续调用仍不产生伪造事件。→ Tasks 3-4。

---

### Task 1: 扩展工具协议，并实现递归 JSON Schema 校验

**Files:**
- Modify: `packages/core/src/tool.ts`
- Create: `packages/core/src/json-schema.ts`
- Create: `packages/core/test/json-schema.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

```ts
export type ToolCall = Extract<ContentBlock, { type: "toolCall" }>;

export interface ToolResult {
	content: ContentBlock[];
	isError?: boolean;
	terminate?: boolean;
}

export type ToolUpdateHandler = (partialResult: ToolResult) => void;

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: ToolCall;
	args: Record<string, unknown>;
	messages: readonly Message[];
}

export type BeforeToolCall = (
	context: BeforeToolCallContext,
	signal?: AbortSignal,
) =>
	| BeforeToolCallResult
	| void
	| Promise<BeforeToolCallResult | undefined>
	| Promise<void>;

export interface ValidationIssue {
	path: string;
	message: string;
}

export function validateJsonSchema(
	value: unknown,
	schema: JSONSchema,
	path?: string,
): ValidationIssue[];
```

`ToolDef.execute` 改为：

```ts
execute: (
	params: P,
	signal?: AbortSignal,
	onUpdate?: ToolUpdateHandler,
) => Promise<ToolResult>;
```

- [ ] **Step 1: 写 schema validator 的失败测试**

创建 `json-schema.test.ts`，用 hand-written schemas 覆盖：

1. built-in 风格的 object + required + properties 成功；
2. 缺少 required、错误 primitive type；
3. nested object 路径 `arguments.options.mode`；
4. array item 路径 `arguments.tags[1]`；
5. `enum` / `const`；
6. `additionalProperties: false`；
7. string/array/number 边界；
8. object/array enum 使用递归结构相等；
9. 不支持的 `oneOf`、schema-valued `additionalProperties` 与非法 regex 返回具名 schema issue，而不是 throw。

断言 literal issue 数组，不用 validator 自己格式化 expected。

- [ ] **Step 2: 跑测试确认模块不存在**

Run: `pnpm --filter @mini-agent/core run test -- json-schema`

Expected: FAIL——无法解析 `../src/json-schema.ts`。

- [ ] **Step 3: 实现 validator**

`validateJsonSchema()` 递归返回所有 issues，不在首错停止。`path` 缺省 `"arguments"`；object property 用点号，array item 用 `[index]`。

类型规则：

- `"number"` 必须是有限 number；`NaN` / `Infinity` 拒绝；
- `"integer"` 使用 `Number.isInteger`；
- `"object"` 排除 `null` 与 array；
- `pattern` 构造失败时报告 schema issue，不 throw；
- annotation keywords 不参与校验；
- 未知 keyword 报 issue，但不要对 `properties` 里的属性名误判为 schema keyword。

- [ ] **Step 4: 扩展 `tool.ts` 协议并更新导出**

从 core index 导出 `ToolCall`、`ToolUpdateHandler`、`BeforeToolCall*`、`ValidationIssue` 与 `validateJsonSchema`。现有工具无需修改：TypeScript 允许实现函数忽略新增的第三参数。

- [ ] **Step 5: 跑定向测试与类型检查**

Run: `pnpm --filter @mini-agent/core run test -- json-schema && pnpm check`

Expected: PASS；stage 1-4 工具定义继续编译。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/tool.ts packages/core/src/json-schema.ts \
  packages/core/test/json-schema.test.ts packages/core/src/index.ts
git commit -m "feat(stage-5): validate tool arguments against JSON Schema"
```

---

### Task 2: 实现 prepare 阶段与 `beforeToolCall`

**Files:**
- Create: `packages/core/src/tool-call.ts`
- Create: `packages/core/test/tool-call.test.ts`

**Interfaces:**

```ts
export type PreparedToolCall = {
	kind: "prepared";
	toolCall: ToolCall;
	tool: ToolDef<any>;
	args: Record<string, unknown>;
	startedAt: number;
};

export type ImmediateToolCallOutcome = {
	kind: "immediate";
	toolCall: ToolCall;
	result: ToolResult;
	isError: boolean;
	startedAt: number;
};

export interface PrepareToolCallOptions {
	toolCall: ToolCall;
	assistantMessage: AssistantMessage;
	messages: readonly Message[];
	tools: readonly ToolDef<any>[];
	beforeToolCall?: BeforeToolCall;
	signal?: AbortSignal;
	startedAt: number;
}

export async function prepareToolCall(
	options: PrepareToolCallOptions,
): Promise<PreparedToolCall | ImmediateToolCallOutcome>;
```

- [ ] **Step 1: 写 prepare 失败测试**

在 `tool-call.test.ts` 先只测试 prepare：

1. 找到工具、schema 合法 → `{ kind: "prepared" }`；
2. 未知工具 → immediate error；
3. nested schema 非法 → hook 与 execute 均未调用，error text 含完整路径；
4. hook 收到 assistantMessage、原 toolCall、已验证 args、只读 messages snapshot；
5. `{ block: true, reason: "Denied" }` → immediate isError，content 为 `Denied`；
6. block 未给 reason → 默认 `Tool execution was blocked`；
7. blocked `terminate: true` 被写入 result；
8. `block: false, terminate: true` 不生效（terminate 只描述被 block 的 outcome）；
9. hook throw → immediate error，不让整个 run reject；
10. hook 返回后 signal 已 aborted → `Operation aborted` immediate error。

使用 `vi.fn()` 只证明 hook/execute 是否被调用；最终断言仍以 prepare outcome 为主。

- [ ] **Step 2: 跑测试确认函数不存在**

Run: `pnpm --filter @mini-agent/core run test -- tool-call`

Expected: FAIL——无法解析 `../src/tool-call.ts`。

- [ ] **Step 3: 实现 `prepareToolCall()`**

顺序必须固定：

```text
find tool
→ validateJsonSchema(arguments)
→ beforeToolCall(validated context)
→ signal check
→ block decision
→ prepared
```

校验 issues 用 `"; "` 拼成一条模型可读错误：

```text
Tool "edit" arguments failed validation: arguments.path: expected string, got number
```

hook 只读 messages 使用 `options.messages.slice()`；本阶段不 clone message 内部对象。

- [ ] **Step 4: 跑定向测试**

Run: `pnpm --filter @mini-agent/core run test -- tool-call`

Expected: prepare tests PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-call.ts packages/core/test/tool-call.test.ts
git commit -m "feat(stage-5): prepare and intercept tool calls"
```

---

### Task 3: 实现 execute 阶段与部分结果 update

**Files:**
- Modify: `packages/core/src/tool-call.ts`
- Modify: `packages/core/test/tool-call.test.ts`

**Interfaces:**

```ts
export type ExecutedToolCallOutcome = {
	toolCall: ToolCall;
	result: ToolResult;
	isError: boolean;
	startedAt: number;
};

export type ToolUpdateSink = (
	partialResult: ToolResult,
) => void | Promise<void>;

export async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome>;
```

- [ ] **Step 1: 写 execute 失败测试**

继续在 `tool-call.test.ts` 增加：

1. 工具正常返回 → content 与 `isError` 归一化；
2. 工具 throw → error result，不 reject；
3. 工具同步调用 onUpdate 两次 → sink 按源顺序收到两次；
4. sink 返回 deferred promises → `executePreparedToolCall()` 在 promises settle 前不 resolve；
5. 工具 promise settle 后再调用保存的 callback → late update 被忽略；
6. 工具因 AbortSignal 抛 `AbortError` → isError result，之前的 updates 仍保留。

- [ ] **Step 2: 跑测试确认 execute API 缺失**

Run: `pnpm --filter @mini-agent/core run test -- tool-call`

Expected: FAIL——`executePreparedToolCall` 尚未导出。

- [ ] **Step 3: 实现 execute**

`acceptingUpdates` 在工具 promise settle 的同一时刻设为 false。callback 将 `Promise.resolve(onUpdate(partial))` 放进数组；工具完成/抛错后，在 try/catch **外部** `await Promise.all(updatePromises)`。

emit/listener rejection 因而不会被工具错误 catch 吞掉；它必须继续冒泡给 Agent 的 listener-failure 边界。

- [ ] **Step 4: 跑定向测试**

Run: `pnpm --filter @mini-agent/core run test -- tool-call`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-call.ts packages/core/test/tool-call.test.ts
git commit -m "feat(stage-5): execute tools with partial updates"
```

---

### Task 4: 实现 finalize，并重写串行 orchestration

**Files:**
- Modify: `packages/core/src/tool-call.ts`
- Modify: `packages/core/src/execute-tool-calls.ts`
- Modify: `packages/core/test/tool-call.test.ts`
- Modify: `packages/core/test/execute-tool-calls.test.ts`

**Interfaces:**

```ts
export type FinalizedToolCallOutcome = {
	toolCall: ToolCall;
	result: ToolResult;
	message: ToolResultMessage;
	isError: boolean;
	durationMs: number;
};

export function finalizeToolCall(
	outcome: ExecutedToolCallOutcome | ImmediateToolCallOutcome,
): FinalizedToolCallOutcome;

export interface ExecuteToolCallsOptions {
	assistantMessage: AssistantMessage;
	messages: readonly Message[];
	tools: readonly ToolDef<any>[];
	signal?: AbortSignal;
	emit?: AgentEventSink;
	beforeToolCall?: BeforeToolCall;
}

export interface ExecutedToolBatch {
	messages: ToolResultMessage[];
	terminate: boolean;
}

export async function executeToolCalls(
	toolCalls: ToolCall[],
	options: ExecuteToolCallsOptions,
): Promise<ExecutedToolBatch>;
```

- [ ] **Step 1: 写 finalize 失败测试**

在 `tool-call.test.ts` 增加：

1. result content / isError / terminate 进入 finalized outcome；
2. ToolResultMessage 只含协议字段，不泄漏 terminate；
3. durationMs 是 `performance.now() - startedAt` 的非负 number；
4. immediate blocked outcome 与 executed outcome 走同一 finalize。

- [ ] **Step 2: 写 orchestration 失败测试**

改写 `execute-tool-calls.test.ts` 使用 options object，并新增：

1. 顺序严格为 start → update×n → end → toolResult message start/end；
2. blocked/invalid/unknown 同样有平衡 lifecycle，execute 未调用；
3. async update listener settle 前不发 end；
4. listener 在 update reject 时 `executeToolCalls()` reject，不合成 tool error；
5. serial batch 仍按 assistant 源顺序；
6. 第一个调用 terminate true 不跳过第二个调用；
7. 全部 finalized terminate true → `batch.terminate === true`；混合值为 false；
8. signal 中止后未开始的后续调用没有事件。

- [ ] **Step 3: 跑测试确认旧 orchestrator 不满足接口**

Run: `pnpm --filter @mini-agent/core run test -- tool-call execute-tool-calls`

Expected: FAIL——旧 positional API、无 update、无 terminate。

- [ ] **Step 4: 实现 finalize**

`finalizeToolCall()` 是纯函数，统一：

- content 缺省 `[]`；
- `isError` 变成明确 boolean；
- `durationMs` 用 monotonic clock；
- `terminate` 留在 `result`，不进入 ToolResultMessage。

- [ ] **Step 5: 重写 `executeToolCalls()`**

每个 call 的顺序：

```text
capture startedAt
→ emit tool_execution_start(raw args)
→ prepare
→ immediate 或 execute(onUpdate → tool_execution_update)
→ finalize
→ emit tool_execution_end
→ emit toolResult message_start/end
```

`tool_execution_update.args` 使用模型原始 arguments；`partialResult` 使用工具传入的 ToolResult。

`shouldTerminateToolBatch()` 使用：

```ts
outcomes.length > 0 &&
outcomes.every((outcome) => outcome.result.terminate === true)
```

`failTruncatedToolCalls()` 继续复用 finalize/event helper，但永远返回 `terminate: false`。

- [ ] **Step 6: 跑 core 定向与全量测试**

Run:

```bash
pnpm --filter @mini-agent/core run test -- tool-call execute-tool-calls
pnpm --filter @mini-agent/core run test
pnpm check
```

Expected: PASS；stage 1-4 的 62 个 core 测试继续通过。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/tool-call.ts packages/core/src/execute-tool-calls.ts \
  packages/core/test/tool-call.test.ts packages/core/test/execute-tool-calls.test.ts
git commit -m "feat(stage-5): finalize and orchestrate tool calls"
```

---

### Task 5: 把 hook、terminate 与 updates 接进 loop / Agent

**Files:**
- Create: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/agent.test.ts`

**Interfaces:**

```ts
export interface AgentOptions {
	system: string;
	messages?: Message[];
	tools?: ToolDef<any>[];
	streamFn?: StreamFn;
	maxTurns?: number;
	beforeToolCall?: BeforeToolCall;
}
```

`AgentLoopOptions` 增加：

```ts
beforeToolCall?: BeforeToolCall;
```

`Agent` 增加可变公共挂载点：

```ts
public beforeToolCall?: BeforeToolCall;
```

构造参数只负责初始值；每次 `prompt()` 都读取当前属性，阶段 11 因而能在不重建 Agent 的情况下安装/替换扩展 hook。

- [ ] **Step 1: 写 Agent/loop 集成失败测试**

覆盖 spec 四条验收：

1. 构造后给 `agent.beforeToolCall` 赋值，对 bash block：execute spy 为 0；历史有 isError toolResult；fake model 被调用第二次并正常回答；
2. schema 非法：hook 与 execute 均为 0，toolResult text 含精确 violation，循环继续；
3. 单个 blocked call `{ terminate: true }`：只调用模型一次，发完 toolResult/turn_end 后直接 `agent_end`；
4. 两个 calls 中只有一个 terminate：两个都 finalize，模型仍被再次调用；
5. 自定义工具调用 onUpdate：Agent subscriber 收到 `tool_execution_update`，字段 id/name/raw args/partialResult 正确，且 update 在 end 前；
6. before hook 能读到当前 assistantMessage、validated args 与此前消息快照；
7. before hook throw 变成 toolResult error，`Agent.prompt()` 不 reject。
8. terminating tool 同时触发 AbortSignal 时，最终走 aborted assistant，而不是被 terminate 伪装成正常 agent_end。

- [ ] **Step 2: 跑测试确认 wiring 缺失**

Run: `pnpm --filter @mini-agent/core run test -- agent-loop agent`

Expected: FAIL——AgentOptions/AgentLoopOptions 无 hook，loop 不消费 terminate。

- [ ] **Step 3: 移出 `AgentOptions` 并接线**

创建 `agent-options.ts`，`agent.ts` 改为 import type；新增 public `beforeToolCall` 字段并用 options 初始化，再传给 `agentLoop`。core index 继续从公共入口导出 `AgentOptions`。

- [ ] **Step 4: 修改 loop**

正常工具分支调用：

```ts
executeToolCalls(toolCalls, {
	assistantMessage: message,
	messages: options.messages,
	tools,
	signal: options.signal,
	emit,
	beforeToolCall: options.beforeToolCall,
});
```

追加 toolResults 并发 `turn_end` 后：

- signal 已 aborted → 沿用阶段 4 terminal aborted turn；
- 否则 `batch.terminate === true` → 发 `agent_end { messages: newMessages }`，立即 return；
- 否则进入下一轮。

length 分支返回 terminate false。

- [ ] **Step 5: 跑集成测试与全仓检查**

Run:

```bash
pnpm --filter @mini-agent/core run test -- agent-loop agent
pnpm test
pnpm check
```

Expected: PASS；blocked 与 update 均通过公共 `Agent` 路径可观察。

- [ ] **Step 6: 检查源码预算**

Run:

```bash
wc -l packages/core/src/tool.ts packages/core/src/json-schema.ts \
  packages/core/src/tool-call.ts packages/core/src/execute-tool-calls.ts \
  packages/core/src/agent-options.ts packages/core/src/agent.ts \
  packages/core/src/agent-loop.ts
```

Expected: 每个文件 < 200 行。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/agent-options.ts packages/core/src/agent.ts \
  packages/core/src/agent-loop.ts packages/core/src/index.ts \
  packages/core/test/agent-loop.test.ts packages/core/test/agent.test.ts
git commit -m "feat(stage-5): wire tool interception into Agent"
```

---

### Task 6: 阶段文档与全量验收

**Files:**
- Create: `docs/stages/05-tool-call-phases.md`

**Interfaces:**
- Consumes: 本阶段全部产物
- Produces: 阶段 5 学习主文档；回测答案仍由后续学习环节单独编写

- [ ] **Step 1: 写阶段文档**

沿用阶段 4 的结构：

1. **这个阶段解决了什么问题**：工具副作用前没有安全拦截点，校验/执行/结果生成纠缠。
2. **Pi 的哪条决策是答案**：prepare / execute / finalize，带 Pi 行号；permission 是 hook 机制而非内置规则。
3. **替代方案为什么更差**：execute 内校验、执行后询问权限、block 直接 throw、update fire-and-forget。
4. **决策点（供回测）**：
   - 为什么 prepare 必须与 execute 分离？
   - 为什么被 block 要回喂模型而不是终止整个 run？
   - 为什么 update 要在 end 前全部 settle？
   - 为什么 terminate 是 batch 聚合而不是首个 true 立即停止？
5. **已知代价**：schema 子集、hook backpressure、late update ignored、串行阶段暂不展示并发收益。
6. **验收对照与实施偏差**：记录实际支持的 schema keywords 与不支持关键字的响亮错误。

- [ ] **Step 2: 全量自动验收**

```bash
pnpm test
pnpm check
grep -rn "fake\|anthropic" packages/core/src/
grep -rn "beforeToolCall" packages/core/src/
grep -rn "tool_execution_update" packages/core/src/
wc -l packages/core/src/*.ts
```

Expected:

- test/check 全绿；
- provider grep 无输出；
- hook 只出现在公共类型、Agent/loop 接线与 prepare；
- update 只由 execute orchestration 发；
- 每个 src 文件 < 200 行。

- [ ] **Step 3: 行为验收**

1. blocked bash 从未执行，但事件/历史有 isError toolResult，模型可恢复；
2. nested schema error 带精确 path；
3. terminate run 不发第二次 provider request；
4. onUpdate 事件严格位于 start 与 end 之间，异步 listener 已 settle；
5. stage 1-4 的既有事件顺序和 abort/error 语义保持。

- [ ] **Step 4: 提交**

```bash
git add docs/stages/05-tool-call-phases.md
git commit -m "docs(stage-5): explain prepare execute and finalize"
```

---

## 完成标准

- [ ] 工具调用显式经过 prepare / execute / finalize 三段，各自有独立单测。
- [ ] JSON Schema 递归校验覆盖声明的子集；非法参数不进入 hook/execute，错误带精确 path。
- [ ] `beforeToolCall` 在副作用前运行；block/hook throw 形成 isError toolResult，循环可恢复。
- [ ] `tool_execution_start` 对未知/非法/blocked 调用仍有平衡 end 与 message events。
- [ ] `onUpdate` 产生 `tool_execution_update`；accepted updates 在 end 前 settle，late updates ignored。
- [ ] listener/emit failure 不被工具错误 catch 吞掉。
- [ ] terminate 只在 batch 全部 finalized outcome 都为 true 时结束 run；当前 batch 不被提前截断。
- [ ] user abort 优先于 terminate，不能被正常 agent_end 掩盖。
- [ ] Agent 与低层 loop 都能注入 hook；Agent 仍 single-flight，状态只由事件回流。
- [ ] stage 1-4 测试保持全绿；`pnpm test` / `pnpm check` 全绿。
- [ ] 所有 src 文件 < 200 行，源码净增量 < 400 行。
- [ ] `docs/stages/05-tool-call-phases.md` 存在并留下四个回测问题。
