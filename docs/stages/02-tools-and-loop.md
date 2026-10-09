# 阶段 2 —— 工具与循环

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 2
> 计划：`docs/plans/2026-10-09-stage-2-tools-and-loop.md`

## 这个阶段解决了什么问题

一轮往返只能聊天。工具是 agent 与 chatbot 的分界：模型输出从「给人看的文本」变成「给人看的文本 + 给运行时看的指令」。本阶段让那条指令有地方去、有结果回——`agentLoop` 升级成单层工具循环：每轮 = 一次 streamFn 往返 + 一批工具执行，直到模型返回的消息里没有 toolCall 才收敛（`maxTurns` 熔断防反复）。`packages/core` 交付 `createDefaultTools()`（`[read, edit, bash]`），CLI 把它接进组装根，并渲染本轮新增的 toolCall 行与 isError 的 toolResult——成功的工具结果不打印，终端不需要看到模型能看到的一切。

## Pi 的哪条决策是答案

**三条，各自独立成立。**

1. **`stopReason === "length"` 时整批判失败，一个都不执行。** 对应 Pi `packages/agent/src/agent-loop.ts:267`：参数 JSON 被 token 上限截断后，「解析成功但不完整」的参数正是 `edit` 会误删文件的情形——半截 JSON 不能信。core 的 `agent-loop.ts` 复现为 `truncatedBatchFailures`：每个 toolCall 得到一条 isError 的 toolResult，文案给模型「重发完整参数」的出路。

2. **`executeToolCallsSequential`：串行、逐条 `await`、逐条 emit。** 对应 Pi `packages/agent/src/agent-loop.ts:530-584`：结果顺序即调用顺序。core 的 `execute-tool-calls.ts` 逐条 await 后按原顺序返回 `ExecutedToolBatch`——历史的形状由这里钉死，provider 靠 `toolCallId` 配对校验时不会错位。

3. **`createToolResultMessage`：工具结果是一条独立消息类型。** 对应 Pi `packages/agent/src/agent-loop.ts:930-944`：把 `toolCallId` / `toolName` / `content` / `isError` 装进 `toolResult` 角色的一条消息，而不是往 assistant 消息里塞字段。core 的 `packages/ai/src/types.ts` 照此定义 `ToolResultMessage`——消息 IR 从阶段 1 起就是全集，加消息类型不用回头改消费方。

## 替代方案为什么更差

| 替代方案 | 差在哪 |
|---|---|
| 工具失败时抛给调用方 | 历史里留下没有配对 toolResult 的 assistant 消息，下次请求被 provider 拒绝；且模型永远学不到错在哪 |
| 把工具结果拼成一条 text 追加给 user | 丢失 `toolCallId` 配对，provider 无法校验；模型分不清「用户说的话」和「工具的输出」 |
| 按完成顺序入历史 | 串行时无害，阶段 6 并行后必然错位——所以本阶段就写测试钉住 |
| `stopReason === "length"` 时尽力执行能解析的那些 | 「解析成功但不完整」的参数正是 `edit` 会误删文件的情形 |

**本阶段新发现的决策点：成功的工具结果为什么不打印？**

`read` 会把整个文件打屏，`bash` 会把构建日志打屏，终端会被冲掉。只打工具调用行 `→ name {args}` 与 isError 结果，成功的结果靠模型下一轮的文字体现。这条判断和阶段 12 的 UI 层一致：**终端不需要看到模型能看到的一切**。

## 决策点（供回测）

> 先自己答，再对答案——对答案的收益远小于自己答错的收益。

1. 工具执行失败时，为什么是「回喂模型」而不是「抛给调用方」？判据是什么？
2. 「结果必须按模型原始调用顺序入历史」这条约定，在串行时代价是零——那**为什么**现在就要写测试钉住它？
3. `stopReason === "length"` 时为什么**整批**不执行，而不是跳过解析失败的那几个、执行其余？
4. `ToolDef` 的 `replay` 字段现在完全是死代码（没有任何代码读它）。为什么现在写进去？

## 已知代价（埋下记号，阶段 5 对照）

本阶段没有 JSON Schema 校验（只查必填与顶层类型），模型给一个 `offset: "abc"` 会一路走到 `readFile` 才炸——阶段 5 补上；`bash` 无输出上限的实时流（`onUpdate`）也留到阶段 5。

## 实施中发现的计划/环境偏差（留档）

- **brief 的临时验证脚本里 `["done"]` 应为 `"done"`**：`FakeStep` 的字符串项就是一句回复，套一层数组会被当成 `ContentBlock[]`——字符串展开成对象后没有 `type` 字段，静默渲染为空。`node --experimental-strip-types` 不做类型检查，这个错只有肉眼输出能发现。
- **`pnpm dev` 的工作目录是 `packages/cli/`**（pnpm `--filter` 在包目录内执行脚本），临时验证的相对文件名实际落在 `packages/cli/` 下；`bash` 工具与 `read` 工具都相对同一 cwd 解析，所以配对仍然成功——但人工核查文件内容时要去包目录找。
