# 阶段 6「并行工具」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏 prepare/hook 顺序、模型结果顺序与文件写安全的前提下，让同一 assistant message 中的独立工具真正并行执行。

**Architecture:** 工具 batch 先按模型源顺序串行 prepare，再把 prepared calls 变成 thunks 交给 `Promise.all`；每个 thunk 在完成时立即发 `tool_execution_end`，但所有 toolResult message 等待整批完成后按原始数组顺序发送。任何全局/单工具 sequential 声明都会让整个 batch 降级为既有串行路径；edit 通过 realpath-keyed mutation queue 保证同文件串行、不同文件并行。

**Tech Stack:** TypeScript 5.9.3（`strict` + `erasableSyntaxOnly`）、Node 22+ / 当前 Node 24、pnpm workspaces、vitest 3。零新增运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md`（阶段 6 见 §5「阶段 6 —— 并行工具」；三段式前置能力见阶段 5）

## Global Constraints

- **零运行时依赖**。并发、锁与 realpath 全部使用 Node 标准库和 Promise。
- **`erasableSyntaxOnly: true`**。禁止 `enum`、构造函数参数属性和 `namespace`；类型导入必须 `import type`。
- 跨包导入用包名；包内相对导入带 `.ts` 后缀；tab 缩进。
- 每个 `src` 文件 < 200 行；注释解释「为什么」，不解释「是什么」。
- 本阶段唯一新概念是 **prepare 串行 / execute 并行 / 双顺序语义 / 同文件写队列**。不提前实现阶段 7 provider、阶段 11 扩展系统或阶段 13 子 agent。
- prepare（含 JSON Schema 与 `beforeToolCall`）始终按 assistant 源顺序串行；权限 UI 不得并发弹出。
- 并行只作用于 prepared execute；unknown/invalid/blocked 等 immediate outcome 不调用 execute。
- `tool_execution_start` 按源顺序在 prepare 前发；`tool_execution_end` 按实际完成顺序发。
- toolResult 的 `message_start/end` 与返回的 `batch.messages` 必须按 assistant 源顺序。
- default `toolExecution` 为 `"parallel"`；全局 `"sequential"` 或 batch 中任一 ToolDef 声明 `executionMode: "sequential"` 时，整个 batch 降级串行。
- batch terminate 仍使用 Stage 5 的 `every(terminate === true)`；user abort 优先于 terminate。
- 并行 abort 时，每个 assistant toolCall 必须得到确定 finalized outcome：已运行工具按实际结果/abort 结算；phase 2 前尚未执行的 prepared call 直接得到 `"Operation aborted"`。
- `file-mutation-queue` 使用 `realpath` 作为 key；同一真实文件（含 symlink 别名）串行，不同文件互不阻塞；失败不能污染后续队列。
- `grep -rn "fake\|anthropic" packages/core/src/` 必须为空。
- `pnpm test` 与 `pnpm check` 必须全绿；阶段源码净增量目标约 350 行，硬上限 < 400 行（测试与文档不计）。

## 两种顺序必须分开

模型源顺序：

```text
toolCall c1 → toolCall c2 → toolCall c3
```

实际完成顺序可能是：

```text
c2 (20ms) → c3 (30ms) → c1 (100ms)
```

因此：

| 消费者 | 顺序 | 原因 |
|---|---|---|
| UI 的 `tool_execution_end` | 完成顺序 `[c2,c3,c1]` | 谁先完成就先反馈 |
| 模型历史的 toolResult | 源顺序 `[c1,c2,c3]` | 保持 toolCall/result 协议配对 |

这不是实现细节，而是阶段 6 的核心契约。

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/core/src/tool.ts` | `ToolExecutionMode` 与 ToolDef.executionMode |
| `packages/core/src/tool-call-events.ts` | start/end/toolResult message 事件 helper，供串行与并行路径共享 |
| `packages/core/src/execute-tool-calls.ts` | dispatcher、串行路径、truncated failure |
| `packages/core/src/execute-tool-calls-parallel.ts` | 两阶段 prepare/execute、完成顺序 end、源顺序 message |
| `packages/core/src/file-mutation-queue.ts` | realpath-keyed Promise queue |
| `packages/core/src/tools.ts` | edit 在 read/validate/write 整段外包 mutation queue |
| `packages/core/src/agent-options.ts` | AgentOptions（为 toolExecution 腾出 `agent.ts` 行数） |
| `packages/core/src/agent.ts` / `agent-loop.ts` | 保存并传递执行模式 |

`execute-tool-calls.ts` 当前 140 行，不能再塞入 parallel path；事件 helper 也必须抽离，避免 serial/parallel 复制 event payload。`agent.ts` 当前 197 行，Stage 6 将 `AgentOptions` 移出后再增加可变 `toolExecution` 字段。

## Review Focus

1. **双顺序语义**：end events 必须按完成顺序，而 toolResult message/history 必须按源顺序；immediate 与 executed outcome 混合时也不能错位。→ Task 2。
2. **prepare 串行**：慢/交互式 before hook 未 settle 前，后一个 prepare 与任何 execute 都不得开始。→ Task 2。
3. **parallel listener failure**：任一 update/end listener reject 时 batch 必须 reject；不能被 Promise.all 或工具错误包装吞掉。→ Task 2。
4. **abort phase boundary**：abort 在 prepare 与 phase 2 之间发生时，prepared/remaining calls 都得到 Operation aborted outcome，且消息仍按源顺序。→ Tasks 2、4。
5. **file queue canonicalization/cleanup**：symlink 指向同一文件必须串行；第一个 mutation throw 后第二个仍能执行；不同 realpath 必须并行。→ Task 3。

---

### Task 1: 增加执行模式协议

**Files:**
- Modify: `packages/core/src/tool.ts`
- Modify: `packages/core/src/execute-tool-calls.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/execute-tool-calls.test.ts`

**Interfaces:**

```ts
export type ToolExecutionMode = "sequential" | "parallel";

export interface ToolDef<P = Record<string, unknown>> extends Tool {
	executionMode?: ToolExecutionMode;
	// existing replay + execute
}

export interface ExecuteToolCallsOptions {
	// existing fields
	toolExecution?: ToolExecutionMode;
}
```

- [ ] **Step 1: 写 dispatch 判定 helper 的失败测试**

在 `execute-tool-calls.test.ts` 直接测试：

```ts
shouldExecuteSequential(toolCalls, tools, mode)
```

覆盖：

1. mode `"sequential"` → true；
2. mode `"parallel"` 且任一已注册工具 `executionMode: "sequential"` → true；
3. 全部 parallel/未声明 → false；
4. 未知 toolCall 不被误判为 sequential；
5. 空 batch 在 parallel mode → false。

- [ ] **Step 2: 跑测试确认 helper 不存在**

Run: `pnpm --filter @mini-agent/core run test -- execute-tool-calls`

Expected: FAIL——`shouldExecuteSequential` 尚未导出。

- [ ] **Step 3: 增加协议与纯判定**

本任务只增加公共类型和纯判定；`executeToolCalls()` 的 Stage 5 串行行为保持不变，Task 2 再接 dispatcher：

```ts
export function shouldExecuteSequential(
	toolCalls: ToolCall[],
	tools: readonly ToolDef<any>[],
	mode: ToolExecutionMode,
): boolean;
```

判定只查注册表中实际找到的 ToolDef；未知工具不声明执行模式。

- [ ] **Step 4: 更新导出并验证**

从 core index 导出 `ToolExecutionMode`。Run:

```bash
pnpm --filter @mini-agent/core run test -- execute-tool-calls
pnpm check
```

Expected: PASS；runtime 行为仍保持 Stage 5 串行，只有协议与判定 helper 完成。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool.ts packages/core/src/execute-tool-calls.ts \
  packages/core/src/index.ts packages/core/test/execute-tool-calls.test.ts
git commit -m "feat(stage-6): define tool execution modes"
```

---

### Task 2: 实现两阶段并行与双顺序语义

**Files:**
- Create: `packages/core/src/tool-call-events.ts`
- Create: `packages/core/src/execute-tool-calls-parallel.ts`
- Modify: `packages/core/src/execute-tool-calls.ts`
- Modify: `packages/core/test/execute-tool-calls.test.ts`

**Interfaces:**

```ts
export async function emitToolStart(
	toolCall: ToolCall,
	emit: AgentEventSink,
): Promise<void>;

export async function emitToolEnd(
	outcome: FinalizedToolCallOutcome,
	emit: AgentEventSink,
): Promise<void>;

export async function emitToolResultMessage(
	message: ToolResultMessage,
	emit: AgentEventSink,
): Promise<void>;

export async function executeToolCallsParallel(
	toolCalls: ToolCall[],
	options: ExecuteToolCallsOptions,
): Promise<ExecutedToolBatch>;
```

- [ ] **Step 1: 写真实并行与双顺序失败测试**

用三个 deterministic fake tools：

```text
c1 sleep 100ms
c2 sleep 20ms
c3 sleep 30ms
```

断言：

- 总耗时 `< 150ms`；
- start 顺序 `[c1,c2,c3]`；
- `tool_execution_end` 顺序 `[c2,c3,c1]`；
- toolResult `message_end` 顺序 `[c1,c2,c3]`；
- `batch.messages` 顺序 `[c1,c2,c3]`。

- [ ] **Step 2: 写 prepare 串行失败测试**

第一个 `beforeToolCall` 用 deferred gate 阻塞：

- gate 未释放时第二个 hook 尚未进入；
- 所有 tool execute 均未开始；
- 释放后 hook 顺序为 `[c1,c2,c3]`；
- prepare 全部完成后 execute 才开始。

- [ ] **Step 3: 写 mixed immediate/execute 顺序测试**

batch 包含：

```text
c1 prepared slow
c2 schema invalid immediate
c3 prepared fast
```

断言：

- c2 的 end 可在 phase 1 提前出现；
- c3 的 end 可先于 c1；
- 三条 toolResult message 仍严格 `[c1,c2,c3]`。

- [ ] **Step 4: 写 parallel failure/abort 测试**

覆盖：

1. update listener reject → batch reject；
2. end listener reject → batch reject；
3. signal 在 prepare phase 中触发，已 prepared thunk 与后续 calls 都 finalize 为 `"Operation aborted"`，execute spy 为 0；
4. 所有 aborted toolResult 仍按源顺序。
5. 把 Stage 5 的「abort 后后续调用不发事件」用例显式设为 `toolExecution: "sequential"`；parallel mode 的对应断言改为后续调用产生 Operation aborted outcome。两种模式语义分别钉住，不能让默认值变化悄悄改坏旧测试。

- [ ] **Step 5: 跑测试确认旧串行实现失败**

Run: `pnpm --filter @mini-agent/core run test -- execute-tool-calls`

Expected: timing/end-order/phase-boundary assertions FAIL。

- [ ] **Step 6: 抽取事件 helper**

把现有 `emitStart` / `emitFinalized` 拆成三个 helper：parallel path 在 thunk 内发 end，但延迟 toolResult message；sequential path 仍 end 后立即发 message。

- [ ] **Step 7: 实现 parallel 两阶段**

阶段一按源顺序：

```text
emit start
→ prepare
→ immediate: finalize + emit end + 存 finalized
→ prepared: 存 async thunk
```

若 signal 已在某个 call 前 aborted，仍为该 call 发 start，并直接存 `"Operation aborted"` immediate outcome，不再运行 hook/execute。

阶段二：

```ts
const ordered = await Promise.all(
	entries.map((entry) =>
		typeof entry === "function" ? entry() : Promise.resolve(entry),
	),
);
```

prepared thunk：

- 开始时再次检查 signal；
- execute/finalize；
- 在 thunk 内 emit end，因此按完成顺序出现。

Promise.all 保留 input index，因此 `ordered` 是源顺序。最后依次 emit toolResult message，并生成 `batch.messages`。

- [ ] **Step 8: 接入 dispatcher 与串行 fallback**

`executeToolCalls()`：

```ts
const mode = options.toolExecution ?? "parallel";
if (shouldExecuteSequential(toolCalls, options.tools, mode))
	return executeToolCallsSequential(...);
return executeToolCallsParallel(...);
```

serial path 复用 Stage 5 语义，不改变事件顺序。

- [ ] **Step 9: 跑定向、全量与类型检查**

```bash
pnpm --filter @mini-agent/core run test -- execute-tool-calls
pnpm --filter @mini-agent/core run test
pnpm check
```

Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add packages/core/src/tool-call-events.ts \
  packages/core/src/execute-tool-calls-parallel.ts \
  packages/core/src/execute-tool-calls.ts \
  packages/core/test/execute-tool-calls.test.ts
git commit -m "feat(stage-6): execute prepared tools in parallel"
```

---

### Task 3: 同文件 mutation queue 与 edit 集成

**Files:**
- Create: `packages/core/src/file-mutation-queue.ts`
- Create: `packages/core/test/file-mutation-queue.test.ts`
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/test/tools.test.ts`

**Interfaces:**

```ts
export async function withFileMutationQueue<T>(
	path: string,
	operation: () => Promise<T>,
): Promise<T>;
```

- [ ] **Step 1: 写 queue 失败测试**

使用真实临时文件与 deferred operations：

1. 同一路径：第二个 operation 在第一个 release 前不进入；
2. 两个不同文件：两个 operation 都能同时进入；
3. symlink 与真实路径：因 `realpath` 相同而串行；
4. 第一个 operation throw：第二个仍执行，queue 不被 rejected promise 污染；
5. 全部完成后相同路径的新 operation 可立即进入（map 已清理）。

- [ ] **Step 2: 跑测试确认模块不存在**

Run: `pnpm --filter @mini-agent/core run test -- file-mutation-queue`

Expected: FAIL——无法解析模块。

- [ ] **Step 3: 实现 realpath-keyed Promise queue**

每个 canonical path 保存一个永远 settle 为 fulfilled 的 tail。新 operation 链在 previous tail 后；finally 只在 map 仍指向自己的 tail 时删除，避免较早调用误删较新的队列。

operation throw 必须原样 reject 给调用方，但 tail 自身吞掉 rejection，让后续调用继续。

- [ ] **Step 4: 把 edit 的完整 read/validate/write 放进 queue**

不能只包 `writeFile`：两个 edit 若在锁外读取，仍会基于同一旧内容计算。queue 必须包住：

```text
readFile
→ unique oldText validation
→ writeFile
```

- [ ] **Step 5: 写 edit 集成测试**

初始文件：

```text
alpha beta
```

并发执行：

```text
alpha → ALPHA
beta → BETA
```

最终必须是 `ALPHA BETA`。再加 symlink 别名调用，证明 realpath canonicalization。

- [ ] **Step 6: 跑定向与全量测试**

```bash
pnpm --filter @mini-agent/core run test -- file-mutation-queue tools
pnpm --filter @mini-agent/core run test
pnpm check
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/file-mutation-queue.ts \
  packages/core/test/file-mutation-queue.test.ts \
  packages/core/src/tools.ts packages/core/test/tools.test.ts
git commit -m "feat(stage-6): serialize mutations per real file"
```

---

### Task 4: 将执行模式接入 Agent / loop，并完成 abort 语义

**Files:**
- Create: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/agent.test.ts`
- Modify: `packages/core/test/agent-loop.test.ts`

**Interfaces:**

```ts
export interface AgentOptions {
	// existing fields
	toolExecution?: ToolExecutionMode;
}

export interface AgentLoopOptions {
	// existing fields
	toolExecution?: ToolExecutionMode;
}

export class Agent {
	public toolExecution: ToolExecutionMode;
}
```

- [ ] **Step 1: 写 Agent 默认并行失败测试**

通过 Agent 跑三个 fake tools，断言 end 完成顺序与历史源顺序分离，证明 public path 默认 parallel。

- [ ] **Step 2: 写动态串行模式失败测试**

构造后设置：

```ts
agent.toolExecution = "sequential";
```

断言三个工具不重叠、end/message 都是 `[c1,c2,c3]`。再设置回 `"parallel"`，下一次 prompt 使用新值，不重建 Agent。

- [ ] **Step 3: 写 per-tool sequential fallback 测试**

仅一个 ToolDef 声明 `executionMode: "sequential"`，Agent 默认 parallel；断言整个 batch 串行。

- [ ] **Step 4: 写 Agent abort phase-boundary 测试**

第二个 `beforeToolCall` 中调用 `agent.abort()`：

- 所有 assistant toolCall 都得到 source-ordered toolResult；
- execute spies 均为 0；
- result text 为 `"Operation aborted"`；
- tool turn 完成后追加 terminal aborted assistant；
- `Agent.prompt()` resolve，`isStreaming === false`。

- [ ] **Step 5: 跑测试确认 Agent 尚未传 mode**

Run: `pnpm --filter @mini-agent/core run test -- agent-loop agent`

Expected: 默认并行、动态模式与 abort assertions FAIL。

- [ ] **Step 6: 移出 AgentOptions 并接线**

`agent.ts` 当前 197 行。把 `AgentOptions` 移到 `agent-options.ts`，Agent 增加：

```ts
public toolExecution: ToolExecutionMode;
```

构造缺省 `"parallel"`；每次 prompt 读取当前属性并传给 loop。

- [ ] **Step 7: 修改 loop**

`AgentLoopOptions.toolExecution` 缺省 `"parallel"`，传给 `executeToolCalls`。length protection 不并行执行真实工具，保持原逻辑。

tool batch 完成后仍按 Stage 5 顺序：

```text
append source-ordered toolResults
→ turn_end
→ abort check
→ terminate check
→ next turn
```

- [ ] **Step 8: 运行全量验证与预算检查**

```bash
pnpm test
pnpm check
grep -rn "fake\|anthropic" packages/core/src/
wc -l packages/core/src/*.ts
git diff --numstat <stage-6-base> -- 'packages/*/src/*.ts'
```

Expected: test/check 全绿、provider grep 为空、每文件 <200、源码净增量 <400。

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/agent-options.ts packages/core/src/agent.ts \
  packages/core/src/agent-loop.ts packages/core/src/index.ts \
  packages/core/test/agent.test.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(stage-6): configure parallel tool execution"
```

---

### Task 5: 阶段文档与全量验收

**Files:**
- Create: `docs/stages/06-parallel-tools.md`

**Interfaces:**
- Consumes: 本阶段全部代码与测试
- Produces: Stage 6 学习主文档；回测答案仍单独编写

- [ ] **Step 1: 写阶段文档**

沿用「完整流程 → 分步拆解」结构：

1. 一次 `[slow, fast, medium]` batch 从 source order 到 completion order 再回到 source-ordered messages；
2. prepare 为什么串行、execute 为什么并行；
3. sequential fallback 分派规则；
4. file-mutation-queue 为什么必须包 read/validate/write；
5. abort 与 terminate 在 parallel batch 中如何结算；
6. 决策点：
   - 为什么 prepare 不能并行？
   - 为什么 end event 与 toolResult message 使用不同顺序？
   - 为什么一个 sequential 工具让整批降级？
   - 为什么同文件队列按 realpath，而不是用户传入字符串？

- [ ] **Step 2: 全量自动验收**

```bash
pnpm test
pnpm check
grep -rn "fake\|anthropic" packages/core/src/
grep -rn "toolExecution\|executionMode" packages/core/src/
grep -rn "realpath\|withFileMutationQueue" packages/core/src/
wc -l packages/core/src/*.ts
```

- [ ] **Step 3: 行为验收**

1. parallel timing `<150ms`；
2. end order `[c2,c3,c1]`；
3. message/history order `[c1,c2,c3]`；
4. hook prepare 严格串行；
5. sequential config/tool fallback；
6. same-file edit 不丢更新、cross-file 不互相阻塞；
7. abort outcomes source-ordered，最终 Agent 为 aborted。

- [ ] **Step 4: 提交**

```bash
git add docs/stages/06-parallel-tools.md
git commit -m "docs(stage-6): explain dual ordering in parallel tools"
```

---

## 完成标准

- [ ] 默认 batch 真正并行执行，且 timing test 证明不是伪并行。
- [ ] prepare/hook 始终按源顺序串行，execute 在所有 prepare 完成后才开始。
- [ ] `tool_execution_end` 按完成顺序；toolResult message/history 按源顺序。
- [ ] immediate outcomes 与 executed outcomes 混合时，消息顺序仍稳定。
- [ ] 全局 sequential 与任一工具 sequential 均让整批降级。
- [ ] same realpath mutation 串行，different realpath 并行，throw 后队列可继续。
- [ ] parallel abort 为未执行 calls 生成 Operation aborted outcomes，历史按源顺序，Agent 最终 aborted。
- [ ] terminate 聚合与 Stage 5 语义保持，abort 优先。
- [ ] Agent 可在 run 之间动态切换 `toolExecution`。
- [ ] Stage 1-5 既有测试保持全绿；`pnpm test` / `pnpm check` 全绿。
- [ ] 所有 src 文件 <200 行，阶段源码净增量 <400 行。
- [ ] `docs/stages/06-parallel-tools.md` 存在并留下四个回测问题。
