# 阶段 13 —— 子 Agent 与中途插话

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 13  
> 计划：`.superpowers/sdd/2026-10-26-stage-13-subagents-and-steering/`（Task 1–8 brief）

## 这个阶段解决了什么问题

阶段 2–12 的 loop 一旦启动就只有两种结局：模型自己停下，或者熔断/出错。运行中途用户想说"别改那个文件，改这个"没有任何通道——`prompt()` 被 active run 拒绝，消息数组在循环手里，subscriber 只能旁观。agent 本该停下时想补一句"顺便再跑一下测试"，也只能等 run 结束再开新 run，丢掉同一会话的连续性。

两个需求听起来都是"往历史里塞一条 user 消息"，但时序完全不同：

- **steer** 要在**当前 turn 结束后、下一次 provider 请求前**生效——模型还在循环里，插队是为了改变它接下来的行为。
- **followUp** 要在 **agent 本该停下来时**才注入——如果模型还在工具驱动的回合中，抢先注入会污染它正在进行的推理。

阶段 13 的第二个问题是**单个工具调用脱离循环执行**。阶段 5 的工具管道（prepare → validate/hook → execute → finalize → afterToolCall）只在 loop 内部可达；子 agent、后台任务、单次重试都想要这条管道，却不想要事件流和消息历史。第三个问题是**子 agent 隔离**：父 agent 委派一个子任务时，子 agent 的多轮工具探索不应进入父的历史——子上下文爆炸不能拖垮父。

本阶段的四个交付物：`PendingMessageQueue` 与 `QueueMode`、双层循环与 `Agent.steer()` / `Agent.followUp()`、`runToolCall()` 独立入口、`createSubagentTool()` 隔离委派。

## Pi 的哪条决策是答案

对应 Pi 的 `PendingMessageQueue`（`agent.ts:143-174`）、`steer`/`followUp`（`agent.ts:112`/`:117`）、`runToolCall` 导出（`agent-loop.ts:811`）、双层循环的 follow-up 分支（`agent-loop.ts:179`/`:302-308`）与 `QueueMode`（`agent/src/types.ts:55`）。本项目采用其决策，不照搬 Pi 的 TUI 交互层。

### 1. 两个队列，两个时机

`Agent` 持有两个 `PendingMessageQueue`，分别对应两种语义。`PendingMessageQueue` 本身是极简 FIFO：`enqueue(message, mode)`、`drain()`、`clear()`、`size`。`QueueMode` 只有两种：

- `"one-at-a-time"`（默认）：每次 `drain()` 只取队首一条。steer 典型场景是一次纠正一条，逐条看模型反应。
- `"all"`：队首为 `all` 时一次 drain 清空全队，按 FIFO 返回。适合"把这几条背景一起给它"。

mode 跟随**队首条目**而不是调用方最后一次使用：混合队列 `u1(one), u2(all), u3` 第一次 drain 得 `[u1]`，第二次得 `[u2, u3]`。测试 `pending-message-queue.test.ts` 固化了这个语义。

入队有生命周期闸门：`Agent` 在 run 开始（`runWithLifecycle`）打开 `acceptingQueueMessages`，在 `agent_end` 事件投递给 listener 之前关闭；idle 时或 `agent_end` listener 里调用 `steer`/`followUp` 抛 `"Cannot steer/followUp without an active run"`——迟到插话属于下一次 run，不能悄悄混进已经结束的历史。空白输入是 no-op，不污染队列。run 结束时 finally 清空两个队列，终止性 turn 留下的 steer 不会泄漏进下一次 `prompt()`。

### 2. 双层 while：内管 steering，外管 follow-up

阶段 2 只有内层。现在：

```text
外层 while (true):                    # 处理 follow-up —— agent 本该停下时，队列有货就重进内层
  内层 while (state.turn < maxTurns):  # 处理 tool call 与 steering
    注入 follow-up messages（若有，turn_start 之后逐条 append + emit）
    注入 steering messages（若有，同上）
    result = runAgentTurn(...)        # 完整一轮：provider 请求 + 工具执行 + turn_end
    terminal → 发 agent_end，返回
    drain steering：有 → 留在内层；无且 result === "stop" → normalStop，退出内层
  normalStop 才 drain follow-up：空 → 发 agent_end，返回；非空 → 外层再转一圈
```

steering 的注入点是**每个 `runAgentTurn` 返回后**：`turn_end` 事件已发（订阅者先看到轮次关闭），下一次 provider 请求未发。这回答了 spec 的决策点"为什么 loop 需要双层 while"——内层解决"运行中插队"，外层解决"本该停下时再续一段"；两者共享同一个 `AgentTurnState`（`turn` 计数与 `overflowRecovered` 跨段保留），所以 follow-up 续上的不是新 run，是同一次 run 的下一段。

### 3. steer 与 followUp 的时序表

| 场景 | `steer` | `followUp` |
|---|---|---|
| 入队后第一个生效点 | 当前 turn 结束（`turn_end` 已发）、下一次 provider 请求前 | 内层以正常 `stop` 退出之后 |
| 无工具的 stop turn | turn 完整结束 → 注入 → 内层直接再来一轮（不经过外层） | 外层重启内层，效果同上但路径不同 |
| 工具驱动的 continue turn | 下一次 provider 请求前注入，模型带着纠正继续 | **不抢**——等模型自然 stop 的那一轮结束后才注入 |
| `finishTurn` 返回 `"end"` | stop 时在 drain steering 检查点照常注入 | 外层照常重启内层（spec 验收 #3） |
| `terminate: true` 的工具 | turn 返回 terminal，**不注入**，队列清空 | **不复活** run |
| provider error / aborted | 同上，terminal | 同上 |
| maxTurns 预算耗尽 | 抛 `hit maxTurns` 错误，**不消费**队列 | 同上（全局预算见下） |

最后三行是本阶段的**硬停优先级**：`terminate`（工具要求立即停止）> provider error/aborted（turn 级 terminal）> maxTurns 耗尽（run 级熔断，抛错）> `finishTurn: "end"`（可续收敛，可被 steering/follow-up 接续）。只有最后一类停下时才看 follow-up 队列；terminal 与熔断都不 drain。测试 `agent-follow-up.test.ts` 分别覆盖了 terminate、provider error、abort 三种硬停后 follow-up 不复活、也不泄漏进下一次 run 的 context。

### 4. 全局 maxTurns

`state.turn` 是**整个 run** 的预算，不是每一段内层的预算。初始段 + 任意多段 follow-up 续段共享它：`maxTurns: 2` 时第一轮后 follow-up 续一段，第二轮结束后再想续会被预算挡住，provider 恰好被调 2 次，最终 assistant 为 `stopReason: "error"` 且文本含 `maxTurns (2)`。错误信息带最后一轮的工具名（从倒数第二条 assistant 里找 toolCall——每轮最后一条是 toolResult），不合成 assistant 消息就抛——熔断本身就是异常路径。不为 `finishTurn: "continue"` 或 follow-up 单开计数器：预算的意义是"这个 run 最多找模型 N 次"，续段没有豁免权。

### 5. `runToolCall()`：同一管道，无事件无历史

`runToolCall(toolCall, options)` 与 loop 内的批处理走**完全相同**的 prepare → execute → finalize → afterToolCall 管道（复用 `tool-call.ts` 与 `execute-tool-calls.ts` 的 `toolCallContext`），但：

- 不接受 `emit` / `toolExecution` / `commitToolIntent`——partial update 被空 sink 吞掉，事件订阅者什么都看不到；
- 从不写 `options.messages`，不写 journal——调用方拿到 `FinalizedToolCallOutcome` 自行处置；
- pre-aborted 的 signal 在 prepare/execute 前短路，execute 零次调用。

beforeToolCall 拦截、schema 校验、抛错映射、afterToolCall 覆盖全部照旧。需要 durable recovery 的调用仍必须走 `AgentSession`——`runToolCall` 是刻意不提供恢复语义的。用途：子 agent 的工具装配、后台任务、单次工具重试（后两者本阶段只提供原语，不建编排）。

### 6. 子 agent 隔离

`createSubagentTool({ system, streamFn, tools, maxTurns, name? })` 返回一个普通 `ToolDef`（默认名 `delegate`），模型像调任何工具一样调它，`task` 是参数。每次 execute：

1. 空白 task 直接返回 error result，不建 child。
2. 新建独立 `Agent`：自己的 system、**空 messages**、显式给定的 tools 副本、可选 maxTurns。父的历史、system、工具集一概不进 child。
3. 父的 abort signal 链到 child（`finally` 里移除监听）；child 先被 abort 时返回 `"Operation aborted"` 错误结果。
4. child `prompt(task)` 跑完 N 轮后，只取**最后一条 assistant 消息的文本**回给父；`error`/`aborted`/`length` 三种 stopReason 映射为 `isError: true`，文本为空时回退 `errorMessage`、再回退 `"Operation aborted"`。
5. 工具的 `replay` 固定为 `"unsafe"`：child 的执行不可重放，session 恢复不会替它重跑。

父的事件流与消息历史里只有一条 toolCall 和一条 toolResult——child 的中间轮次（包括它自己的工具调用与结果）对父完全不可见。

### 7. session user 持久化

`AgentSession.steer()` / `followUp()` 只是委托给当前 agent，不建第二份队列。持久化在事件侧完成：`runSubmission` 在 `agent.prompt()` 前置 `skipNextSubmissionUser = true`，`persistEvent(message_end)` 遇到首个 user 时清标记、保持旧的 submission 去重（初始 user 只由 `submission` entry 重建，不重复写 `message` entry）；**同 run 后续 user 一律 append `{ type: "message", message }`**。reopen 后 steer/followUp 注入的用户和模型回应一起按 journal 重放——崩溃恢复后插话不丢。session version 与 entry union 未变。

## 替代方案为什么更差

| 替代方案 | 失去什么 |
|---|---|
| 两个插话共用一个队列 | "立即生效"与"停下才生效"无法区分：要么 follow-up 抢在工具驱动的下一轮之前污染推理，要么 steer 得等到 agent 完全停下，失去纠正的意义。时序表塌成一行 |
| 共享 messages 数组的父子 agent | 子的多轮探索全部进父历史：父的 context 被子的中间噪声塞爆（这正是 spec 要求隔离的场景），且无法分别 abort、分别限轮 |
| 把 child 的事件直接转发给父订阅者 | 父的订阅者看到双倍交错的事件流，UI 无法区分来源；stage 12"UI 只订阅事件"的边界被击穿 |
| 用递归调 `runToolCall` 代替双层循环 | `runToolCall` 不发事件不写消息——turn 生命周期、`turn_start`/`turn_end` 配对、`agent_end` 唯一性、steering 检查点全部要在调用处重建，队列时机反而丢失；Agent 也不支持重入 |
| 每次 drain 清空全队（无 one-at-a-time） | 模型一次看到全部纠正，失去"插一条、看反应、再插"的交互粒度；`all` 作为显式 opt-in 保留批量语义 |
| 为 follow-up 续段单开 maxTurns 计数器 | 预算语义变成"每段 N 次"，follow-up 可以无限续段，熔断名存实亡 |
| steer/followUp 任何时候都接受入队 | 迟到插话混进已结束的历史；idle 调用静默丢失，调用方误以为生效 |
| execute 前把 child intent 写进父 journal | child 执行不可重放（`replay: "unsafe"`），父的恢复逻辑会被不可重放的子意图污染 |

## 决策点（供回测）

1. 为什么必须是**两个**队列？如果共用一个队列，steer 和 followUp 各会失去什么时序保证？（对照时序表前三行）
2. 为什么 loop 要双层 while？把 follow-up 检查塞进内层（stop 时直接看 follow-up 队列）会改变哪些可观察行为？
3. 硬停优先级里，`terminate`、provider error、maxTurns 耗尽为什么都**不看** follow-up 队列？`finishTurn: "end"` 又为什么可以看？
4. maxTurns 为什么是全局预算而不是每段预算？"续段"凭什么不刷新预算？
5. `runToolCall` 复用批处理管道却去掉 emit/commitToolIntent/消息写入——这三个缺失分别保护了 loop 内的什么不变量？
6. 子 agent 只回最后一条 assistant 文本给父：如果改为回全部 assistant 文本或转发 child 事件，父的上下文与事件流分别会发生什么？
7. `AgentSession` 里初始 user 走 submission 去重、后续 user 走 `message` entry——为什么不能统一写成 `message`？reopen 时两种 entry 的重建路径差在哪？

## 非目标

- 不做真实 provider 联调（CI 内全部是确定性假模型；本阶段未手动联调真实模型）。
- 不做后台任务编排与自动工具重试——`runToolCall` 只是原语。
- 子 agent 不继承父工具集（显式给定，防递归 delegate），没有独立 child journal，不参与父 session 恢复。
- 不做跨进程/跨机器的队列：插话只在单进程单 run 内有意义。
- 不改 stage 12 的 UI/server/protocol：它们只看到既有的 `AgentEvent` 流，本阶段事件类型零新增。
- 不做 `QueueMode` 的更多档位（如按 token 合并、优先级插队）。

## 实施边界与成本

六个新增/拆出的 loop 相关文件各 `< 200` 行（`wc -l` 实测）：

| 文件 | 行数 |
|---|---|
| `packages/core/src/pending-message-queue.ts` | 35 |
| `packages/core/src/agent-loop.ts` | 103 |
| `packages/core/src/prepare-agent-turn.ts` | 103 |
| `packages/core/src/agent-turn.ts` | 135 |
| `packages/core/src/run-tool-call.ts` | 66 |
| `packages/core/src/subagent-tool.ts` | 69 |

`git diff --numstat master...HEAD -- packages/core/src` 实测：535 additions / 227 deletions，**净增 308 行**，低于 spec 约 350 行的源码预算。其中 agent-loop.ts 从 master 的 279 行降到 103 行（Task 2 的单轮机械拆分），agent.ts 296 → 328，agent-session.ts 569 → 584（队列转发与 user 持久化 +15），`agent-options.ts` +23、`index.ts` +7。

**既有超限债务**（master 上已 > 200 行，非本阶段制造）：`agent-session.ts` 569 → 584、`session-journal.ts` 273、`compaction.ts` 246、`session-recovery.ts` 216、`agent.ts` 296 → 328；`agent-loop.ts` 279 → 103 是本阶段唯一缩下来的。stage 9 文档已记录 session 四文件超预算是有意接受的偏差；本阶段只让 agent-session 微增 15 行，未新增任何超限文件。

零新增运行时依赖：`pnpm list -r --depth 0 --prod` 显示 core 仍只依赖 `@mini-agent/ai`。session journal version 保持 1，entry union 未变。

**五项 spec 验收的测试落点**（`pnpm test` 全绿：8 包 64 文件 736 测试）：

1. steer 时机：`packages/core/test/agent-steering.test.ts` — "injects steering after the complete tool turn and before the next provider request"（事件时间线 `turn_end < steering_start < provider#2`，第二个 provider context 末位是该 user）。
2. followUp 续 run：`packages/core/test/agent-follow-up.test.ts` — "continues a normal stop in the same run with the queued user message"（1 对 agent_start/agent_end，follow-up 的 `message_end` 在唯一 `agent_end` 前）。
3. 双层循环：`agent-follow-up.test.ts` — "re-enters the inner loop after finishTurn requests end"（`finishTurn: () => ({ action: "end" })` 仍调第二次模型）。
4. 子 agent 隔离：`packages/core/test/subagent-tool.test.ts` — 父 transcript 恰为 `system,user,assistant,toolResult,assistant`，child 跑 echo 工具 + 最终文本两轮，父只收 `"child final"`。
5. runToolCall：`packages/core/test/run-tool-call.test.ts` — emit spy 零调用、`messages` 与 `structuredClone` 基线一致、outcome 形状完整；拦截/未知工具/抛错/abort 短路各就其位。

持久化落点：`packages/core/test/session-queued-messages.test.ts` — reopen 后 user 序列为 `["go","change","again"]`，submission 恰 1 条不重复，steer/followUp 各有一条 `message` entry。
