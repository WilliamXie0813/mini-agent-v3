# mini-agent Web UI V1 设计文档

> 状态：已批准  
> 日期：2026-10-12  
> 对应代码基线：阶段 6「并行工具」  
> 相关总设计：`docs/specs/2026-10-09-mini-agent-v3-design.md`

---

## 1. 背景与意图

mini-agent 当前已经具备：

- `Agent` 与无状态 `agentLoop`
- agent / turn / message / tool execution 三层生命周期事件
- 流式 assistant message
- `read` / `edit` / `bash` 工具
- `prepare → execute → finalize` 工具调用
- prepare 串行、execute 并行、toolResult 按源顺序回喂
- abort、single-flight 与 awaited listeners

但这些机制目前只能通过 CLI 输出和测试理解。CLI 适合验证最终结果，不适合同时观察：

- 一次 run 如何从 `agent_start` 走到 `agent_end`
- 一个 run 为什么包含多个 turn
- assistant message、工具执行和 toolResult 之间如何衔接
- 并行工具的完成顺序为什么不同于模型历史顺序
- abort 与错误路径如何正常关闭生命周期

Web UI V1 的目标是建立一个**本机单用户的 Agent 教学工作台**：用户一边操作 Agent，一边观察可验证的运行事实。

它不是普通聊天产品，也不是提前实现总设计中的阶段 12。V1 只映射当前阶段 1–6 已存在的公共能力，并随 Agent 后续阶段增量演进。

---

## 2. 目标

### 2.1 产品目标

1. 用户能选择一个确定性的 Demo 场景，输入本次 run 的用户消息并启动 Agent。
2. 用户能在中央聊天区看到流式 assistant message、工具调用摘要和最终回答。
3. 用户能在右侧 Timeline 中完整观察一次 run 的生命周期。
4. 用户能点击 Timeline 节点查看原始事件 payload、参数、结果、耗时和顺序。
5. 用户能中止正在运行的 Agent，并看到完整的 aborted 收尾。
6. UI 与 core 保持事件驱动边界，不读取或依赖 core 内部实现。
7. V1 的结构能在后续 Agent 阶段加入真实 provider、持久化、压缩和扩展能力，而不重做主界面。

### 2.2 教学目标

V1 应帮助用户回答：

- 一次 run 包含哪些生命周期层级？
- turn 与 message 的边界分别是什么？
- 流式 delta 为什么不等于消息历史？
- 工具调用和 toolResult 如何配对？
- 并行工具为什么存在两种顺序？
- abort 为什么仍然需要完整 terminal lifecycle？

---

## 3. 非目标

V1 明确不做：

- 真实 LLM provider
- provider reasoning / thinking block
- 持久化、历史会话、resume、branch
- 文件树、代码编辑器、diff viewer
- 内嵌终端
- 多 Agent 或子 Agent
- 多用户、登录、权限和公网部署
- 移动端优先设计
- 直接修改 core 来迎合 UI
- 伪造或推测模型隐藏 chain-of-thought

这些能力必须等对应 Agent 阶段提供真实协议或状态来源后再加入。

---

## 4. 核心原则

### 4.1 展示运行事实，不伪造思考

V1 展示：

- AgentEvent 生命周期
- assistant 流式事件
- 工具参数、更新、结果和耗时
- 事件相对时间与顺序
- error / aborted terminal message

V1 不把 UI 自己生成的解释冒充模型思考。

若阶段 7 之后 provider 真实提供 reasoning/thinking block，Web UI 再通过 capability 增加对应折叠区域。

### 4.2 Chat 与 Timeline 来自同一事件源

聊天区和 Timeline 不得各自读取不同的数据源：

```text
AgentEvent
   ├─ chat reducer
   └─ timeline reducer
```

同一事件流必须同时驱动：

- 当前流式 assistant draft
- 已完成消息
- 工具调用卡片
- run / turn 状态
- Timeline 节点
- selected event details

### 4.3 V1 是单 Run 工作区

- 页面一次只观察一个 run。
- 一个 run 内可以包含多个 turn、多个模型往返和多个工具调用。
- 启动新 run 前清空上一 run 的聊天、Timeline 和事件详情。
- 页面刷新、server 重启或 WebSocket 断开后，临时数据不恢复。

这避免 fake provider 被误解为可无限聊天的真实模型，也不提前实现阶段 9 的 session 语义。

### 4.4 Capability 驱动演进

server 在连接建立时声明当前 capabilities。Web 只显示当前真实可用的面板。

V1 capabilities：

- `demo_scenarios`
- `streaming_messages`
- `abort_run`
- `turn_timeline`
- `raw_event_details`

后续可能增加：

- `provider_thinking`
- `model_io`
- `persistent_sessions`
- `session_branching`
- `compaction_events`
- `extensions`
- `subagents`

不存在 capability 时，不显示空壳页签。

---

## 5. 页面布局

### 5.1 总体布局

采用 Light 主题三栏工作台：

```text
┌───────────────────────────────────────────────────────────────┐
│ Header：连接状态 / run 状态 / Stop                            │
├──────────────┬──────────────────────────┬─────────────────────┤
│ Demo 场景     │ Chat / Prompt            │ Run Timeline        │
│ 场景说明      │ Streaming messages       │ Turn groups         │
│ Provider 信息 │ Inline tool cards        │ Selected event JSON │
│ Reset         │ Prompt + Run             │                     │
└──────────────┴──────────────────────────┴─────────────────────┘
```

视觉风格：

- 暖白和浅灰作为页面与面板背景
- 蓝色作为主要交互色
- 绿色表示完成
- 红色表示 error / aborted / disconnected
- 边框和层级优先于大面积阴影
- 不提供 Dark 主题

V1 desktop-first，目标宽度为 1100px 以上。窄屏可折叠左栏或把 Timeline 变为 drawer，但不投入移动端专项设计。

### 5.2 Header

Header 展示：

- 产品名 `mini-agent`
- WebSocket 连接状态
- 当前 run 状态：`idle | running | completed | aborted | error | failed`
- active run 时显示 `Stop run`

规则：

- `running` 时禁用场景切换、Prompt 编辑和 Run 按钮。
- Stop 调用 `run.abort`，不能直接在客户端伪造结束。
- 连接断开时显示阻塞性 disconnected 状态，不显示成功形状的 fallback。

### 5.3 左栏：Demo 场景

左栏不是历史会话栏。V1 展示：

- 可用 Demo 场景
- 当前场景说明
- provider：`deterministic fake`
- session：`ephemeral`
- protocol version
- `Reset workspace`

选择新场景只更新选择；真正开始新 run 时清空当前工作区。

### 5.4 中栏：Chat

中栏包含：

- 当前场景与 run id
- user message
- 流式 assistant message
- inline tool cards
- error / aborted terminal message
- Prompt composer
- 显式 Demo 场景选择
- Run 按钮

Prompt 文本会真实进入 transcript，但 deterministic script 不根据 Prompt 内容决策。UI 必须明确显示当前 Demo，不能暗示 fake provider 理解了用户输入。

### 5.5 右栏：Turn-grouped Timeline

Timeline 默认打开，按真实 sequence 从上到下排列。

结构：

```text
agent_start
Turn 1
  user message
  assistant stream × N
  tool start / update / end
  toolResult message
turn_end
Turn 2
  assistant stream × N
  final assistant message
turn_end
agent_end
```

规则：

- `turn_start` 创建 group，`turn_end` 关闭 group。
- 连续的 `message_update` 默认聚合为 `assistant stream × N`。
- 聚合行展开后能查看每条原始 event envelope。
- tool execution end 按实际完成 sequence 展示。
- toolResult message 按 assistant 源顺序展示。
- `agent_start` 和 `agent_end` 位于 turn groups 外层。
- 未识别的新事件以 generic raw event row 展示并标记 warning，不能静默丢弃。

### 5.6 Selected event details

点击 Timeline 行后显示：

- `runId`
- `sequence`
- `elapsedMs`
- event type
- 完整 JSON payload
- Copy JSON

若选中聚合后的 assistant stream 行，详情展示其包含的原始 envelopes 列表。

---

## 6. Inline tool card

Chat 中的 tool card 表达模型源顺序；Timeline 表达真实事件完成顺序。

工具卡片状态：

- `pending`
- `running`
- `completed`
- `error`

V1 不为单个工具声明结构化 `aborted` 状态。当前公共
`tool_execution_end` 只有 `isError`，无法在不读取错误文案的前提下区分
普通工具错误与 signal abort。中止作为 run 级状态展示；已产生
`isError` 的工具结果仍显示为 error。

卡片摘要：

- tool name
- toolCallId
- arguments 摘要
- duration
- result 摘要
- error 标记

数据合并规则：

1. assistant message 中的 toolCall block 决定卡片的源顺序和基本身份。
2. `tool_execution_start` 把对应卡片标为 running。
3. `tool_execution_update` 更新 partial result 摘要。
4. `tool_execution_end` 填入完成状态、duration 和 execution result。
5. `ToolResultMessage` 填入最终回喂模型的 protocol message。

因此 parallel demo 中：

```text
Timeline tool_end：c2 → c3 → c1
Chat tool cards：  c1 → c2 → c3
```

这项差异必须能被肉眼观察。

---

## 7. 初始 Demo 场景

Demo 定义只存在于 server 层，不进入 core。

### 7.1 Streaming text

目的：验证阶段 3。

事件重点：

```text
message_start → message_update × N → message_end
```

验收：

- Chat 逐步增长。
- Timeline 默认聚合 updates。
- 历史最终只有一条 assistant message。

### 7.2 Tool loop

目的：验证阶段 2 和阶段 4。

流程：

```text
assistant(toolCall)
→ tool execution
→ ToolResultMessage
→ next turn
→ assistant(final text)
```

使用 server 内的 deterministic demo tool，避免依赖工作目录和真实文件副作用。

### 7.3 Parallel tools

目的：验证阶段 6 的双顺序语义。

三个 demo tools：

- `slow`：约 100ms
- `fast`：约 20ms
- `medium`：约 30ms

验收：

- tool end sequence 为 `fast → medium → slow`
- tool cards / toolResult messages 为 `slow → fast → medium`

“所有 prepare 在任何 execute 之前完成”继续由现有 core 测试验证。V1
公开事件没有 prepare-complete / execute-start 边界，因此 Timeline
不伪造这一层可视化。

### 7.4 Recoverable error

目的：验证模型可修复错误回喂。

初始实现使用 schema-invalid tool call：

```text
invalid arguments
→ isError toolResult
→ next model turn
→ recovered final answer
```

UI 不将其显示为 transport failure。

### 7.5 Abort lifecycle

目的：验证阶段 4 的中止语义。

使用带明显延迟的 streaming 或 tool execution。用户点击 Stop 后：

- active signal 被 abort
- 半截 assistant partial 不进入消息历史
- UI 显示 terminal assistant message，`stopReason: "aborted"`
- Timeline 正常闭合到 `agent_end`

---

## 8. 包结构

新增：

```text
packages/
  protocol/
    package.json
    src/index.ts
    src/messages.ts
    src/guards.ts
    test/
  server/
    package.json
    src/index.ts
    src/session-controller.ts
    src/scenarios.ts
    src/websocket-server.ts
    test/
  web/
    package.json
    index.html
    src/main.tsx
    src/app.tsx
    src/styles.css
    src/protocol-client.ts
    src/state/
    src/components/
    test/
```

依赖方向：

```text
web ──────> protocol
server ───> protocol
server ───> core ───> ai
protocol --type-only--> core
```

`web` 不依赖 `core` 或 `server`。

`protocol` 只通过 `import type` 使用 core 的公共 `AgentEvent`。这条依赖
用于定义 wire envelope 的静态类型，不产生浏览器运行时代码，也不允许
protocol import core 实现模块。

### 8.1 技术栈

- Web：React + Vite + TypeScript
- Server：Node HTTP + `ws`
- Transport：WebSocket + JSON
- Styling：项目内普通 CSS，不引入组件库
- Tests：Vitest；Web reducer/component tests 使用 jsdom

依赖只加入 Web / Server 层。`core` 与 `ai` 继续保持现有运行时依赖边界。

---

## 9. WebSocket 协议

协议使用字符串联合类型和手写 runtime guards，保持与 `erasableSyntaxOnly` 兼容。

### 9.1 Client commands

```ts
type ClientCommand =
	| {
			type: "run.start";
			requestId: string;
			scenarioId: string;
			prompt: string;
	  }
	| {
			type: "run.abort";
			requestId: string;
	  }
	| {
			type: "workspace.reset";
			requestId: string;
	  };
```

规则：

- 每条命令必须有 `requestId`。
- server 必须校验 JSON shape。
- active run 期间再次 `run.start` 返回具名错误，不排队。
- 空白 Prompt 返回 validation error，不启动生命周期。

### 9.2 Server messages

```ts
type ServerMessage =
	| {
			type: "server.ready";
			protocolVersion: 1;
			capabilities: Capability[];
			scenarios: DemoScenarioSummary[];
	  }
	| {
			type: "run.accepted";
			requestId: string;
			runId: string;
	  }
	| {
			type: "agent.event";
			runId: string;
			sequence: number;
			elapsedMs: number;
			event: AgentEvent;
	  }
	| {
			type: "run.settled";
			runId: string;
			outcome: "completed" | "aborted" | "error" | "failed";
	  }
	| {
			type: "workspace.reset";
			requestId: string;
	  }
	| {
			type: "protocol.error";
			requestId?: string;
			code: string;
			message: string;
	  };
```

`run.settled` 是 transport acknowledgement：

- 正常情况下在 `agent_end` 已完成 WebSocket listener 交付之后发送。
- 它负责解锁 UI 控件，不替代 Timeline 中的 `agent_end`。
- terminal assistant 的 `stopReason` 决定 `completed | aborted | error`。
- listener / transport / server infrastructure failure 使用 `failed`，不得
  伪造 `agent_end`。

UI 状态映射：

| 生命周期事实 | `run.settled.outcome` | Header 状态 |
|---|---|---|
| 正常 `agent_end` | `completed` | completed |
| terminal assistant `stopReason: "aborted"` | `aborted` | aborted |
| terminal assistant `stopReason: "error"` | `error` | error |
| 没有合法 terminal lifecycle 的基础设施故障 | `failed` | failed |

### 9.3 Event envelope

server 不改写 `AgentEvent`，只增加：

- `runId`：当前 run 身份
- `sequence`：从 0 递增，作为 UI 权威排序键
- `elapsedMs`：使用 `performance.now()` 相对 run 起点计算

Web 不使用消息到达本机的时间重新排序。

### 9.4 Wire schema 所有权

- ClientCommand、ServerMessage、capabilities、scenario summary 与 runtime
  guards 由 `@mini-agent/protocol` 所有。
- `AgentEvent` 的唯一静态定义仍由 `@mini-agent/core` 所有；protocol
  使用 type-only import，不复制联合类型。
- server 发出的 AgentEvent 来自本地受信任 core，不做重复深层校验。
- web 校验 ServerMessage 顶层 envelope、protocolVersion 和必要字段；
  对 event payload 使用同版本 protocol 提供的静态类型。
- AgentEvent 出现破坏性 wire 变化时必须提升 protocolVersion。

这样避免复制事件联合类型，也避免为了 transport 把协议定义下沉进 core。

---

## 10. Server 设计

### 10.1 SessionController

V1 只管理：

- 一个 WebSocket client
- 一个 active Agent
- 一个 active run
- 当前选定 Demo

`run.start` 流程：

1. 校验无 active run。
2. 校验 scenarioId 和 Prompt。
3. 清空上一 run 的 server 临时引用。
4. 由 scenario factory 创建新的 `StreamFn`、tools 和 Agent options。
5. 创建全新的 Agent。
6. 生成 `runId`，发送 `run.accepted`。
7. 在调用 `prompt()` 前订阅 AgentEvent。
8. 每收到一个事件，增加 sequence、计算 elapsedMs、发送 `agent.event`。
9. 等待 `agent.prompt()` settle。
10. 发送 `run.settled` 并清理 active run。

### 10.2 Abort

`run.abort`：

- 无 active run 时返回 `NO_ACTIVE_RUN`。
- 有 active run 时调用 `agent.abort()`。
- 不立即发送 completed/aborted UI 状态。
- 等 Agent 产生 aborted lifecycle 并 settle。

### 10.3 Reset

- idle 时清空 server 临时状态并发送 acknowledgement。
- running 时拒绝，要求先 abort。

### 10.4 Disconnect

WebSocket 断开时：

1. abort active Agent
2. 不等待客户端接收剩余事件
3. 清空临时 session
4. 新连接从全新 `server.ready` 开始

### 10.5 安全边界

- 只绑定 `127.0.0.1`
- 不提供公网 host 配置
- 不做 auth
- 所有 ClientCommand 做 runtime shape validation
- 单条 WebSocket message 设置合理大小上限
- 错误显式返回，不静默 fallback

---

## 11. Web 状态与 reducer

### 11.1 顶层状态

```ts
interface AppState {
	connection: "connecting" | "connected" | "disconnected" | "incompatible";
	scenarios: DemoScenarioSummary[];
	selectedScenarioId?: string;
	prompt: string;
	run?: RunViewState;
	selectedTimelineItemId?: string;
	lastProtocolError?: ProtocolError;
}
```

### 11.2 RunViewState

包含：

- runId
- status
- ordered envelopes
- turn groups
- message views
- tool call views
- selected raw event
- startedAt / elapsed

### 11.3 Chat reducer

- `message_start(user)`：创建 user message。
- `message_start(assistant)`：创建 assistant draft。
- `message_update`：使用 event 中的 `message` 快照更新 draft。
- `message_end`：用权威 message 完成对应记录。
- `message_start/end(toolResult)`：创建 toolResult protocol record，并合并进对应 tool card。
- `agent_end`：标记生命周期已结束，但控件等待 `run.settled` 解锁。

不得把每个 delta 追加为独立 message。

### 11.4 Timeline reducer

- 按 envelope.sequence 处理。
- 维护 active turn group。
- `message_update` 聚合只影响视图，不删除原始 envelope。
- 每个可见 row 都能回到一条或多条原始 envelopes。
- reducer 遇到不合法生命周期顺序时保留事件，并显示 diagnostic warning。

---

## 12. 错误与边界状态

| 场景 | UI 行为 |
|---|---|
| WebSocket 正在连接 | 阻止 Run，显示 connecting |
| WebSocket 断开 | 阻止交互，显示 disconnected 与刷新提示 |
| protocol version 不兼容 | 阻塞页面，显示双方版本 |
| invalid command | 显示 protocol error，不创建 fake run |
| active run 再次 start | 显示 single-flight 错误 |
| Agent 合成 error assistant | 作为正常 lifecycle 展示 |
| Agent 合成 aborted assistant | 作为 aborted lifecycle 展示 |
| server listener / send failure | run settled 为 failed，不伪造 agent_end |
| 未知 server message | 显示 protocol diagnostic，不静默忽略 |

---

## 13. 测试策略

### 13.1 Protocol

- 每种合法 ClientCommand 通过 guard。
- 缺字段、错类型、未知 command 被拒绝。
- protocol version 与 capability shape 测试。

### 13.2 Server

- 连接后首先收到 `server.ready`。
- `run.accepted` 早于任何 `agent.event`。
- sequence 严格递增。
- `elapsedMs` 非负且不倒退。
- active run 拒绝第二个 start。
- abort 产生 aborted lifecycle。
- disconnect abort 并清空。
- invalid JSON / command 返回具名 protocol error。

### 13.3 Demo scenarios

- Streaming text：updates 聚合前的原始事件完整。
- Tool loop：两个 turn 和 toolResult 配对正确。
- Parallel tools：end 完成顺序和 toolResult 源顺序同时正确。
- Recoverable error：isError toolResult 后进入下一 turn。
- Abort lifecycle：半截 assistant 不成为完成历史。

### 13.4 Web reducer

使用固定 ServerMessage fixtures 测试：

- 流式 assistant draft 到 final message
- message_update 不污染 message 数量
- turn grouping
- update aggregation
- tool cards 按源顺序
- Timeline tool end 按 sequence
- selected event 映射到 raw envelope
- completed / error / aborted / failed 四种不同状态

### 13.5 Component

- running 时 Run / scenario / prompt disabled，Stop enabled。
- idle 时 Run enabled，Stop hidden/disabled。
- Reset 清空 chat、Timeline 和 selection。
- disconnected / incompatible 是阻塞状态。

不在 V1 引入完整 E2E 工具；完成后做一次真实浏览器手动验收。

---

## 14. V1 验收标准

1. `pnpm dev:web` 能启动 server 与 web，并自动或明确打印浏览器 URL。
2. 页面为批准的 Light 三栏布局。
3. 用户可选择五个 Demo 之一、输入 Prompt 并启动 run。
4. Chat 能流式展示 assistant，并显示 tool cards。
5. Timeline 按 Turn 分组展示完整 agent lifecycle。
6. 点击 Timeline 行能查看原始 payload。
7. Parallel tools 场景能同时展示两种顺序。
8. Stop 能产生真实 aborted lifecycle。
9. 新 run 清空上一 run。
10. 刷新页面后从空 workspace 开始。
11. Web 不 import core 或 server。
12. Server 只使用 core 公共 API，不 import core 内部文件。
13. `pnpm test` 与 `pnpm check` 全绿。

---

## 15. 后续阶段演进

| Agent 阶段 | Web UI 增量 |
|---|---|
| 阶段 7：真实 provider | provider selector、真实 streaming、usage、真实 error；若协议提供则显示 thinking block |
| 阶段 8：System prompt 即历史 | Model I/O / system replay inspector |
| 阶段 9：持久化 | 左栏变为真实 sessions、continue、branch 与 reconnect replay |
| 阶段 10：压缩 | compaction Timeline marker、摘要与切点详情 |
| 阶段 11：扩展 | extension/tool 来源与 hook 决策展示 |
| 阶段 13：子 Agent | parent/child run navigation、steer/follow-up 队列 |

Web UI 每次只消费新公开协议，不通过读取内部字段提前模拟这些能力。

---

## 16. 已确认的用户决策

- 采用聊天主界面 + 右侧 Runtime Inspector。
- 使用 Light 主题，不做 Dark 主题。
- Runtime Inspector 默认打开 Timeline。
- Timeline 采用按 Turn 分组的时间线。
- “思考过程”指理解一次 run 如何从开始走到结束。
- V1 先接 fake provider，后续随 Agent 阶段演进。
- V1 session 为 ephemeral。
- Fake 阶段采用 Prompt + 显式 Demo 的混合输入。
- 技术栈为 React + Vite + Node WebSocket server。
- V1 只运行在 localhost，面向单用户。
- V1 一次只观察一个 run，新 run 清空上一 run。
- 已批准合成版视觉与交互基线。

---

## 17. Builder 可自行决定的细节

以下细节不改变产品含义，由实现者在计划中确定：

- React 组件文件的具体拆分
- CSS class 命名方式
- 图标使用纯文本、内联 SVG 或极小图标依赖
- runId / requestId 的具体生成方式
- Web 与 server 的开发端口
- 窄屏折叠的具体 breakpoint
- selected event JSON 的 syntax highlighting 实现

这些决定不得改变本文规定的包边界、事件来源、单 Run 语义或 V1 范围。
