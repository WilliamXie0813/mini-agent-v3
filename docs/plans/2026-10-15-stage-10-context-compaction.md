# 阶段 10「上下文压缩」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不删除或改写任何历史 entry 的前提下，为持久化会话增加手动、阈值和上下文溢出三条压缩路径，使后续模型请求使用「累计摘要 + 最近完整 turns」，同时保留 branch 回到原文历史的能力。

**Architecture:** `SessionJournal` 继续保存完整 append-only 事实；新的 `session-context.ts` 把当前祖先路径投影为模型上下文，最新 `compaction` entry 在其 `firstKeptEntryId` 前注入摘要，旧 conversation entries 仍留在文件中。`Agent.prepareRequest` 成为调用模型前的最后替换缝，`AgentSession` 在这里做阈值检查；provider 用结构化 `errorKind: "context_overflow"` 报超窗时，agent loop 最多调用一次压缩恢复并重试。

**Tech Stack:** Node 22+、TypeScript 5.9.3（strict + erasableSyntaxOnly）、pnpm workspaces、vitest 3、append-only JSONL、现有 `StreamFn` / Anthropic SSE 适配器。零新增运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md` §3.2(b)、§4、§5 阶段 10、§7.1–7.4；持久化前置能力见 `docs/stages/09-session-persistence.md`。

## Global Constraints

- **只加一个新概念**：上下文压缩。不得提前实现阶段 11 的 `ExtensionAPI`、通用 hook 注册表或第二 provider，阶段 12 的 WebSocket/UI，阶段 13 的子 agent/双队列。
- 先写失败测试，再写最小实现；每个任务独立提交。阶段结束时 `pnpm test` 与 `pnpm check` 全绿。
- 阶段源码净增量目标约 380 行。阶段 9 已接受较大持久化实现，本阶段不得借压缩之名重写 journal、recovery 或 Agent 生命周期。
- 零新增运行时依赖；token 粗估、摘要序列化、错误分类和配置解析只使用现有代码与 Node 标准库。
- tab 缩进；ESM；包内相对导入带 `.ts`；跨包用包名；类型导入用 `import type`。
- `strict: true`、`erasableSyntaxOnly: true`；禁止 `enum`、构造函数参数属性、`namespace` 和 `as any`。
- `SessionJournal` 仍是完整事实源。压缩只能 append 一个新 entry；不得删除、覆盖、重排或重新序列化任何完整旧行。
- `compaction.firstKeptEntryId` 必须指向该 compaction parent 的既有祖先，且必须是模型可见 conversation 边界。append 与 open 都拒绝缺失、非祖先或指向 `toolResult` 的边界。
- branch 到 compaction 之前的 entry 时恢复原始未压缩上下文；branch 到 compaction 或其后代时应用该分支上最新的 compaction。
- system sections 与工具声明历史不参与摘要裁剪，始终按当前祖先路径完整重放；压缩只替换 conversation 部分。
- `CompactionSettings.enabled` 只控制 threshold 自动压缩。手动 `compact()` 与 overflow 恢复仍可使用。
- 计划固定默认值：`contextWindow = 128_000`、`reserveTokens = 16_384`、`keepRecentTurns = 4`。CLI 可用 `ANTHROPIC_CONTEXT_WINDOW` 覆盖 context window。
- `shouldCompact()` 使用严格大于：`contextTokens > contextWindow - reserveTokens`。刚好等于阈值不压缩，超过 1 token 才压缩。
- 一个 retained turn 定义为一条模型可见、非 `error`/`aborted` 的 assistant message，以及紧随其后的全部 toolResult entries。切点可以落在 user submission 或 assistant entry，绝不能落在 toolResult 或其 recovery metadata 中间。
- `Usage.inputTokens` 已包含 cache read/write 输入；阈值校准只用 `inputTokens + outputTokens`，不能再次加 `cacheReadTokens` / `cacheWriteTokens`。
- compaction 发生后，之前 assistant usage 对新投影失效；直到压缩后出现新的有效 usage，token 数必须回退到逐消息 `ceil(chars / 4)`。
- 摘要使用同一个底层 `StreamFn`，但必须是独立请求：单独 summarization system prompt、一个序列化 conversation 的 user message、`tools: []`。不得把摘要请求写成普通 session turn。
- 摘要响应为 `error`、`aborted`、`length`、包含 toolCall 或空白文本时，明确失败；不得 append compaction entry，也不得用空摘要继续请求。
- compaction 摘要进入模型上下文时固定包装为：

  ```text
  The conversation history before this point was compacted into the following summary:

  <summary>
  {summary}
  </summary>
  ```

- provider 上下文溢出必须通过结构化 `AssistantMessage.errorKind === "context_overflow"` 识别；core 禁止匹配 provider 错误字符串。`stopReason: "length"` 仍表示输出 token 上限，不触发上下文压缩恢复。
- 第一次 overflow assistant diagnostic 保留在 journal 供审计，但从下一次模型上下文投影中排除。每次 `submit()` 最多 compact-and-retry 一次；第二次 overflow 正常结束为 error，不得递归重试。
- threshold/overflow compaction 发生在当前 Agent 的 active run 内，不能当场替换 `this.agent`。内部压缩只 append entry 并返回新的 request projection；`runSubmission()` 在旧 Agent 完全 settle 后再从 journal 重建 Agent。手动 idle compaction 才立即重建。
- `compaction_start` 在摘要请求前发出；成功 entry fsync 后才发 `compaction_end(status:"completed")`。失败时发成对的 `compaction_end(status:"error")` 后重抛原错误。
- 手动压缩在 session idle 时运行；无可摘要前缀时返回 `undefined`、不发事件、不写 journal、不请求 provider。
- 所有实施 commits 必须带：

  ```text
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```

- 本计划基于本地 `master` 的阶段 9 完成点 `3d9db48` 或其后继；执行时使用独立 `stage-10-context-compaction` 分支/工作树，不改写阶段 9 commits。

## Review Focus

1. **切点破坏 toolCall/toolResult 对**：parallel outcomes、tool metadata 和完整 result messages 混排时，first-kept 仍只能是 submission/assistant，且保留 assistant 后全部 results。→ Task 1。
2. **重复压缩错误使用旧 usage 或旧 summary**：最新 compaction 必须成为唯一活动摘要；其前 usage 失效，下一次摘要基于「旧摘要 + 新增旧消息」而不是重新发送所有 raw history。→ Tasks 1–3。
3. **append-only 与 branch 语义被投影掩盖**：压缩后旧文件 bytes/entry 数量只能增长；branch 到压缩前节点必须重新看到原文，坏 `firstKeptEntryId` 必须拒绝。→ Task 2。
4. **摘要失败产生 success-shaped entry**：error/aborted/length/toolCall/空白摘要，以及 compaction append 失败，都不能留下可被 replay 的 compaction。→ Task 3。
5. **overflow 形成循环或误把 output length 当超窗**：一次 submit 最多一次恢复；第二次 overflow、普通 provider error 和 `length` 都不得再次摘要。→ Task 5。

---

## 1. 锁定的数据模型与文件职责

### 1.1 JSONL schema

`packages/core/src/session-types.ts` 增加：

```ts
export type CompactionReason = "manual" | "threshold" | "overflow";

export type SessionEntryData =
	// existing variants...
	| {
			type: "compaction";
			reason: CompactionReason;
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
	  };
```

`compaction` 自身仍由 `SessionJournal.append()` 添加 `id`、`parentId`、`createdAt`。`firstKeptEntryId` 是上下文投影边界，不改变 parent tree。

### 1.2 compaction 公共类型

`packages/core/src/compaction.ts` 固定导出：

```ts
export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTurns: number;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTurns: 4,
};

export interface ProjectedSessionEntry {
	source: SessionEntry;
	messages: Message[];
}

export interface SessionContextProjection {
	entries: ProjectedSessionEntry[];
	messages: Message[];
	latestCompaction?: SessionEntryOf<"compaction">;
}

export interface CutPoint {
	firstKeptEntryId: string;
	messagesToSummarize: Message[];
}

export interface CompactionPreparation extends CutPoint {
	tokensBefore: number;
}

export function estimateTokens(message: Message): number;
export function estimateContextTokens(
	projection: SessionContextProjection,
): number;
export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean;
export function findCutPoint(
	entries: readonly ProjectedSessionEntry[],
	keepRecentTurns: number,
): CutPoint | undefined;
export function prepareCompaction(
	projection: SessionContextProjection,
	keepRecentTurns: number,
): CompactionPreparation | undefined;
export function createCompactionSummaryMessage(summary: string): Message;
export async function generateCompactionSummary(
	streamFn: StreamFn,
	messages: readonly Message[],
	signal?: AbortSignal,
): Promise<string>;
```

`normalizeCompactionOptions(contextWindow, settings)` 可保持 module-private；参数为 `number | undefined` 与 `Partial<CompactionSettings> | undefined`，返回 `{ contextWindow: number; settings: CompactionSettings }`。它验证 safe integer、`reserveTokens >= 0`、`keepRecentTurns >= 1`、`contextWindow >= 1`，并拒绝 `reserveTokens >= contextWindow`。

### 1.3 session projection

`packages/core/src/session-context.ts` 固定导出：

```ts
export function projectSessionContext(
	entries: readonly SessionEntry[],
): SessionContextProjection;

export function messagesFromSessionPath(
	entries: readonly SessionEntry[],
): Message[];

export function streamContextFromSessionPath(
	entries: readonly SessionEntry[],
): StreamContext;
```

投影规则：

1. 无 compaction 时保持阶段 9 行为：`submission` 变 user message，`message` entry 原样恢复，其余 metadata 不进 transcript。
2. 有 compaction 时只应用当前 path 上最后一个 compaction。
3. 所有 system message 仍按 path 顺序保留。
4. 在 `firstKeptEntryId` 前插入最新 compaction 的 synthetic user summary。
5. 只保留 `firstKeptEntryId...compaction.parent` 的 conversation，以及 compaction 之后追加的 conversation。
6. 旧 compaction entries 不再次生成 summary message。
7. `messagesFromSessionPath()` 用于 Agent state，保留 provider diagnostics；`streamContextFromSessionPath()` 额外排除 `assistant.errorKind === "context_overflow"`，并从完整 system/tool 历史重算 `system` 与 `tools`。

### 1.4 request/overflow hooks

`packages/core/src/agent-options.ts` 增加：

```ts
export interface PrepareRequestContext {
	context: StreamContext;
	signal: AbortSignal;
}

export type PrepareRequest = (
	input: PrepareRequestContext,
) => StreamContext | Promise<StreamContext>;

export interface RecoverContextOverflowContext {
	context: StreamContext;
	message: AssistantMessage;
	signal: AbortSignal;
}

export type RecoverContextOverflow = (
	input: RecoverContextOverflowContext,
) => boolean | Promise<boolean>;
```

`AgentOptions` / `AgentLoopOptions` 增加 `prepareRequest?` 与 `recoverContextOverflow?`。`AgentSessionOptions` 必须 omit 这两个内部所有权 hook，并增加：

```ts
contextWindow?: number;
compaction?: Partial<CompactionSettings>;
```

`Agent` 暴露可替换的 `public prepareRequest?: PrepareRequest`，与现有 `beforeToolCall` seam 一致；`recoverContextOverflow` 只由构造配置与 `AgentSession` 编排持有，不成为阶段 11 的通用扩展 hook。

`AgentSession` 构造时用 `options.streamFn ?? getDefaultStreamFn()` 解析并保存同一个 `private readonly streamFn`；普通 Agent 请求与 summarization 都使用这份引用，不能在摘要路径悄悄换 provider。

`AgentSession` 增加：

```ts
compact(): Promise<SessionEntryOf<"compaction"> | undefined>;
```

### 1.5 events 与 provider error

`packages/ai/src/types.ts` 增加：

```ts
export type AssistantErrorKind = "context_overflow" | "provider";

export interface AssistantMessage {
	// existing fields...
	errorKind?: AssistantErrorKind;
}
```

`packages/core/src/agent-event.ts` 增加：

```ts
| {
		type: "compaction_start";
		reason: CompactionReason;
		contextTokens: number;
  }
| {
		type: "compaction_end";
		reason: CompactionReason;
		status: "completed";
		entryId: string;
		firstKeptEntryId: string;
		tokensBefore: number;
  }
| {
		type: "compaction_end";
		reason: CompactionReason;
		status: "error";
		errorMessage: string;
  }
```

### 1.6 文件结构

| 文件 | 职责 |
|---|---|
| Create `packages/core/src/compaction.ts` | settings、token 估算、切点、摘要消息与摘要调用 |
| Create `packages/core/src/session-context.ts` | 当前 path 的 compaction-aware 投影与 StreamContext 重建 |
| Create `packages/core/test/compaction.test.ts` | 纯函数、摘要请求、失败边界 |
| Create `packages/core/test/session-context.test.ts` | projection、重复压缩、branch 与坏边界 |
| Create `packages/ai/src/anthropic-error.ts` | Anthropic HTTP/SSE error 的结构化分类 |
| Modify `session-types.ts` / `session-journal.ts` | compaction schema、append/open 语义校验 |
| Modify Agent option/loop/event files | `prepareRequest`、单次 overflow recovery、compaction events |
| Modify `agent-session.ts` | settings、手动/阈值/overflow 压缩编排 |
| Modify Anthropic provider files/tests | `errorKind` 分类，不改变正常 SSE 流 |
| Modify CLI/tests | context window 组装、`/compact`、阶段 10 banner |
| Create `docs/stages/10-context-compaction.md` | 阶段决策与回测文档 |

---

### Task 1: 实现 token 阈值与完整 turn 切点纯函数

**Files:**
- Create: `packages/core/src/compaction.ts`
- Create: `packages/core/test/compaction.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `CompactionSettings`、默认值、`estimateTokens()`、`estimateContextTokens()`、`shouldCompact()`、`findCutPoint()`、`prepareCompaction()`。
- Consumers: Tasks 2–5。

- [ ] **Step 1: 写失败测试 `compacts_only_after_crossing_the_reserved_boundary`**

```ts
const settings = {
	enabled: true,
	reserveTokens: 20,
	keepRecentTurns: 2,
};

expect(shouldCompact(79, 100, settings)).toBe(false);
expect(shouldCompact(80, 100, settings)).toBe(false);
expect(shouldCompact(81, 100, settings)).toBe(true);
expect(shouldCompact(1000, 100, { ...settings, enabled: false })).toBe(false);
```

同一测试文件覆盖非法 context window、负 reserve、`reserve >= window`、零/小数 `keepRecentTurns` 的具名错误。

- [ ] **Step 2: 运行阈值测试确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- compaction.test.ts -t "reserved boundary"
```

Expected: FAIL，`compaction.ts` 或导出尚不存在。

- [ ] **Step 3: 实现 settings 默认值、校验与 `shouldCompact()`**

严格使用 `>`，不要在调用方复制阈值公式。

- [ ] **Step 4: 运行阈值测试确认通过**

Run: 与 Step 2 相同。  
Expected: PASS。

- [ ] **Step 5: 写失败测试 `estimates_messages_and_uses_the_latest_valid_usage_without_double_counting_cache`**

覆盖：

- text 使用 `Math.ceil(chars / 4)`；
- toolCall 计入 tool name 与 `JSON.stringify(arguments)`；
- system sections 与 tools declarations 都计入；
- toolResult text 计入；
- 最后一条有效 assistant usage 为 `{ inputTokens: 80, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 }`，其后 8 个字符的消息使总值为 `102`，不是 `142`；
- `error` / `aborted` / 全零 usage 不作为校准点；
- latest compaction 之前的 usage 被忽略，全部回退逐消息估算。

- [ ] **Step 6: 运行 token 测试确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- compaction.test.ts -t "latest valid usage"
```

Expected: FAIL，估算函数尚未实现。

- [ ] **Step 7: 实现 `estimateTokens()` 与 `estimateContextTokens()`**

`estimateContextTokens()` 从 projection 尾部找 compaction 之后最后一条有效 assistant usage，再加其后的粗估消息；找不到时对 projection 的 model-visible messages 全量粗估。

- [ ] **Step 8: 运行 token 测试确认通过**

Run: 与 Step 6 相同。  
Expected: PASS。

- [ ] **Step 9: 写失败测试 `keeps_recent_assistant_turns_without_cutting_tool_results`**

构造 logical entries：

```text
submission u1
assistant a1(toolCall c1)
tool_intent/update/outcome metadata
toolResult r1
assistant a2(stop)
submission u2
assistant a3(toolCall c2,c3)
toolResult r2
toolResult r3
assistant a4(stop)
```

断言：

- `keepRecentTurns = 2` 的 `firstKeptEntryId` 是 `a3`，不是 `r2` / `r3`；
- `messagesToSummarize` 含 u1/a1/r1/a2/u2，但不含 a3/r2/r3/a4；
- `error` / `aborted` assistant 不计入 retained turn 数；
- retained 不足或切点前无 model-visible conversation 时返回 `undefined`；
- parallel toolResult 顺序不影响切点，a3 后全部 results 都保留。

- [ ] **Step 10: 运行切点测试确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- compaction.test.ts -t "recent assistant turns"
```

Expected: FAIL，`findCutPoint()` / `prepareCompaction()` 尚未实现。

- [ ] **Step 11: 实现反向 turn 扫描**

算法只扫描 `ProjectedSessionEntry.messages`：

1. 跳过 system、metadata、compaction diagnostic 与 `error`/`aborted` assistant。
2. 从尾部数 model-visible assistant turns。
3. 第 N 条 assistant 是候选 first-kept。
4. 候选后的所有 entries 原样 retained，因此 tool results 不会被切开。
5. 候选前只收集 model-visible、非 system messages 作为摘要输入。

- [ ] **Step 12: 运行 Task 1 全部测试**

Run:

```bash
pnpm --filter @mini-agent/core test -- compaction.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: compaction tests 与 core type-check PASS。

- [ ] **Step 13: 提交 Task 1**

```bash
git add packages/core/src/compaction.ts packages/core/src/index.ts packages/core/test/compaction.test.ts
git commit -m "feat(stage-10): add compaction thresholds and cut points" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 持久化 compaction entry 并重建模型上下文

**Files:**
- Create: `packages/core/src/session-context.ts`
- Create: `packages/core/test/session-context.test.ts`
- Modify: `packages/core/src/session-types.ts:19-49`
- Modify: `packages/core/src/session-journal.ts:43-69,100-176,183-203`
- Modify: `packages/core/src/agent-session.ts:42-51,93-127,151-157`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/session-journal.test.ts`
- Modify: `packages/core/test/agent-session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 projection types 与 summary message helper。
- Produces: compaction schema、`projectSessionContext()`、`messagesFromSessionPath()`、`streamContextFromSessionPath()`。
- Consumers: Tasks 3–5。

- [ ] **Step 1: 写失败 journal 测试 `appends_compaction_without_rewriting_history`**

在已有多轮 journal 上保存 `before` bytes 与旧 entry JSON，append：

```ts
{
	type: "compaction",
	reason: "manual",
	summary: "old work summary",
	firstKeptEntryId: kept.id,
	tokensBefore: 120_000,
}
```

断言：

- `after.startsWith(before) === true`；
- entry 数量只增加 1；
- 所有旧行逐字节不变；
- reopen 后字段完整；
- compaction parent 是 append 前 leaf，`firstKeptEntryId` 不改变 tree parent。

- [ ] **Step 2: 写失败 journal 测试 `rejects_invalid_compaction_boundaries`**

覆盖 append 与手写 JSONL reopen：

- missing id；
- id 存在但不在 compaction parent 的祖先链；
- 指向 `message.role === "toolResult"`；
- 空 summary；
- 非允许 reason；
- 负数/非 safe integer `tokensBefore`。

每种失败都必须保持 disk、entries 与 leaf 不变。

- [ ] **Step 3: 运行 journal selector 确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- session-journal.test.ts -t "compaction"
```

Expected: FAIL，entry type/schema 尚未支持。

- [ ] **Step 4: 扩展 session schema 与 journal 验证**

把 `compaction` 加入 `ENTRY_TYPES`；parse 时校验字段，append/open 共用同一个 boundary validator。不要顺便为阶段 9 全部旧 variants 重写 schema parser。

- [ ] **Step 5: 运行 journal selector 确认通过**

Run: 与 Step 3 相同。  
Expected: PASS。

- [ ] **Step 6: 写失败 projection 测试 `projects_summary_before_the_kept_tail_and_preserves_system_history`**

构造：

```text
system(base tools)
u1 → a1
system(policy update)
u2 → a2
u3 → a3
compaction(summary, firstKept=a2)
u4 → a4
```

断言 projection：

- `getCurrentSystemMessage()` 同压缩前逐字段相等；
- `getCurrentTools()` 同压缩前相等；
- conversation 为 `summary, a2, u3, a3, u4, a4`；
- 不含 u1/a1/u2；
- synthetic summary 使用 Global Constraints 中固定 wrapper；
- raw journal entries 仍全部存在。

- [ ] **Step 7: 写失败 projection 测试 `uses_only_the_latest_compaction_and_branches_back_to_raw_history`**

覆盖：

1. 第二次 compaction 后只出现第二份摘要，第一份摘要作为第二次摘要输入而不是并列进入最终 context；
2. branch 到第一次 compaction 前的 entry 后，无摘要且原始 conversation 恢复；
3. branch 到第一次 compaction 后、第二次 compaction 前时，只应用第一次摘要；
4. `streamContextFromSessionPath()` 排除 `errorKind:"context_overflow"` diagnostic，但 `messagesFromSessionPath()` 保留它供 state/audit。

- [ ] **Step 8: 运行 projection 测试确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- session-context.test.ts
```

Expected: FAIL，projection module 尚不存在。

- [ ] **Step 9: 实现 compaction-aware projection**

关键顺序：

1. 找 active path 最后的 compaction C 与其 first-kept K。
2. 在 K 的 logical 位置插入 C 的 synthetic summary。
3. system entries 始终保留原相对顺序。
4. conversation 只保留 K...C.parent 与 C 后 entries。
5. 所有 compaction metadata 自身不直接进入 Message[]。
6. projection entries 保留 source 映射，供 Task 1 切点和 usage 失效判断。

- [ ] **Step 10: 用 shared projection 替换 `agent-session.ts` 私有 `messagesFromPath()`**

create/open/branch/runSubmission 的 Agent 重建都调用 `messagesFromSessionPath(journal.pathTo())`；无 compaction 路径的现有 stage 9 assertions 必须保持不变。

- [ ] **Step 11: 运行 projection、journal 与 session 回归**

Run:

```bash
pnpm --filter @mini-agent/core test -- session-context.test.ts session-journal.test.ts agent-session.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: PASS；阶段 9 resume/branch/idempotency 测试不变。

- [ ] **Step 12: 提交 Task 2**

```bash
git add packages/core/src/session-context.ts packages/core/src/session-types.ts \
  packages/core/src/session-journal.ts packages/core/src/agent-session.ts \
  packages/core/src/index.ts packages/core/test/session-context.test.ts \
  packages/core/test/session-journal.test.ts packages/core/test/agent-session.test.ts
git commit -m "feat(stage-10): persist and project compaction entries" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: 生成摘要并提供手动 `AgentSession.compact()`

**Files:**
- Modify: `packages/core/src/compaction.ts`
- Modify: `packages/core/src/agent-event.ts`
- Modify: `packages/core/src/agent-session.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/compaction.test.ts`
- Modify: `packages/core/test/agent-session.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 的 preparation、projection、journal schema。
- Produces: `generateCompactionSummary()`、compaction events、`AgentSession.compact()` 与内部 `compact(reason, signal)` 编排。
- Consumers: Tasks 4–6。

- [ ] **Step 1: 写失败测试 `summarizes_with_a_separate_tool_free_request`**

捕获传给 `StreamFn` 的 context，返回一条 text assistant。断言：

- `context.system.sections` 只有以下固定 summarization prompt：

  ```text
  Summarize the earlier mini-agent conversation for another model that will continue the same task. Preserve goals, constraints, decisions, completed work, open work, exact file paths, commands, and errors. Do not continue the task and do not call tools. Return only the summary.
  ```

- `context.tools` 为 `[]`；
- `context.messages` 只有一个 user message；
- user text 是 `<conversation>\n${JSON.stringify(messages, null, 2)}\n</conversation>`；
- 返回值 trim 后等于 assistant text。

- [ ] **Step 2: 写失败测试 `rejects_unsafe_summary_responses`**

table 覆盖：

- `stopReason: "error"`；
- `stopReason: "aborted"`；
- `stopReason: "length"`；
- content 含 toolCall；
- text 全空白。

每种都 reject 具名 `/summary|summarization/i` 错误。

- [ ] **Step 3: 运行摘要测试确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- compaction.test.ts -t "summary"
```

Expected: FAIL，summary helper 尚未实现。

- [ ] **Step 4: 实现 summary request**

直接用 `consumeAssistantMessage(streamFn(context, signal))`；`AgentSession` 把构造时解析好的同一份 streamFn 传入。不创建临时 Agent，不发普通 agent/message/tool events，不把 summary usage 当作 conversation assistant usage。

- [ ] **Step 5: 运行摘要测试确认通过**

Run: 与 Step 3 相同。  
Expected: PASS。

- [ ] **Step 6: 写失败 integration test `manually_compacts_append_only_and_emits_committed_events`**

准备超过 `keepRecentTurns` 的 session，订阅事件，保存 compaction 前 bytes/entries，然后 `await session.compact()`。

断言：

- 事件顺序恰好含 `compaction_start(manual)` → `compaction_end(completed)`；
- start 在 summary provider call 前，completed 在 journal append/fsync 后；
- 返回 entry 与 journal 最后一条相同；
- old bytes 仍是新文件前缀，old entries 深相等；
- `session.state.messages` 重建为 summary + retained tail，system/tools 正确；
- reopen 后得到相同 state；
- 第二次 compaction 的 summary prompt 包含第一次 summary，不包含第一次已经丢弃的 raw prefix。

- [ ] **Step 7: 写失败 integration test `leaves_session_unchanged_when_manual_compaction_cannot_complete`**

覆盖：

1. 无 eligible prefix → 返回 `undefined`、零事件、零 provider call、零写入；
2. summary provider 失败 → start/end(error) 成对、无 compaction entry、原错误 reject；
3. compaction append 失败 → start/end(error) 成对、state 不切换为摘要、旧历史仍可 reopen。

- [ ] **Step 8: 运行 AgentSession compaction selector 确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-session.test.ts -t "compact"
```

Expected: FAIL，API/events 尚不存在。

- [ ] **Step 9: 实现 `AgentSession.compact()` 与内部编排**

内部流程固定为：

```text
assert/run session ownership
→ project active path
→ prepareCompaction
→ no preparation: return undefined
→ emit start
→ generate summary
→ append compaction
→ emit completed
→ return entry
```

catch 分支先 emit error end，再重抛原错误。公开 `compact()` 使用 reason `"manual"`，entry durable 后立即重建 idle Agent；threshold/overflow 在后续任务调用同一内部函数，但只返回新的 request projection，绝不替换正在运行的 Agent。

- [ ] **Step 10: 运行 Task 3 tests 与 type-check**

Run:

```bash
pnpm --filter @mini-agent/core test -- compaction.test.ts agent-session.test.ts session-context.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: PASS。

- [ ] **Step 11: 提交 Task 3**

```bash
git add packages/core/src/compaction.ts packages/core/src/agent-event.ts \
  packages/core/src/agent-session.ts packages/core/src/index.ts \
  packages/core/test/compaction.test.ts packages/core/test/agent-session.test.ts
git commit -m "feat(stage-10): add manual session compaction" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: 在 `prepareRequest` 最后检查 threshold

**Files:**
- Modify: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent-loop.ts:19-91`
- Modify: `packages/core/src/agent.ts:20-110`
- Modify: `packages/core/src/agent-session.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/agent.test.ts`
- Modify: `packages/core/test/agent-session.test.ts`

**Interfaces:**
- Consumes: Task 3 的内部 compaction 编排。
- Produces: `PrepareRequest` hook 与 threshold 自动触发。
- Consumer: Task 5；阶段 11 后续扩展系统复用这个缝，但本任务不实现 hook registry。

- [ ] **Step 1: 写失败 agent-loop 测试 `prepares_the_final_context_immediately_before_streaming`**

hook 把 context 替换成带 `"prepared"` user message 与不同 tools 的快照。断言：

- 调用顺序为 `prepareRequest` → `streamFn`；
- streamFn 只看到替换后的 context；
- active tool execution registry 只允许 prepared context 仍声明的工具；
- hook 每次 provider turn 调一次，包括工具结果后的下一轮。

- [ ] **Step 2: 运行 prepareRequest selector 确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-loop.test.ts -t "prepares the final context"
```

Expected: FAIL，option 不存在。

- [ ] **Step 3: 接通 `PrepareRequest`**

`agentLoop()` 先构建 replay context，再 await hook，最后从 prepared context 计算本轮可执行工具并调用 streamFn。`Agent` 保存 hook 并像 durable intent/listener 一样把 hook failure 当 infrastructure failure 原样抛出。

- [ ] **Step 4: 运行 Agent/loop hook tests**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-loop.test.ts agent.test.ts -t "prepare"
```

Expected: PASS。

- [ ] **Step 5: 写失败 integration test `automatically_compacts_before_an_over_threshold_request`**

使用小 `contextWindow` 与已有长历史；summary/normal provider 根据 summarization system prompt 返回不同脚本。

断言：

- provider 正式请求前已 append compaction；
- event 序列中 `agent_start` / `turn_start` 后出现 `compaction_start` → `compaction_end`，然后才是 assistant `message_start`；
- 正式 provider context 是「正确 system + summary + retained tail + 当前 submission」；
- context 不含被摘要 raw prefix；
- active Agent 在请求期间没有被替换；run settle 后 `session.state` 才从 durable projection 重建；
- old journal bytes 未改；
- `enabled:false` 不自动压缩；
- 刚好等于 threshold 不触发，超过 1 token 触发。

- [ ] **Step 6: 写失败 integration test `does_not_recompact_from_usage_recorded_before_the_latest_compaction`**

先手动压缩，再发下一请求；保留尾部含一个高 usage assistant。断言 prepareRequest 使用粗估而不是旧 usage，不立即重复压缩。压缩后产生新 assistant usage 后，下一次请求可以再次用 usage 校准。

- [ ] **Step 7: 运行 threshold integration selector 确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-session.test.ts -t "threshold|usage recorded before"
```

Expected: FAIL，AgentSession 尚未拥有 prepareRequest。

- [ ] **Step 8: 在 AgentSession 归一化 compaction 配置**

构造时复制 settings；`contextWindow` 缺省 `128_000`。`AgentSessionOptions` omit caller 的 `prepareRequest`/`recoverContextOverflow`，防止绕过 journal 编排。

- [ ] **Step 9: 实现 threshold `prepareRequest`**

每次调用忽略传入 raw conversation，改从 `journal.pathTo()` 建立 projection：

1. 估算即将发送的 context；
2. `shouldCompact === false` 时返回 `streamContextFromSessionPath()`；
3. true 时用 reason `"threshold"` 调内部 compaction；
4. 成功后再次投影并返回；无 eligible prefix 时返回未压缩 context，避免循环。

`runSubmission()` 必须在 `await this.agent.prompt()` settle 后、清理 active submission 之前，从最新 `journal.pathTo()` 重建下一次操作使用的 Agent；旧 Agent 的 abort、idle 与事件 ownership 保持到本次 run 完全结束。

- [ ] **Step 10: 运行 Task 4 tests 与 core check**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-loop.test.ts agent.test.ts agent-session.test.ts compaction.test.ts session-context.test.ts
pnpm --filter @mini-agent/core run check
```

Expected: PASS。

- [ ] **Step 11: 提交 Task 4**

```bash
git add packages/core/src/agent-options.ts packages/core/src/agent-loop.ts \
  packages/core/src/agent.ts packages/core/src/agent-session.ts \
  packages/core/src/index.ts packages/core/test/agent-loop.test.ts \
  packages/core/test/agent.test.ts packages/core/test/agent-session.test.ts
git commit -m "feat(stage-10): compact before over-threshold requests" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: 结构化识别 context overflow 并只重试一次

**Files:**
- Create: `packages/ai/src/anthropic-error.ts`
- Modify: `packages/ai/src/types.ts:20-38`
- Modify: `packages/ai/src/anthropic.ts`
- Modify: `packages/ai/src/anthropic-stream.ts:24-52`
- Modify: `packages/ai/src/index.ts`
- Modify: `packages/ai/test/anthropic.test.ts`
- Modify: `packages/ai/test/anthropic-stream.test.ts`
- Modify: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/agent-session.ts`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/agent-session.test.ts`

**Interfaces:**
- Consumes: Task 4 的 prepareRequest 与 Task 3 的 compaction 编排。
- Produces: `AssistantErrorKind`、Anthropic error classifier、`RecoverContextOverflow` 与单次 retry。
- Consumer: Task 6 CLI composition root。

- [ ] **Step 1: 写失败 AI tests `classifies_http_and_sse_context_overflow_without_string_matching_in_core`**

HTTP fixture：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "prompt is too long for the model context window"
  }
}
```

SSE fixture 使用同一 error object。断言两者 terminal message：

```ts
{
	stopReason: "error",
	errorKind: "context_overflow",
	errorMessage: expect.stringMatching(/prompt is too long/i),
}
```

另断言 `overloaded_error`、HTTP 500、普通 invalid request 都是 `errorKind:"provider"`；API key redaction与 1024 字符上限保持。

- [ ] **Step 2: 运行 AI overflow tests 确认失败**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic.test.ts anthropic-stream.test.ts -t "context overflow"
```

Expected: FAIL，`errorKind` / classifier 尚不存在。

- [ ] **Step 3: 实现 `classifyAnthropicError(type, message, status?)`**

classifier 只在 provider 层识别 Anthropic/Kimi 的结构化 type/status 与已知超窗短语；返回 `{ kind, diagnostic }`。HTTP 非 2xx 必须读取并解析有限诊断 body，解析失败仍返回 provider error，不 throw 出 event stream。

- [ ] **Step 4: 把 kind 穿过 HTTP 与 SSE state machine**

`createAnthropicStreamState.fail()` 增加可选 kind；所有 generic protocol/network errors 使用 `"provider"`，abort 不设置 provider kind。

- [ ] **Step 5: 运行 AI tests 与 check**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic.test.ts anthropic-stream.test.ts
pnpm --filter @mini-agent/ai run check
```

Expected: PASS。

- [ ] **Step 6: 写失败 core test `compacts_and_retries_one_context_overflow`**

自定义 StreamFn 按 context 类型执行：

1. 第一次正式请求返回 `errorKind:"context_overflow"`；
2. summarization 请求返回 `"checkpoint"`；
3. retry 正式请求返回 `"recovered"`。

断言：

- 第一次 overflow message 已 journaled；
- overflow turn 先 `turn_end`，然后 compaction events，再发新的 `turn_start`；
- retry context 含 checkpoint + retained tail，不含 overflow diagnostic；
- 最终 run_end 为 completed；
- 总正式请求 2 次、summary 请求 1 次。

- [ ] **Step 7: 写失败 core test `does_not_retry_a_second_overflow_or_output_length`**

覆盖：

- 第一次 overflow → summary → 第二次 overflow：summary 仅 1 次、正式请求仅 2 次、最终 error；
- 第一次普通 provider error：零 summary、零 retry；
- `stopReason:"length"`：继续保持阶段 2 的截断 tool safety，不调用 overflow recovery；
- compaction 无 eligible prefix 或 summary 失败：不发 retry，错误明确传播。

- [ ] **Step 8: 运行 core overflow selector 确认失败**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-loop.test.ts agent-session.test.ts -t "overflow|output length"
```

Expected: FAIL，recovery hook/guard 尚不存在。

- [ ] **Step 9: 实现 `RecoverContextOverflow` 与 loop guard**

agent loop 在 terminal overflow message 已完成 `message_end` 后：

1. append 到本地 transcript；
2. emit 当前 `turn_end`；
3. 若本 run 尚未 retry，await recovery hook；
4. hook 返回 true 时标记 guard、emit 新 `turn_start`、重新进入 prepareRequest/stream；
5. false 或第二次 overflow 时 emit `agent_end` 并结束。

`Agent` 对 recovery hook failure 使用 infrastructure failure 规则，不能合成成功形状。

- [ ] **Step 10: 在 AgentSession 中接通 overflow compaction**

hook 用 reason `"overflow"` 调内部 compaction；只有成功 append entry 才返回 true。`enabled:false` 不阻止 overflow recovery。retry 的 prepareRequest 从 journal 重建 model context，因此自动排除前一次 overflow diagnostic。

- [ ] **Step 11: 运行 AI/Core targeted tests 与 checks**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic.test.ts anthropic-stream.test.ts
pnpm --filter @mini-agent/core test -- agent-loop.test.ts agent.test.ts agent-session.test.ts compaction.test.ts session-context.test.ts
pnpm --filter @mini-agent/ai run check
pnpm --filter @mini-agent/core run check
```

Expected: PASS。

- [ ] **Step 12: 提交 Task 5**

```bash
git add packages/ai/src/anthropic-error.ts packages/ai/src/types.ts \
  packages/ai/src/anthropic.ts packages/ai/src/anthropic-stream.ts \
  packages/ai/src/index.ts packages/ai/test/anthropic.test.ts \
  packages/ai/test/anthropic-stream.test.ts packages/core/src/agent-options.ts \
  packages/core/src/agent-loop.ts packages/core/src/agent.ts \
  packages/core/src/agent-session.ts packages/core/test/agent-loop.test.ts \
  packages/core/test/agent-session.test.ts
git commit -m "feat(stage-10): recover once from context overflow" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: 接通 CLI context window 与 `/compact`

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/ai/test/anthropic-cli.test.ts`

**Interfaces:**
- Consumes: `AgentSessionOptions.contextWindow` 与 `AgentSession.compact()`。
- Produces: CLI 手动入口、环境配置与 stage 10 banner。

- [ ] **Step 1: 写失败 CLI test `treats_compact_as_a_command_not_a_submission`**

在没有 eligible prefix 的新 session 输入：

```text
/compact
/exit
```

断言：

- provider request 数为 0；
- journal 中没有 submission/compaction；
- stdout 含 `nothing to compact`；
- banner 为 `mini-agent (stage 10)`。

- [ ] **Step 2: 写失败 CLI test `passes_a_valid_context_window_and_rejects_invalid_values`**

扩展 `runCli()` 可覆盖 env：

- `ANTHROPIC_CONTEXT_WINDOW=256000` 能正常启动；
- `0`、负数、小数、非数字明确失败并提到变量名；
- 未设置时使用 `128000`，现有 CLI 场景不改变。

- [ ] **Step 3: 运行 CLI selectors 确认失败**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic-cli.test.ts -t "compact|context window"
```

Expected: FAIL，CLI 尚未识别命令/配置。

- [ ] **Step 4: 实现 CLI composition**

在创建 session options 前解析 context window；输入循环中 `/compact` 必须早于普通 `submit()` 分支：

```text
/exit    → 退出
/compact → await session.compact(); 打印结果；不生成 requestId
blank    → no-op
other    → submit
```

compaction 事件本阶段不输出摘要正文，只打印手动命令结果，避免把可能敏感的摘要重复写到终端。

- [ ] **Step 5: 运行完整 CLI/provider tests 与 checks**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic-cli.test.ts anthropic.test.ts anthropic-stream.test.ts
pnpm --filter @mini-agent/ai run check
pnpm --filter @mini-agent/cli run check
```

Expected: PASS。

- [ ] **Step 6: 提交 Task 6**

```bash
git add packages/cli/src/index.ts packages/ai/test/anthropic-cli.test.ts
git commit -m "feat(stage-10): expose manual compaction in the cli" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: 写阶段文档并完成整体验收

**Files:**
- Create: `docs/stages/10-context-compaction.md`
- Modify only if verification exposes a Stage 10 regression: directly owning source/test files

**Interfaces:**
- Consumes: Tasks 1–6 的最终行为。
- Produces: 阶段 10 学习主文档与可复现验收证据。

- [ ] **Step 1: 写 `docs/stages/10-context-compaction.md`**

沿用阶段 9 结构，必须覆盖：

1. 这个阶段解决了什么问题；
2. Pi 的答案：entry 不删除、summary + first-kept 投影；
3. threshold / cut point / usage 校准；
4. 为什么 toolCall 与 toolResult 不能切开；
5. 单独 summary request 与失败规则；
6. manual / threshold / overflow 三条路径；
7. overflow 为什么只能 retry 一次；
8. branch 到压缩前后的差异；
9. 替代方案为什么更差；
10. 决策点回测；
11. 实际源码成本与任何预算偏差。

- [ ] **Step 2: 运行阶段 10 targeted acceptance**

Run:

```bash
pnpm --filter @mini-agent/core test -- compaction.test.ts session-context.test.ts agent-session.test.ts agent-loop.test.ts
pnpm --filter @mini-agent/ai test -- anthropic.test.ts anthropic-stream.test.ts anthropic-cli.test.ts
```

Expected:

- threshold 边界、切点、append-only、projection、manual、overflow 单次 retry 全部 PASS；
- existing stage 7–9 provider/session/CLI tests 仍 PASS。

- [ ] **Step 3: 运行全工作区验证**

Run:

```bash
pnpm test
pnpm check
```

Expected: 全工作区测试与 AI/Core/CLI type-check PASS。

- [ ] **Step 4: 检查阶段边界与源码预算**

Run:

```bash
git --no-pager diff --stat master...HEAD
git --no-pager diff --name-only master...HEAD
wc -l packages/core/src/compaction.ts packages/core/src/session-context.ts \
  packages/ai/src/anthropic-error.ts
rg -n "ExtensionAPI|WebSocket|subagent|follow.?up" packages/core/src packages/ai/src packages/cli/src
```

Expected:

- 只有阶段 10 直接相关文件；
- 无阶段 11–13 提前实现；
- 若源码明显超过约 380 行，阶段文档记录原因和保留/拆分决定，不能删除错误边界凑数字。

- [ ] **Step 5: 检查工作区与提交阶段文档**

Run:

```bash
git --no-pager status --short
git add docs/stages/10-context-compaction.md
git commit -m "docs(stage-10): explain append-only context compaction" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git --no-pager status --short
```

Expected: commit 成功，工作区干净。
