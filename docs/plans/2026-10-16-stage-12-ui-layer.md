# 阶段 12「UI 层」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 core 内部实现的前提下，为真实 `AgentSession` 增加 localhost WebSocket 服务与 React 工作台，使 CLI 与 Web 共享同一套 core/provider/扩展装配，并支持流式消息、工具卡片、token 用量、压缩标记和断线后的 journal 重放。

**Architecture:** 新增 `packages/protocol`、`packages/server`、`packages/web`。`SessionHost` 长期持有一个 `AgentSession`，与 WebSocket 连接解耦：它把实时 `AgentEvent` 包成有序 JSON envelope，同时在每次连接时发送当前 journal 活跃祖先路径；若连接发生在一次 run/compact 中途，则 snapshot 停在操作开始前的 leaf，并附上该操作从开始到当前的瞬时事件，避免重复或缺口。React 只保存 raw snapshot 与 envelopes，再由纯 selector 派生 Chat、tool cards、usage 和 Timeline；不读取 `Agent.state`，不 import core/server。

**Tech Stack:** Node 22+、TypeScript 5.9.3（strict + erasableSyntaxOnly）、pnpm workspaces、vitest 3、React、Vite、Node HTTP、`ws`、Testing Library、jsdom。运行时依赖只允许新增在 `server` / `web`；`ai`、`core`、`extensions` 的依赖与源码保持不变。

**Spec:** 权威范围为 `docs/specs/2026-10-09-mini-agent-v3-design.md` §3.1、§3.2(c)、§5 阶段 12、§7.1–7.4。`docs/specs/2026-10-12-web-ui-v1-design.md` 仅作为已批准的 Light 三栏视觉/交互基线；其中 deterministic Demo、ephemeral session、阶段 6 基线和“不自动重连”被本计划的真实 provider、持久化 session、阶段 11 基线和 journal 重放覆盖。已批准的 `docs/specs/2026-10-23-stage-12-ui-visual-design.md` 进一步锁定 Quiet Observability 方向、React + Vite 技术栈与 Event Details modal；其范围边界优先于旧视觉基线。旧计划 `docs/plans/2026-10-12-web-ui-v1.md` 不用于阶段 12 执行。

## Global Constraints

- **只加一个新概念**：UI/transport 层。不得提前实现阶段 13 的 `steer` / `followUp`、双层 loop、`runToolCall` 独立入口、子 Agent 或 parent/child UI。
- 先写失败测试，再写最小实现；每个任务独立提交。阶段结束时 `pnpm test` 与 `pnpm check` 全绿。
- `packages/core/src/**`、`packages/ai/src/**`、`packages/extensions/src/**` 和 `packages/cli/src/**` 不修改。阶段 12 必须证明现有公共 API 已足够；若实现要求 deep import 或新增 core getter，先停下并修正计划，而不是穿透边界。
- CLI 保持现有 `pnpm dev`、`--continue`、`/compact`、扩展与 provider 行为。Web 是并列前端，不替换 CLI。
- 依赖方向固定：

  ```text
  web ──────> protocol
  server ───> protocol
  server ───> core ───> ai
  server ───> extensions
  protocol -- type-only --> core
  ```

- `web/src/**` 禁止 import `@mini-agent/core`、`@mini-agent/ai`、`@mini-agent/server` 或任意深层 workspace 路径。`protocol/src/**` 对 core 只能 `import type`；`server/src/**` 只能从 `@mini-agent/core`、`@mini-agent/ai`、`@mini-agent/extensions` 的包根导入。
- WebSocket 只用 JSON 文本消息，不实现 Pi experimental server 的 CBOR、RPC、插件协议或二进制帧。
- 服务只绑定 `127.0.0.1`；upgrade path 固定 `/agent`；浏览器 Origin 只允许 `localhost` / `127.0.0.1`；单条 client payload 上限 `64 KiB`。
- 所有 client command 必须经 runtime shape validation。非法 JSON、缺字段、空 prompt、未知 command、active run 冲突都返回具名 `protocol.error`；不得 crash server 或静默忽略。
- `SessionHost` 的生命周期独立于 socket。浏览器断开只 detach sink，**不得**调用 `session.abort()`；active run 继续并持久化，重连后由 snapshot 补齐。
- journal replay 必须沿 `leafId` 的 `parentId` 祖先链构造 active path，禁止把 `session.entries` 的物理追加顺序直接当当前会话。
- idle snapshot 包含当前完整 active path。若 `prompt.submit` 或 `session.compact` 正在运行，snapshot 的 `entries` 只能截止到该操作开始前的 leaf；本次操作全部由 `transientEvents` 表示。这样同一条 assistant/toolResult/compaction 不会同时从 journal 与 live event 出现两次。
- `AgentEventEnvelope.sequence` 在单次 server 进程内从 0 严格递增；`elapsedMs` 用 `performance.now()` 相对当前操作起点计算。客户端只按 sequence 排序，不使用消息到达时间。
- `SessionHost` 作为 `AgentSession` listener 时只做内存记录与非阻塞分发，不 await 网络 I/O。坏/慢 socket 不能给 Agent 施加 backpressure，也不能让 listener rejection 杀死 run；可靠性由 journal snapshot 补偿。
- `AgentSession` 已保证“内部持久化先于外部 listener”。server 不重复写 session、不复制恢复规则、不根据错误文本猜测状态。
- Web 的事实源只有 `SessionSnapshot.entries` 与 `AgentEventEnvelope[]`。Chat、tool cards、usage、Timeline、selected details 都是纯 selector；不得在组件里维护第二份业务状态。
- delta 只更新当前 assistant draft；只有 `message_end`/journal `message` 是完成消息。40 个 `message_update` 仍只能产生 1 条 assistant Chat message。
- tool cards 按 assistant `toolCall` block 的源顺序；Timeline 中 `tool_execution_end` 按 envelope sequence。不得用同一排序满足两者。
- token 用量只累计 `AssistantMessage.usage` 的 input/output/cache 计数。没有经验证的价格表，本阶段**不显示成本**、不把未知成本写成 0。
- compaction 只显示 reason、状态、tokensBefore、entry/boundary 标识等已有事实；不得在 UI 里重新摘要或删除历史。
- React 沿用已批准的 Light 三栏工作台与 Quiet Observability 方向；不加 Dark 主题、文件树、编辑器、diff、内嵌终端、session branch 选择器或扩展管理页。
- 阶段 12 不提供 Web 端 New session、历史 session 列表或 session 切换；新会话仍通过 server 启动参数控制。
- Event Details 使用按需 modal，右侧栏完整留给 Timeline；不得为了常显 details 而恢复固定底部面板。
- tab 缩进；ESM；包内相对导入带 `.ts` / `.tsx`；类型导入使用 `import type`。
- `strict: true`、`erasableSyntaxOnly: true`；禁止 `enum`、构造函数参数属性、`namespace`、`as any`。
- 每个 `src` 文件目标 < 200 行。超过时按协议、状态投影、组件职责拆分，不以大文件硬撑。
- 所有实施 commits 必须带：

  ```text
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```

- 执行时从阶段 11 完成点或其后继创建独立 `stage-12-ui-layer` 分支/工作树；不得覆盖当前工作区中与阶段 12 无关的教学文档和测试改动。

## Review Focus

1. **重连时重复或遗漏当前 run**：snapshot 若包含 active submission 的 journal entries，同时又重放该 run 的 AgentEvent，会出现重复消息；若只发 journal，又会丢正在流式增长的 partial。→ Tasks 2、3、4、6。
2. **socket 反向破坏 Agent 生命周期**：把 `ws.send`/client ack 作为 awaited listener 会让慢浏览器阻塞 `agent_end`，断开时 reject 还会杀死 run。→ Tasks 2、3。
3. **把物理 JSONL 行顺序当 active branch**：branch 后 snapshot 会混入旧分支 descendants，Web 展示的历史与下一次模型上下文不一致。→ Tasks 2、4。
4. **wire 边界失守**：malformed/oversized payload、非 localhost Origin、未知 protocol version 或浏览器误 import core runtime，都可能把本地教学服务变成脆弱边界。→ Tasks 1、3、6。
5. **视图破坏消息与工具顺序语义**：delta 被当成消息、parallel tool cards 按完成顺序重排、usage 重复累计、compaction live/replay 重复，都会让 UI 展示与 core 事实不一致。→ Tasks 4、5。

---

## 1. 锁定的协议与文件职责

### 1.1 Wire protocol（`packages/protocol/src/messages.ts`）

```ts
import type { AgentEvent, SessionEntry } from "@mini-agent/core";

export const PROTOCOL_VERSION = 1;

export type Capability =
	| "journal_replay"
	| "streaming_messages"
	| "tool_timeline"
	| "abort_run"
	| "manual_compaction"
	| "token_usage";

export interface AgentEventEnvelope {
	sessionId: string;
	sequence: number;
	elapsedMs: number;
	event: AgentEvent;
}

export interface SessionSnapshot {
	sessionId: string;
	leafId: string | null;
	status: "idle" | "running" | "compacting";
	entries: SessionEntry[]; // active path only
	transientEvents: AgentEventEnvelope[]; // current operation only
	latestSequence: number;
}

export type ClientCommand =
	| { type: "prompt.submit"; requestId: string; prompt: string }
	| { type: "run.abort"; requestId: string }
	| { type: "session.compact"; requestId: string };

export type CommandCompletion =
	| {
			command: "prompt.submit";
			result: { submissionId: string };
	  }
	| {
			command: "run.abort";
			result: Record<string, never>;
	  }
	| {
			command: "session.compact";
			result: {
				compacted: boolean;
				entryId?: string;
				tokensBefore?: number;
			};
	  };

export type ProtocolErrorCode =
	| "INVALID_JSON"
	| "INVALID_MESSAGE"
	| "RUN_ACTIVE"
	| "NO_ACTIVE_RUN"
	| "COMMAND_FAILED"
	| "UNSUPPORTED_PROTOCOL";

export type ServerMessage =
	| {
			type: "server.ready";
			protocolVersion: 1;
			capabilities: Capability[];
	  }
	| { type: "session.snapshot"; snapshot: SessionSnapshot }
	| {
			type: "command.accepted";
			requestId: string;
			command: ClientCommand["type"];
	  }
	| ({
			type: "command.completed";
			requestId: string;
	  } & CommandCompletion)
	| {
			type: "agent.event";
			envelope: AgentEventEnvelope;
	  }
	| {
			type: "protocol.error";
			requestId?: string;
			code: ProtocolErrorCode;
			message: string;
	  };

export type DecodeResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: {
				code:
					| "INVALID_JSON"
					| "INVALID_MESSAGE"
					| "UNSUPPORTED_PROTOCOL";
				message: string;
			};
	  };
```

`decodeClientCommand(raw)` 对 client 输入做完整字段校验。`decodeServerMessage(raw)` 校验 server envelope、snapshot 顶层、entry 基础字段与 `event.type`；不复制 core 的完整 `AgentEvent`/`Message` 联合验证。

### 1.2 SessionHost（`packages/server/src/session-host.ts`）

```ts
export type ServerMessageSink = (message: ServerMessage) => void;

export interface SessionHostOptions {
	now?: () => number;
	onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export class SessionHost {
	constructor(session: AgentSession, options?: SessionHostOptions);
	attach(send: ServerMessageSink): () => void;
	handle(command: ClientCommand, reply: ServerMessageSink): void;
	snapshot(): SessionSnapshot;
	close(): Promise<void>;
}
```

- constructor 立即订阅一次 `AgentSession`，socket 数量变化不重复订阅。
- `attach()` 先注册 paused client，再同步发送 snapshot，最后 flush 连接期间排队的 live messages；返回 detach。
- `handle()` 在发 `command.accepted` 后启动异步操作，不阻塞 WebSocket message handler。
- prompt 的同一 active `requestId` 可复用 core 的 in-flight promise；不同 requestId 返回 `RUN_ACTIVE`。
- socket detach 不 abort；只有 `SessionHost.close()`（server shutdown）会 abort active run 并等待 `session.waitForIdle()`。

### 1.3 Web raw state（`packages/web/src/state/types.ts`）

```ts
export interface SessionViewState {
	sessionId: string;
	leafId: string | null;
	status: SessionSnapshot["status"];
	entries: SessionSnapshot["entries"];
	events: AgentEventEnvelope[];
	latestSequence: number;
	diagnostics: Array<{ id: string; message: string }>;
}

export interface AppState {
	connection:
		| "connecting"
		| "connected"
		| "reconnecting"
		| "disconnected"
		| "incompatible";
	session?: SessionViewState;
	prompt: string;
	selectedTimelineItemId?: string;
	pendingRequests: Record<string, ClientCommand["type"]>;
	lastProtocolError?: { code: string; message: string };
}

export type AppAction =
	| { type: "connection.changed"; connection: AppState["connection"] }
	| { type: "server.message"; message: ServerMessage }
	| { type: "prompt.changed"; prompt: string }
	| { type: "timeline.selected"; itemId?: string }
	| { type: "local.error"; code: string; message: string };

export interface ChatMessageView {
	kind: "message";
	id: string;
	role: "user" | "assistant" | "toolResult";
	text: string;
	streaming: boolean;
	stopReason?:
		| "pending"
		| "stop"
		| "length"
		| "toolUse"
		| "error"
		| "aborted";
	toolCallId?: string;
	toolCallIds: string[];
}

export type ChatItem = ChatMessageView;

export interface ToolCardView {
	id: string;
	toolCallId: string;
	toolName: string;
	sourceIndex: number;
	status: "pending" | "running" | "completed" | "error";
	args: unknown;
	partialResult?: unknown;
	result?: unknown;
	durationMs?: number;
	isError?: boolean;
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface TimelineItem {
	id: string;
	source: "journal" | "live" | "diagnostic";
	kind:
		| "submission"
		| "message"
		| "tool-intent"
		| "tool-update"
		| "tool-outcome"
		| "run-end"
		| "compaction"
		| "agent"
		| "turn"
		| "message-lifecycle"
		| "assistant-stream"
		| "tool-start"
		| "tool-update-live"
		| "tool-end"
		| "diagnostic";
	label: string;
	raw: unknown[];
	sequence?: number;
	elapsedMs?: number;
	toolCallId?: string;
	warning?: string;
}

export function createInitialAppState(): AppState;
export function reduceAppState(state: AppState, action: AppAction): AppState;
```

`SessionViewState` 只保存 raw facts。下列 selector 是唯一允许解释消息/工具/usage/Timeline 的位置：

```ts
export function buildChatView(session: SessionViewState): ChatItem[];
export function buildToolCards(session: SessionViewState): ToolCardView[];
export function buildUsageTotals(session: SessionViewState): UsageTotals;
export function buildTimeline(session: SessionViewState): TimelineItem[];
```

### 1.4 文件职责

| 文件 | 职责 |
|---|---|
| `packages/protocol/src/messages.ts` | protocol version、wire unions、capabilities。 |
| `packages/protocol/src/guards.ts` | client/server JSON decode 与 runtime guards。 |
| `packages/protocol/src/index.ts` | 公共导出。 |
| `packages/protocol/test/guards.test.ts` | 合法/非法命令、snapshot/envelope guards。 |
| `packages/protocol/test/no-runtime-core-imports.test.ts` | 强制 protocol 对 core 只有 type-only import。 |
| `packages/server/src/session-path.ts` | `activeSessionPath(entries, leafId)`，按 parent 链重建 active branch。 |
| `packages/server/src/session-host.ts` | 长生命周期 AgentSession、命令、sequence、snapshot、连接 sink。 |
| `packages/server/src/create-runtime.ts` | 与 CLI 等价的 provider/extensions/tools/session 组装。 |
| `packages/server/src/websocket-server.ts` | localhost HTTP upgrade、Origin/path/payload、decode/dispatch。 |
| `packages/server/src/index.ts` | `.env`、`--continue`、启动/关闭入口。 |
| `packages/server/test/session-path.test.ts` | 分支 active path 与坏 parent 防御。 |
| `packages/server/test/session-host.test.ts` | prompt/abort/compact、snapshot seam、detach/reconnect。 |
| `packages/server/test/websocket-server.test.ts` | 真实 `ws` client、边界与中途重连。 |
| `packages/server/test/no-deep-imports.test.ts` | server 只用 workspace 包根。 |
| `packages/web/src/state/types.ts` | raw AppState 与 selector 输出类型。 |
| `packages/web/src/state/reducer.ts` | connection/server message/local action reducer。 |
| `packages/web/src/state/chat.ts` | journal + event → semantic messages。 |
| `packages/web/src/state/tools.ts` | assistant 源顺序 tool cards + execution facts。 |
| `packages/web/src/state/usage.ts` | usage 累计，零价格逻辑。 |
| `packages/web/src/state/timeline.ts` | journal rows + live AgentEvent rows + compaction markers。 |
| `packages/web/src/protocol-client.ts` | WebSocket 生命周期、decode、自动重连、typed send。 |
| `packages/web/src/use-agent-session.ts` | React hook：client、requestId、reducer、commands。 |
| `packages/web/src/components/*.tsx` | Header、session sidebar、Chat、tool card、composer、Timeline、Event Details modal。 |
| `packages/web/src/workspace.tsx` | 三栏纯组件组合，不碰 WebSocket。 |
| `packages/web/src/app.tsx` / `main.tsx` | hook 接线与 React 入口。 |
| `packages/web/src/styles.css` | 已批准的 Light desktop-first tokens/layout。 |
| `docs/stages/12-ui-layer.md` | 阶段决策文档：事件 UI、无状态 server、reconnect seam。 |

---

## 2. 任务分解

### Task 1: 建立共享 JSON protocol 与导入边界

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/vitest.config.ts`
- Create: `packages/protocol/src/messages.ts`
- Create: `packages/protocol/src/guards.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/guards.test.ts`
- Create: `packages/protocol/test/no-runtime-core-imports.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: public `AgentEvent` / `SessionEntry` types from `@mini-agent/core` via `import type`.
- Produces: §1.1 的 `PROTOCOL_VERSION`、`Capability`、`AgentEventEnvelope`、`SessionSnapshot`、`ClientCommand`、`ServerMessage`、`decodeClientCommand()`、`decodeServerMessage()`。

- [ ] **Step 1: 创建 protocol 包配置**

`package.json` 固定为 `@mini-agent/protocol`，exports 指向 `./src/index.ts`，scripts 为 `test: vitest run`、`check: tsc --noEmit`。`@mini-agent/core` 放 `devDependencies`，不是 `dependencies`；另含仓库同版本的 TypeScript、Vitest、`@types/node`。

- [ ] **Step 2: 写失败的 client command guard 测试**

`guards.test.ts` 至少包含：

```ts
expect(decodeClientCommand(JSON.stringify({
	type: "prompt.submit", requestId: "r1", prompt: "hello",
}))).toEqual({
	ok: true,
	value: { type: "prompt.submit", requestId: "r1", prompt: "hello" },
});

expect(decodeClientCommand("{")).toMatchObject({
	ok: false, error: { code: "INVALID_JSON" },
});
expect(decodeClientCommand(JSON.stringify({
	type: "prompt.submit", requestId: "r1", prompt: "   ",
}))).toMatchObject({
	ok: false, error: { code: "INVALID_MESSAGE" },
});
```

另覆盖 `run.abort`、`session.compact`、空 requestId、未知 type、数组/null/non-string 字段。

- [ ] **Step 3: 写失败的 server message guard 测试**

覆盖：

- `server.ready.protocolVersion === 1`
- `protocolVersion: 2` 返回 `UNSUPPORTED_PROTOCOL`
- snapshot 的 sessionId、leafId、status、latestSequence
- entry 必须有 `type/id/parentId/createdAt`
- transient envelope 必须有非负整数 sequence、非负 elapsedMs、字符串 event.type
- 未知 server message type 被拒绝

- [ ] **Step 4: 写失败的结构性 import 测试**

扫描 `packages/protocol/src/**/*.ts`：

```ts
for (const line of source.split("\n")) {
	if (!line.includes('"@mini-agent/core"')) continue;
	expect(line).toMatch(/^\s*import type\b/);
}
expect(source).not.toContain("@mini-agent/core/");
```

- [ ] **Step 5: 运行测试确认失败**

Run: `pnpm --filter @mini-agent/protocol run test`

Expected: FAIL，缺少 `src/guards.ts` / `src/messages.ts` 实现。

- [ ] **Step 6: 实现 wire types 与手写 guards**

`guards.ts` 只用 `JSON.parse` 和小型 `isRecord` / `isNonEmptyString` / `isNonNegativeInteger` helper。不要引 zod。对 trusted local core event 只校验顶层 `event.type`，不要复制 `AgentEvent` 每个变体。

- [ ] **Step 7: 安装 workspace links 并验证**

Run:

```bash
pnpm install
pnpm --filter @mini-agent/protocol run test
pnpm --filter @mini-agent/protocol run check
```

Expected: protocol tests PASS，TypeScript 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add packages/protocol pnpm-lock.yaml
git commit -m "feat(stage-12): add the websocket protocol" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: 实现 journal active path 与长生命周期 `SessionHost`

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/vitest.config.ts`
- Create: `packages/server/src/session-path.ts`
- Create: `packages/server/src/session-host.ts`
- Create: `packages/server/test/session-path.test.ts`
- Create: `packages/server/test/session-host.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `AgentSession`、`AgentEvent`、`SessionEntry`（core public API）；Task 1 protocol。
- Produces:

```ts
export function activeSessionPath(
	entries: readonly SessionEntry[],
	leafId: string | null,
): SessionEntry[];

export class SessionHost {
	constructor(session: AgentSession, options?: SessionHostOptions);
	attach(send: ServerMessageSink): () => void;
	handle(command: ClientCommand, reply: ServerMessageSink): void;
	snapshot(): SessionSnapshot;
	close(): Promise<void>;
}
```

- [ ] **Step 1: 创建 server 包骨架**

`@mini-agent/server` dependencies：`@mini-agent/ai`、`@mini-agent/core`、`@mini-agent/extensions`、`@mini-agent/protocol`（均 `workspace:*`）。本任务先不加 `ws`；测试和 check 版本与现有包一致。

- [ ] **Step 2: 写 active path 失败测试**

构造物理顺序 `A, B, C, D, E`、parent tree `A→B→C` 与 `A→D→E`：

```ts
expect(activeSessionPath(entries, "E").map((entry) => entry.id))
	.toEqual(["A", "D", "E"]);
expect(activeSessionPath(entries, null)).toEqual([]);
expect(() => activeSessionPath(entries, "missing"))
	.toThrowError("Unknown session entry: missing");
```

再覆盖 parent cycle/缺 parent，防止坏 snapshot 无限循环。

- [ ] **Step 3: 写 idle snapshot 与 attach 原子性失败测试**

用真实 `AgentSession.create()` + `createFakeStreamFn()`：

- idle snapshot.entries 等于 active parent path，不含旧分支 descendants
- `attach()` 第一条必为 `session.snapshot`
- 在 snapshot send 回调中触发一个 live event 时，该 event 在 snapshot 后收到，不丢失
- detach 后 sink 不再收到消息，但 session 保持可提交

- [ ] **Step 4: 写 prompt command 失败测试**

覆盖：

1. `command.accepted` 早于第一条 `agent.event`
2. envelope sequence 为 `0,1,2...`
3. 注入 `now()` 后 elapsedMs 非负且单调
4. prompt 完成发送 `command.completed`，result.submissionId 为 durable submission id
5. active run 的不同 requestId 返回 `RUN_ACTIVE`
6. active run 的相同 requestId 复用同一个 in-flight submission，不产生第二次 provider 调用

- [ ] **Step 5: 写 active snapshot seam 失败测试**

使用带延迟 delta 的 `StreamFn`，在收到第一条 `message_update` 后调用 `host.snapshot()`：

```ts
expect(snapshot.status).toBe("running");
expect(snapshot.entries.map((entry) => entry.type))
	.not.toContain("submission"); // 当前 run 由 transient events 表示
expect(snapshot.transientEvents.map((item) => item.event.type))
	.toEqual(expect.arrayContaining([
		"agent_start", "turn_start", "message_start", "message_update",
	]));
```

run settle 后再次 snapshot：

```ts
expect(snapshot.status).toBe("idle");
expect(snapshot.transientEvents).toEqual([]);
expect(snapshot.entries.at(-1)).toMatchObject({
	type: "run_end", status: "completed",
});
```

- [ ] **Step 6: 写 abort / compact / close 失败测试**

- idle abort → `NO_ACTIVE_RUN`
- running abort 只调用 `session.abort()`；真正 terminal 状态来自后续 AgentEvent
- compact 期间 status=`compacting`，snapshot entries 截止操作前 leaf，events 含 compaction pair
- no-op compact completed result 为 `{ compacted: false }`
- `host.close()` abort active run 并等 `waitForIdle()`
- 普通 detach 不 abort

- [ ] **Step 7: 运行确认失败**

Run: `pnpm --filter @mini-agent/server run test`

Expected: FAIL，`session-path.ts` / `session-host.ts` 尚不存在。

- [ ] **Step 8: 实现 `activeSessionPath()`**

使用 `Map<id, entry>` 从 leaf 反向走 parent；用 `Set` 检测 cycle；反转后返回 `structuredClone(path)`，避免 transport 调用方改 session 内存对象。

- [ ] **Step 9: 实现 `SessionHost`**

必须固定以下顺序：

1. operation 开始前保存 `operationBaseLeafId = session.leafId`
2. 清空 `operationEvents`，记录 `operationStartedAt`
3. 发 `command.accepted`
4. 调用 `session.submit()` / `compact()`
5. AgentSession listener 为每个 event 分配 sequence、记录当前 operation event、广播
6. settle 后发 completed/error
7. 最后清空 operation base/events/status

client sink 包装为 `{ paused, queue, send }`。broadcast 时如果 paused 则入 queue；active sink 的 `send` 抛错时只 detach 该 sink，不向 Agent listener 抛错。

- [ ] **Step 10: 验证**

Run:

```bash
pnpm --filter @mini-agent/server run test
pnpm --filter @mini-agent/server run check
```

Expected: session path/host tests PASS。

- [ ] **Step 11: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(stage-12): host persistent sessions for web clients" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: 暴露真实 provider 的 localhost WebSocket server

**Files:**
- Create: `packages/server/src/create-runtime.ts`
- Create: `packages/server/src/websocket-server.ts`
- Create: `packages/server/src/index.ts`
- Create: `packages/server/test/create-runtime.test.ts`
- Create: `packages/server/test/websocket-server.test.ts`
- Create: `packages/server/test/no-deep-imports.test.ts`
- Modify: `packages/server/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 2 `SessionHost`；现有 `createAnthropicStreamFn`、`setDefaultStreamFn`、`AgentSession`、`createDefaultTools`、`bootstrapExtensions`、`createDemoExtension`。
- Produces:

```ts
export interface CreateRuntimeOptions {
	continueSession?: boolean;
	directory?: string;
	env?: NodeJS.ProcessEnv;
	streamFn?: StreamFn;
	extensions?: Extension[];
}

export async function createRuntime(
	options?: CreateRuntimeOptions,
): Promise<SessionHost>;

export interface AgentWebSocketServerOptions {
	runtime: SessionHost;
	host?: "127.0.0.1";
	port?: number;
	maxPayloadBytes?: number;
}

export interface AgentWebSocketServerHandle {
	url: string;
	close(): Promise<void>;
}

export function startAgentWebSocketServer(
	options: AgentWebSocketServerOptions,
): Promise<AgentWebSocketServerHandle>;
```

- [ ] **Step 1: 用 package manager 添加 transport 依赖**

Run:

```bash
pnpm --filter @mini-agent/server add ws
pnpm --filter @mini-agent/server add -D @types/ws
```

Expected: server manifest 与 lockfile 更新；core/ai/extensions manifests 不变。

- [ ] **Step 2: 写 `createRuntime` 失败测试**

通过临时目录与 env 注入覆盖：

- `continueSession:false` 创建新 session
- `continueSession:true` 打开 latest session
- 非法 `ANTHROPIC_CONTEXT_WINDOW` 以与 CLI 相同的具名错误失败
- 注入 `streamFn: createFakeStreamFn(...)` 后可走完整 prompt，不访问网络/API key
- 注入测试 extension 后证明 runtime 使用 `bootstrapped.tools(createDefaultTools())` 与 `bootstrapped.hooks`
- extension observer 通过 `SessionHostOptions.onEvent` 收到事件，但其失败不杀 run

- [ ] **Step 3: 写 WebSocket happy-path 失败测试**

使用 `port: 0` 和真实 `ws` client：

1. 第一条是 `server.ready`
2. 第二条是 `session.snapshot`
3. 发 `prompt.submit` 后先收到 `command.accepted`，再收到 `agent.event`
4. 最终收到 `agent_end` 与 `command.completed`
5. sequence 严格递增

- [ ] **Step 4: 写 malformed/security 失败测试**

覆盖：

- invalid JSON → `INVALID_JSON`，同一连接下一条合法 command 仍可处理
- invalid shape / blank prompt → `INVALID_MESSAGE`
- 非 `/agent` upgrade 拒绝
- Origin `https://example.com` 拒绝
- 无 Origin 的测试/CLI client 允许
- payload > 65536 bytes 关闭该 socket，server 仍接受新连接
- unknown protocol message 不调用 SessionHost

- [ ] **Step 5: 写断线中途重连失败测试**

使用延迟 streaming fake session：

1. client A 启动 prompt，收到至少一个 `message_update` 后关闭
2. run 不 abort，provider 继续
3. client B 连接后收到 snapshot，status 为 `running` 或（若刚好 settle）完整 idle journal
4. running snapshot 的 transientEvents 含 A 错过的当前 run 前缀
5. B 继续收到后续 live events 和 `agent_end`
6. 最终再连接 client C，snapshot 为 idle、entries 含 `run_end`、transientEvents 为空

- [ ] **Step 6: 写结构性 server import 测试**

扫描 `server/src`：

- 禁止 `@mini-agent/core/`、`@mini-agent/ai/`、`@mini-agent/extensions/`
- 允许包根 import
- 禁止相对路径跨入 `../core` / `../ai`

- [ ] **Step 7: 运行确认失败**

Run: `pnpm --filter @mini-agent/server run test`

Expected: FAIL，runtime/transport 尚未实现。

- [ ] **Step 8: 实现 `createRuntime()`**

行为与 CLI 装配根对齐：

```ts
setDefaultStreamFn(options.streamFn ?? createAnthropicStreamFn({
	apiKey: env.ANTHROPIC_API_KEY ?? "",
	baseUrl: env.ANTHROPIC_BASE_URL,
	model: env.ANTHROPIC_MODEL,
}));
const bootstrapped = await bootstrapExtensions({
	extensions: options.extensions ?? [createDemoExtension()],
});
bootstrapped.installStreamFn();
```

session options 固定：

- system: `"You are a minimal teaching agent."`
- tools: `bootstrapped.tools(createDefaultTools())`
- hooks: `bootstrapped.hooks`
- contextWindow: 与 CLI 相同的 positive safe integer 校验

`onEvent` 使用 `void bootstrapped.notify(event)` 的软隔离语义。

- [ ] **Step 9: 实现 WebSocket transport**

- `http.createServer()` + `WebSocketServer({ noServer: true, maxPayload })`
- upgrade 时校验 path/origin
- connection 顺序：send `server.ready` → `runtime.attach(send)`
- message：`decodeClientCommand` → `runtime.handle`
- socket close/error：只 detach
- send wrapper 检查 `readyState === OPEN`；失败 detach，不 throw 回 Agent

- [ ] **Step 10: 实现 executable entry**

`src/index.ts`：

- `process.loadEnvFile()`，仅忽略 `ENOENT`
- 参数只允许零个或 `--continue`
- 创建 runtime、启动 `127.0.0.1:8787`
- 打印 `mini-agent server listening on ws://127.0.0.1:8787/agent`
- SIGINT/SIGTERM 时先 close server，再 `runtime.close()`

`package.json` 增加 `"dev": "node --experimental-strip-types src/index.ts"`。

- [ ] **Step 11: 验证**

Run:

```bash
pnpm --filter @mini-agent/server run test
pnpm --filter @mini-agent/server run check
```

Expected: server 全部测试 PASS。

- [ ] **Step 12: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(stage-12): expose sessions over localhost websocket" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: 建立 Web raw state 与 journal/event 纯投影

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/vitest.config.ts`
- Create: `packages/web/test/setup.ts`
- Create: `packages/web/src/state/types.ts`
- Create: `packages/web/src/state/reducer.ts`
- Create: `packages/web/src/state/chat.ts`
- Create: `packages/web/src/state/tools.ts`
- Create: `packages/web/src/state/usage.ts`
- Create: `packages/web/src/state/timeline.ts`
- Create: `packages/web/test/state/reducer.test.ts`
- Create: `packages/web/test/state/chat.test.ts`
- Create: `packages/web/test/state/tools.test.ts`
- Create: `packages/web/test/state/usage.test.ts`
- Create: `packages/web/test/state/timeline.test.ts`
- Create: `packages/web/test/no-runtime-boundary-imports.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 `ServerMessage` / snapshot/envelope types。
- Produces: §1.3 `AppState` / `SessionViewState` 与四个 pure selectors。

- [ ] **Step 1: 创建 Web 包骨架**

`@mini-agent/web` runtime dependency 只有 `@mini-agent/protocol`；本任务 devDependencies 先加入 TypeScript、Vitest、jsdom、`@types/node`。`tsconfig` 增加 DOM libs、`jsx: "react-jsx"`，但本任务尚不写组件。

- [ ] **Step 2: 写 reducer 失败测试**

覆盖：

- `server.ready` 把 connection 设为 connected
- `session.snapshot` 原子替换 entries/events/status/sequence
- live `agent.event` 只接受同 session；本地已有事件时要求 sequence > latest。若 snapshot 没有 transient events 且 `latestSequence === 0`，表示尚未见过任何 event，第一个 sequence `0` 必须接受
- duplicate sequence 不重复 append，写 diagnostic
- sequence gap 保留事件并写 diagnostic，不 crash
- `command.accepted/completed` 更新 pendingRequests
- `protocol.error` 保存错误，不伪造 run 结束
- reconnect snapshot 清掉旧 diagnostics/selection 中已经无效的 item

- [ ] **Step 3: 写 durable Chat 失败测试**

构造 active path：

```text
system message
submission(user)
assistant(toolCall c1,c2)
tool intents/outcomes
toolResult c1,c2
assistant(final)
run_end
```

断言：

- system 不进入 Chat
- submission 恰好产生一条 user message
- assistant/toolResult/final 各出现一次
- 不从 `tool_intent` / `tool_outcome` 额外生成重复 Chat message

- [ ] **Step 4: 写 live streaming Chat 失败测试**

snapshot base 不含当前 submission，events 包含 user lifecycle、assistant start、40 个 update、assistant end：

```ts
expect(buildChatView(session).filter((item) =>
	item.kind === "message" && item.role === "assistant"
)).toHaveLength(1);
expect(lastAssistant.text).toBe("complete text");
expect(lastAssistant.streaming).toBe(false);
```

在缺 `message_end` 时，文本取最后一条 `message_update.message`，`streaming=true`。

- [ ] **Step 5: 写 tool card 双顺序失败测试**

assistant blocks 顺序 `[c1,c2,c3]`，live tool end sequence `[c2,c3,c1]`：

```ts
expect(buildToolCards(session).map((card) => card.toolCallId))
	.toEqual(["c1", "c2", "c3"]);
expect(buildTimeline(session)
	.filter((item) => item.kind === "tool-end")
	.map((item) => item.toolCallId))
	.toEqual(["c2", "c3", "c1"]);
```

另断言 durable `tool_update` / `tool_outcome` / toolResult message 合并进同一 card，duration/isError 不从文本猜测。

- [ ] **Step 6: 写 usage 与 compaction 失败测试**

- input/output/cache 四项分别求和
- 没有 usage 的 assistant 不加 0 成本字段，selector 不导出 cost
- durable assistant 与 live assistant 不重复累计（active snapshot seam）
- journal compaction 生成 marker
- live `compaction_start/end` 生成进行中/完成/错误 marker

- [ ] **Step 7: 写 unknown/out-of-order Timeline 失败测试**

未知 event type、turn_end 缺 turn_start、message_update 无 assistant start 都保留 raw JSON，并生成 warning item；不得 throw 或静默丢弃。

- [ ] **Step 8: 写 Web 边界 import 失败测试**

扫描 `web/src`，拒绝：

```text
@mini-agent/core
@mini-agent/ai
@mini-agent/server
@mini-agent/*/src/
```

- [ ] **Step 9: 运行确认失败**

Run: `pnpm --filter @mini-agent/web run test -- state`

Expected: FAIL，state modules 尚不存在。

- [ ] **Step 10: 实现 reducer 与 selectors**

关键实现规则：

- reducer 永不改写 event/entry payload
- journal entry view id 使用 `entry:${entry.id}`
- live event view id 使用 `event:${sessionId}:${sequence}`
- message update 聚合只在 selector 层，raw envelopes 全保留
- tool card identity 永远是 `toolCallId`
- durable Timeline 用 submission/run_end 分组；live Timeline 用 agent/turn/message/tool events 分层
- selected details 能回到原始 entry 或 envelope

- [ ] **Step 11: 验证**

Run:

```bash
pnpm install
pnpm --filter @mini-agent/web run test -- state
pnpm --filter @mini-agent/web run check
```

Expected: state tests PASS。

- [ ] **Step 12: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "feat(stage-12): project journal and events into web views" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: 实现 Light 三栏 React 工作台

**Files:**
- Create: `packages/web/src/components/workspace-header.tsx`
- Create: `packages/web/src/components/session-sidebar.tsx`
- Create: `packages/web/src/components/chat-panel.tsx`
- Create: `packages/web/src/components/tool-card.tsx`
- Create: `packages/web/src/components/prompt-composer.tsx`
- Create: `packages/web/src/components/timeline-panel.tsx`
- Create: `packages/web/src/components/event-details-modal.tsx`
- Create: `packages/web/src/workspace.tsx`
- Create: `packages/web/src/styles.css`
- Create: `packages/web/test/workspace.test.tsx`
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 4 raw state/selectors。
- Produces:

```ts
export interface WorkspaceProps {
	state: AppState;
	onPromptChange(prompt: string): void;
	onSubmit(): void;
	onAbort(): void;
	onCompact(): void;
	onSelectTimelineItem(itemId?: string): void;
}

export function Workspace(props: WorkspaceProps): React.JSX.Element;
```

- [ ] **Step 1: 用 package manager 添加 React 测试依赖**

Run:

```bash
pnpm --filter @mini-agent/web add react react-dom
pnpm --filter @mini-agent/web add -D \
  @types/react @types/react-dom \
  @testing-library/react @testing-library/user-event \
  @testing-library/jest-dom
```

- [ ] **Step 2: 写 layout / connection 状态失败测试**

断言：

- 页面有 `Session`、`Chat`、`Timeline` 三个 landmark
- 根节点 `data-theme="light"`，不存在 dark toggle
- connecting/reconnecting/disconnected/incompatible 有明确阻塞状态
- connected idle：Prompt/Send/Compact enabled，Stop hidden
- running：Prompt/Send/Compact disabled，Stop visible
- compacting：Prompt/Send/Compact disabled，不把状态显示为 running

- [ ] **Step 3: 写 Chat/tool card 失败测试**

覆盖：

- user / assistant / toolResult 文本
- streaming draft indicator
- tool cards source order
- 参数、partial、result、duration、error
- tool result 默认折叠
- aborted/error assistant 显式显示 terminal 状态

- [ ] **Step 4: 写 usage / compaction / Timeline modal 失败测试**

- Header 显示 input/output/cache totals
- 页面不存在 currency/cost 文案
- compaction marker 显示 reason 与 tokensBefore
- live message updates 显示聚合 count
- 点击 durable entry/live event 调 `onSelectTimelineItem`
- 有 selected item 时打开 `role="dialog"`、`aria-modal="true"` 的 Event Details modal
- modal 展示 source、id/sequence、elapsedMs 与格式化 JSON
- Esc 与关闭按钮都调用 `onSelectTimelineItem(undefined)`，并把焦点还给原 Timeline row
- Previous / Next event 调用相邻可见 Timeline item 的 id
- modal 打开期间 Timeline 保持渲染，但背景不可交互（例如 `aria-hidden` / `inert`）

- [ ] **Step 5: 运行确认失败**

Run: `pnpm --filter @mini-agent/web run test -- workspace`

Expected: FAIL，React components 尚未实现。

- [ ] **Step 6: 实现 Header、Sidebar 与 Composer**

- Header：产品名、connection、session status、usage、Stop
- Sidebar：sessionId、leafId、persistent/journal replay 标签、Compact
- Composer：textarea + Send；说明 Web 与 CLI 共享 core，但各自进程持有自己的 session

- [ ] **Step 7: 实现 ChatPanel 与 ToolCard**

组件只消费 selector 输出，不读取 raw entries/events。ToolCard 状态仅 `pending | running | completed | error`；run aborted 不伪造每个工具的 aborted 状态。

- [ ] **Step 8: 实现 TimelinePanel 与 EventDetailsModal**

Timeline 同时展示：

- journal：submission/message/tool/compaction/run_end
- live：agent/turn/message/tool/compaction lifecycle

两类 row 用 source badge 区分，避免把 journal replay 冒充原始实时事件。

EventDetailsModal 只消费 selected `TimelineItem` 及其 raw payloads：modal 显示 source、sequence/id、elapsedMs、Copy JSON、Previous / Next event；Esc 或 Close 清除 selection。modal 尺寸遵循 `min(880px, calc(100vw - 64px))` 宽、`min(760px, calc(100vh - 96px))` 高，窄屏占满视口。背景 Timeline 保持可见但不可交互。

- [ ] **Step 9: 实现 Workspace 与 Light CSS**

沿用视觉基线：

```css
--color-page: #f7f8fa;
--color-panel: #ffffff;
--color-border: #e4e7ec;
--color-text: #172033;
--color-muted: #667085;
--color-primary: #175cd3;
--color-success: #027a48;
--color-danger: #b42318;
```

desktop grid：

```css
grid-template-columns: 220px minmax(420px, 1.5fr) minmax(360px, 1fr);
```

右侧栏不再为 details 预留固定高度，Timeline 占满可用纵向空间。modal overlay 使用半透明深色背景与单个白色内容容器；正文阅读区设置最大宽度并左对齐。Chat assistant 不使用厚重气泡，Timeline 使用连续事件轨道与 Live / Journal badge。

小于 1100px 时 Timeline 变为右侧 drawer；不做 mobile navigation。

- [ ] **Step 10: 验证**

Run:

```bash
pnpm --filter @mini-agent/web run test -- workspace
pnpm --filter @mini-agent/web run check
```

Expected: component tests PASS。

- [ ] **Step 11: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "feat(stage-12): render the persistent agent workspace" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: 接通 ProtocolClient、自动重连与 React app

**Files:**
- Create: `packages/web/index.html`
- Create: `packages/web/vite.config.ts`
- Create: `packages/web/src/protocol-client.ts`
- Create: `packages/web/src/use-agent-session.ts`
- Create: `packages/web/src/app.tsx`
- Create: `packages/web/src/main.tsx`
- Create: `packages/web/test/protocol-client.test.ts`
- Create: `packages/web/test/use-agent-session.test.tsx`
- Create: `packages/web/test/app.test.tsx`
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 guards/types、Task 4 reducer、Task 5 Workspace。
- Produces:

```ts
export interface ProtocolClientOptions {
	url: string;
	onMessage(message: ServerMessage): void;
	onConnectionChange(state: AppState["connection"]): void;
	createSocket?: (url: string) => WebSocket;
	reconnectDelaysMs?: readonly number[];
}

export interface ProtocolClient {
	connect(): void;
	send(command: ClientCommand): void;
	close(): void;
}

export function createProtocolClient(
	options: ProtocolClientOptions,
): ProtocolClient;

export function useAgentSession(): {
	state: AppState;
	actions: Omit<WorkspaceProps, "state">;
};
```

- [ ] **Step 1: 用 package manager 添加 Vite**

Run:

```bash
pnpm --filter @mini-agent/web add -D vite @vitejs/plugin-react
```

`tsconfig.json` types 增加 `"vite/client"`。

- [ ] **Step 2: 写 ProtocolClient 失败测试**

注入 fake WebSocket，覆盖：

- `connect()`：connecting → connected
- incoming 合法 JSON 经 `decodeServerMessage`
- malformed/unsupported message → incompatible，不调用 onMessage
- socket 意外 close：reconnecting，按 `[250, 500, 1000, 2000]` 循环重连
- 新 socket open 后 connected；server 自动发送新的 snapshot
- 显式 `close()` 取消 timer，不再重连
- 非 OPEN 时 `send()` 抛 `WebSocket is not connected`

- [ ] **Step 3: 写 hook command 失败测试**

固定 `crypto.randomUUID()`：

- 非空 prompt 发 `prompt.submit`
- 空白 prompt 不发送，写本地错误
- Stop 发 `run.abort`
- Compact 发 `session.compact`
- server `command.accepted/completed/error` 正确更新 reducer
- reconnect snapshot 原子替换 stale local facts

- [ ] **Step 4: 写 App 集成失败测试**

mock hook，断言 Workspace callbacks；再用 fake client 推送：

- snapshot → durable Chat
- message_update → streaming text
- tool events → card/timeline
- agent_end → idle controls
- socket close → reconnecting banner，现有 journal view 保留但输入禁用

- [ ] **Step 5: 运行确认失败**

Run: `pnpm --filter @mini-agent/web run test -- protocol-client use-agent-session app`

Expected: FAIL，client/hook/app 尚未实现。

- [ ] **Step 6: 实现 `ProtocolClient`**

- browser URL：当前页面为 http 时 `ws://<host>/agent`，https 时 `wss://<host>/agent`
- outgoing 只 `JSON.stringify(ClientCommand)`
- incoming 必经 `decodeServerMessage`
- 重连 timer 由 client 自己拥有；同时最多一个 socket/一个 timer
- 每次 open 不发送 sync command：server 的 `ready + snapshot` 是握手

- [ ] **Step 7: 实现 `useAgentSession`**

hook 只负责：

- 创建/关闭 ProtocolClient
- dispatch reducer action
- 生成 requestId
- 将 Send/Stop/Compact 转成 typed command

不得在 hook 中解释 tool card、usage 或 timeline。

- [ ] **Step 8: 实现 Vite / React 入口**

`vite.config.ts`：

```ts
export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/agent": {
				target: "ws://127.0.0.1:8787",
				ws: true,
			},
		},
	},
});
```

`main.tsx` 引入 `styles.css` 并挂载 `<App />`。

- [ ] **Step 9: 验证**

Run:

```bash
pnpm --filter @mini-agent/web run test
pnpm --filter @mini-agent/web run check
```

Expected: Web 全部测试 PASS。

- [ ] **Step 10: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "feat(stage-12): connect react to the replaying websocket" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: 根开发流程、全链路验收与阶段文档

**Files:**
- Modify: `package.json`
- Create: `docs/stages/12-ui-layer.md`
- Test: existing/new tests from Tasks 1–6

**Interfaces:**
- Consumes: 完整 protocol/server/web。
- Produces: `pnpm dev:web` 双进程开发入口；阶段 12 教学文档。

- [ ] **Step 1: 增加开发脚本**

根 `package.json` 保留现有 `dev/test/check`，新增：

```json
{
	"dev:web": "pnpm --parallel --filter @mini-agent/server --filter @mini-agent/web run dev"
}
```

继续已有 Web session 固定使用两个终端，避免把 `--continue` 误传给 Vite：

```bash
pnpm --filter @mini-agent/server run dev -- --continue
pnpm --filter @mini-agent/web run dev
```

- [ ] **Step 2: 跑 targeted package suites**

Run:

```bash
pnpm --filter @mini-agent/protocol run test
pnpm --filter @mini-agent/server run test
pnpm --filter @mini-agent/web run test
pnpm --filter @mini-agent/protocol run check
pnpm --filter @mini-agent/server run check
pnpm --filter @mini-agent/web run check
```

Expected: 全绿。

- [ ] **Step 3: 跑全仓回归**

Run:

```bash
pnpm test
pnpm check
```

Expected: ai/core/extensions 既有测试一条未删，CLI 类型检查仍通过，新三包全绿。

- [ ] **Step 4: 验证结构与文件规模**

Run:

```bash
rg -n '@mini-agent/(core|ai|server)|@mini-agent/.+/src/' packages/web/src
rg -n '@mini-agent/(core|ai|extensions)/' packages/server/src
find packages/protocol packages/server packages/web \
  -path '*/src/*' -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -print0 | xargs -0 wc -l
```

Expected:

- 前两条均无输出（包根 import 不匹配带尾随 `/` 的第二条）
- 每个 src 文件 < 200 行；超限先拆分再继续

- [ ] **Step 5: 手动浏览器验收**

Run: `pnpm dev:web`

打开 Vite URL，使用真实环境变量逐项验证：

1. 输入“读一下 package.json 然后总结”，看到流式文本、read 工具卡、结果和最终回答。
2. 同时在另一终端运行 `pnpm dev`，CLI 仍可正常创建独立 session 并工作。
3. Web assistant usage 更新 input/output/cache token totals；页面无 cost。
4. 运行 `/compact` 等价 Web Compact 操作（Web 按钮），Timeline 出现 compaction marker。
5. run 中途断开浏览器网络或关闭 tab，再打开：当前 run 未被 abort，snapshot + transient events 补齐；settle 后刷新可由 journal 恢复完整已完成历史。
6. parallel tools 时 Chat cards 保持源顺序，Timeline end 保持完成顺序。
7. Stop 产生真实 aborted assistant + agent_end；不是客户端伪造状态。

- [ ] **Step 6: 写阶段决策文档**

`docs/stages/12-ui-layer.md` 必须覆盖：

- 问题：CLI 为什么不足以观察同一事件流的多个视图
- Pi 决策：UI 订阅事件，不读 Agent 内部状态
- server 为什么只做命令转发、event envelope 和 journal snapshot
- live event 与 durable journal 为什么必须分层；为什么不能把丢失 delta 伪造成原始事件
- 断线为什么不 abort Agent；slow socket 为什么不能成为 awaited listener
- 替代方案代价：轮询 `agent.state`、每个组件各自取数据、socket 断开即 abort、把物理 JSONL 顺序当 active path
- 决策点：**“为什么 UI 只订阅事实流，不读取 `agent.state`？重连时为什么需要 journal base + current-operation events 两层？”**

- [ ] **Step 7: 最终 clean-room 验证**

停止 dev processes，确认没有临时 fixture/session 被提交；`.mini-agent/` 仍被 `.gitignore` 忽略。

Run:

```bash
git --no-pager status --short
pnpm test
pnpm check
```

Expected: 只有阶段 12 预期文件；测试和类型检查全绿。

- [ ] **Step 8: Commit**

```bash
git add package.json docs/stages/12-ui-layer.md
git commit -m "docs(stage-12): explain the event-driven ui boundary" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## 完成标准

- [ ] `pnpm test` 与 `pnpm check` 全绿；core/ai/extensions/CLI 无阶段 12 行为回归。
- [ ] `packages/protocol` 对 core 只有 type-only import；Web 不 import core/ai/server；server 不 deep import。
- [ ] WebSocket 断开不 abort active Agent；中途重连测试证明 snapshot + transient events 无重复、无缺口。
- [ ] snapshot 沿 active parent path，不混入旧 branch descendants。
- [ ] server.ready → session.snapshot → live events 的顺序稳定；invalid/oversized input 与非 localhost Origin 明确失败。
- [ ] Chat 的 delta/done 语义正确；tool cards 源顺序与 Timeline 完成顺序同时正确。
- [ ] token usage 可见且不显示虚假成本；manual/threshold/overflow compaction 均可形成 marker。
- [ ] `pnpm dev` 与 `pnpm dev:web` 可并列运行，共享同一 core/provider/extension 架构。
- [ ] Event Details 通过 modal 展示 source、sequence、elapsedMs 与原始 JSON，并支持 Esc、Previous / Next 与焦点返回。
- [ ] `docs/stages/12-ui-layer.md` 讲清本阶段决策点。
- [ ] 分支 `stage-12-ui-layer` 上任务级原子 commits 均带 Copilot trailer。

## Plan Self-Review（已完成）

- [x] Spec coverage：阶段 12 的事件序列化、WebSocket、React、双前端、工具卡、usage、流式文本、压缩 marker、journal reconnect 均有任务。
- [x] Step scan：每个 checkbox 是单个可验证动作；实现 body 只在协议/seam 不足以消除歧义时给出。
- [x] Type consistency：`SessionSnapshot`、`AgentEventEnvelope`、`SessionHost`、`AppState`、`WorkspaceProps`、`TimelineItem` 与 `EventDetailsModal` 在所有任务中命名一致。
- [x] Visual sync：已批准的 Quiet Observability 方向、React + Vite、Event Details modal 与“不做 New session”边界在 Task 5 和 Global Constraints 中显式锁定。
- [x] Review Focus：五个高风险输入/失败模式分别有 Task 1–6 的失败测试。
- [x] Proportion：计划锁定接口、测试和边界，不转录 React/host 的完整实现。
