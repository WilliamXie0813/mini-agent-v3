# 阶段 12 Web UI 视觉设计

> 状态：已批准  
> 日期：2026-10-23  
> 对应实施计划：`docs/plans/2026-10-16-stage-12-ui-layer.md`  
> 视觉基线：`docs/specs/2026-10-12-web-ui-v1-design.md`

---

## 1. 意图

阶段 12 的 Web UI 是本机单用户的 Agent 教学工作台，不是普通聊天产品。界面要让用户同时完成三件事：

1. 在中央区域阅读用户消息、流式 assistant 和工具结果。
2. 在右侧按真实 sequence 检查一次 run 的生命周期。
3. 随时区分持久化 journal 事实与当前 live event。

## 2. 已选方向：Quiet Observability

界面气质是“安静的学习型观测台”：

- **Chat 偏阅读**：assistant 不使用厚重气泡；user message 使用浅蓝底；正文保持足够行高。
- **Tool cards 偏工程感**：卡片承载参数、结果、耗时和错误，但避免把 Chat 切成一整列独立卡片。
- **Timeline 偏精密检查器**：使用连续事件轨道、sequence、相对时间和 Live / Journal source badge。
- **Header 保持轻量**：连接状态、run 状态、token usage 和 Stop 集中呈现，不做统计卡片墙。
- **层级依靠边框与留白**：不使用渐变、大面积阴影、装饰插画或拟物终端效果。

## 3. 技术栈与布局

前端技术栈固定为 **React + Vite + TypeScript + 普通 CSS**：

- React 负责组件与状态接线。
- Vite 负责开发服务器与 `/agent` WebSocket proxy。
- 不引入组件库、CSS-in-JS 或完整设计系统框架。
- 视觉系统通过项目内 CSS custom properties 与少量组件样式表达。

保持已批准的 Light 三栏工作台：

```text
┌──────────────────────────────────────────────────────────────────┐
│ Header：brand / connection / run status / usage / Stop             │
├──────────────┬────────────────────────────────┬──────────────────┤
│ Session       │ Chat                           │ Run timeline      │
│ metadata      │ messages + inline tool cards    │ turn groups       │
│ Compact       │ prompt composer                 │                  │
└──────────────┴────────────────────────────────┴──────────────────┘
```

- Desktop 目标宽度 1100px 以上；Timeline 默认打开。
- 中央 Chat 内容设置最大阅读宽度并左对齐，不随窗口无限拉宽。
- 小于 1100px 时 Timeline 可以转为右侧 drawer；不做移动端专项导航。
- Session 侧栏只展示当前 session 的持久化、leaf、replay 与 compression 信息。

## 4. 视觉 tokens

沿用阶段 12 计划锁定的 Light palette：

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

辅助颜色只用于真实状态或信息层级：

- `primary soft`：Live event、选中 Timeline 行、running 状态。
- `success soft`：completed 工具状态。
- `danger soft`：error / aborted / disconnected。
- 暖色仅用于 compaction marker，避免与错误红色混淆。

字体分两族：

- UI 与正文使用清晰的现代 sans-serif（优先系统可用的人本主义 sans）。
- ID、sequence、event type、参数、耗时和 JSON 使用等宽字体；等宽字体只服务代码与数据，不把它当作整体风格。

圆角有层级：message/tool 容器约 `10px`，按钮约 `6px`，不做所有元素统一大圆角。

## 5. 关键组件

### 5.1 Header

从左到右依次承担身份、状态与操作：

- `mini-agent` 品牌与 Runtime workbench 标识。
- WebSocket connection 与 Agent run status，用彩色状态点区分。
- input / output / cache token totals，只做文本数据，不显示成本。
- active run 时显示 Stop；Stop 只发送 `run.abort`，不在客户端伪造结束。

### 5.2 Chat

- role label 使用小字，不把 UI 做成大头像聊天流。
- streaming assistant 显示当前 draft 与明确的 streaming indicator；delta 不产生多条消息。
- tool cards 遵循 assistant `toolCall` block 的源顺序。
- 工具结果默认折叠，展开后显示 protocol result；error 状态必须可见但不把整片区域染红。
- Prompt composer 固定在中央面板底部，running / compacting 时禁用。

### 5.3 Timeline

- 按 envelope sequence 从上到下排列；turn 使用分隔组表达。
- 连续 `message_update` 聚合为一行，聚合行仍保留原始 envelopes 供 details 查看。
- Live 与 Journal 使用轻量 badge 区分，避免把重放记录冒充实时事件。
- tool end 按完成顺序展示，与 Chat tool cards 的源顺序差异必须肉眼可见。
- compaction marker 显示 reason、状态和 tokensBefore，不重新摘要或隐藏历史。

### 5.4 Event Details modal

Timeline 下方不再固定显示小面积 Event Details 面板。点击 Timeline row 后打开 modal：

- 尺寸约为 `min(880px, calc(100vw - 64px))` 宽、`min(760px, calc(100vh - 96px))` 高；窄屏占满视口。
- Header 显示 event type、source、sequence、elapsedMs 与关闭按钮。
- Toolbar 显示 turn/tool 上下文与 Copy JSON。
- Body 使用大字号等宽 JSON、语法色彩和独立滚动区。
- Footer 支持 Previous / Next event，便于连续检查事件流。
- Esc 关闭，关闭后焦点返回原 Timeline row；modal 打开时页面背景保持 dimmed 且不可交互。

这样 Timeline 获得更多纵向空间，长 JSON 也获得足够面积；代价是 details 不再常显。这个取舍成立，因为 details 属于按需检查，不是持续阅读内容。

## 6. 状态与错误

| 状态 | 视觉处理 |
|---|---|
| connecting / reconnecting | 阻塞输入，明确显示连接状态，不假装可用 |
| disconnected | 阻塞性提示；不显示成功形状 fallback |
| running | Prompt / Send / Compact disabled；Stop visible |
| compacting | 与 running 区分显示；控制禁用 |
| aborted / error assistant | 显示真实 terminal stopReason，不伪造每工具 aborted |
| protocol error | 显示具名错误，不创建 fake run |
| unknown event | Timeline 保留 raw row 并显示 warning，不静默丢弃 |

## 7. 范围边界

本次视觉设计**不包含**：

- Web 端 New session 或历史 session 切换。
- Dark 主题。
- 文件树、代码编辑器、diff、内嵌终端。
- session branch 选择器或扩展管理页。
- 阶段 13 的 steer / followUp、子 Agent 或 parent/child UI。
- 成本展示。

## 8. 曾考虑但未采用的方向

1. **Dense IDE inspector**：信息密度更高，但会把教学观察工具做成完整 IDE，容易抢走 Chat 的阅读层级，也会诱发文件树、编辑器等越界功能。
2. **Conversational chat-first**：对话更舒适，但 Timeline 和工具事实会退居次位，违背“同一事件流可对照验证”的产品目的。
3. **Quiet Observability（已选）**：保留标准三栏操作模型，同时用 Timeline 轨道、Live/Journal 标记和轻量技术排版形成辨识度；表达服务于任务，不变成终端或 IDE cosplay。

## 9. 实施者可自行决定

- 具体 CSS class 命名与组件文件拆分。
- 图标使用极小内联 SVG。
- JSON syntax highlighting 的轻量实现。
- modal 使用原生 `<dialog>` 还是 React 状态组件；都必须满足焦点、Esc、滚动与可访问性要求。
- 小于 1100px 时 Timeline drawer 的具体断点。
