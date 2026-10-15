# 阶段 9 —— 会话持久化与崩溃恢复

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §3.2(b–c)、§5 阶段 9  
> 计划：`docs/plans/2026-10-14-stage-9-session-persistence.md`  
> 交互图解：[`09-session-persistence-explained.html`](09-session-persistence-explained.html)

## 这个阶段解决了什么问题

阶段 8 把 system prompt 和工具声明放进历史，但历史仍在内存里。进程退出后，用户输入、assistant 回复和当时的工具集全部丢失。更难的问题是：工具可能已经改了文件，进程却死在结果写入之前。重启后，“没有结果”不能证明“没有执行”。

阶段 9 增加 `AgentSession`，把 `Agent` 包装在一个持久化边界里：

```text
submit({ requestId, prompt })
  → submission 写入并 fsync
  → Agent.prompt()
  → assistant message 写入并 fsync
  → prepare 工具参数/权限/abort
  → tool_intent 写入并 fsync
  → execute
  → tool_update / tool_outcome 写入并 fsync
  → source-ordered toolResult message 写入并 fsync
  → run_end 写入并 fsync
```

新会话位于当前目录的 `.mini-agent/sessions/<epochMs>_<uuid>.jsonl`。CLI 默认创建新文件；从仓库根运行 `node --experimental-strip-types packages/cli/src/index.ts --continue` 打开当前目录最新的会话。使用 `pnpm dev` 时进程 cwd 是 `packages/cli`，会话目录也随之改变。未知参数、没有可继续会话、日志损坏和持久化失败都明确报错。

`requestId` 是整个 session 文件的幂等键：同进程并发、重启后、其他分支里的重复提交，都返回原来的 submission，不追加、不再请求模型。这不是“重试直到成功”：如果原 submission 被中断，同一个 id 仍指向它；新的用户操作需要新的 id。

不同 requestId 的并发提交，以及 submit／system／tools／branch 之间的冲突，都会在写日志前拒绝。会话从第一个 await 前就保留操作所有权；`waitForIdle()` 包括 submission 和策略变更的持久化等待，而不仅是模型生成。CLI 空白行仍是 no-op，不创建 submission。

## Pi 的哪条决策是答案

对应总设计中的 Pi session tree、append-only 历史与工具 `replay` 声明。本项目采用其决策，不照搬分布式 durable runtime。

### 1. 只追加的 JSONL 是事实，内存是派生状态

首行是 `{ type: "session", version: 1, id, createdAt }`，其后每行一个带 `id`、`parentId`、`createdAt` 的 entry。类型包括 `submission`、`message`、`tool_intent`、`tool_update`、`tool_outcome` 和 `run_end`。

`SessionJournal.append()` 串行化写入，用 append-mode 文件句柄写 `JSON + "\n"`，等待 `FileHandle.sync()` 后才更新内存。`writeFile()` 在这里是**句柄方法**，不是对路径覆盖文件；只有初建 header 使用独占创建模式。完整历史的旧字节永远是新文件的前缀。

读取器拒绝未知 version、重复 id、缺失 parent、中间坏 JSON，以及以换行结束的坏 JSON。它只容忍最后一条**没有换行、且无法解析**的残缺 fragment，加载其前面的有效历史。完整 JSON 即使没有最后换行，也仍须通过结构检查；不能把所有坏尾行都当成崩溃。

**经用户批准的例外（2026-10-15）**：open 完成有效前缀校验后，只截掉这个残片并 fsync，保留所有完整 entry；若最后一条 JSON 完整但缺换行，则只追加换行并 fsync。这修复了“首次 open 能读，继续追加后第二次 open 却损坏”的窗口。原先的“任何旧字节绝不删除”放宽为“完整历史绝不修改”，不是悄悄扩大损坏容忍范围。

这是本地文件持久化，不是多进程数据库：同一 journal 实例内的 appends 排队；不承诺跨进程写锁、跨文件事务或外部工具副作用的 exactly-once。

### 2. 树路径不等于文件行顺序

```text
物理追加顺序： A, B, C, D, E

祖先关系：     A → B → C
              └→ D → E  ← 当前 leaf

当前历史：     A, D, E
```

`branch(A.id)` 只移动内存 leaf，不写新行，不复制文件。下一条 D 的 `parentId` 指向 A，旧的 B、C 仍然可追溯。默认 reopen 选择物理最后一条有效 entry，再沿 parent 链重建历史。

`submission` 自身重建 user message，避免再次保存同一输入；`message` 重建 system、assistant、toolResult。工具 intent/update/outcome 是恢复元数据，不直接塞进模型 transcript。阶段 8 的 system replay 因此仍然成立。

### 3. intent 必须先于 execute

intent 保存工具声明、JSON-safe 参数、`replay`、submission、assistant entry 和 source index，不保存执行闭包、provider、HTTP headers 或 API key。

prepare 失败（未知工具、schema、权限阻断、abort）不写 intent，因为执行边界没有到达。intent 持久化失败是基础设施故障：原错误向 submit 调用方传播，不生成模型错误消息或 run_end 把未完成工具封死；后续恢复仍能处理已经 durable 的 intent。

parallel batch 更严格：先按 assistant 中的源顺序完成所有 prepare 和 intent commits，再启动任何 execute。第二条 intent 的 fsync 失败时，整个 prepared batch 的 execute 次数为 0。工具可以乱序完成，toolResult transcript 仍按调用源顺序记录。

持久化监听器先于外部订阅者完成：当订阅者收到 assistant/toolResult 的 `message_end`、工具 update/outcome 或 `agent_end`，对应记录已 durable。流式 text delta 不逐 token 保存。

### 4. 恢复先处理不确定性，再交还完整 turn

`AgentSession.open()` 在构造恢复后的 Agent 前扫描当前祖先路径。以 assistant entry 和 source index 关联 intent，避免早期轮次复用 toolCall id 时混淆。

新的 submit 也先规范化 active path，再重建 Agent：同进程持久化失败后继续，或 branch 到历史 tool_update／intent 时，不能绕过缺失的工具结果直接进入模型。恢复扫描在下一条 submission 前截止，不拿另一个请求的 assistant 收尾旧 run。branch 本身仍只移动 leaf，不追加恢复记录；这些记录在下一次新 submit 前追加。

| 崩溃窗口 | 恢复动作 | 是否再次 execute |
|---|---|---|
| assistant toolCall 已写，intent 未写 | 补明确的“未到 durable execute boundary”错误结果 | 否 |
| intent 已写，无 outcome；工具仍是 safe 且声明匹配 | 用保存的参数重跑，补 outcome 和 message | 是 |
| intent 已写，无 outcome；unsafe／工具缺失／声明变化 | 保留 committed partial content，追加 interrupted 错误 | 否 |
| outcome 已写，toolResult message 未写 | 用原 outcome 补 transcript message | 否 |
| 最终 assistant 已写，run_end 未写 | 按 stopReason 补 run_end | 否 |

`replay` 由工具作者声明，缺省是 `"unsafe"`。内置 read 是 safe，edit/bash 是 unsafe。safe 表示允许重跑，不表示重新读取的数据一定和崩溃前一致，也不保证 execute 只调用一次。当前声明或 replay 策略变化时宁可中断，也不猜测兼容。

unsafe 的 partial output 只是**已持久化的观察**，不能证明副作用是否完成。恢复结果保留这些 content，并明确标记未知完成状态；绝不以“没有 outcome”推断“没有副作用”。

对外承诺是**级别 2：完整 turn 边界**。恢复不继续 provider 生成、不自动调用模型、不恢复任意 step checkpoint 或 task graph。下一次用户 submit 才进入模型。若崩溃仅留下 submission、尚无 assistant，当前实现保留 user-only 历史，不自动重发原请求。

## 替代方案为什么更差

| 替代方案 | 失去什么 |
|---|---|
| 每轮覆盖一个 session.json | 每次写都触碰旧历史，崩溃可能损坏整个快照，难保留分支 |
| execute 后才写 intent | 副作用发生但日志无迹可查，恢复无法区分“没做”和“做了没记” |
| 自动重跑所有 pending tools | edit/bash 可能重复修改文件或执行命令，未知副作用被放大 |
| 有 outcome 也重跑 | 已有 durable 结果仍重复副作用，丢掉日志最重要的证明 |
| branch 复制或改写旧文件 | 失去同文件树与统一审计，幂等键也容易变成分支局部状态 |
| requestId 只在内存去重 | 重启、跨 branch 或请求重试又执行一次 |

## 决策点（供回测）

1. 为什么 journal 只能 append？如果恢复时覆盖旧行，哪些承诺会消失？
2. 为什么 intent commit 与 execute 的顺序不能反？parallel batch 又为什么需要全批屏障？
3. safe 与 unsafe 的边界是谁声明的？safe 是否等于 exactly-once，或者结果永远相同？
4. branch 为什么只移动 leaf？为什么文件最后几行不一定是当前对话的全部历史？
5. outcome 已 durable、toolResult message 未写时，为什么只能补 message，不能重跑？

## 实施边界与成本

四个会话文件在 Task 7 时共 **815 行**：journal 206、recovery 210、types 49、AgentSession 350；加上 CLI／执行链接线，阶段源码净增 **893 行**。这超出约 400 行的教学目标，是明确接受的偏差，不是达标。

最终审查修复后，会话文件为 **859 行**（222／216／49／372），阶段源码净增 **950 行**。额外代码用于尾部规范化、会话操作所有权、intent 基础设施错误传播和继续对话前的恢复，不是后续阶段功能。

检查后保留实现：journal 的 fsync／结构校验、recovery 的多个崩溃窗口、AgentSession 的提交去重／事件持久化／重建各有不同边界，没有引入后续阶段功能。机械拆文件不能减少复杂度，删除恢复规则又会弱化正确性。代价是阅读与维护负担更大，尤其 AgentSession 职责较多；后续重构应由真实重复或行为问题驱动，而不是行数。

零新增 registry 运行时依赖。未实现 `/fork` 新文件命令、交互式分支选择器、compaction、扩展系统或 provider 自动恢复。HTML 中的树与恢复实验仅是教学模拟器，不是 CLI 新功能。

## 验收

`pnpm test` 和 `pnpm check` 覆盖全工作区；会话测试覆盖：

- 两轮完成后真实子进程 SIGKILL，恢复历史并继续第三轮。
- 同文件分支、全 session 幂等提交、持久化先于外部事件。
- safe／unsafe 执行中的真实 SIGKILL，unsafe 保留 partial output。
- outcome/message 崩溃窗口、源顺序补结果、toolCall id 跨轮复用。
- 完整旧字节前缀不变、intent commit 失败时零执行、torn tail 修复后可再次写入和 reopen。
- pending persistence 期间操作互斥与 idle 等待、intent 错误穿过 Agent 后仍可恢复。
- 同进程 outcome 写入失败／branch 到 partial 节点后，保留 partial 并规范化再继续。
- CLI 空白输入不退出、不写 submission、不请求 provider。

这些结果证明已覆盖的边界，不代表任意外部工具副作用都能自动恢复。
