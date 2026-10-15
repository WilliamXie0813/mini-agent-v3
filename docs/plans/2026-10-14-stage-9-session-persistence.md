# 阶段 9「会话持久化」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 append-only JSONL journal 持久化完整 agent 会话，支持进程重启后的继续对话、同文件分支、幂等提交，以及 safe/unsafe 工具的崩溃恢复。

**Architecture:** 新增 `SessionJournal` 负责持久化 header、树形 entries 与 durable append；新增 `AgentSession` 包装 `Agent`，在 awaited 生命周期事件中写入 transcript、工具输出和 run 边界，并以 `requestId` 去重。工具执行链新增一个 prepare 后、execute 前的 awaited `commitToolIntent` 缝，恢复时先把未完成工具规范化成一个完整 turn 边界，再把会话交还 CLI。

**Tech Stack:** Node 22+ `node:fs/promises` / `crypto.randomUUID()` / child processes、TypeScript 5.9.3（strict + erasableSyntaxOnly）、pnpm workspaces、vitest 3、JSON Lines。零新增运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 9、§3.2(b)、§3.2(c)、§7.1–7.4；前置能力见 `docs/stages/08-system-prompt-history.md`。

## Global Constraints

- **只加一个新概念**：JSONL session journal + tree + replay recovery。不得提前实现阶段 10 的 compaction、阶段 11 的 ExtensionAPI、阶段 12 的 WebSocket replay 或阶段 13 的子 agent/双队列。
- **先写测试，再写实现**；阶段结束时 `pnpm test` 与 `pnpm check` 全绿。
- 阶段源码净增量目标约 400 行；新增文件保持职责单一并尽量 <200 行。现有 `agent.ts` 已在阶段 8 经用户允许超过 200 行，本阶段不为满足数字做无关重构。
- 零新增运行时依赖；JSONL、UUID、目录遍历、fsync 与 child-process 验收全部使用 Node 标准库。
- tab 缩进；ESM；包内相对导入带 `.ts` 后缀；跨包用包名；类型导入用 `import type`。
- `strict: true`、`erasableSyntaxOnly: true`；禁止 `enum`、构造函数参数属性与 `namespace`。
- 默认存储目录固定为 `.mini-agent/sessions/`；测试可注入临时目录。该目录已由 `.gitignore` 的 `.mini-agent/` 规则覆盖。
- 文件名固定为 `<epochMs>_<sessionId>.jsonl`。首行必须是 `SessionHeader`，其余每行恰好一个 `SessionEntry`。
- `SessionHeader.version` 固定为 `1`；未知 version 明确拒绝，不能猜测兼容。
- 每次 append 写完整 JSON + `\n`，等待 `FileHandle.sync()` 后才算 committed。不得通过重写、截断、rename 全文件或修改旧行“修正”历史。
- loader 只容忍**文件末尾没有换行的一条残缺 JSON fragment**（进程在 append 中被杀）；中间坏行、以换行结尾的坏 JSON、重复 entry id、缺失 parent 都明确报错。
- entry 的 `id` / `parentId` 组成树；物理行顺序是 append 时间，不等于当前分支的祖先顺序。`leafId` 只存在于内存，默认取最后一条有效 entry。
- `branch(fromId)` 只把内存 `leafId` 移到既有 entry，不写新行、不建新文件；下一次 append 以 `fromId` 为 parent。阶段 9 不实现 `/fork` 新文件命令或交互式树选择器。
- `requestId` 在整个 session 文件内全局幂等，包括其他分支、重启后与同进程并发调用；重复 id 返回原 `submission`，不重复写、不重复调模型。
- **先 commit intent，再 execute**：只有通过 unknown/schema/beforeToolCall/abort prepare 后、真正即将执行的工具才写 `tool_intent`；immediate error 不伪造执行意图。
- parallel batch 必须先按源顺序完成全部 prepare + intent commits，再启动任何 execute。任一 commit 失败时，本批 prepared tools 的 execute 次数为 0。
- `ToolDef.replay` 缺省 `"unsafe"`；当前内置 `read` 是 `"safe"`，`edit` / `bash` 是 `"unsafe"`。
- 恢复对外只承诺**级别 2：完整 turn 边界**。journal 会记录 intent/update/outcome 以解决副作用不确定性，但不会暴露任意 step checkpoint、自动恢复 provider 生成或完整 task graph。
- session open 在返回前处理未完成工具：safe intent 可重跑；unsafe/missing/mismatched tool 生成 `interrupted` error result；已 committed outcome 但未写 transcript message 时只补 message，绝不重跑。
- unsafe interrupted result 保留已 committed `tool_update` content，再追加明确的 interruption 文本；不能把未知副作用伪装成“未执行”或自动成功。
- 恢复完成后不自动再次请求模型。它把 transcript 修复到 assistant toolCall + source-ordered toolResult 的 turn 边界，下一次用户 submit 再进入模型。
- session JSON 不写 API key、HTTP headers、StreamFn、execute 闭包或任意不可序列化运行时对象；工具历史只含 model-visible declarations 与 JSON-safe args/results。
- CLI 只新增 `--continue`；无该参数时创建新 session，有该参数时打开当前 cwd 下最新 session。未知参数与无可继续 session 都明确报错。
- 本计划与后续实现基于分支 `stage-9-session-persistence`，其起点必须保持为 `origin/master` 的 `dca4381` 或该提交的后继。

## Review Focus

1. **崩溃窗口不只一种**：intent 后无 outcome 要按 replay 恢复；outcome 已 durable 但 toolResult message 未 durable 时只补 message，不能重复执行。→ Task 5。
2. **并发/重启后的 requestId 重复**：两个同 id submit 与 reopen 后再次 submit 都只能产生一条 submission、一次模型运行。→ Tasks 3–4。
3. **树路径与物理行分离**：branch 后新 entries 的 parent 必须指向早期节点，旧后代仍留在文件；resume 只重建当前 leaf 的祖先路径。→ Task 4。
4. **journal 尾部损坏边界**：单个无换行 torn tail 可忽略；中间损坏、完整坏行、缺 parent、重复 id/version 错误必须拒绝。→ Task 1。
5. **持久化失败不能晚于副作用**：intent append/fsync reject 时 execute 为 0；update/outcome append reject 原样失败，留下可恢复 intent，不能返回成功形状。→ Tasks 2、3。

---

## 1. 锁定的数据模型与文件职责

### 1.1 JSONL schema

`packages/core/src/session-types.ts` 固定导出：

```ts
export const SESSION_VERSION = 1;

export interface SessionHeader {
	type: "session";
	version: 1;
	id: string;
	createdAt: string;
}

export interface SessionEntryBase {
	id: string;
	parentId: string | null;
	createdAt: string;
}

export type SessionEntryData =
	| { type: "message"; message: Message; intentId?: string }
	| { type: "submission"; requestId: string; prompt: string }
	| {
			type: "tool_intent";
			submissionId: string;
			assistantEntryId: string;
			toolCallId: string;
			tool: Tool;
			args: Record<string, unknown>;
			replay: "safe" | "unsafe";
			sourceIndex: number;
	  }
	| { type: "tool_update"; intentId: string; partialResult: ToolResult }
	| {
			type: "tool_outcome";
			intentId: string;
			result: ToolResult;
			isError: boolean;
			durationMs?: number;
	  }
	| {
			type: "run_end";
			submissionId: string;
			status: "completed" | "error" | "aborted" | "interrupted";
	  };

export type SessionEntry = SessionEntryBase & SessionEntryData;
export type SessionEntryOf<TType extends SessionEntryData["type"]> =
	SessionEntryBase & Extract<SessionEntryData, { type: TType }>;
```

约定：

- `submission` 自身重建一条 user text message，因此正常 user `message_end` 不再重复写 `message` entry。
- assistant/system/toolResult 通过 `message` entry 重建 transcript。
- prepared tool 的 `tool_intent` 用 `assistantEntryId + sourceIndex + intentId` 消除跨 turn 重用 toolCallId 的歧义。
- intent 中的 `tool` 只保存 model-visible declaration；恢复时用它检测同名工具 description/schema 是否已变化。
- `tool_update` / `tool_outcome` 是 recovery metadata；正常 transcript 顺序仍以 source-ordered `message` entries 为准。
- `run_end` 标记 submission 已收敛；恢复完成的 crash run 写 `"interrupted"`。

### 1.2 文件结构

| 文件 | 职责 |
|---|---|
| Create `packages/core/src/session-types.ts` | JSON-safe header/entry/public option 类型 |
| Create `packages/core/src/session-journal.ts` | durable append、load/validate、leaf/path/branch、latest file |
| Create `packages/core/src/agent-session.ts` | Agent 包装、submit 幂等、事件持久化、公开 session API |
| Create `packages/core/src/session-recovery.ts` | active path 扫描、pending tool 恢复、source-order 补结果 |
| Modify `packages/core/src/tool.ts` | `CommitToolIntentContext` / `CommitToolIntent` |
| Modify tool execution/Agent wiring files | 在 prepare 与 execute 之间 await intent commit |
| Modify `packages/cli/src/index.ts` | 新 session / `--continue` 组装与 requestId |
| Create core session tests + process fixture | journal/tree/session/recovery/kill 验收 |
| Create `docs/stages/09-session-persistence.md` | 学习主文档 |

### 1.3 公共接口

```ts
// session-journal.ts
export class SessionJournal {
	static create(directory: string): Promise<SessionJournal>;
	static open(path: string): Promise<SessionJournal>;
	static findLatest(directory: string): Promise<string>;

	readonly header: SessionHeader;
	readonly path: string;
	readonly entries: readonly SessionEntry[];
	get leafId(): string | null;

	append<TData extends SessionEntryData>(
		data: TData,
	): Promise<SessionEntryBase & TData>;
	branch(fromId: string): void;
	pathTo(id?: string | null): SessionEntry[];
}

// tool.ts
export interface CommitToolIntentContext {
	assistantMessage: AssistantMessage;
	toolCall: ToolCall;
	tool: ToolDef<any>;
	args: Record<string, unknown>;
	sourceIndex: number;
}
export type CommitToolIntent = (
	context: CommitToolIntentContext,
) => void | Promise<void>;

// agent-session.ts
export type AgentSessionOptions = Omit<
	AgentOptions,
	"messages" | "commitToolIntent"
> & {
	directory?: string;
};

export type OpenAgentSessionOptions = AgentSessionOptions & {
	path: string;
};

export class AgentSession {
	static create(options: AgentSessionOptions): Promise<AgentSession>;
	static open(options: OpenAgentSessionOptions): Promise<AgentSession>;
	static openLatest(options: AgentSessionOptions): Promise<AgentSession>;

	get sessionId(): string;
	get filePath(): string;
	get leafId(): string | null;
	get entries(): readonly SessionEntry[];
	get state(): Readonly<AgentState>;

	subscribe(listener: AgentEventListener): () => void;
	submit(
		input: { requestId: string; prompt: string },
	): Promise<SessionEntryOf<"submission">>;
	branch(fromId: string): void;
	appendSystemSections(sections: readonly SystemSection[]): Promise<void>;
	setTools(tools: ToolDef<any>[]): Promise<void>;
	abort(): void;
	waitForIdle(): Promise<void>;
}
```

`submit()` 返回 narrowed `SessionEntryOf<"submission">`；若 requestId 已存在，返回同一 entry id。`AgentSession` 不公开底层 `Agent`，避免调用方绕过 journal 直接 `prompt()` / `setTools()`。

---

### Task 1: 实现 durable JSONL journal 与树路径

**Files:**
- Create: `packages/core/src/session-types.ts`
- Create: `packages/core/src/session-journal.ts`
- Create: `packages/core/test/session-journal.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `SessionHeader`、`SessionEntry`、`SessionEntryData`、`SessionEntryOf<TType>`、`SessionJournal`。
- Consumers: Tasks 3–5。

- [ ] **Step 1: 写失败测试 `creates_versioned_session_and_appends_without_rewriting_old_bytes`**

在真实临时目录创建 journal：

```ts
const journal = await SessionJournal.create(directory);
const initial = await readFile(journal.path, "utf8");
const first = await journal.append({
	type: "submission",
	requestId: "req-1",
	prompt: "hello",
});
const afterFirst = await readFile(journal.path, "utf8");
const second = await journal.append({
	type: "run_end",
	submissionId: first.id,
	status: "completed",
});
const afterSecond = await readFile(journal.path, "utf8");

expect(JSON.parse(initial.trim())).toMatchObject({
	type: "session",
	version: 1,
	id: expect.any(String),
});
expect(afterFirst.startsWith(initial)).toBe(true);
expect(afterSecond.startsWith(afterFirst)).toBe(true);
expect(second.parentId).toBe(first.id);
```

同时断言文件名匹配 `/^\d+_[0-9a-f-]+\.jsonl$/`，每一完整行可独立 `JSON.parse`。

- [ ] **Step 2: 写失败测试 `branches_by_parent_pointer_without_touching_existing_bytes`**

append `a → b → c`，保存 bytes；调用 `journal.branch(a.id)` 后：

- 文件 bytes 不变；
- `leafId === a.id`；
- 下一条 `d.parentId === a.id`；
- `pathTo(c.id)` 为 `[a,b,c]`，`pathTo(d.id)` 为 `[a,d]`；
- 物理 `entries` 同时含 `[a,b,c,d]`。

未知 id 应抛 `/unknown session entry/i`，且 leaf/文件不变。

- [ ] **Step 3: 写失败测试 `loads_valid_prefix_and_rejects_structural_corruption`**

覆盖：

1. 正常 reopen：header、entries、last valid entry leaf 保持；
2. 文件最后追加 `{"type":` 且**无换行** → 忽略 torn tail，旧 entries 可用；
3. 同样坏 JSON 后有 `\n` → reject；
4. 中间坏行 → reject；
5. version `2` → reject；
6. 重复 entry id → reject；
7. parentId 指向不存在/后续 entry → reject。

- [ ] **Step 4: 写失败测试 `serializes_concurrent_appends_and_rejects_non_json_values`**

并发 `Promise.all` append 20 条，断言文件仍是 20 条完整 entry、parent 链线性且无重复 id。包含 `BigInt` 或循环引用的数据 append 应 reject，文件 bytes 与 `entries` 不变。

- [ ] **Step 5: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/core test -- session-journal
```

Expected: session 模块不存在而 FAIL。

- [ ] **Step 6: 实现 SessionJournal**

实现要求：

- `create()` 使用 `mkdir({ recursive:true })`，header 用 `"wx"` 创建，写完 `sync()`；
- `append()` 通过内部 promise tail 串行化；先 `JSON.stringify`，再 `open("a") → write → sync → close`，durable 成功后才更新内存 entries/leaf；
- `open()` 读取行并执行 Step 3 的校验；
- parent 只能为 `null` 或前面已出现的 id，由此树天然无环；
- `pathTo()` 从 leaf 反向跟 parent 后 reverse，保留 metadata entries；
- `findLatest()` 只考虑 `*.jsonl`，按文件名倒序取最新；目录不存在/为空时抛具名错误。

- [ ] **Step 7: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/core test -- session-journal
pnpm --filter @mini-agent/core check
```

Expected: PASS。

Commit:

```bash
git add packages/core/src/session-types.ts \
  packages/core/src/session-journal.ts packages/core/src/index.ts \
  packages/core/test/session-journal.test.ts
git commit -m "feat(stage-9): add durable append-only session journal"
```

---

### Task 2: 在 prepare 与 execute 之间加入 durable intent hook

**Files:**
- Modify: `packages/core/src/tool.ts`
- Modify: `packages/core/src/execute-tool-calls.ts`
- Modify: `packages/core/src/execute-tool-calls-parallel.ts`
- Modify: `packages/core/src/agent-options.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/execute-tool-calls.test.ts`
- Modify: `packages/core/test/agent.test.ts`

**Interfaces:**
- Consumes: 既有三段式 prepare/execute/finalize。
- Produces: `CommitToolIntentContext` / `CommitToolIntent`；`AgentOptions`、`AgentLoopOptions`、`ExecuteToolCallsOptions` 的可选 `commitToolIntent`。

- [ ] **Step 1: 写失败测试 `commits_after_prepare_and_before_execute_in_sequential_mode`**

用 beforeToolCall、commit hook、execute 各 push 标记：

```ts
expect(order).toEqual([
	"before:c1",
	"commit:c1",
	"execute:c1",
	"end:c1",
]);
```

commit context 精确断言：validated args、ToolDef、assistant message、toolCall 与 `sourceIndex: 0`。unknown/schema-invalid/blocked/aborted immediate outcome 的 commit 次数必须为 0。

- [ ] **Step 2: 写失败测试 `commits_every_parallel_intent_before_any_execute`**

三个 parallel tools，断言：

```ts
expect(order.slice(0, 3)).toEqual([
	"commit:c1",
	"commit:c2",
	"commit:c3",
]);
expect(order.findIndex((value) => value.startsWith("execute:")))
	.toBeGreaterThan(2);
```

sourceIndex 分别为 0/1/2。commit #2 reject 时三个 execute spy 全为 0；错误原样 reject，不生成 success-shaped batch。

- [ ] **Step 3: 写 Agent 接线失败测试**

通过 `new Agent({ commitToolIntent })` 跑一次工具调用，断言 hook 在 execute 前被 await。hook 用 deferred gate 阻塞时，工具未开始且 `agent.state.isStreaming === true`；释放后 run 正常收敛。

- [ ] **Step 4: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/core test -- execute-tool-calls agent
```

Expected: 新 hook 类型/字段不存在或 execute 提前发生而 FAIL。

- [ ] **Step 5: 实现 hook**

规则：

- 只对 `PreparedToolCall` 调用；
- sequential path：prepare → await commit → execute；
- parallel path：phase 1 按源顺序 prepare + await commit + 存 thunk，phase 2 才 `Promise.allSettled`；
- `tool.replay ?? "unsafe"` 不在 core hook内改写；Session consumer 从 context.tool 读取；
- hook failure 属于持久化基础设施失败，不转成 model-fixable toolResult。

- [ ] **Step 6: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/core test -- execute-tool-calls agent
pnpm --filter @mini-agent/core check
```

Expected: PASS，Stage 5/6 的 prepare 串行、end 完成顺序、message 源顺序保持。

Commit:

```bash
git add packages/core/src/tool.ts packages/core/src/execute-tool-calls.ts \
  packages/core/src/execute-tool-calls-parallel.ts \
  packages/core/src/agent-options.ts packages/core/src/agent-loop.ts \
  packages/core/src/agent.ts packages/core/src/index.ts \
  packages/core/test/execute-tool-calls.test.ts \
  packages/core/test/agent.test.ts
git commit -m "feat(stage-9): commit tool intents before execution"
```

---

### Task 3: 实现 AgentSession、事件持久化与幂等 submit

**Files:**
- Create: `packages/core/src/agent-session.ts`
- Create: `packages/core/test/agent-session.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–2 的 journal 与 commit hook。
- Produces: `AgentSession.create()`、normal-run persistence、`submit()`、session event proxy、system/tool wrappers。

- [ ] **Step 1: 写失败测试 `persists_a_complete_run_in_reconstructable_order`**

创建 fake provider 的一轮 text response，调用：

```ts
const session = await AgentSession.create({
	directory,
	system: "test",
	tools: [],
	streamFn: createFakeStreamFn(["hello"]),
});
const submission = await session.submit({
	requestId: "req-1",
	prompt: "hi",
});
```

断言 active path 的语义顺序：

```text
message(system)
submission(user "hi")
message(assistant "hello")
run_end(completed)
```

重新读取 JSONL，submission id 与返回值相同；`session.state.messages` 为 `[system,user,assistant]`；旧文件 bytes 是新文件 bytes 的前缀。

- [ ] **Step 2: 写失败测试 `persists_tool_intent_updates_outcome_and_source_ordered_messages`**

provider 返回两个 toolCall，c2 先完成。工具 c1 发两次 update。断言：

- assistant `message` entry 先于两个 `tool_intent`；
- intent sourceIndex 为 0/1，且都先于任一 execute marker；
- `tool_outcome` 物理顺序可为 c2/c1；
- toolResult `message` entries 仍为 c1/c2；
- update entries 都引用 c1 intentId；
- run_end 最后。

在 external session listener 收到 assistant `message_end`、`tool_execution_update`、`tool_execution_end` 与 toolResult `message_end` 时读取文件，证明对应内部 entry 已先 durable；`tool_execution_start` 只表示 UI 生命周期开始，不错误宣称 intent 已 commit。external listener reject 仍原样让 submit reject。

另用测试工具分别在 partial update 与 final result 中返回不可 JSON 序列化值（测试内窄化/强转即可）：submit 必须 reject，不能写 success run_end；intent 已 durable，execute 已发生的事实由后续 recovery 处理，不能回滚或伪装成功。

- [ ] **Step 3: 写失败测试 `deduplicates_same_request_id_in_memory_and_after_reopen_indexing`**

同进程并发：

```ts
const [left, right] = await Promise.all([
	session.submit({ requestId: "same", prompt: "one" }),
	session.submit({ requestId: "same", prompt: "one" }),
]);
expect(left.id).toBe(right.id);
expect(provider).toHaveBeenCalledTimes(1);
```

本任务先验证 persisted index 可从 `entries` 构建：再次调用同 id 返回原 entry、无新增行。真正 `AgentSession.open()` 后的重复在 Task 4 复现。

空 requestId、空白 prompt 在写 journal 前 reject。

- [ ] **Step 4: 写失败测试 `journals_system_and_tool_changes_through_session_wrappers`**

`await session.appendSystemSections(...)` 与 `await session.setTools(...)` 后：

- Agent state 增加的最后一条 SystemMessage 与 journal message entry 深度相等；
- 相同 tool declarations 不新增 entry；
- active run 期间两个方法 reject，journal/state 不变；
- journal append reject 时底层 Agent state/registry 不先变化；
- caller 后续修改输入 arrays/objects 不改变 journal。

- [ ] **Step 5: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-session
```

Expected: `AgentSession` 不存在而 FAIL。

- [ ] **Step 6: 实现 AgentSession normal path**

内部规则：

- `create()` 先建 journal，再构造 Agent；把 Agent 初始 system messages 逐条写为 root `message` entries；
- Session 自己维护 listener set；底层 Agent 只装一个 internal listener，先 await journal，再按注册顺序 await external listeners；
- `submit()` 在调用 Agent 前 durable append submission，建立 in-flight/request index，设置 active submission；
- user `message_end` 不写第二份 entry；
- assistant/toolResult `message_end` 写 message entry；assistant entry id 供 intent hook 使用；
- commit hook 复制 model-visible tool declaration，durable append `tool_intent`，再建立 active toolCallId → intent entry 映射；
- update/end 事件只在有 prepared intent 时写 metadata；immediate outcomes 由 source-ordered toolResult message entry 表达；
- agent_end 写 run_end：最后一条 assistant 为 error/aborted 时对应状态，否则（包括 terminate 后以 toolResult 结束）为 completed；
- `appendSystemSections` / model-visible `setTools` 变化先 durable append 对应 SystemMessage，再改变底层 Agent state；相同 declarations 只更新执行注册表，不写 entry；
- journal failure 原样冒泡；submission 已 committed 时不删除/回滚。

- [ ] **Step 7: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-session
pnpm --filter @mini-agent/core check
```

Expected: PASS。

Commit:

```bash
git add packages/core/src/agent-session.ts packages/core/src/index.ts \
  packages/core/test/agent-session.test.ts
git commit -m "feat(stage-9): persist agent runs with idempotent submissions"
```

---

### Task 4: 支持 reopen、祖先路径重建与原地 branch

**Files:**
- Modify: `packages/core/src/agent-session.ts`
- Modify: `packages/core/test/agent-session.test.ts`

**Interfaces:**
- Produces: `AgentSession.open()`、`openLatest()`、`branch()`。
- Consumes: `SessionJournal.pathTo()` 与已有 transcript replay。

- [ ] **Step 1: 写失败测试 `reopens_the_leaf_path_and_continues_with_full_history`**

创建 session、submit 两轮、记录 file path，重新：

```ts
const resumed = await AgentSession.open({
	path: session.filePath,
	system: "ignored because transcript has system",
	tools,
	streamFn: createFakeStreamFn(["third"]),
});
```

断言恢复 state 与关闭前完全相同；第三次 submit 后 provider context 包含前两轮 + 新 user，文件继续 append，未重写旧 bytes。

`openLatest({ directory })` 必须选同一路径；空目录抛具名错误。

- [ ] **Step 2: 写失败测试 `branches_from_an_earlier_entry_without_erasing_old_descendants`**

流程：

1. submit `one`，记录 `firstLeaf`；
2. submit `old branch`，记录 `oldLeaf` 与 bytes；
3. `session.branch(firstLeaf)`；
4. submit `new branch`，记录 `newLeaf`。

断言：

- branch 调用本身不改 bytes；
- 新 submission.parentId === firstLeaf；
- 文件仍含 oldLeaf 与 newLeaf；
- current state 含 `one + new branch`，不含 `old branch`；
- `journal.pathTo(oldLeaf)` 与 `pathTo(newLeaf)` 共享前缀后分叉；
- reopen 默认使用物理最后 entry 的 new branch。

- [ ] **Step 3: 写 branch 防护与 requestId 全文件幂等测试**

- unknown id → reject/throw，state/file/leaf 不变；
- active run 中 branch → reject；
- branch 到旧节点后再次 submit 一个旧分支已用的 requestId → 返回原 submission，不在新分支重复执行；
- branch 后 external subscribers 仍能收到新底层 Agent 的事件，unsubscribe 仍有效。

- [ ] **Step 4: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-session
```

Expected: open/branch 接口不存在或 state 仍含错误分支而 FAIL。

- [ ] **Step 5: 实现重建与 Agent 替换**

`messagesFromPath()` 的唯一映射：

- `submission` → `{ role:"user", content:[{type:"text", text:prompt}] }`；
- `message` → entry.message；
- intent/update/outcome/run_end → 不直接进入 transcript。

`branch()` 与 `open()` 都用 active path 重建 messages，并创建新 Agent；session 自己持有 external listeners，所以替换 Agent 后订阅关系不丢。`branch()` 只允许 idle。

- [ ] **Step 6: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/core test -- agent-session
pnpm --filter @mini-agent/core check
```

Expected: PASS。

Commit:

```bash
git add packages/core/src/agent-session.ts \
  packages/core/test/agent-session.test.ts
git commit -m "feat(stage-9): reopen and branch session history"
```

---

### Task 5: 恢复 interrupted tools，并用真实进程 kill 验证

**Files:**
- Create: `packages/core/src/session-recovery.ts`
- Create: `packages/core/test/session-recovery.test.ts`
- Create: `packages/core/test/session-process.test.ts`
- Create: `packages/core/test/fixtures/session-process.ts`
- Modify: `packages/core/src/agent-session.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: active path 的 assistant message、intent/update/outcome/message entries 与 ToolDef registry。
- Produces:

```ts
export async function recoverInterruptedTools(
	journal: SessionJournal,
	tools: readonly ToolDef<any>[],
): Promise<void>;
```

`AgentSession.open()` / `openLatest()` 必须在构造 Agent 前调用它，然后重新读取 active path messages。

- [ ] **Step 1: 写失败测试 `replays_safe_intent_and_preserves_updates`**

手工构造 active path：

```text
submission
message(assistant toolCall read c1)
tool_intent(c1, replay:safe, args)
tool_update(c1, "partial")
```

当前 read ToolDef `replay:"safe"`。调用 recovery 后断言：

- execute 恰一次，args 与 intent 一致；
- 新 update/outcome/message 按 durable 顺序 append；
- toolResult message source position对应 c1，包含最终结果；
- 再调用 recovery execute 不再发生（幂等）。

- [ ] **Step 2: 写失败测试 `turns_unsafe_pending_intent_into_interrupted_result`**

unsafe edit/bash intent 无 outcome，已有两个 partial updates。断言 execute 为 0；生成的 toolResult：

```ts
{
	role: "toolResult",
	toolCallId: "c1",
	toolName: "edit",
	isError: true,
	content: [
		...committedPartialContent,
		{ type: "text", text: expect.stringMatching(/interrupted.*unsafe/i) },
	],
}
```

同时 append synthetic `tool_outcome` 与 source-ordered message。tool 缺失、当前声明与 intent.tool 不相等、当前不再 safe、intent 默认 unsafe 都走此路径。

- [ ] **Step 3: 写失败测试 `does_not_reexecute_a_committed_outcome_missing_only_its_message`**

active path 有 intent + outcome，但没有对应 message（crash 发生在 `tool_execution_end` journal 后、`message_end` 前）。recovery 只从 outcome 补 toolResult message；execute spy 为 0。

覆盖两个并行 calls：outcome 物理完成顺序 `[c2,c1]`，补进 transcript 的 message 顺序必须按 assistant content `[c1,c2]`。

同组再覆盖：final assistant message 已 durable、只缺 `run_end` 时，recovery 仅按 stopReason 补 `completed` / `error` / `aborted` run_end，不追加消息、不调用工具。

- [ ] **Step 4: 写失败测试 `closes_uncommitted_tool_calls_without_claiming_execution`**

assistant 已 durable，但某个 toolCall 没有 intent/result，表示 crash 在 durable execute boundary 前。生成 isError toolResult，文本说明没有到达 committed execute boundary；不执行 unsafe/safe tool。这样 open 后总在完整 turn 边界。

- [ ] **Step 5: 写真实进程 kill 测试**

`session-process.ts` 支持测试模式：

1. `completed-runs`：submit 两轮，打印 `{ ready, path }` 后保持进程；
2. `resume`：open path，输出 recovered roles/text，再 submit 第三轮；
3. `tool-crash-safe` / `tool-crash-unsafe`：工具进入 execute 后写计数/partial marker、打印 ready、永久等待；
4. `recover-safe` / `recover-unsafe`：open 同一 path 并输出执行计数与 recovered toolResult。

父测试用 `spawn(process.execPath, ["--experimental-strip-types", fixture, ...])`，等 ready 后对**具体 child PID**调用 `child.kill("SIGKILL")`。断言：

- completed 两轮 kill 后 resume 历史完整并能第三轮；
- safe tool 计数从 1 变 2；
- unsafe tool 计数保持 1，result 含 partial + interrupted；
- 所有子进程/临时目录在 finally 精确清理。

- [ ] **Step 6: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/core test -- session-recovery session-process
```

Expected: recovery 模块/fixture 不存在而 FAIL。

- [ ] **Step 7: 实现 recovery**

算法按 assistant message 中 toolCall 源顺序处理：

1. 已有 source-ordered toolResult message → 跳过；
2. intent + outcome、缺 message → 从 outcome 补 message；
3. intent 无 outcome且 replay safe、当前同名 ToolDef 仍 safe、model-visible declaration 与 intent.tool 相等 → 用 committed args 调 `executePreparedToolCall`，update append 后写 outcome/message；
4. intent 无 outcome且不能 safe replay → 合并 committed updates + interrupted marker，写 synthetic outcome/message；
5. 无 intent → 写“未到 durable execute boundary”的 error message；
6. 若 transcript 已有 final assistant 但缺 run_end，只按其 stopReason 补 completed/error/aborted，不执行任何工具；
7. 完成 pending tool 缺口后，为未结束 submission append `run_end(interrupted)`。

safe replay 不重新跑 beforeToolCall/schema：intent 能存在就证明原 prepare 已成功。任何 recovery append 失败都让 open reject，不暴露半恢复 session。

- [ ] **Step 8: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/core test -- session-recovery session-process
pnpm --filter @mini-agent/core test
pnpm --filter @mini-agent/core check
```

Expected: PASS。

Commit:

```bash
git add packages/core/src/session-recovery.ts \
  packages/core/src/agent-session.ts packages/core/src/index.ts \
  packages/core/test/session-recovery.test.ts \
  packages/core/test/session-process.test.ts \
  packages/core/test/fixtures/session-process.ts
git commit -m "feat(stage-9): recover interrupted tool executions"
```

---

### Task 6: 接入 CLI `--continue`

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/ai/test/anthropic-cli.test.ts`

**Interfaces:**
- CLI 消费 `AgentSession.create/openLatest`；不直接构造或调用 `Agent.prompt()`。
- 每条终端输入使用 `randomUUID()` 生成 requestId。

- [ ] **Step 1: 扩展 CLI subprocess harness**

让 `runCli()` 接受：

- `args?: string[]`；
- 可复用的 `cwd`；
- 是否在结束后保留 temp cwd。

清理仍只删除测试创建的精确临时目录。现有 Stage 7/8 text/tool/error 用例必须保持。

- [ ] **Step 2: 写失败测试 `continues_the_latest_session_in_the_same_directory`**

第一次进程：

```text
prompt one
/exit
```

第二次同 cwd：

```bash
node .../cli/index.ts --continue
```

输入 `prompt two`。断言：

- banner 为 stage 9，并明确显示 resumed/session path；
- 第二次 HTTP request messages 包含第一进程的 user + assistant + 第二个 user；
- `.mini-agent/sessions` 只有一个 session 文件；
- 第二进程退出后文件旧 bytes 保持前缀。

- [ ] **Step 3: 写 CLI 参数错误测试**

- `--continue` 且没有 session → 非零退出，stderr 含 `no session`；
- 未知参数 → 非零退出并列出唯一支持的 `--continue`；
- 默认无参数创建新 session；
- API key/config failure 仍在明确边界失败，不退回 fake，不创建 success-shaped run。

- [ ] **Step 4: 跑测试确认红灯**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic-cli
```

Expected: CLI 仍是 stage 8 且不认识 `--continue`。

- [ ] **Step 5: 修改 CLI 组装**

规则：

- provider 与 tools 仍由 CLI 组装；
- `const session = continueFlag ? await AgentSession.openLatest(...) : await AgentSession.create(...)`；
- 事件渲染订阅 `session.subscribe`，SIGINT 调 `session.abort()`；
- readline 每行调用 `session.submit({ requestId: randomUUID(), prompt: line })`；
- banner 为 `mini-agent (stage 9)`，打印 session file path 与 created/resumed 状态；
- 不新增 `/branch`、`/fork` 或交互 session picker。

- [ ] **Step 6: 验证与提交**

Run:

```bash
pnpm --filter @mini-agent/ai test -- anthropic-cli
pnpm --filter @mini-agent/cli check
```

Expected: PASS。

Commit:

```bash
git add packages/cli/src/index.ts packages/ai/test/anthropic-cli.test.ts
git commit -m "feat(stage-9): resume the latest session from the CLI"
```

---

### Task 7: 阶段文档、全量验收与边界检查

**Files:**
- Create: `docs/stages/09-session-persistence.md`

**Interfaces:**
- Consumes: Tasks 1–6。
- Produces: 阶段 9 教学主文档；回测答案仍由用户先作答。

- [ ] **Step 1: 写阶段文档**

沿用既有四段结构：

1. **这个阶段解决了什么问题**：进程退出即丢历史，副作用工具在 crash 后“不知道做没做”；
2. **Pi 的哪条决策是答案**：append-only tree journal；intent commit 先于 execute；
3. **替代方案为什么更差**：
   - 每次覆盖一个 session.json；
   - execute 后再写 intent；
   - 所有 pending tools 自动重跑；
   - branch 复制/改写旧文件；
   - requestId 只做内存去重；
4. **决策点**：
   - 为什么 journal 只能 append？
   - commit/execute 顺序为什么不能反？
   - safe 与 unsafe 的边界是谁声明的？
   - branch 为什么只移动 leaf？
   - outcome 已写但 message 未写时为什么不能重跑？

明确级别 2 边界、torn-tail 策略、partial output 保留、`/fork` 未实现。

- [ ] **Step 2: 全量自动验收**

Run:

```bash
pnpm test
pnpm check
```

Expected: ai/core/cli 全绿。

- [ ] **Step 3: 结构与依赖检查**

Run:

```bash
pnpm list -r --depth 0 --prod
git grep -n 'writeFile\\|truncate\\|rename' -- packages/core/src/session-*.ts
git grep -n 'ANTHROPIC_API_KEY\\|x-api-key' -- packages/core/src/session-*.ts || true
git grep -n 'replay:' -- packages/core/src/tools.ts
wc -l packages/core/src/session-*.ts packages/core/src/agent-session.ts
git diff --numstat dca4381 -- 'packages/*/src/*.ts'
```

Expected:

- 无新增 registry 运行时依赖；
- session 文件实现不重写旧 JSONL（header 初建除外；append 使用 open/write/sync）；
- session 层不含凭据字段；
- read safe、edit/bash unsafe；
- 新文件职责清晰，阶段源码净增量约 400 行，超出时先检查重复与过早功能。

- [ ] **Step 4: 行为验收**

1. 两轮 → SIGKILL → `--continue` → 历史完整且可第三轮；
2. branch 后两条分支同文件共存；
3. safe pending intent 重跑，unsafe 不重跑并保留 partial；
4. outcome 已 commit 的工具不重复执行；
5. 同 requestId 并发/重启/跨 branch 都只执行一次；
6. 旧 bytes 永远是新文件前缀；
7. intent fsync 失败时 execute 为 0；
8. torn final fragment 可恢复，中间 corruption 明确失败。

- [ ] **Step 5: 提交阶段文档**

```bash
git add docs/stages/09-session-persistence.md
git commit -m "docs(stage-9): explain append-only recovery semantics"
```

每个 commit 结尾使用：

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

### Task 8: 交互式教学 HTML 与行为测试

**Files:**
- Create: `docs/stages/09-session-persistence-explained.html`
- Create: `packages/ai/test/session-persistence-teaching.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7 的 journal/tree/recovery 语义，沿用阶段 7/8 的 Node VM 教学脚本测试方式。
- Produces: 可离线打开的中文教学页；不新增 runtime API 或依赖。

- [ ] **Step 1: 先写并运行失败测试**

执行 HTML 内真实 JavaScript，验证 safe intent 重跑、unsafe 保留 partial 并中断、已有 outcome 仅补 message、branch 只改 leaf 后追加、intent commit 失败零执行、全 session requestId 去重，以及 scenario/timeline/prev/next/reset/jump-end 的交互。

Run: `pnpm --filter @mini-agent/ai exec vitest run test/session-persistence-teaching.test.ts`

Expected: 因教学页尚不存在而失败；测试预期使用手工推导的执行次数、parent 和结果内容。

- [ ] **Step 2: 实现教学页**

解释新增内容、替代方案、append-only、write/sync/execute 屏障、id/parentId 树与级别 2 恢复边界。模拟器展示 durable journal、active ancestor path、模型 transcript、工具执行次数；允许逐步导航与场景切换。明确模拟器不执行真实文件 I/O 或工具。

Run: `pnpm --filter @mini-agent/ai exec vitest run test/session-persistence-teaching.test.ts`

Expected: 所有教学行为测试通过。

- [ ] **Step 3: 完整验证并提交**

Run: `pnpm test && pnpm check`

Expected: 全工作区通过。

提交教学页、测试与本 Task 8 计划补充；message `docs(stage-9): add tested interactive persistence lesson`，附 Co-authored-by trailer。随后记录 task-done。

---

## 完成标准

- [ ] 新 session 写入 `.mini-agent/sessions/<timestamp>_<id>.jsonl`，header version=1。
- [ ] journal append 每次 write + fsync，旧 bytes 从不修改。
- [ ] entries 用 id/parentId 成树，branch 只移动 leaf，旧后代保留。
- [ ] active leaf path 能重建完整 SystemMessage/user/assistant/toolResult transcript。
- [ ] submit 在 append submission 后才调用 Agent；requestId 全 session 幂等。
- [ ] prepared tool 在 intent durable commit 后才 execute；parallel 全部 commit 后才启动。
- [ ] update/outcome/message/run_end 通过 awaited 持久化链写入。
- [ ] safe pending intent 可重跑；unsafe 生成 interrupted result 并保留 partial。
- [ ] outcome 已 durable、message 未 durable 的 crash 窗口不会重复执行。
- [ ] open 返回前把会话修复到完整 turn 边界，不自动请求模型。
- [ ] CLI 默认创建 session，`--continue` 打开 cwd 最新 session 并继续对话。
- [ ] 真实 child SIGKILL 测试覆盖已完成轮次与工具执行中断。
- [ ] `pnpm test` / `pnpm check` 全绿，零新增运行时依赖。
- [ ] `docs/stages/09-session-persistence.md` 完成并留下五个可追问决策点。

执行顺序为 Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7。Task 2 的 intent hook 是 Task 3/5 的正确性前提；Task 4 先建立 reopen/tree，再由 Task 5 补 crash recovery；不得并行实现相互依赖的 session 核心任务。
