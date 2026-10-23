# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要用户是本项目作者：具有 TypeScript / 前端背景、正在逐阶段学习 coding agent 架构的工程师。用户在本机运行真实 Agent，同时对照最终回答、工具执行与生命周期事件，回测核心设计决策。

## Product Purpose

mini-agent 是一个从零重写最小 coding agent 的教学项目。阶段 12 的 Web UI 为真实、持久化的 AgentSession 提供与 CLI 并列的前端，让用户在浏览器中提交 prompt、观察流式回答和工具调用、检查 token 用量与压缩事件，并在断线重连后恢复当前会话视图。成功意味着同一份 core 的公开事件与 journal 事实足以支撑完整、可验证的多视图观察体验。

## Positioning

它不是普通聊天产品，而是本机单用户 Agent 教学工作台。Chat、tool cards、usage 与 Timeline 都来自同一组 journal / event 原始事实；UI 不读取 Agent 内部状态，不伪造推理过程，也不把实时事件与持久化记录混为一谈。

## Operating Context

- 仅在 localhost 本机单用户环境运行，桌面优先。
- 用户通过 React Web UI 与 CLI 分别使用同一套 core / provider / extension 架构。
- 典型任务是提交 coding prompt，观察 assistant streaming、工具执行、最终结果、压缩与 aborted / error 收尾。
- Runtime Inspector 默认打开，用户可点击 Timeline 项检查原始 JSON。

## Capabilities and Constraints

- Light 三栏工作台：Session、Chat / Prompt、Timeline / Event Details。
- 支持 prompt.submit、run.abort、session.compact；不提前实现 steer、followUp、子 Agent 或 parent / child UI。
- 展示流式消息、工具参数 / 部分结果 / 最终结果 / 耗时 / 错误、token usage 与 compaction marker。
- tool cards 遵循 assistant 源顺序；Timeline tool end 遵循实际事件完成顺序。
- 断线不中止 active run；重连通过 journal snapshot 与 current-operation events 补齐。
- 技术栈固定为 React、Vite、TypeScript、普通 CSS、Node HTTP 与 ws。
- 不做 Dark 主题、文件树、编辑器、diff、内嵌终端、session branch 选择器、扩展管理页或移动端专项导航。
- 没有经验证的价格表，因此不显示成本。
- 事实来源仅限 SessionSnapshot.entries 与 AgentEventEnvelope[]；不得展示虚构的模型思考或隐藏状态。

## Brand Commitments

- 产品名为 `mini-agent`。
- 使用已批准的 Light 视觉基线；蓝色为主要交互色，绿色表示完成，红色表示错误 / aborted / disconnected。
- 层级优先依靠边框、留白与排版，而非大面积阴影。
- 界面应服务架构教学与事实核对，而非营销展示或通用 AI 产品观感。

## Evidence on Hand

- `docs/specs/2026-10-09-mini-agent-v3-design.md`：总体架构、消息与事件语义、阶段 12 范围。
- `docs/plans/2026-10-16-stage-12-ui-layer.md`：真实功能、协议、状态投影、组件职责与验收标准。
- `docs/specs/2026-10-12-web-ui-v1-design.md`：已批准的 Light 三栏视觉与交互基线；其中旧 Demo / ephemeral 语义已被阶段 12 计划覆盖。
- 当前尚无 Web UI 实现、既有组件、品牌图形或截图资产。

## Product Principles

1. 展示运行事实，不伪造模型思考或隐藏状态。
2. Chat 用于理解结果，Timeline 用于验证过程，两者必须来自同一事实源。
3. 持久化记录与实时事件在视觉上可区分，在语义上不重复。
4. 错误、断线、中止与压缩都是可检查的正常运行状态，不用装饰性成功反馈掩盖。
5. 保持本机教学工具的克制与清晰度，不扩张为通用 IDE 或完整 Agent 管理平台。
