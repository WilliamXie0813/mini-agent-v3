# 交接文档 —— 2026-10-10 收工

> 给明天（以及任何 fresh context）的自己读。**不需要读这个会话的历史。**
> 仓库：`D:\project\harness\mini-agent-v3`（对标 `D:\project\harness\pi`）
> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md`（905 行，13 阶段严格线性）
> 当前分支 `stage-3-streaming`（`master` 与 `stage-2-tools-and-loop` 都停在 `569b72c`，阶段 1/2 的提交在这条线上）；工作树干净

---

## 1. 一句话状态

**阶段 3「流式」已完成并提交（5 个 commit），全绿；它的回测答案还没写，另外留了一个已知 latent bug 要在阶段 4 之前修。**

下一步不是阶段 4 的代码，是**回测阶段 3**（spec §7.4 第 2 项是学习的主载体，`docs/stages/03-streaming.md` 已经写好四问，答案要你自己先答）。

---

## 2. 怎么在 30 秒内确认状态没坏

```bash
cd /d/project/harness/mini-agent-v3
pnpm test      # 期望：ai 26 passed / core 40 passed，0 failed
pnpm check     # 期望：无输出（3 个包的 tsc --noEmit 都过）
pnpm dev       # 期望：看到 banner "mini-agent (stage 3)"，输入 hello 后逐字打印
```

若 `pnpm dev` 里 `Hello from the deterministic fake model.` 是**一次跳出**而不是逐字，检查 `packages/cli/src/index.ts:12` 的 `{ delayMs: 25 }` 是否还在。

**注意 `pnpm dev` 是 TTY 交互的**——想非交互验证用管道：

```bash
printf 'hello\n/exit\n' | pnpm dev
```

---

## 3. 阶段 3 交付了什么（8 个 commit）

| commit | 内容 |
|---|---|
| `c15de4f` | `feat(stage-3): EventStream with push/end/result` |
| `f36af37` | `feat(stage-3): push-based StreamFn and the delta/partial event shape` |
| `403d1a3` | `feat(stage-3): fake model streams text deltas` |
| `dbc9ac2` | `feat(stage-3): loop consumes deltas, only done enters history` |
| `4bae545` | `feat(stage-3): CLI prints deltas as they arrive` |
| `ecf3e8b` | `docs(stage-3): why deltas never enter the message history` |
| `073d35d` | `fix(stage-3): contain pump failures with a catch-all end()` |
| `c5bc912` | `fix(stage-3): treat a mid-stream abort as a stop, not a broken provider` |
| `b8b46a5` | `style(stage-3): reflow long signatures and error construction` |

### 本阶段唯一的结构性改动

`StreamFn` 的返回值从 `AsyncGenerator<AssistantMessageEvent>` 换成了 `AssistantMessageEventStream`（推模型）。

**为什么**（这是回测第 2 问，先自己答再看这里）：`AsyncGenerator` 是拉模型，消费者不 `next()` 生产者就停——阶段 7 的 Anthropic SSE socket 按网络节奏吐字节，字节没地方放。且最终消息要从迭代的 `return` 值里抠，而 `for await` 会吃掉 `return` 值。`EventStream` 的 `result()` 是与迭代**并行**的第二个出口。

Pi 的两处证据：`pi/packages/ai/src/providers/faux.ts:523`（`queueMicrotask` 推送泵，生产者跑在自己的任务里）、`pi/packages/agent/src/agent-loop.ts:403-414`（先拿 `response`、定义 `result()`、**然后**才 `for await`——同时持有两个句柄）。

### 当前接口（`packages/ai/src/`）

```ts
// types.ts:50-54 —— 3 个变体（Pi 有 12 个，其余是阶段 7 的）
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage };

// stream-fn.ts:7 —— 注意返回类型
export type StreamFn = (context: StreamContext, signal?: AbortSignal) => AssistantMessageEventStream;
export type StreamDeltaHandler = (delta: string) => void;

// stream-fn.ts:28 —— 事件消费的唯一实现，放在 ai 不放在 core
export async function consumeAssistantMessage(
	stream: AssistantMessageEventStream,
	onDelta?: StreamDeltaHandler,
): Promise<AssistantMessage>;

// event-stream.ts:29 / :107
export class EventStream<T, R = T> implements AsyncIterable<T> {
	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R);
	push(event: T): void;
	end(result?: R): void;
	result(): Promise<R>;
	[Symbol.asyncIterator](): AsyncIterator<T>;
}
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage>;

// core/src/agent-loop.ts:20 —— 新增的唯一字段
onDelta?: StreamDeltaHandler; // 流式增量只给 UI 看；入历史的永远是 done 携带的那条消息
```

### 三条贯穿全阶段的不变式

1. **delta 只给 UI，只有 `done` 携带的消息进历史。** 40 个 delta 描述的是 1 条 assistant 消息。
2. **字段名分两种**：delta 类变体用 `partial`（还在长的那份，不是快照），`done` 用 `message`。
3. **`consumeAssistantMessage` 用 `done` 事件而不是 `result()`**——`done` 里那条就是权威消息，多一次 `await` 不带来信息。`result()` 留给宿主代码与测试。

---

## 4. ✅ 已修：中途 abort 挂死（2026-10-11 修完，第二步未提交）

**原先的状态**：signal 在流式过程中被 abort 时 `agentLoop` 永久不 resolve（探针 5000ms 超时 + unhandled `AbortError`）。

**根因**：`node:timers/promises` 的 `setTimeout(delayMs, undefined, { signal })` 在 abort 时 **reject** `AbortError`。它跑在 detach 的 `queueMicrotask(async () => {...})` 泵里，没人 await——异常变成 unhandled rejection 飘走，`stream.end()` 永不执行，消费者的 `for await` 停在等待者 promise 上。（顺带：泵里那个 `if (signal?.aborted)` 检查在 `delayMs > 0` 与 `=== 0` 两个分支**都是死代码**，前者被 await 先抛，后者整段同步跑完没有插入时机。）

修的过程分两步，**第一步不是我修的**：

### 第一步：`fake.ts` 的 catch-all（commit `073d35d`，已提交）

整个泵体包进 `try { … } catch { stream.end() }`。挂死当场消失：`end()` 让消费者正常收尾，unhandled rejection 也没了。**实测 `agentLoop` 45ms 内 settle。**

### 第二步：`agentLoop` 把中止当故障报（本次修，未提交）

第一步之后不挂了，但**收尾方式是错的**——`agentLoop` 会 reject：

```
Error: assistant stream ended without a done event
  at consumeAssistantMessage (../ai/src/stream-fn.ts:48:9)
  at agentLoop (src/agent-loop.ts:54:19)
```

两个问题，其实是同一个：

1. **Ctrl+C 被打成 provider 故障。** 那条错误是留给「provider 没发 done 就结束」的契约违反用的。中止是用户意图，不是契约违反——用户按停却看到一句像 bug 的报错。
2. **用户那一轮被整个丢掉。** 探针实测：abort 后 `messages` 只剩 `[{role:"user", text:"hi"}]`，assistant 回复蒸发。而 `agent-loop.ts:28` 和 `:45` 两处 abort 检查点都是 `return options.messages`——**abort 在本项目里是 return，不是 throw**，只有流内这一处例外。

修法（`packages/core/src/agent-loop.ts:54-68`）：把 `consumeAssistantMessage` 包进 try，catch 里查 `options.signal?.aborted`，是中止就 `return options.messages`，否则原样 `throw`。三处检查点语义就此统一。

半截消息**不进历史**（它不满足「只有 done 进历史」），所以终端上留着半句、历史里没有对应的半条——这个不一致是有意的，中止时那半句本来就不是一个完整的模型输出。

新测试：`core/test/agent-loop.test.ts` 的 `"returns instead of rejecting when aborted mid-stream, keeping the user turn and no half message"`。**已验证它在没有这个修复时会失败**（`git stash` 掉 src 改动实跑过），不是摆设。

### 留下的语义尾巴（阶段 4 结算）

中止现在表现为「静默 return」。阶段 4 有了 `AgentEvent` 之后，UI 需要知道「这轮以 aborted 结束」才能把终端那半句收个尾（补换行、打 `^C` 标记）。那时该走 `error` / `aborted` 事件变体（Pi 的 `ai/src/types.ts:817`），而不是让 `agentLoop` 的返回值兼职表达这件事。**本次没动它，是刻意的。**

---

## 5. 下一个阶段要读什么（阶段 4「事件分层与生命周期」）

spec §5 的阶段 4 块 + §4.5（`AgentEvent` 联合类型在 spec 第 183-187 行附近）。阶段 4 的范围从 spec 抄：

- 新概念：**`AgentEvent` 分层 + `Agent` 类**
- 决策点：为什么 `AgentEvent` 要分这么多层，而不是直接复用 `AssistantMessageEvent`？
- 已验证的相关事实：Pi 的 `AgentEvent` 联合在 `pi/packages/agent/src/types.ts:505-545`；Pi 的循环里 `start` 会把 partial **推进 `context.messages`**、9 个 delta 变体逐个 `emit({type:"message_update", assistantMessageEvent: event, message: {...partialMessage}})`（`pi/packages/agent/src/agent-loop.ts:414-441`）——这正是 spec 阶段 3 验收 #4 说的那个 `partial`。

**注意**：spec 阶段 3 验收 #4 说的 `message_update` 的字段名是 `partial`，而 spec 自己的 `AgentEvent` 定义（第 183 行）写的是 `{ type: "message_update"; message: Message; event: AssistantMessageEvent }`。**两处对不上**——阶段 4 写计划时要定：是把 spec 第 183 行改成 `assistantMessageEvent` + `partial`（对齐 Pi），还是在阶段 3 文档里注掉验收 #4 的措辞。**这是阶段 4 的第一个待决问题，不是我留的坑。**

---

## 6. 待办清单（明天按顺序）

- [ ] **提交未跟踪的计划文档**：`docs/plans/2026-10-10-stage-3-streaming.md`（唯一未跟踪文件）。建议 `git add` 后一次 `docs(stage-3): implementation plan`。
- [ ] **回测阶段 3**（学习主载体）：读 `docs/stages/03-streaming.md`，先自己答四问，再写 `docs/stages/03-回测答案.md`。格式照抄 `docs/stages/01-回测答案.md`（每题：一句话 + 拆开几层 + Pi 行号 + 反面情形 + 小结表）。四问：
  1. 为什么 delta 事件不进消息历史，只有 `done` 携带的消息进？
  2. 为什么 `StreamFn` 必须从 `AsyncGenerator` 换成 `EventStream`？
  3. 为什么 delta 的字段叫 `partial` 而不是 `message`？（提示：最后一刻两者内容相同，为什么仍是两个名字）
  4. 为什么 provider 没发 `done` 就结束时要抛具名错误，而不是返回空消息兜底？
- [x] ~~**修 §4 的 abort 挂死 bug**~~ —— 2026-10-11 已修完（`073d35d` 的 catch-all + 本次 `agentLoop` 的 abort 语义修正），未提交。
- [ ] **阶段 4 计划生成**（用户会主动说「开始阶段 4 的计划」）。
- [ ] 可选：`docs/stages/02-tools-and-loop.md` 存在但**没有**对应的 `02-回测答案.md`（阶段 1 有、阶段 3 引用了但还没写）。若想补齐学习闭环，阶段 2 的回测也还没做。

---

## 7. 工作方式约定（这个项目的学习契约）

- **Claude 实现（或写计划），用户学设计思路，阶段之间做回测（苏格拉底式问答）。** 每个阶段交付：可运行的程序 + `docs/stages/NN-<name>.md` + 一次 commit。
- **计划文档放 `docs/plans/YYYY-MM-DD-stage-N-<slug>.md`**（不是 superpowers 默认的 `docs/superpowers/plans/`——spec §7.1 只列 `docs/specs/` 和 `docs/stages/`）。
- **阶段文档四段结构**：这个阶段解决了什么问题 / Pi 的哪条决策是答案（带行号） / 替代方案为什么更差 / 决策点（供回测）+ 已知代价 + 实施中发现的偏差留档。
- **commit 前缀**`feat(stage-NN):` / `docs(stage-NN):` / `fix(stage-NN):`，结尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 用户的完整实现历史：阶段 1 的 6 个 commit（`274521c`..`d471ec5`）、阶段 2 的 11 个（`cc5f635`..`f9a6c0b`）、阶段 3 的 6 个（`c15de4f`..`ecf3e8b`）。

## 8. 硬约束（写代码前必看）

- **零运行时依赖**：所有包 `dependencies` 为空（`cli` 只有两个 workspace 依赖）。
- **`erasableSyntaxOnly: true`**：禁 `enum`、**构造函数参数属性**（`constructor(private x: number)` → `TS1294`）、`namespace`；类型导入必须 `import type`。**已实测合法**：`protected` 字段、`readonly #私有` 字段、`override` 方法。
- **跨包导入用包名，包内相对导入带 `.ts` 后缀**；tab 缩进；每个 `src` 文件 < 200 行（当前最大 `event-stream.ts` 138 行）。
- **`grep -rn "fake\|anthropic" packages/core/src/` 必须为空**——core 不认识任何 provider 实现，这是可机器验证的边界，不是口头承诺。
- **`pnpm dev` 走 `node --experimental-strip-types`，不走 vitest**（阶段 4 需要真实 TTY 与 Ctrl+C，阶段 9 需要 kill 进程）。
- **注释解释「为什么」，不解释「是什么」。**

## 9. 当前代码规模

```
packages/ai/src/event-stream.ts    138   ← 本阶段新增，最大文件
packages/core/src/tools.ts         130
packages/core/src/agent-loop.ts    113   ← 本阶段 −3 行（消费逻辑抽去了 ai）
packages/ai/src/fake.ts            103   ← 本阶段 +58，含 §4 的 bug
packages/core/src/execute-tool-calls.ts  89
packages/cli/src/index.ts           71
packages/ai/src/types.ts            54
packages/ai/src/stream-fn.ts        44
packages/core/src/tool.ts           24
源码合计约 638 行；测试 6 个文件 66 个用例（ai 26 / core 40）
```

阶段 3 源码增量约 250 行，与 spec 的预算一致。
