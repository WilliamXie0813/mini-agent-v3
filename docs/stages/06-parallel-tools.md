# 阶段 6 —— 并行工具

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 6
> 计划：`docs/plans/2026-10-12-stage-6-parallel-tools.md`

## 这个阶段解决了什么问题

阶段 5 已经把每个工具拆成：

```text
prepare → execute → finalize
```

但一个 assistant message 里的多个 toolCall 仍然逐个执行：

```text
prepare #1 → execute #1 → finalize #1
prepare #2 → execute #2 → finalize #2
prepare #3 → execute #3 → finalize #3
```

若三个独立 read 分别耗时 100ms、20ms、30ms，总耗时约 150ms。阶段 6 把结构改成：

```text
串行 prepare：#1 → #2 → #3
并行 execute：#1 ───────── 100ms
              #2 ── 20ms
              #3 ─── 30ms
```

总耗时接近最慢的 100ms，而不是三者之和。

## 一次完整 batch 的两种顺序

模型发出的源顺序：

```text
c1 slow
c2 fast
c3 medium
```

完成顺序：

```text
c2 → c3 → c1
```

阶段 6 必须同时保留两种顺序：

```text
UI events:
  tool_execution_end(c2)
  tool_execution_end(c3)
  tool_execution_end(c1)

模型历史:
  toolResult(c1)
  toolResult(c2)
  toolResult(c3)
```

事件是实时反馈，应该谁先完成谁先出现；消息历史是模型协议，必须按模型发出 toolCall 的顺序配对。

## Pi 的哪条决策是答案

### 1. prepare 串行，execute 并行

Pi 的两阶段并行位于 `agent-loop.ts:586-660` 附近。

第一阶段按源顺序：

```text
emit tool_execution_start
→ prepareToolCall
→ immediate outcome 直接 finalize
→ prepared outcome 包成 thunk
```

所有 prepare 完成后，第二阶段才开始：

```ts
const ordered = await Promise.all(
	entries.map((entry) =>
		typeof entry === "function"
			? entry()
			: Promise.resolve(entry),
	),
);
```

为什么 prepare 不并行：

- `beforeToolCall` 可能弹权限对话框；
- 三个权限请求同时出现会让用户不知道先处理哪个；
- hook 的顺序本身可能是策略的一部分；
- execute 开始前必须确认所有调用都已经完成 preflight。

### 2. end 在 thunk 内发，message 在 Promise.all 后发

每个 thunk 完成时立即：

```text
finalize
→ emit tool_execution_end
```

因此 end 自然按实际完成顺序出现。

但 `Promise.all()` 返回数组时仍保持 input index。runtime 随后遍历 ordered outcomes：

```text
emit toolResult message #1
emit toolResult message #2
emit toolResult message #3
```

这就是「事件完成顺序 / 消息源顺序」同时成立的原因。

### 3. immediate outcome 也必须占住源位置

假设：

```text
c1 slow prepared
c2 schema invalid
c3 fast prepared
```

c2 在 prepare 阶段已经 finalize，end 可能最早出现：

```text
end order:    c2 → c3 → c1
message order:c1 → c2 → c3
```

invalid/blocked/unknown 并不会从 ordered 数组消失，否则后续 message index 会错位。

## sequential fallback

执行模式：

```ts
type ToolExecutionMode = "sequential" | "parallel";
```

分派规则：

```ts
if (
	toolExecution === "sequential" ||
	toolCalls.some(call =>
		findTool(call.name)?.executionMode === "sequential"
	)
) {
	return executeSequential();
}
return executeParallel();
```

只要一个工具要求 sequential，整批降级。原因是模型把这些调用放在同一批中；只挑其中一个串行、其他并行，会产生难以解释的半并行依赖。

Agent 默认：

```ts
agent.toolExecution = "parallel";
```

该字段可在两次 prompt 之间动态切换，不需要重建 Agent。

## 为什么还需要 file-mutation-queue

即使两个 edit 改同一文件的不同位置，它们也可能这样交错：

```text
edit #1 read 旧文件
edit #2 read 同一个旧文件
edit #1 write 结果 A
edit #2 write 结果 B，覆盖结果 A
```

所以不能只给 writeFile 加锁。锁必须包住：

```text
read
→ 验证 oldText 唯一
→ 计算新内容
→ write
```

queue 使用 `realpath` 作为 key：

```text
a.txt
alias-to-a.txt
```

即使用户传入不同字符串，只要指向同一个真实文件，就必须进入同一队列。

不同 realpath 使用不同 Promise tail，因此仍能并行。

operation throw 时，只让当前调用 reject；内部 tail 始终 fulfilled，后续 mutation 不会被前一个 rejection 永久堵住。

## parallel abort 如何结算

prepare 阶段可能已经准备好 c1，随后 c2 的 hook 触发 abort。

runtime 仍为整批生成确定结果：

```text
c1 prepared thunk → phase 2 发现 aborted → Operation aborted
c2 current prepare → Operation aborted
c3 尚未 prepare → synthetic Operation aborted
```

结果消息仍按 `[c1,c2,c3]` 写入历史，然后 Agent 按阶段 4 规则追加 terminal aborted assistant。

sequential 模式不同：尚未开始的调用不产生伪造 lifecycle。两个模式的 abort 语义分别由测试钉住。

## 替代方案为什么更差

| 替代方案 | 代价 |
|---|---|
| prepare 也 Promise.all | 权限 UI 并发弹出；hook 顺序不可预测 |
| end 事件等全部工具后统一发送 | 快工具完成后 UI 长时间没有反馈 |
| toolResult 按完成顺序入历史 | 模型 toolCall/result 协议顺序被运行时延迟污染 |
| 只给 writeFile 加锁 | 两个 edit 已经在锁外读取相同旧内容，仍会丢更新 |
| 用用户传入 path 字符串作为 key | symlink/相对路径别名可绕过同文件串行 |
| 第一个 sequential 工具只锁自己 | 形成难解释的半并行 batch，事件与依赖更复杂 |

## 决策点（供回测）

1. 为什么 prepare 必须串行，而 execute 可以并行？
2. 为什么 `tool_execution_end` 按完成顺序，而 toolResult message 必须按源顺序？
3. 为什么一个 sequential 工具出现时，整个 batch 都要降级？
4. 为什么文件 mutation queue 使用 realpath，并且必须包住 read/validate/write？

## 已知代价

- parallel path 比 serial path 多一层 entry/thunk 与 ordered outcomes。
- end 与 message 不再紧挨着发送，读事件代码必须理解两种顺序。
- 慢 prepare 会推迟所有 execute，这是权限顺序换来的代价。
- 同文件 edit 会失去并行收益，但换来不丢更新。
- 工具如果完全忽略 AbortSignal，已经开始的副作用仍可能完成；runtime 只能阻止尚未开始的执行。

## 验收对照

1. ✅ 100/20/30ms 工具总耗时 `<150ms`，证明真实并行。
2. ✅ end 顺序 `[c2,c3,c1]`，message/history 顺序 `[c1,c2,c3]`。
3. ✅ before hook 严格串行，所有 prepare 完成前 execute 不启动。
4. ✅ global sequential 与 per-tool sequential 都整批降级。
5. ✅ same realpath edit 串行、different realpath 并行、symlink 归一。
6. ✅ queue 中 operation throw 后下一项仍执行。
7. ✅ parallel prepare abort 生成 source-ordered Operation aborted 结果，Agent 最终 aborted。
8. ✅ Agent 可在 prompt 之间动态切换 execution mode。
