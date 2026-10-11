# 阶段 3「流式」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `StreamFn` 从「拉一个生成器」改成「推一个事件流」——provider 自己按到达节奏 `push` 事件，循环 `for await` 消费的同时用 `result()` 拿权威消息；新增 `EventStream<T, R>`、`AssistantMessageEvent` 的 delta 变体、假模型发 delta 序列、CLI 逐字打印。

**Architecture:** 新概念只有一条：**delta 与 done 的分离**。一次响应从 `start` 开始，中间发 n 个 `text_delta`，最后以 `done` 收尾——而**只有 `done` 携带的消息进历史**。为了让 provider 能「不等消费者要就推」，需要 `EventStream<T, R>`：内部一个 FIFO 队列 + 一个等待者队列，`push` 时有等待者就直接交付、没有就入队；`result()` 是一个与迭代并行的 promise，在 `done` 事件上 resolve。**这同时是阶段 7 的地基**：Anthropic 的 SSE socket 是推送源，不是可 `yield` 的生成器；把推拉适配放进本阶段，阶段 7 只需把 `fetch` 的字节喂进 `push`。

**Tech Stack:** 同阶段 1/2（TypeScript 5.9.3 `strict` + `erasableSyntaxOnly`、Node 24 `--experimental-strip-types` 零构建、pnpm workspaces、vitest 3）。**仍不引入任何运行时依赖**——延迟用 `node:timers/promises` 的 `setTimeout`。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md`（阶段 3 见 §5「阶段 3 —— 流式」，事件分层见 §4.5，目录见 §7.1）

## Global Constraints

从 spec 逐条抄录，每个任务都隐含包含本节：

- **零运行时依赖**。所有包 `dependencies` 为空（`cli` 只有两个 workspace 依赖）。
- **`erasableSyntaxOnly: true`**。禁止 `enum`、**构造函数参数属性**（`constructor(private x: number)` → `TS1294`）、`namespace`；类型导入必须 `import type`。**已实测**：`protected` 字段、`readonly #私有` 字段、`override` 方法在本项目配置下**合法**——Pi 的 `EventStream`/`AssistantMessageEventStream` 类形状可以逐字搬过来。
- **可擦除语法下，跨包导入用包名，包内相对导入带 `.ts` 后缀**。
- **tab 缩进**；每个 `src` 文件 < 200 行。
- **注释解释「为什么」，不解释「是什么」**。
- **`pnpm dev` 走 `node --experimental-strip-types`，不走 vitest**。
- **每阶段只加一个新概念**；不许提前实现下一阶段的内容。本阶段的新概念是「`AssistantMessageEvent` + delta 与 done 的分离」。**本阶段不做**：`thinking_*` / `toolcall_start` / `toolcall_delta` / `toolcall_end` / `error` 变体（阶段 7 随 SSE 一起加）、`AgentEvent` 分层与 `Agent` 类（阶段 4）、`message_update` 事件（阶段 4）、并行工具（阶段 6）、`usage` 的真实填充（阶段 7）、Ctrl+C 中断（阶段 4）。
- **不许回头改阶段 1/2 的既有行为**。循环的收敛条件、length 保护、工具串行执行、错误回喂语义**一个字都不动**——本阶段只换「事件怎么来」和「历史怎么写」。
- **`pnpm test` 与 `pnpm check` 必须全绿**才算完成。
- 本阶段源码预算 ~250 行（spec §5 阶段 3）。阶段增量 < 350 行（含测试）。

## 阶段 2 留下的接口（本计划的起点）

这些已经在仓库里（HEAD = `569b72c`）。本计划**改它们的形状**，这是阶段 1/2 之后第一次改已有接口，改动清单必须和本节的「要改什么」逐条对上：

```ts
// packages/ai/src/types.ts:45-48 —— 要改：变体扩充 + 字段改名 message → partial
export type AssistantMessageEvent =
	| { type: "start"; message: AssistantMessage }
	| { type: "done"; message: AssistantMessage };

// packages/ai/src/stream-fn.ts:6-9 —— 要改：返回值从 AsyncGenerator 换成 AssistantMessageEventStream
export type StreamFn = (
	context: StreamContext,
	signal?: AbortSignal,
) => AsyncGenerator<AssistantMessageEvent>;

// packages/ai/src/fake.ts:29-44 —— 要改：yield 两次 → 按 chunk 推一串 delta
export function createFakeStreamFn(script: FakeStep[]): StreamFn;

// packages/core/src/agent-loop.ts:51-58 —— 要改：只读 done → 消费 delta（回调）+ 依旧只把 done 入历史
for await (const event of streamFn(context, options.signal)) {
	if (event.type === "done") doneMessage = event.message;
}
const message = doneMessage!;
options.messages.push(message);
```

**不改的**：`AgentLoopOptions` 的字段、`executeToolCalls`、`ToolDef`、`tools.ts` 三个工具、`getDefaultStreamFn` 的具名错误、`StopReason` 六元联合、`ContentBlock`。

## 本阶段的四个关键决策（实现时必须体现在代码里）

### 决策 A：`StreamFn` 的返回值从 `AsyncGenerator` 换成 `EventStream`

**这是本阶段唯一的结构性改动，也是唯一一个「看起来不必要」的改动。** 必须讲清为什么不能只做「生成器里多 yield 几个 delta」。

`AsyncGenerator` 是**拉**模型：消费者 `next()` 一次，生产者才跑一步。它有三个致命处，全都撞在阶段 7 上：

| 处 | 拉模型的问题 | `EventStream` 的答案 |
|---|---|---|
| 谁决定节奏 | `await` 一回来 producer 就继续，**消费者不 `next()`，SSE 字节就没地方放** | provider 在自己的 `queueMicrotask`/IIFE 里推，消费者什么时候读都行（事件先入队） |
| 最终消息怎么拿 | 只能从最后一次迭代的 `return` 值里抠，而 `for await` 的 `return` 值被语法吃掉了，得手写 `while (true) { const r = await it.next(); if (r.done) ... }` | `result(): Promise<R>`——与迭代**并行**的第二个出口，Pi 的循环就是这么用的 |
| 提前结束 | `end(result)` 不存在；只能 `return` + 消费者自己收尾 | `end(result?)` 显式关闭，唤醒所有等待者 |

Pi 的两处证据（本机 `D:\project\harness\pi` 核对过行号）：

- **provider 侧**：`packages/ai/src/providers/faux.ts:523` 用 `queueMicrotask(async () => { ... })` 把整个生产逻辑甩进微任务，函数立刻返回 stream。`packages/ai/src/api/anthropic-messages.ts:576` 同构，只是换成 IIFE。**生产者跑在自己的任务里，不等消费者。**
- **消费者侧**：`packages/agent/src/agent-loop.ts:403-409` 先拿到 `response`，定义 `const result = async () => await response.result()`（`:409`），然后 `for await (const event of response)`（`:414`）——**同一时刻同时持有「迭代」和「最终结果」两个句柄**。生成器形态给不了这个。

所以 `StreamFn` 的新签名是：

```ts
export type StreamFn = (context: StreamContext, signal?: AbortSignal) => AssistantMessageEventStream;
```

**代价**：消费者不能再掉以轻心地「`for await` 完事」——`for await` 结束时 `doneMessage` 可能是 `undefined`（provider 违反契约提前 `end`）。这个失败模式在原实现里会变成 `undefined is not a function`，现在必须显式挡（见决策 D）。

### 决策 B：delta 不进历史，只有 `done` 进

这是 spec 的决策点，也是本阶段的**唯一一条新约定**：

> **流式增量只用于 UI 即时显示；只有 `done` 携带的完整消息才进入历史。**

`AgentLoopOptions` 因此要多一个可选参数：`onDelta?: (delta: string) => void`。循环在消费事件时对每个 `text_delta` 调它，CLI 传 `process.stdout.write`。

**为什么不是「把 delta 拼起来当消息」**：就算拼对了，也是在历史里放一条「自己拼的」消息，而 `done` 里那条是 provider 权威给出的（带 `stopReason`、`usage`、`durationMs`）。**两条消息内容相同、身份不同**——阶段 7 之后 `done` 的消息还可能经过 provider 侧归一化（工具参数 JSON 的最终解析结果），拼出来的那份不会有。同理 `/loop/resume`（阶段 9）从磁盘读回来的必须是 `done` 那条。

**为什么 delta 绝对不能自己入历史**：40 个 `text_delta` 会变成 40 条 assistant 消息——历史被碎片污染、持久化写入 40 条无意义记录、重放时无法区分「一次响应的 40 个碎块」和「用户真的发了 40 条」。验收 #2 就是钉这件事。

### 决策 C：字段名是 `partial`，不是 `message`

Pi 的 12 个变体里，**每一个**都用 `partial`（`packages/ai/src/types.ts:801-817`），包括 `start` 和 `done`。v3 现在用的是 `message`。本阶段**改名为 `partial`**。

三个理由，第三个是硬要求：

1. **遮蔽变体的区分作用**。`done` 的字段承载语义是「这是最终消息」，`text_delta` 的字段承载语义是「这是到目前为止攒出来的东西」。共用 `message` 会让 `start`/`text_delta` 的那份看起来也是「一条消息」，而这正是决策 B 要防的误解。
2. Pi 的文档注释（`types.ts:786-800`）明确写着它**不是**事件时刻的快照：text/thinking 块在 `*_start` 时是空的，靠 `*_delta` 增长，直到 `*_end` 才是权威。`partial` 这个词把「还在变」写进了名字里。
3. **spec 验收 #4 的原文点名 `partial`**：

   > 4. 断言 `message_update` 的 `partial` 在最后一条 delta 后与 `done.message` 一致。

   `message_update` 是阶段 4 的 `AgentEvent`，本阶段不能造它（不许提前实现）。但**字段名可以现在对齐**：阶段 4 落地时，事件里直接放上已命名为 `partial` 的 `event.partial`，验收 #4 一字不改地成立。这是「阶段 4 那一行验收现在就该能通过」的读法——本阶段把它的**前提**做出来，并在阶段文档里写明这一点。

**同时保留 `done.message` 这个名字**（Pi 也是这么分的：`done` 用 `message`，其余用 `partial`）。改的只有 `start` 和新增的 delta 变体。

> **勘误（2026-10-11 事后补，正文保留原样当历史）**
>
> 决策 C 的**结论对，第 3 个理由错**。理由 1、2 独立成立，而且已被 Pi 原文坐实：`ai/src/types.ts:794-799` 的文档注释明写「`partial` is the shared live response-so-far helper, **not an event-time snapshot**」。ai 层用 `partial` 没问题。
>
> 错的是外推出来的那句：**「阶段 4 落地时事件里直接放 `event.partial`，验收 #4 一字不改地成立」——不成立。** Pi 的 `agent/src/types.ts:526` 是 `{ type: "message_update"; message; assistantMessageEvent }`：顶层叫 `message`，而且装的是 `{ ...partialMessage }` 的**快照**。我拿上面那段 spec 验收 #4 的错措辞当成了 Pi 的做法，把 ai 层的字段名外推到了 agent 层。
>
> 后果与已做的修正（详见 `docs/HANDOFF.md` §5）：
> - spec 第 183 行 `event` → `assistantMessageEvent`；顶层保持 `message`（`message_start`/`message_update`/`message_end` 同名字段，否则 UI reduce 与持久化要写特判分支）。
> - 原验收 #4 **移入阶段 4**（现为阶段 4 验收 #5），改写为断言 `message_update` 的 `message` 与 `message_end` 的 `message` 一致。`message_update` 本阶段不存在，不是字段名的问题。
> - `packages/ai/src/types.ts` 与 `docs/stages/03-streaming.md` 的对应说法已改。
>
> **教训**：拿 spec 里的一句转述当 Pi 的原始事实用。凡是「Pi 是这么写的」，必须落到 Pi 的具体行号上再下结论——这一条本计划自己在别处做到了（决策 C 理由 2 就带了 `types.ts:786-800`），唯独理由 3 没做。
>
> 回测第 3 问（为什么字段叫 `partial` 而不是 `message`）**不受影响，反而更清楚了**：两个名字指两种东西——`partial` 是 ai 层还在长、被就地变更的那份；`message` 是 agent 层复制出来的死值。答案就在这个对比里。

### 决策 D：契约违反要响亮，静默兜底不要

`for await` 结束后 `doneMessage` 仍是 `undefined` = provider 没发 `done` 就结束了。这在原实现里是「`doneMessage!` 非空断言 + 下游炸」；换成 `EventStream` 后更糟——`result()` 的 promise **永不 settle**，循环会**静默挂住**，没有栈、没有错误，只有一个不动的终端。

两条出路，本阶段都做：

- **源头**：`AgentLoopOptions` 的消费逻辑在 `for await` 之后显式检查，抛具名错误 `stream ended without a done event`。与阶段 1 的 `getDefaultStreamFn` 是同一条原则——**能报出「谁违反了契约」就别让下一个环节去猜**。
- **兜底**：`EventStream.end()` 里检查「是否已经因 `isComplete` 而完成」，没完成就 `reject` 那个 final result promise。这样即使有人绕过循环直接 `await stream.result()`，也是立刻 rejection 而不是永久挂起。

`consumeAssistantMessage` 用 `done` 事件携带的消息，不用 `result()`——**因为 `done` 里那条就是权威消息，多一次 `await` 不带来信息**。`result()` 保留给宿主代码和测试（Pi 的循环用它，是因为 Pi 的 provider 还会往 result 上补字段）。

## 本阶段改动的文件

| 文件 | 动作 | 行数 |
|---|---|---|
| `packages/ai/src/event-stream.ts` | **新建**：`FifoQueue<T>` + `EventStream<T, R>` + `AssistantMessageEventStream` + `createAssistantMessageEventStream()` | ~85 |
| `packages/ai/test/event-stream.test.ts` | **新建** | ~70 |
| `packages/ai/src/types.ts` | 改：`AssistantMessageEvent` 变体扩充 + `message` → `partial` | 45-48 → ~54 |
| `packages/ai/src/stream-fn.ts` | 改：`StreamFn` 返回值 + `consumeAssistantMessage` | 23 → ~48 |
| `packages/ai/src/fake.ts` | 改：`async function*` → 推 delta 序列 | 45 → ~78 |
| `packages/ai/src/index.ts` | 改：导出新符号 | 4 → 7 |
| `packages/core/src/agent-loop.ts` | 改：`for await` 块 → 消费 delta + 契约检查 | 51-58 → ~14 |
| `packages/core/src/index.ts` | 改：透出 `StreamDeltaHandler` 类型 | 7 → 8 |
| `packages/cli/src/index.ts` | 改：逐字打印 | 85 → ~80 |
| `packages/ai/test/fake.test.ts` | 改：helper 换 API + 事件序列断言 | 71 → ~85 |
| `docs/stages/03-streaming.md` | **新建**（阶段文档） | ~90 |

**放在 `ai/src/event-stream.ts` 而不是 Pi 的 `ai/src/utils/event-stream.ts`**：v3 的 `ai/src/` 目前是平铺的（`types.ts` / `stream-fn.ts` / `fake.ts`），`utils/` 这一层现在只有一个文件，是空目录的仪式。等阶段 7 的 `anthropic.ts` 和阶段的真实出现第二个工具文件时再分层——那时分层有依据（一组文件，不是一个人）。

## Review Focus

Spec 是愿景文档，它没写到的输入不是「允许出问题」。以下五类是本阶段最可能咬到人的，每类都在对应任务里钉了测试：

1. **provider 提前 `end()` 而不发 `done`**：`for await` 正常结束、`result()` 永不 settle。使用者会期望「要么拿到消息，要么拿到错误」，而不是终端卡死。→ Task 5 Step 3（循环抛具名错误）、Task 1 Step 3（`result()` reject）。
2. **`text_delta` 的 `partial` 与 `done.partial` 是同一个对象引用**：假模型 `{ ...partial }` 只浅拷贝，`content` 数组和里面的块是共享的——消费者若在 `done` 之前就把它入了历史，历史会被后续 delta 继续改写。使用者会期望「拿到了就不能再变」。→ Task 4 Step 3。
3. **脚本文本是空串**：`splitIntoDeltas("", n)` 若返回 `[]`，`start` 之后直接 `done`，验收 #3 的「`text_delta`×n」中 n=0 会让人以为流坏了。空文本必须仍然产出一个空 delta。→ Task 4 Step 4。
4. **`chunkSize <= 0`**：`text.slice(0, 0)` 无限循环（`index += 0`）。使用者会期望「参数不合法就报错」，而不是进程挂死。→ Task 4 Step 2。
5. **`durationMs` 在 `done` 时被填充**：spec 明确要求，但假模型在同一个微任务里跑完，`durationMs` 会是 0——`0` 与 `undefined` 语义不同（「测到了但为 0」vs「没测」），断言必须用 `typeof === "number"` 而不是真值。→ Task 1 Step 3、Task 5 Step 3。

---

### Task 1: `EventStream<T, R>` 与 `AssistantMessageEventStream`

**Files:**
- Create: `packages/ai/src/event-stream.ts`
- Test: `packages/ai/test/event-stream.test.ts`
- Modify: `packages/ai/src/index.ts`

**Interfaces:**
- Consumes: `AssistantMessageEvent`、`AssistantMessage`（`./types.ts`，**注意 Task 2 才改变体形状；本任务按当前的两变体实现即可**，`done` 的字段名在 Task 2 一并改）
- Produces:
  - `class EventStream<T, R = T> implements AsyncIterable<T>`，构造参数 `(isComplete: (event: T) => boolean, extractResult: (event: T) => R)`
  - `EventStream.push(event: T): void`
  - `EventStream.end(result?: R): void`
  - `EventStream.result(): Promise<R>`
  - `EventStream[Symbol.asyncIterator](): AsyncIterator<T>`
  - `class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage>`，无参构造
  - `createAssistantMessageEventStream(): AssistantMessageEventStream`

  不引入工厂之外的名字——`AssistantMessageEventStream` 类本身即可当类型用，`StreamFn` 的返回类型直接写它。

- [ ] **Step 1: 写失败测试**

创建 `packages/ai/test/event-stream.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { EventStream, createAssistantMessageEventStream } from "../src/event-stream.ts";
import type { AssistantMessage } from "../src/types.ts";

function textMessage(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

describe("EventStream", () => {
	it("delivers events pushed before anyone consumes, in order", async () => {
		const stream = new EventStream<number, number>((n) => n === 3, (n) => n);
		stream.push(1);
		stream.push(2);
		stream.push(3);
		stream.end(3);
		const seen: number[] = [];
		for await (const n of stream) seen.push(n);
		expect(seen).toEqual([1, 2, 3]);
		expect(await stream.result()).toBe(3);
	});

	it("hands an event directly to a consumer that is already waiting", async () => {
		const stream = new EventStream<number, number>((n) => n === 2, (n) => n);
		const seen: number[] = [];
		const drain = (async () => {
			for await (const n of stream) seen.push(n);
		})();
		await Promise.resolve(); // 让 drain 抵达等待点
		stream.push(1);
		stream.push(2);
		stream.end(2);
		await drain;
		expect(seen).toEqual([1, 2]);
	});

	it("drops events pushed after the stream is done", async () => {
		const stream = new EventStream<number, number>((n) => n === 1, (n) => n);
		stream.push(1);
		stream.push(2);
		stream.end(1);
		const seen: number[] = [];
		for await (const n of stream) seen.push(n);
		expect(seen).toEqual([1]);
	});

	it("ends iteration without a result when end() is called early", async () => {
		const stream = new EventStream<number, number>(() => false, (n) => n);
		stream.push(1);
		stream.end();
		const seen: number[] = [];
		for await (const n of stream) seen.push(n);
		expect(seen).toEqual([1]);
	});
});

describe("AssistantMessageEventStream", () => {
	it("stamps durationMs on the done message", async () => {
		const stream = createAssistantMessageEventStream();
		const message = textMessage("hi");
		stream.push({ type: "start", message: { ...message } });
		await new Promise((resolve) => setTimeout(resolve, 12));
		stream.push({ type: "done", message });
		stream.end(message);
		expect(await stream.result()).toBe(message);
		expect(typeof message.durationMs).toBe("number");
		expect(message.durationMs).toBeGreaterThanOrEqual(5);
	});

	it("keeps a durationMs the message already carries", async () => {
		const stream = createAssistantMessageEventStream();
		const message = { ...textMessage("hi"), durationMs: 7 };
		stream.push({ type: "done", message });
		stream.end(message);
		expect(message.durationMs).toBe(7);
	});
});
```

（最后一条 `createFakeStreamFn` 未导入——第二个 describe 的第一行需要补 `import { createAssistantMessageEventStream } from "../src/event-stream.ts";`。写测试时一并加上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @mini-agent/ai run test -- event-stream`
Expected: FAIL — `Failed to resolve import "../src/event-stream.ts"`

- [ ] **Step 3: 实现 `packages/ai/src/event-stream.ts`**

直接搬 Pi 的 `packages/ai/src/utils/event-stream.ts:3-135`，做三处简化（都是**减去** Pi 为多 provider 生态背的包袱，不是加东西）：

1. 去掉 `AssistantMessageEventStream` 的 `#time` 里 `message.timestamp < this.#startedAt` 这个守卫——v3 的 `AssistantMessage` 没有 `timestamp` 字段（`types.ts:15-21`），这个守卫的用途是「转发一个在别处开始的响应就不要计时」，v3 没有 deferred 响应（阶段 7 才有）。**注释要写明这一点**，否则读者会以为漏抄了。
2. `#time` 保留 `durationMs !== undefined` 的守卫（写入前先看有没有）——这条是有用的：provider 自己测了就以它为准。
3. `EventStream.end()` 加一条「未完成就 reject」：

```ts
end(result?: R): void {
	// 契约违反兜底：isComplete 从未触发（provider 没发 done/error 就结束）时，
	// result() 不能永远挂着——那是一个没有栈、没有错误的死锁。
	if (!this.settled) this.rejectFinalResult(new Error("event stream ended without a completion event"));
	this.done = true;
	if (result !== undefined) this.resolveFinalResult(result);
	while (this.waiting.length > 0) {
		const waiter = this.waiting.dequeue()!;
		waiter({ value: undefined as any, done: true });
	}
}
```

对应地，`push` 里命中 `isComplete` 的分支要置 `this.settled = true`，`result()` 里 `await` 之后仍失败则抛出那个错误（保持「迭代正常但 result 失败」两者都可见）。

**注意 `erasableSyntaxOnly`**：`private queue = new FifoQueue<T>()` 和 `readonly #startedAt = Date.now()` 都合法（字段声明 + 初始化器）；**不许**写 `constructor(private queue: ...)`。

`FifoQueue` 用两个栈：`enqueue` 推入 `incoming`，`dequeue` 时若 `outgoing` 为空就把 `incoming` 全部倒进去再 `pop`。这是摊还 O(1) 的队列，Pi 用它来同时承载「事件队列」和「等待者队列」两种用途。

- [ ] **Step 4: 加导出**

`packages/ai/src/index.ts` 追加：

```ts
export { EventStream, AssistantMessageEventStream, createAssistantMessageEventStream } from "./event-stream.ts";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @mini-agent/ai run test -- event-stream`
Expected: PASS（6 个用例）

- [ ] **Step 6: 提交**

```bash
git add packages/ai/src/event-stream.ts packages/ai/test/event-stream.test.ts packages/ai/src/index.ts
git commit -m "feat(stage-3): EventStream with push/end/result"
```

---

### Task 2: `AssistantMessageEvent` 扩变体、字段改名 `partial`

**Files:**
- Modify: `packages/ai/src/types.ts:45-48`
- Test: 无独立测试（形状改动由 Task 3/4 的测试覆盖）

**Interfaces:**
- Consumes: `AssistantMessage`（同文件）
- Produces:
  - `type AssistantMessageEvent = { type: "start"; partial: AssistantMessage } | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage } | { type: "done"; message: AssistantMessage }`

- [ ] **Step 1: 替换 `types.ts` 的 45-48 行**

```ts
// 流式事件协议（spec §5 阶段 3）。本阶段只有文本 delta——
// thinking_* 与 toolcall_* 是阶段 7 随真实 SSE 一起加。
//
// 字段名两种：delta 类变体用 partial（"到目前为止攒出来的东西"，不是快照——
// text 块靠 *_delta 增长，只有 done 里那份才是权威），done 用 message。
// 阶段 4 的 message_update 会把 partial 原样透出，验收 #4 因此现在就该成立。
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage };
```

`contentIndex` 保留 Pis 的字段（`ai/src/types.ts:805`）：本阶段只用下标 0，但阶段 7 一条响应里会有多个块，那时消费者已经不需要改签名。

- [ ] **Step 2: 跑 check 看编译错在哪些消费点**

Run: `pnpm run check`
Expected: FAIL，错误集中在 `packages/ai/src/fake.ts`（`yield { type: "start", message }`）与 `packages/core/src/agent-loop.ts`（`event.message`）。**这一步是刻意的**：让编译器把「谁在消费这个事件」列全，比 grep 可靠。逐条记下来，Task 4/5 按这份清单改。

- [ ] **Step 3: 提交**

先不提交——本任务单独提交会让仓库处于 `pnpm check` 红的状态。**把本任务和 Task 3 合成一次提交**（Task 3 的 Step 4 负责）。

---

### Task 3: `StreamFn` 换成推模型 + `consumeAssistantMessage`

**Files:**
- Modify: `packages/ai/src/stream-fn.ts`
- Modify: `packages/ai/src/index.ts`
- Test: `packages/ai/test/stream-fn.test.ts`（既有 3 个用例必须仍然通过，本任务只改它们的类型注解）

**Interfaces:**
- Consumes: `AssistantMessageEventStream`（Task 1）、`AssistantMessageEvent`（Task 2）
- Produces:
  - `type StreamFn = (context: StreamContext, signal?: AbortSignal) => AssistantMessageEventStream`
  - `type StreamDeltaHandler = (delta: string) => void`
  - `async function consumeAssistantMessage(stream: AssistantMessageEventStream, onDelta?: StreamDeltaHandler): Promise<AssistantMessage>`

- [ ] **Step 1: 改 `StreamFn` 的返回类型**

`packages/ai/src/stream-fn.ts:6-9` 改为：

```ts
// 依赖注入缝：core 完全不知道 provider 存在（spec §3.2a）。
// 返回事件流而不是 AsyncGenerator：provider 是推送源（阶段 7 的 SSE socket
// 按自己的节奏吐字节），拉模型要求消费者先伸手才继续，字节没地方放。
export type StreamFn = (context: StreamContext, signal?: AbortSignal) => AssistantMessageEventStream;
```

顶部 import 加 `import type { AssistantMessageEventStream } from "./event-stream.ts";`。

- [ ] **Step 2: 追加 `consumeAssistantMessage`**

```ts
export type StreamDeltaHandler = (delta: string) => void;

// 事件消费的唯一实现：delta 交给 UI 即时显示，done 携带的消息是唯一进历史的候选。
// 放在 ai 而不是 core，因为它是「事件协议怎么读」的知识，与 provider 同侧；
// core 只负责决定拿到的消息要不要入历史。
export async function consumeAssistantMessage(
	stream: AssistantMessageEventStream,
	onDelta?: StreamDeltaHandler,
): Promise<AssistantMessage> {
	let done: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "text_delta") {
			onDelta?.(event.delta);
		} else if (event.type === "done") {
			done = event.message;
		}
	}
	// 契约违反：provider 结束流却没发 done。没有这条，result() 会永远挂着，
	// 排查成本是「终端不动，什么都没有」。
	if (done === undefined) throw new Error("assistant stream ended without a done event");
	return done;
}
```

顶部还要 `import type { AssistantMessage } from "./types.ts";`。

- [ ] **Step 3: 更新导出**

`packages/ai/src/index.ts` 追加：

```ts
export { consumeAssistantMessage } from "./stream-fn.ts";
export type { StreamDeltaHandler } from "./stream-fn.ts";
```

- [ ] **Step 4: 跑 check —— 只剩 fake.ts 和 agent-loop.ts 该红**

Run: `pnpm run check`
Expected: FAIL，且错误**只剩** `packages/ai/src/fake.ts`（返回生成器，类型不匹配）和 `packages/core/src/agent-loop.ts`（`event.message` 在 delta 变体上不存在）。

`packages/ai/test/stream-fn.test.ts:13` 和 `:19` 现在写的是 `const fn: StreamFn = async function* () {};`——一个空生成器（无参，所以参数位不报错，但**返回值类型不匹配**）。**不要动断言**，只把这两处的假实现换成一个真的空流：

```ts
// 空流而不是空生成器：StreamFn 现在返回 AssistantMessageEventStream。
// 这个替身只用来验证插槽存了什么，不需要发任何事件。
function emptyStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.end();
	return stream;
}
```

`:13` 改成 `const fn: StreamFn = emptyStream;`，`:19` 改成 `setDefaultStreamFn(emptyStream);`，并从 `../src/event-stream.ts` 加 `import type { AssistantMessageEventStream }` 与值的 `createAssistantMessageEventStream`。

若 `pnpm run check` 报了**第三处**（不在上面两个文件、也不在 `stream-fn.test.ts`），说明有消费点没被列进本计划——**先停下来告诉使用者**，不要就地改。

- [ ] **Step 5: 提交（Task 2 + Task 3 合并）**

```bash
git add packages/ai/src/types.ts packages/ai/src/stream-fn.ts packages/ai/src/index.ts packages/ai/test/stream-fn.test.ts
git commit -m "feat(stage-3): push-based StreamFn and the delta/partial event shape"
```

---

### Task 4: 假模型发 delta 序列

**Files:**
- Modify: `packages/ai/src/fake.ts`
- Test: `packages/ai/test/fake.test.ts`

**Interfaces:**
- Consumes: `AssistantMessageEventStream`（Task 1）、`AssistantMessageEvent`（Task 2）、`StreamFn`（Task 3）
- Produces:
  - `interface FakeStreamOptions { chunkSize?: number; delayMs?: number }`
  - `function createFakeStreamFn(script: FakeStep[], options?: FakeStreamOptions): StreamFn`

- [ ] **Step 1: 重写 `fake.ts` 的 `createFakeStreamFn`**

保留 `FakeStep`、`stopReasonFor`、`normalize` 三个既有声明**一字不改**。把 `createFakeStreamFn` 换成：

```ts
export interface FakeStreamOptions {
	// 每个 delta 的字符数。缺省 1：CLI 的「逐字出现」（验收 #1）是默认行为，
	// 不是需要在组装点记得打开的开关。测试想要短事件序列就显式传大值。
	chunkSize?: number;
	// 每个 delta 之间的等待。缺省 0：测试不应该是慢的。
	delayMs?: number;
}

// 按固定宽度切片。空文本返回 [""] 而不是 []——空串必须也走一遍 delta，
// 否则「start 之后直接 done」和「流坏了」在事件序列上无法区分。
function splitIntoDeltas(text: string, chunkSize: number): string[] {
	if (chunkSize < 1) throw new Error(`chunkSize must be >= 1, got ${chunkSize}`);
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += chunkSize) {
		chunks.push(text.slice(index, index + chunkSize));
	}
	return chunks.length > 0 ? chunks : [""];
}

export function createFakeStreamFn(script: FakeStep[], options: FakeStreamOptions = {}): StreamFn {
	const chunkSize = options.chunkSize ?? 1;
	const delayMs = options.delayMs ?? 0;
	let callIndex = 0;
	return (context, signal) => {
		const stream = createAssistantMessageEventStream();
		// 生产跑在自己的微任务里，函数立刻返回 stream——与 Pi 的 faux.ts:523 同构。
		// 消费者的 for await 因此是在「流已经可能有一批事件了」之后才开始读的，
		// 这正是 EventStream 的队列存在的原因。
		queueMicrotask(async () => {
			const step = script[Math.min(callIndex, script.length - 1)];
			callIndex++;
			const { content, stopReason } = normalize(step);
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				stopReason: "pending",
			};
			stream.push({ type: "start", partial: { ...partial } });
			for (let index = 0; index < content.length; index++) {
				const block = content[index];
				// 工具调用块本阶段不分片（toolcall_delta 是阶段 7 的）。
				if (block.type !== "text") {
					partial.content = [...partial.content, { ...block }];
					continue;
				}
				partial.content = [...partial.content, { type: "text", text: "" }];
				for (const chunk of splitIntoDeltas(block.text, chunkSize)) {
					if (delayMs > 0) await setTimeout(delayMs, undefined, { signal });
					if (signal?.aborted) {
						stream.end();
						return;
					}
					const target = partial.content[index];
					if (target.type === "text") target.text += chunk;
					stream.push({ type: "text_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
				}
			}
			// stopReason "pending" 不能出现在 done 里——它是「还没开始」的占位值。
			const message: AssistantMessage = {
				role: "assistant",
				content,
				stopReason: stopReason ?? stopReasonFor(content),
			};
			stream.push({ type: "done", message });
			stream.end(message);
		});
		return stream;
	};
}
```

`import { setTimeout } from "node:timers/promises";` 与 `import { createAssistantMessageEventStream } from "./event-stream.ts";` 加到顶部。

**注意两处刻意的不对称**：`partial.content[index].text += chunk` 是**就地改写**（那是「live 的、还在长的那份」），而推出去的是 `{ ...partial }`（**浅拷贝**——`content` 数组引用是共享的，所以消费者拿到的那份只是在被读的那一刻内容正确）。这个不对称是 Pi 原样（`faux.ts:411`），也是 Review Focus #2 要钉的东西。

- [ ] **Step 2: 更新 `fake.test.ts` 的 helper**

`run` 不能再 `for await` 生成器了，改成收事件流：

```ts
// round 参数是文档性的：假模型内部按被调用次数索引脚本（见 src/fake.ts），
// 测试不必构造历史，只需按顺序调用。
async function run(fn: StreamFn, round = 1): Promise<AssistantMessageEvent[]> {
	void round;
	const events: AssistantMessageEvent[] = [];
	for await (const event of fn({ system: { role: "system", content: "s" }, messages: [], tools: [] })) {
		events.push(event);
	}
	return events;
}
```

顶部 import 加 `StreamFn` 类型。**原有的 8 个断言里凡是读 `events.at(-1)!.message` 的，全部改成读一个局部 helper**：

```ts
function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
	const last = events.at(-1)!;
	if (last.type !== "done") throw new Error(`expected done, got ${last.type}`);
	return last.message;
}
```

并把 `(r1.at(-1)!.message as AssistantMessage)` 这类写法替换为 `doneMessage(r1)`。**不要**用 `as` 断言绕过——Task 2 加了变体之后 `as` 会让「取错了变体」编译期不报错。

- [ ] **Step 3: 加三个新测试**

```ts
it("emits start, one delta per character, then done", async () => {
	const events = await run(createFakeStreamFn(["abc"]));
	expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "text_delta", "done"]);
});

it("concatenates all deltas into the text of done's message", async () => {
	const events = await run(createFakeStreamFn(["hello world"]));
	const joined = events
		.filter((e) => e.type === "text_delta")
		.map((e) => e.delta)
		.join("");
	expect(joined).toBe("hello world");
	expect(textOfPartial(doneMessage(events))).toBe("hello world");
});

it("still emits one empty delta when the script entry is an empty string", async () => {
	const events = await run(createFakeStreamFn([""]));
	expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
	expect(events[1]).toMatchObject({ type: "text_delta", delta: "" });
});

it("chunks by the configured size instead of by character", async () => {
	const events = await run(createFakeStreamFn(["abcdef"], { chunkSize: 3 }));
	const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
	expect(deltas).toEqual(["abc", "def"]);
});

it("hands a partial that is still live, not a frozen snapshot", async () => {
	const stream = createFakeStreamFn(["abc"], { delayMs: 5 })({
		system: { role: "system", content: "s" }, messages: [], tools: [],
	});
	const seen: string[] = [];
	for await (const event of stream) {
		if (event.type === "text_delta") seen.push(textOfPartial(event.partial));
	}
	expect(seen).toEqual(["a", "ab", "abc"]);
});
```

第二、五个测试里的 `textOfPartial` 是测试文件内的局部函数，与 `cli/src/index.ts` 的 `textOf` 同构：

```ts
function textOfPartial(message: AssistantMessage): string {
	return message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}
```

第二个测试的完整断言是 `expect(textOfPartial(doneMessage(events))).toBe("hello world")`。**`chunkSize: 0` 抛错**的用例也放这里：

```ts
it("rejects a nonsensical chunk size instead of looping forever", () => {
	expect(() => createFakeStreamFn(["x"], { chunkSize: 0 })).toThrow(/chunkSize/);
});
```

（注意抛点在**调用 `createFakeStreamFn` 时**就要发生，所以 `chunkSize` 的校验不能只写在 `splitIntoDeltas` 里——在 `createFakeStreamFn` 里也校验一次。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @mini-agent/ai run test`
Expected: PASS。`fake.test.ts` 现在 13 个用例，`event-stream.test.ts` 6 个，`stream-fn.test.ts` 3 个。

- [ ] **Step 5: 提交**

```bash
git add packages/ai/src/fake.ts packages/ai/test/fake.test.ts
git commit -m "feat(stage-3): fake model streams text deltas"
```

---

### Task 5: 循环消费 delta，只有 done 进历史

**Files:**
- Modify: `packages/core/src/agent-loop.ts:14-22`（选项）与 `:51-58`（消费）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-loop.test.ts`

**Interfaces:**
- Consumes: `consumeAssistantMessage`、`StreamDeltaHandler`（Task 3）
- Produces:
  - `AgentLoopOptions.onDelta?: StreamDeltaHandler`
  - 循环对历史的行为**完全不变**：一轮一条 assistant 消息

- [ ] **Step 1: 加 `onDelta` 选项**

`AgentLoopOptions` 追加一行（放在 `signal` 之后）：

```ts
	onDelta?: StreamDeltaHandler; // 流式增量只给 UI 看；入历史的永远是 done 携带的那条消息
```

导入加 `import { consumeAssistantMessage, getDefaultStreamFn } from "@mini-agent/ai";`（原来 `consumeAssistantMessage` 要并进现有的值导入那一行）和 `import type { StreamDeltaHandler } from "@mini-agent/ai";`。

- [ ] **Step 2: 替换 51-58 行的消费块**

```ts
		// 只有 done 携带的完整消息才进历史：delta 是传输层的碎块，
		// 一次响应的 40 个 delta 共同描述的是 1 条 assistant 消息（spec §5 阶段 3）。
		const message = await consumeAssistantMessage(streamFn(context, options.signal), options.onDelta);
		options.messages.push(message);
```

**这就是全部改动**：`doneMessage!` 的非空断言被具名错误取代（决策 D），入历史的时机与内容一字未变，工具执行与终止条件完全不动。

- [ ] **Step 3: 加两个测试**

`packages/core/test/agent-loop.test.ts` 里加一个 describe：

```ts
describe("agentLoop (stage 3: streaming)", () => {
	beforeEach(() => setDefaultStreamFn(undefined));

	it("keeps one assistant message per response no matter how many deltas", async () => {
		const messages = await agentLoop({
			...base(), prompt: "hi", streamFn: createFakeStreamFn(["forty characters long string, give or take"]),
		});
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ role: "assistant" });
		expect(messages[1].content).toEqual([{ type: "text", text: "forty characters long string, give or take" }]);
	});

	it("forwards every delta to onDelta in order, and the joined deltas equal the stored text", async () => {
		const deltas: string[] = [];
		const messages = await agentLoop({
			...base(), prompt: "hi", onDelta: (d) => deltas.push(d),
			streamFn: createFakeStreamFn(["hello"]),
		});
		expect(deltas).toEqual(["h", "e", "l", "l", "o"]);
		expect((messages[1].content[0] as { text: string }).text).toBe(deltas.join(""));
	});

	it("throws a named error when a provider ends the stream without a done event", async () => {
		const broken: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end());
			return stream;
		};
		await expect(agentLoop({ ...base(), prompt: "hi", streamFn: broken })).rejects.toThrow(
			/without a done event/,
		);
	});
});
```

第三个测试需要 `import { createAssistantMessageEventStream } from "@mini-agent/ai";` 与 `import type { StreamFn } from "@mini-agent/ai";`。**它也会顺手覆盖 `EventStream.end()` 的兜底**——循环先炸在具名错误上，`result()` 那个 rejection 无人 await，因此不能变成 unhandled rejection 噪音。若 vitest 报 unhandled rejection，说明 Task 1 的 `end()` 兜底写成了「无论如何都 reject」，要改成「只在 `isComplete` 从未触发时 reject」。

- [ ] **Step 4: 跑全部测试确认通过**

Run: `pnpm test`
Expected: PASS。阶段 2 的 16 个循环用例**一个都不许改**——本阶段不改循环行为，它们必须原样通过。若某个用例红了，先确认是不是 `createFakeStreamFn` 的默认 `chunkSize: 1` 带来的副作用（应该没有：循环只看 done）。

- [ ] **Step 5: 导出类型**

`packages/core/src/index.ts` 追加：

```ts
export type { StreamDeltaHandler } from "@mini-agent/ai";
```

（这样扩展侧（阶段 11）能拿到 handler 类型而不必直接依赖 `@mini-agent/ai` 的实现包。若 `pnpm check` 报 `StreamDeltaHandler` 不是本包导出，就改成从 `./agent-loop.ts` 再导一次——`AgentLoopOptions` 已经这么做了。）

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/agent-loop.ts packages/core/src/index.ts packages/core/test/agent-loop.test.ts
git commit -m "feat(stage-3): loop consumes deltas, only done enters history"
```

---

### Task 6: CLI 逐字打印

**Files:**
- Modify: `packages/cli/src/index.ts`
- Test: 手动（`pnpm dev`）

**Interfaces:**
- Consumes: `AgentLoopOptions.onDelta`（Task 5）、`createFakeStreamFn(script, options)`（Task 4）
- Produces: 无新导出

- [ ] **Step 1: 恢复阶段 1 的固定问候、去掉阶段 2 的临时脚本**

`packages/cli/src/index.ts:9-11` 的组装改成：

```ts
// 组装根：cli 是唯一知道用哪个 provider 的地方（spec §3.2a）。
// 必须发生在任何循环之前。问候文案刻意一眼能认出是假模型——
// 阶段 7 接真实模型时，从输出就能判断切换是否成功。
// 默认 chunkSize 1 + delayMs 25：肉眼能看到逐字出现（验收 #1）。
// 测试里同样的 provider 用 chunkSize 3、delayMs 0。
setDefaultStreamFn(createFakeStreamFn(["Hello from the deterministic fake model."], { delayMs: 25 }));
```

删掉 13-35 行那段注释为「临时验证 stage 2 工具链路（验证完恢复上面的固定问候）」的脚本（它对应的 `tools` 参数在下面的 `agentLoop` 调用里已经存在，靠 `createDefaultTools()` 就够）。

- [ ] **Step 2: 改 banner 与渲染**

`:28` 的 banner 改成 `mini-agent (stage 3) — type /exit to quit`。

`:43-55` 的渲染循环改成：**assistant 文本不再事后整块打印**（已经在 `onDelta` 里打过了），只补工具调用与错误：

```ts
		const before = messages.length;
		let streamed = false;
		await agentLoop({
			prompt: line,
			messages,
			system,
			tools: createDefaultTools(),
			onDelta: (delta) => {
				streamed = true;
				process.stdout.write(delta);
			},
		});
		for (const message of messages.slice(before)) {
			if (message.role === "assistant") {
				// text 块已经在 onDelta 里逐字打过了，这里只补非文本块——
				// 事后重印一遍会让每句话出现两次。
				for (const block of message.content) {
					if (block.type === "toolCall")
						console.log(`\n→ ${block.name} ${JSON.stringify(block.arguments)}`);
				}
			}
			if (message.role === "toolResult" && message.isError) {
				console.log(`✗ ${message.toolName}: ${textOf(message.content)}`);
			}
		}
		// 只在真的流式输出过之后换行：无工具的空响应不该多出一个空行
		//（空白 prompt 由 agentLoop 提前返回，走不到这里）。
		if (streamed) console.log();
```

`textOf` 保留不动（toolResult 的错误分支还在用它）。

注意 `streamed` 的判据是「有没有收到过 delta」而不是「有没有 text 块」——空字符串的响应会推一个空 delta，`streamed` 为 `true`，换行一次，这与阶段 2 的行为（`content.some(c => c.type === "text")` → 换行）一致。

- [ ] **Step 3: 手动验收（验收 #1）**

Run: `pnpm dev`
Input: `hello`
Expected:
```
mini-agent (stage 3) — type /exit to quit
> hello
Hello from the deterministic fake model.
> /exit
```
且 `Hello from ...` **是逐字出现**的（每个字符间隔约 25ms，整句约 1.1 秒），不是一次跳出。**这一条必须亲眼看到**——测试能断言事件序列，但「终端逐字」只有人能确认。若一次跳出，检查 `delayMs` 是否被 `?? 0` 吃掉了。

- [ ] **Step 4: 手动验收（验收 #2/#3 的现场版）**

同一个会话里再敲一句 `hello`，确认：
- 历史里**没有**重复累积（每轮只多 2 条消息）；
- 工具路径仍可用：`read package.json` 应该看到「文本 → `→ read ...` → 结果 → 总结文本」的顺序，且 `→ read` 出现在**流式文本之后**。

- [ ] **Step 5: 提交**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(stage-3): CLI prints deltas as they arrive"
```

---

### Task 7: 阶段文档与全量验收

**Files:**
- Create: `docs/stages/03-streaming.md`
- Modify: 无

**Interfaces:**
- Consumes: 本阶段全部产物
- Produces: 学习主载体（spec §7.4 第 2 项）

- [ ] **Step 1: 写 `docs/stages/03-streaming.md`**

沿用 `01-one-round-trip.md` 的四段结构 + 决策点，标题 `# 阶段 3 —— 流式`，开头两行引用 spec 与计划路径。六个小节：

1. **这个阶段解决了什么问题**——阶段 1/2 的循环把「一次响应」当成一个标量（`await` 一次得到一条消息），所以模型在想什么必须等它想完。本阶段把响应拆成 `start → text_delta×n → done`，**但历史仍然只认 `done`**。要点：这是一次「为了让 UI 动起来而改传输层」的改动，代价是 `StreamFn` 的签名变了（路线里第一次改已有接口）。
2. **Pi 的哪条决策是答案**——`EventStream<T, R>`（`ai/src/utils/event-stream.ts:26`）、`AssistantMessageEventStream`（`:97`）、12 个变体（`ai/src/types.ts:801-817`）、`queueMicrotask` 推送泵（`providers/faux.ts:523`）、循环同时持有迭代与 `result()`（`agent/src/agent-loop.ts:403-414`）。每一条都要带行号，并说明 v3 抄了什么、简化了什么（去掉 `timestamp` 守卫、只留 3 个变体）。
3. **替代方案为什么更差**——表格三行：(a) 生成器里多 `yield` 几个 delta（消费者不 `next()` 就没字节的位置；最终消息要从迭代 return 值里抠）；(b) 回调式 `onEvent` 参数（把「事件协议」降级成「一次调用的参数」，阶段 4 的 `AgentEvent` 与阶段 11 的扩展都要重新发明一个流对象）；(c) delta 也入历史、消费者自己合并（历史被碎片污染，且丢失 provider 侧的最终归一化）。
4. **决策点（供回测）**——spec 给的是 **「为什么 delta 事件不进消息历史，只有 `done` 携带的消息进？」**。本节列 4 问，第一问就是它，另外三问是：2. 为什么 `StreamFn` 必须从 `AsyncGenerator` 换成 `EventStream`？（用阶段 7 的 SSE 回答，而不是用「Pi 这么写」）3. 为什么 delta 的字段叫 `partial` 而不是 `message`？（提示：`partial` 和 `done.message` 的内容在最后一刻是相同的，那为什么仍是两个不同名字）4. 为什么 provider 没发 `done` 就结束时要抛具名错误，而不是返回一条空消息兜底？
5. **已知代价**——`EventStream` 引入了一个「迭代正常结束但 `result()` reject」的状态；`partial` 是浅拷贝，历史里若误存了它会被后续 delta 继续改写；`chunkSize`/`delayMs` 是假模型的旋钮，真实 provider 没有「chunk 大小」这个概念（阶段 7 会发现 delta 的边界由网络决定）。
6. **验收对照**——spec 的三条逐条打勾（第 4 条已移入阶段 4，见决策 C 的勘误）。

- [ ] **Step 2: 全量验收**

```bash
pnpm test
pnpm check
grep -rn "fake\|anthropic" packages/core/src/          # 必须为空
grep -c "while\|for (let turn" packages/core/src/agent-loop.ts   # 仍是 1
wc -l packages/ai/src/event-stream.ts packages/ai/src/fake.ts packages/ai/src/types.ts \
      packages/ai/src/stream-fn.ts packages/core/src/agent-loop.ts packages/cli/src/index.ts
pnpm dev                                                # 逐字打印，肉眼确认
```

Expected:
- `pnpm test` 全绿（`ai` 22 个用例：6 + 13 + 3；`core` 19 个：16 + 3）；
- `pnpm check` 全绿；
- 第一条 grep 空（core 仍不认识任何 provider——本阶段加了 `event-stream.ts` 到 `ai`，core 一行 import 都没多）；
- 第二条仍是 `1`（本阶段没动循环层数）；
- 六个文件行数都 < 200；
- `pnpm dev` 逐字打印。

- [ ] **Step 3: 提交**

```bash
git add docs/stages/03-streaming.md
git commit -m "docs(stage-3): why deltas never enter the message history"
```

---

## 完成标准

阶段 3 完成的定义，逐条可验：

- [ ] `pnpm test` 与 `pnpm check` 全绿。
- [ ] `pnpm dev` 里终端能看到文本**逐字出现**（spec 验收 #1）——已亲眼确认，不是从测试推断。
- [ ] 一轮结束后 `messages` 里只有 **1 条** assistant 消息（不是 40 条），且 `content[0].text` 是完整文本（验收 #2）。
- [ ] 事件序列是 `start` → `text_delta`×n → `done`，且所有 delta 拼接等于 `done.message` 的文本（验收 #3）。
- [ ] 事件里承载「还在长的消息」的字段名是 **`partial`**，`done` 用的是 `message`；阶段 4 的 `message_update` 落地时验收 #4 无需改签名（本阶段只做到这条前提，并在阶段文档里写明）。
- [ ] `EventStream<T, R>` 有 `push` / `end` / `result()` / `Symbol.asyncIterator` 四件事，且有测试覆盖前四类失败模式（Review Focus 1-4）。
- [ ] provider 结束流却没发 `done` 时，循环抛具名错误而不是挂住（Review Focus #1）。
- [ ] `packages/ai/src/event-stream.ts` 与既有各文件都 < 200 行；源码增量约 250 行（spec 预算）。
- [ ] `docs/stages/03-streaming.md` 存在，含 spec 的决策点原文，四问的答案**尚未写出**（留给回测，答案另存 `docs/stages/03-回测答案.md`）。
- [ ] 阶段 2 的 16 个循环用例**未经修改**全部通过（证明「只换事件怎么来」这个承诺）。
- [ ] `grep -rn "fake\|anthropic" packages/core/src/` 仍为空。
