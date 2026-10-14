# 阶段 8 —— System prompt 即历史

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §3.2(b)、§5 阶段 8  
> 计划：`docs/plans/2026-10-14-stage-8-system-prompt-history.md`  
> 交互图解：[`08-system-prompt-history-explained.html`](08-system-prompt-history-explained.html)

## 这个阶段解决了什么问题

阶段 1–7 里 system prompt 是一个 `string` 参数，模型可见工具集来自 `AgentState.tools` 注册表。这是两份易变状态，在三处会出问题：

1. **resume**：只持久化 conversation messages 时，"当时的 prompt" 丢了；另存一份就是第二份真相，可能和历史分叉。
2. **prompt cache**：每轮用参数现拼 system 文本，无法证明两次请求的前缀逐字节一致——追加一段背景就全缓存失效。
3. **动态工具**：原地改 `state.tools` 之后，历史里早期的 assistant 轮次与"当时的工具集"脱钩，重放与审计都失真。

阶段 8 把这两者都改成 append-only transcript 里的 `SystemMessage` 增量记录：

```ts
interface SystemMessage {
	role: "system";
	sections: { tag?: string; text: string }[];  // 增量段落，只追加
	toolsAdded?: Tool[];      // 本轮新增的工具声明
	toolsRemoved?: string[];  // 本轮移除的工具名
}
```

"当前 prompt" 与"当前工具集"不再是字段，而是对整条 transcript 做一次 O(n) 重放的结果：

```text
transcript:  [system₁] user assistant [system₂] user assistant toolResult …
                 │                  │
                 └──── 重放 ────────┘
                        ↓
        snapshot = { sections: 全部累计, toolsAdded: 当前声明集合 }
                        ↓
              StreamContext { system: snapshot, messages, tools }
```

`AgentOptions.system: string` 保留为新会话的组装层简写：只在 `messages` 不含任何 system entry 时生成一条 leading SystemMessage；已有 system 历史（resume）时该值被忽略，transcript 是权威。

## Pi 的哪条决策是答案

对应 spec §3.2(b)：Pi 把 system/tool changes 建模为 transcript entries（`packages/ai/src/types.ts:541`、`utils/transcript.ts:99`，行号沿用总设计，未本地复核）。本项目采用了已批准的简化形状：不照搬 Pi 后续版本的 `content`、命名 section patch、timestamp 或 `ToolReference`。

具体到本仓库的落点：

### 1. 重放是纯函数，快照只活在请求里

`packages/ai/src/transcript.ts` 提供一组只读 helper：`getCurrentSystemMessage` 产出累计 snapshot（只含 sections 与当前 `toolsAdded`，不回带已消费的 `toolsRemoved`），`getCurrentSystemPrompt` 把非空 section text 以 `"\n\n"` 连接（tag 是元数据，不渲染进文本），`getCurrentTools` 用 name-keyed Map 按首次/重新加入顺序输出当前声明。

`agentLoop` 每轮调用 `streamFn` 前重新重放，snapshot 不写回 transcript。provider 拿到的 `context.messages` 仍含全部 system entries——那是阶段 9 持久化要存的真相；wire 转换层负责把它们跳过。

### 2. 工具变化按声明内容比较，不按对象身份

`toolDeclarationsEqual` 只比较 model-visible 的 `name`/`description`/`parameters`；`execute` 闭包、`replay`、`executionMode` 是运行时属性，不参与比较。`getToolStateChanges` 产出最小 delta：

- 结构相同的新对象 → 无 delta，不新增历史条目（cache 前缀稳定的前提）；
- 同名工具 description/schema 变化 → 同一条 entry 里先 `toolsRemoved` 后 `toolsAdded`，新定义生效；
- 只换 `execute` 闭包 → 无历史 delta，但注册表更新，下一次调用用新闭包。

### 3. 注册表是执行闭包仓库，不是工具状态真相

`AgentState.tools` 仍然保留，但它只回答"这个工具名的闭包在哪"。每轮允许执行的是 transcript 重放仍声明着的子集：

```ts
const activeTools = tools.filter((tool) =>
	currentTools.some((declaration) => toolDeclarationsEqual(tool, declaration)));
```

已从 transcript 移除的工具，即使闭包还在注册表里，provider 看不见、`executeToolCalls` 也只会走既有的 `Tool "x" not found` model-fixable 错误路径，不会偷偷执行旧闭包。

### 4. 更新只追加，且运行中禁止

`Agent.appendSystemSections()` 追加 `{ role: "system", sections }`；`Agent.setTools()` 先重放旧声明、算最小 delta，两边都空就不新增条目。两个方法在 active run 期间抛具名错误——单次 run 的 provider snapshot、执行表和历史不能中途分叉。初始 system message 在构造时写入 state，不发 `AgentEvent`；`agent_end.messages` 仍只含本次 run 新增的 conversation messages。

### 5. 裁剪不破坏重放

丢弃旧 conversation entries、保留全部 system entries 后，`getCurrentSystemPrompt` / `getCurrentTools` 的结果逐字节不变。阶段 10 的 compaction 因此只需要处理 conversation 部分，prompt 与工具状态天然正确。本阶段只用纯函数测试验证这条性质，不实现 compaction entry、token 阈值或摘要。

## 替代方案为什么更差

| 替代方案 | 失去什么 |
|---|---|
| 原地改 `Agent.system` 字符串 | resume 时"当时的 prompt"无从恢复；历史与 prompt 脱钩 |
| 另存一份 current tools 字段 | 第二份易变状态，裁剪/恢复时两份真相可能分叉 |
| 每轮重新 prepend 全量 system | transcript 被重复条目污染；prompt cache 前缀每次都在变 |
| 修改旧 system entry | 历史不再是 append-only，审计与重放语义全毁 |
| 每个 provider 各自实现一套 replay | 重放规则被复制 N 份，行为分叉；provider 该只消费 snapshot |

## 决策点（供回测）

1. 为什么 prompt 从参数变成历史后，resume 不需要另存 prompt？
2. 为什么同名工具的定义变化要表示为 remove + add，而不是原地更新声明？
3. 为什么 `AgentState.tools` 仍然存在，却不是模型可见工具集的真相？
4. 为什么相同 prompt、相同工具声明的重复请求不能追加 system entry？
5. 读取 prompt 从 O(1) 变成 O(n) 重放，这个代价为什么值得？

## 实施边界与取舍

- 本阶段只**模拟**裁剪验证重放稳定性；不实现阶段 10 的 compaction entry 与 token 阈值，不实现阶段 11 的 ExtensionAPI/动态工具注册系统。
- `AnthropicRequest` wire 形状不变：顶层 `system: string` + `tools`，system entries 不进 wire `messages`；`sections`/`toolsAdded`/`toolsRemoved` 是内部 IR，不出站。
- `StreamContext` 公共形状不变（`{ system, messages, tools }`），但 `system` 与 `tools` 的语义变为 replay snapshot，不能从 `Agent` 字段直接复制。
- 执行期新增 `Agent.appendSystemSections` / `Agent.setTools` 两个公共方法；mutation helper 放在 `agent-state.ts`，`Agent` 只做 active-run 检查。
- 单文件 <200 行约束由用户放宽（2026-10-14，实现与可读性优先）；阶段源码净增量 <400 行的约束仍保留。零新增运行时依赖。

## 验收

- `pnpm test` / `pnpm check` 全绿（ai、core、cli 三个包）。
- transcript 重放：增量、裁剪、声明变化、不可变性（冻结输入两次调用结果一致）。
- Agent：leading system message 只写一次；已有 system 历史的 resume 不重复 prepend；removed tool 不发送、不执行。
- CLI 真实 provider 回归：本地 HTTP 子进程完成 text/tool/result/final response，第一条请求 system 文本为 `"You are a minimal teaching agent."`，连续两次请求的 system 与 tool 声明逐字节一致。
