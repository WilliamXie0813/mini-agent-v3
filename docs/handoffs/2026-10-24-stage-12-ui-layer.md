# Stage 12 UI Layer Handoff

> 日期：2026-10-24  
> 分支：`stage-12-ui-layer`  
> Worktree：`/Users/william/Desktop/project/my-harness/mini-agent-v3/.claude/worktrees/stage-12-ui-layer`  
> 当前 HEAD：以 `git log` 为准；实现完成点为 `14a3d54e241d9b7b992089c4bc99d6f64661ec55`  
> 状态：Task 1–7 已完成并通过逐任务审查；whole-branch final review 按用户要求暂停，尚未执行。

---

## 1. 下次从哪里继续

下次会话可以直接说：

> 继续 stage-12-ui-layer，从 handoff 恢复，先读 `docs/handoffs/2026-10-24-stage-12-ui-layer.md`，然后执行 whole-branch final review。

建议先确认 worktree 仍在：

```bash
cd /Users/william/Desktop/project/my-harness/mini-agent-v3/.claude/worktrees/stage-12-ui-layer
git status --short
git log --oneline -12
```

如果 worktree 已被清理，在原仓库中找回分支：

```bash
cd /Users/william/Desktop/project/my-harness/mini-agent-v3
git branch --list stage-12-ui-layer
git worktree list
```

然后可以重新创建/进入 worktree，或直接在分支上继续。

## 2. 当前验证状态

在 `14a3d54` 上由控制会话直接运行：

- `pnpm test`：679/679 passed
- `pnpm check`：全部 8 个 TypeScript package 通过
- `git status --short`：干净（handoff 文档提交后仍应干净）

分包测试数：

| Package | Tests |
|---|---:|
| ai | 177 |
| core | 318 |
| protocol | 19 |
| extensions | 41 |
| examples | 2 |
| web | 85 |
| server | 37 |
| 合计 | 679 |

## 3. 已完成范围

### 设计与计划

- 视觉设计：`docs/specs/2026-10-23-stage-12-ui-visual-design.md`
  - Quiet Observability
  - React + Vite + TypeScript + 普通 CSS
  - Light 三栏工作台
  - Event Details modal
  - Web New session 明确不做
- 实施计划：`docs/plans/2026-10-16-stage-12-ui-layer.md`
- 阶段文档：`docs/stages/12-ui-layer.md`

### Task 1 — protocol

提交：`92242a7 feat(stage-12): add the websocket protocol`

新增 `@mini-agent/protocol`：

- `PROTOCOL_VERSION = 1`
- `ClientCommand` / `ServerMessage` / `SessionSnapshot` / `AgentEventEnvelope`
- 手写 runtime guards
- protocol 对 core 只允许 `import type`

### Task 2 — SessionHost

提交：`37056d3 feat(stage-12): host persistent sessions for web clients`

新增 server session 层：

- `activeSessionPath()` 沿 `leafId -> parentId` 重建活跃分支
- `SessionHost` 独立于 socket 生命周期
- attach snapshot + live event queue
- prompt/abort/compact 命令
- mid-operation snapshot seam
- detach 不 abort

### Task 3 — WebSocket server

提交：`a2f48b6 feat(stage-12): expose sessions over localhost websocket`

新增真实 transport：

- `createRuntime()` 与 CLI 等价装配
- `startAgentWebSocketServer()`
- `127.0.0.1`、`/agent`、localhost Origin、64 KiB payload 边界
- `server.ready -> session.snapshot -> live events`
- 断线重连 backfill 测试

### Task 4 — Web raw state

提交：`2aef997 feat(stage-12): project journal and events into web views`

新增 `@mini-agent/web` state/selectors：

- reducer
- `buildChatView`
- `buildToolCards`
- `buildUsageTotals`
- `buildTimeline`
- fresh snapshot 首个 `sequence: 0` 修正
- Web 不 import core/ai/server

### Task 5 — React workspace

提交：

- `912930a feat(stage-12): render the persistent agent workspace`
- `db946b0 refactor(stage-12): split workspace styles into focused partials`
- `37395a1 feat(stage-12): colorize event JSON and group timeline by turn`

实现：

- Header / Session / Chat / ToolCard / Composer / Timeline
- Event Details modal
- modal Esc、焦点返回、Previous / Next
- JSON 语法着色
- Timeline turn 分组
- CSS 按职责拆分

### Task 6 — browser client/app

提交：`042da37 feat(stage-12): connect react to the replaying websocket`

实现：

- `ProtocolClient`
- WebSocket reconnect
- typed commands
- `useAgentSession`
- Vite proxy与 React entry

### Task 7 — 集成验收与阶段文档

提交：

- `06497da refactor(stage-12): split session-host operation bookkeeping`
- `1afb4c0 fix(stage-12): derive live run status from event pairs`
- `85d428b docs(stage-12): explain the event-driven ui boundary`
- `14a3d54 fix(stage-12): replay reconnect transient events through live status`

完成：

- 根 `pnpm dev:web`
- `SessionHost` 拆分到 200 行以下
- 修复 run status 不进入 running、Stop 不出现
- 修复 reconnect snapshot 中 transient compaction 不重放状态
- 完成阶段教学文档
- 使用 agent-browser 对真实 provider 做过浏览器验收

## 4. 浏览器验收结果

Task 7 已用 agent-browser 对真实 provider 验证过：

1. 流式回答、read tool card、tool result、最终回答。
2. Web 与 CLI 并列运行，各自持有独立 session。
3. token usage 更新，页面无 cost。
4. Web Compact 产生 live marker 和 journal replay marker。
5. run 中途关闭 tab 不 abort；重开后 snapshot + transient events 补齐，无重复/诊断。
6. 并行工具中 Chat card 源顺序与 Timeline 完成顺序分离。
7. Stop 产生真实 `run_end: aborted` 和 aborted assistant。
8. Event Details modal 可打开、切换前后事件、Esc 关闭。

注意：验收时使用了 `ANTHROPIC_MODEL=k3`，因为当前 shell 的默认 `ANTHROPIC_MODEL` 会被配置的 proxy 拒绝。下次如需重跑真实浏览器验收，使用：

```bash
ANTHROPIC_MODEL=k3 pnpm dev:web
```

## 5. 尚未完成：whole-branch final review

用户明确要求在 Task 7 完成后暂停，所以目前**没有执行** SDD 的最终 whole-branch review。

下次继续时的主要任务：

1. 读本 handoff。
2. 读 SDD ledger（如果 worktree 仍存在）：
   `.superpowers/sdd/2026-10-16-stage-12-ui-layer/progress.md`
3. 读最终计划与阶段文档。
4. 执行 whole-branch final review，范围是从 master 基线到当前 HEAD。
5. 处理 final review 的 Critical/Important findings。
6. 再进入 `superpowers:finishing-a-development-branch`。

## 6. Deferred Minor findings 汇总

这些都不阻塞当前任务审查，但 final review 应该重新 triage。

### Server / protocol

- `SessionHost.attach()` 在 `close()` 后仍可 attach 并发送 snapshot。
- WebSocket greeting 在极小概率的 socket 提前关闭 race 下可能 throw。
- reconnect 测试依赖 3.2s fake run 的时间窗口。
- `createRuntime()` 会把 optional `directory/contextWindow` 显式传成 `undefined`。
- `SessionHost.session` / `now` / `reply` 为支持 `OperationContext` 被 widened 为 public readonly。

### Web state

- `ToolCardView.sourceIndex` 每个 assistant message 内从 0 重新开始，字段可能与全局顺序语义混淆。
- completed/error tool card 可能在 selector 层保留 stale `partialResult`；UI 已防御性隐藏。
- `ToolCardView.result` 的 runtime shape 可能是 `ToolResult` 或 `ContentBlock[]`。
- orphan journal `tool_update/tool_outcome` 不产生 warning。
- boundary import regex 对假想的 `@mini-agent/ai-foo` 过宽。
- reconnect snapshot seed 假设 current-operation transient events 包含 enclosing `agent_start`。

### Web UI / client

- compaction marker 的 warm tint token 尚未充分使用。
- modal 打开瞬间可能有 transient `aria-hidden`-on-focused-element 警告。
- Esc 绑定在 dialog container，而不是 document-level listener。
- `<1100px` Timeline drawer 固定展开，没有 toggle。
- turn row 如果是第一个 Timeline item，会有额外 8px top margin。
- JSON tokenizer 是轻量启发式，不是完整 parser。
- `ProtocolClient.connect()` 重复调用会遗留旧 socket（当前 hook 只调用一次）。
- reconnect backoff 当前是 clamp 到 2000ms，而不是严格 wrap 回 250ms。
- 自定义 `reconnectDelaysMs` 尚未有专门测试。
- socket `onerror` 静默，依赖后续 `onclose`。
- hook 把 non-open `send()` 转成 `NOT_CONNECTED` local error，这是超出计划的防御行为。
- stage 文档中的 src 行数可能仍引用拆分前数字（2591 vs 2608）。
- compact 不足 `keepRecentTurns` 时 UI 对 `compacted:false` 没有明显反馈。

## 7. 关键架构边界

下次 review 或修改时不要破坏这些边界：

- `web -> protocol`
- `server -> protocol`
- `server -> core -> ai`
- `server -> extensions`
- `protocol -- type-only --> core`
- Web 不 import core/ai/server。
- Server 不 deep import core/ai/extensions。
- UI 只从 snapshot entries + event envelopes 派生视图。
- delta 只更新 draft；只有 `message_end` / journal message 是完成消息。
- Tool cards 按 assistant 源顺序；Timeline tool end 按完成顺序。
- 断线不 abort；重连依赖 journal base + current-operation transient events。
- 不显示成本。
- 阶段 12 不做 Web New session、历史 session 切换、steer/followUp 或子 Agent UI。

## 8. 工作区与提交注意事项

- 当前阶段分支上的 commit 都带有 Copilot 与 Claude Code trailers。
- `.superpowers/` 已在 `.gitignore` 中，SDD ledger/review package 不应提交。
- `.mini-agent/` 被忽略；真实验收产生的 session 文件不应提交。
- `dist/` 不应提交。
- 如果 final review 要检查完整差异，使用 master 基线到当前 HEAD，而不是只看最后一个 commit。

## 9. 快速恢复检查清单

```bash
cd /Users/william/Desktop/project/my-harness/mini-agent-v3/.claude/worktrees/stage-12-ui-layer
git status --short
pnpm install
pnpm test
pnpm check
```

若全部通过，下一步就是 whole-branch final review。
