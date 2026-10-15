# 阶段 10 —— 上下文压缩

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §3.2(b)、§4、§5 阶段 10  
> 计划：`docs/plans/2026-10-15-stage-10-context-compaction.md`

## 这个阶段解决了什么问题

阶段 9 之后，session journal 只会变长，而模型的 context window 有限。长会话必然撞窗：不处理，provider 报错然后会话卡死；真删历史，阶段 9 的 branch 和审计承诺全部作废。

阶段 10 增加**上下文压缩**：不删除任何 entry，而是追加一条 `compaction` entry；之后每次模型请求前，把当前祖先路径**投影**成「累计摘要 + 最近完整 turns」。三条触发路径：手动 `/compact`、请求前阈值检查、provider 报超窗后的单次恢复。

## Pi 的哪条决策是答案

对应 Pi `compaction/compaction.ts`（`shouldCompact` / `findCutPoint` / `estimateTokens`）与 `core/messages.ts` 的 summary message。本项目采用其决策，不照搬实现。

### 1. 压缩是 append-only 历史里的一个 entry，不是删除

```text
journal:  ... u1 a1 u2 a2 u3 a3 [compaction C(summary, firstKept=a2)] u4 a4
投影:     system… [summary] a2 u3 a3 u4 a4
```

`SessionJournal` 仍是完整事实源：压缩只 append，旧 bytes 永远是新文件的前缀。`firstKeptEntryId` 是投影边界，**不改变 parent tree**——C 的 parent 是 append 前的 leaf。append 与 open 共用同一个边界校验：firstKept 必须存在、必须在 parent 的祖先链上、必须是 submission 或非 toolResult 的 message entry。坏边界连盘都不落。

因为投影是纯函数，`branch()` 到压缩之前的 entry 就恢复原始未压缩上下文；branch 到压缩之后则应用该分支上最新的 compaction。时间旅行与压缩共存，这正是「不能真删」的原因。

### 2. 阈值判定、切点与 usage 校准都是纯函数

- `shouldCompact(tokens, window, settings)` 严格大于：`tokens > window - reserve`。刚好顶到边界不压缩，超过 1 token 才压缩。阈值公式只活在 `compaction.ts`，调用方不得复制。
- `estimateTokens(message)` 逐条粗估（字符数 / 4），system sections 与工具声明都计入。
- `estimateContextTokens(projection)` 优先用最新有效 assistant `usage` 校准：`inputTokens + outputTokens`——cache read/write 已含在 inputTokens 里，**不能重复加**。`error`/`aborted`/全零 usage 不是校准点。
- **压缩后旧 usage 失效**：它量的是压缩前的大上下文。投影里 latest compaction 之前的 assistant usage 被忽略（校准区从 C.parent 之后开始），直到压缩后出现新 usage，都回退到逐条粗估。

### 3. 切点只能落在完整 turn 边界

一个 retained turn = 一条有效（非 error/aborted）assistant + 紧随其后的全部 toolResult。`findCutPoint` 从尾部数 N 条有效 assistant，候选 entry 之前的 conversation 进摘要，候选及其后原样保留。**切点永远不会落在 toolResult 中间**——否则模型看到没有结果的 toolCall（或没有调用的 toolResult），协议直接坏掉。parallel 结果的完成顺序不影响切点。

### 4. 摘要是一次独立的无工具请求

摘要走同一个底层 `StreamFn`（不悄悄换 provider），但不是普通 session turn：单独的 summarization system prompt、一个 `<conversation>` 包裹 JSON 序列化历史的 user message、`tools: []`。响应为 `error`/`aborted`/`length`、含 toolCall、或文本全空白时**明确失败**：不 append compaction entry，不发 completed 事件，原错误传播。空摘要等于悄悄丢历史，宁可不压。

### 5. overflow 恢复只重试一次

provider 用结构化 `AssistantMessage.errorKind === "context_overflow"` 报超窗（classifier 只在 provider 层识别 Anthropic/Kimi 的 `invalid_request_error` + 超窗短语；**core 禁止匹配错误字符串**）。`stopReason: "length"` 仍是输出上限，走阶段 2 的截断整批保护，不触发压缩。

overflow turn 先正常 `turn_end`（诊断消息已 journaled 供审计），然后压缩，再开新 turn 重试。guard 保证一次 submit 最多恢复一次：第二次 overflow、普通 provider error、摘要失败都正常结束为 error，不递归——否则「超窗 + 压缩也失败」会烧成无限循环。overflow 诊断留在 journal，但从下一次模型上下文投影中排除：每次请求都背着失败现场既浪费窗口也干扰恢复。

## 三条路径的分工

| | manual | threshold | overflow |
|---|---|---|---|
| 触发 | `/compact` / `session.compact()` | `prepareRequest`（每次模型请求前） | 结构化超窗后 |
| `enabled:false` | 仍可用 | 关闭 | 仍可用 |
| 时机 | session idle（runExclusive 守卫） | active run 内 | active run 内 |
| Agent 重建 | 立即（idle） | run settle 后 | run settle 后 |

run 内压缩（threshold/overflow）只 append entry 并返回新的 request projection，**绝不当场替换正在运行的 Agent**；`runSubmission()` 在旧 Agent 完全 settle 后才从 journal 重建。`compaction_start` 在摘要请求前发出，`compaction_end(completed)` 在 entry fsync 后；失败是成对的 `start + end(error)`，journal 不留半成品。

## 替代方案为什么更差

| 替代方案 | 失去什么 |
|---|---|
| 真删除旧消息 | branch 回时间旅行；压缩是有损的，删掉就再也拿不回原文 |
| 滑动窗口硬截断 | toolCall/toolResult 对被切开；system/工具历史丢失；无审计 |
| 每次都重新摘要全部历史 | 摘要成本随历史线性增长；旧摘要 + 新增量的滚动摘要便宜得多 |
| overflow 无限重试 | 压缩也救不回来时无限烧 token；一次重试后错误必须见光 |
| core 匹配 provider 错误字符串 | core 与 provider 字符串耦合，换 provider 就要改 core；结构化 kind 才是契约 |

## 决策点（供回测）

1. 压缩为什么不删除 entry？如果投影掩盖了 append-only，哪些承诺会消失？
2. 切点为什么不能落在 toolResult 上？`firstKeptEntryId` 为什么必须是 parent 的祖先？
3. 重复压缩时，为什么第一份摘要是第二次摘要的输入而不是并列进入 context？压缩前的 usage 为什么失效？
4. 摘要为什么必须是独立的无工具请求？空白/error/length 摘要为什么不能写入 journal？
5. overflow 为什么只能 retry 一次？`length` 与 `context_overflow` 的区别是什么？

## 实施边界与成本

阶段源码净增 **+764 行**（目标约 380，明确接受的偏差）：compaction.ts 246（纯函数 + 摘要请求）、session-context.ts 105（投影）、agent-session.ts +143（三条路径编排）、journal 边界校验 +51、anthropic-error.ts 45（结构化分类）、loop/Agent/CLI 接线 +174。超额来自真实机制——三条触发路径、append/open 双层边界校验、usage 校准失效规则各有不可替代的正确性边界，不是靠拆文件能减下去的复杂度。

零新增运行时依赖。未实现：`ExtensionAPI`/通用 hook 注册表（阶段 11）、WebSocket/UI（阶段 12）、子 agent（阶段 13）、`/fork` 新文件命令。CLI 的 compaction 事件只打印手动命令结果，不把可能敏感的摘要正文写到终端。

## 验收

`pnpm test` 与 `pnpm check` 全绿（ai 176、core 255）。覆盖：

- 阈值边界：79/80/81 三值、disabled、非法 window/reserve/keepRecentTurns 具名错误。
- 切点：完整 turn 保留、parallel 结果顺序无关、error/aborted 不计入、retained 不足或无可摘要前缀返回 undefined。
- token 估算：chars/4、cache 不重复计、压缩前 usage 失效、压缩后新 usage 恢复校准。
- journal：append-only（旧 bytes 前缀不变）、坏边界 append/open 双拒、手写坏 JSONL reopen 拒绝。
- 投影：summary 固定 wrapper、system/工具历史完整重放、最新 compaction 唯一生效、branch 回原文、overflow 诊断留在 state 但不进模型上下文。
- 摘要请求：独立无工具、五种不安全响应全拒、第二次摘要基于旧摘要 + 新增量。
- 三条路径：手动（事件成对、append 失败不留痕）、threshold（恰好等于不压、超 1 token 才压、disabled 不自动压）、overflow（单次重试、第二次不重试、provider error/length 不误判、摘要失败原错误传播）。
- CLI：`/compact` 是命令不是 submission（零 provider 请求、零写入）、`ANTHROPIC_CONTEXT_WINDOW` 覆盖与非法值拒绝。
