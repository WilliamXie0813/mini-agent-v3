# 阶段 3 —— 流式

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 3
> 计划：`docs/plans/2026-10-10-stage-3-streaming.md`

## 这个阶段解决了什么问题

阶段 1/2 的循环把「一次响应」当成一个标量：`await` 一次拿到一条完整消息，模型在想什么必须等它想完才能看到。本阶段把响应拆成 `start → text_delta×n → done` 的事件流，让 UI 能在响应到达的过程中逐字显示——**但历史仍然只认 `done`**。

这是一次「为了让 UI 动起来而改传输层」的改动，代价是 `StreamFn` 的签名变了：返回值从 `AsyncGenerator` 换成 `AssistantMessageEventStream`。这是路线里第一次回头改已有接口。循环的收敛条件、length 保护、工具串行执行、错误回喂语义一个字都没动——阶段 2 的 16 个循环用例未经修改全部通过，就是这条承诺的证据。

## Pi 的哪条决策是答案

**`EventStream<T, R>`：推送源与 `for await` 之间的推拉适配器。**

- `EventStream`（Pi `packages/ai/src/utils/event-stream.ts:26`）：内部一个 FIFO 队列 + 一个等待者队列，`push` 时有等待者直接交付、没有就入队；`result()` 是与迭代并行的 promise，在完成事件上 resolve。v3 逐字搬运，只加了一条兜底：`end()` 时若 `isComplete` 从未触发就 `reject` 掉 result promise——否则 provider 没发 `done` 就结束，`result()` 会永远挂着（没有栈、没有错误的死锁）。
- `AssistantMessageEventStream`（Pi `:97`）：在 `done` 上用单调时钟给消息盖 `durationMs`。v3 去掉了 Pi 的「`timestamp` 早于流创建则不计时」守卫——v3 的 `AssistantMessage` 没有 `timestamp` 字段，也没有 deferred 响应（阶段 7 才有），守卫保护的场景不存在。
- 12 个事件变体（Pi `packages/ai/src/types.ts:801-817`）：v3 只留 3 个（`start` / `text_delta` / `done`）；`thinking_*`、`toolcall_*`、`error` 是阶段 7 随真实 SSE 一起加的。字段名对齐 Pi：delta 类变体用 `partial`（「还在长的那份」，不是快照），`done` 用 `message`。
- 推送泵（Pi `packages/ai/src/providers/faux.ts:523`）：假模型把整个生产逻辑甩进 `queueMicrotask`，函数立刻返回 stream——生产者跑在自己的任务里，不等消费者。
- 循环同时持有迭代与 `result()` 两个句柄（Pi `packages/agent/src/agent-loop.ts:403-414`）：v3 的 `consumeAssistantMessage` 只用迭代（`done` 里那条就是权威消息，`result()` 多一次 `await` 不带来信息），`result()` 留给宿主代码与测试。

## 替代方案为什么更差

| 替代方案 | 差在哪 |
|---|---|
| 生成器里多 `yield` 几个 delta | `AsyncGenerator` 是拉模型：消费者不 `next()`，生产者就停——阶段 7 的 SSE socket 按自己的节奏吐字节，字节没地方放。且最终消息要从迭代的 `return` 值里抠，而 `for await` 会吃掉 `return` 值 |
| 回调式 `onEvent` 参数 | 把「事件协议」降级成「一次调用的参数」；阶段 4 的 `AgentEvent` 与阶段 11 的扩展都要重新发明一个流对象 |
| delta 也入历史、消费者自己合并 | 40 个 delta 变成 40 条 assistant 消息：历史被碎片污染、持久化写 40 条无意义记录、重放无法区分「一次响应的 40 个碎块」和「用户真发了 40 条」。且丢掉 provider 侧的最终归一化（`done` 那条才是权威的） |

## 决策点（供回测）

> 答案见 [`03-回测答案.md`](./03-回测答案.md)。**先自己答，再对答案**——对答案的收益远小于自己答错的收益。

1. 为什么 delta 事件不进消息历史，只有 `done` 携带的消息进？
2. 为什么 `StreamFn` 必须从 `AsyncGenerator` 换成 `EventStream`？（用阶段 7 的 SSE 回答，而不是用「Pi 这么写」）
3. 为什么 delta 的字段叫 `partial` 而不是 `message`？（提示：`partial` 和 `done.message` 的内容在最后一刻是相同的，那为什么仍是两个不同名字）
4. 为什么 provider 没发 `done` 就结束时要抛具名错误，而不是返回一条空消息兜底？

## 已知代价

- `EventStream` 引入了一个「迭代正常结束但 `result()` reject」的状态——`end()` 兜底会把契约违反变成 rejection，无人 `await` 时靠构造时预挂的 noop catch 压住（「已处理」是标记，不是吞掉；`await result()` 的人照样拿到）。
- `partial` 是浅拷贝：`content` 数组与里面的块和 live 的那份共享引用，消费者若在 `done` 之前把它存进历史，历史会被后续 delta 继续改写。这是 Pi 原样（`faux.ts:411`），约定是「partial 只在被读的那一刻有效」。
- `chunkSize` / `delayMs` 是假模型的旋钮；真实 provider 没有「chunk 大小」这个概念——阶段 7 会发现 delta 的边界由网络决定。

## 验收对照

1. ✅ 终端逐字出现：`pnpm dev` 下假模型 `chunkSize: 1` + `delayMs: 25`，整句约 1.1 秒逐字打出（已用管道输入 + 计时验证，不是从测试推断）。
2. ✅ 一轮结束 `messages` 里只有 1 条 assistant 消息且文本完整——`core/test/agent-loop.test.ts`「keeps one assistant message per response no matter how many deltas」。
3. ✅ 事件序列 `start → text_delta×n → done` 且 delta 拼接等于 `done.message` 文本——`ai/test/fake.test.ts` 的 stage 3 describe。
4. ⏳ **`message_update` 的 `partial` 与 `done.message` 一致**——`message_update` 是阶段 4 的 `AgentEvent`，本阶段不造它（不许提前实现）。本阶段做到的是前提：事件字段已命名为 `partial`，语义与 `done.message` 的关系已在 `types.ts` 注释里定死。阶段 4 落地时该条验收无需改签名即可断言。

## 实施中发现的计划/环境偏差（留档）

- **计划 Task 6 假设 CLI 里有一段「临时验证 stage 2 工具链路」的脚本要删**——HEAD 上不存在（阶段 2 收尾时已清理），只改了 `setDefaultStreamFn` 的 options。后果：计划的 Step 4「`read package.json` 走通工具路径」在固定问候脚本下不可演示（假模型不理会 prompt）；工具路径由 core 的 16 个未改动的循环用例覆盖。
- **`agent-loop.ts` 在 Task 2 改名后没有编译报错**：循环里 `if (event.type === "done")` 的窄化让 `done.message` 依然合法——计划预期它会红，实际红的只有 fake 两侧。消费点清单以编译器输出为准。
