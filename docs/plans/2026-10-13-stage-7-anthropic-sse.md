# 阶段 7「真实 LLM 适配器（手写 SSE）」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手写一个符合既有 `StreamFn` 契约的 Anthropic Messages SSE 适配器，让 CLI 完成真实的「流式回复 → 工具调用 → 结果回喂 → 最终答案」。

**Architecture:** 在 `ai` 包内分开消息转换、SSE 帧解析、响应状态累积与 HTTP 泵；组装根只替换注入的函数，core 不识别 provider。先补齐统一流事件的成功/失败终止语义，再让真实适配器接入；只有完整响应进入历史，失败不执行半截工具。

**Tech Stack:** Node 22+ 内建 fetch / Web Streams / TextDecoder / AbortController、TypeScript 5.9.3（strict + erasableSyntaxOnly）、pnpm workspaces、vitest 3。零新增运行时依赖。

**Spec:** `docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 7、§3.2(a)、§4、§7.1–7.4；前置实现见 `docs/stages/06-parallel-tools.md`。

## Global Constraints

- **只加一个新概念**：消息 IR 与真实 provider 协议之间的适配。不得提前实现阶段 8 的 SystemMessage 重放、阶段 9 的持久化或阶段 11 的扩展系统。
- **先写测试，再写实现**；阶段结束时 `pnpm test` 与 `pnpm check` 全绿。
- **源码总量增量 < 400 行**；每个 `src` 文件 < 200 行。测试、fixtures 与文档不计入源码预算。
- **运行时依赖：零新增**；不引入 ai-sdk、`@anthropic-ai/sdk`、SSE parser 或 JSON repair 库。
- tab 缩进；ESM；包内相对导入带 `.ts` 后缀，跨包用包名；类型导入用 `import type`。
- `strict: true`、`erasableSyntaxOnly: true`；禁 enum、构造函数参数属性和 namespace。
- `StreamFn` 仍是同步返回 `AssistantMessageEventStream` 的函数；不能改回 AsyncGenerator 或 Promise，也不引入 Provider 类。
- **StreamFn 不抛异常，失败编码为终止事件**；配置工厂的前置条件错误与 listener 故障仍可抛，不能混入 provider 错误。
- delta 只供即时显示；正常响应只有 `message_stop` 才能生成 `done`，`content_block_stop` 和 `message_delta` 都不是完整消息终点。
- toolResult 按 assistant 源顺序回喂；连续的 toolResult 合并为同一条 user 消息中的 tool_result blocks。
- 网络测试不进 CI；fixtures 与 stub fetch 用于自动化验收，真实 API 仅在阶段结束前手动联调。
- core 不 import 或判断 fake/anthropic；假模型继续保留给确定性测试。Stage 7 不创建 Web/server 包或第二个组装根。
- 认证只支持 `ANTHROPIC_API_KEY`，并映射为 `x-api-key`；不把语义不同的 auth token 当作 API key 兼容。
- 不读取、输出、录制或提交真实凭据；错误诊断不能包含 Authorization/x-api-key 或完整请求上下文。

## Review Focus

1. **任意网络分片**：中文 UTF-8、CRLF、帧分隔符跨 chunk、单 chunk 多帧都必须得到相同事件。→ Task 3。
2. **工具参数截断与断网不同**：max_tokens + message_stop 是 length；没有 message_stop 的 EOF 是 error；两者都不能执行半截参数。→ Tasks 4、6。
3. **失败也必须 settle**：HTTP 500、SSE error、read reject、abort 必须恰有一个终止事件，迭代与 result() 都收尾。→ Tasks 1、5。
4. **历史转换不能错配**：混合 text/toolCall、多条连续 toolResult、失败回合之后再次 prompt 都保持合法 wire history；不原地改 IR。→ Tasks 2、6。
5. **事件交付失败不能伪装成 provider 错误**：慢 listener 仍被 await；reject 原样冒泡且不会触发第二套 terminal lifecycle。→ Tasks 1、6。

---

## 1. 已确认的边界与当前状态

2026-10-13 用户确认：

- **Stage 7 只把 CLI 接到真实模型；当前没有 Web/server 包，本阶段也不创建。thinking 暂不启用，且请求体不发送 thinking 字段。**
- **本阶段只记录 token 用量，成本延后。** 不新增价格表，不把未知费用写成 0；与总设计 §4 的 usage 契约一致。

因此本阶段实现 text/toolcall 三段事件与 error 终止，共 **9 个变体**，不机械复制 Pi 的 12 变体。thinking_* 与对应 content block 延后；请求体省略 `thinking` 字段，若网关仍主动返回不支持的语义 block，应显式报错，不能静默丢弃。

现有代码的衔接点：

| 当前文件 | 已有行为 | 本阶段要补的缝 |
|---|---|---|
| `ai/src/types.ts` | start / text_delta / done；Usage 仅两个字段 | block 起止、toolcall 增量、error、可读错误诊断、cache token 子计数 |
| `ai/src/event-stream.ts` | 仅 done 是 completion，自动计时 | error 同样完成 result() 并计时 |
| `ai/src/stream-fn.ts` | consume 仅接受 done | 返回 done.message 或 error.error；无 terminal 仍是契约违反 |
| `ai/src/fake.ts` | abort/异常用裸 end() | 对齐终止协议，保留既有正常 start/text_delta/done 序列 |
| `core/src/stream-assistant.ts` | 仅转发 text_delta | 所有 block 事件转成 message_update；error 转成 message_end |
| `core/src/agent-loop.ts` | 仅 length 有整批工具保护 | error/aborted 必须在任何工具执行前直接结束当前 run |
| `cli/src/index.ts` | 注入 fake；banner 仍标 stage 4 | 注入真实 provider，显示错误诊断，更新 banner |

`docs/HANDOFF.md` 停留在阶段 3，不能当作当前实现状态。Web UI 与 server 已从 `master` 撤销并保留在独立 feature 分支；执行 Stage 7 时不得重新创建或接线。`.gitignore` 受组织内容策略限制，本次未读取，也不能绕过限制读取。

## 2. 必须先定死的语义

### 2.1 成功与失败是两个终止出口

```text
正常：start → [text_* / toolcall_*] → done(message)
失败：start → [已发出的增量] → error(reason, error)
```

成功 stopReason 映射：

| Anthropic stop_reason | IR stopReason |
|---|---|
| end_turn / stop_sequence | stop |
| tool_use | toolUse |
| max_tokens | length |

null 只允许存在于未完成状态；未知 stop_reason、缺失必要生命周期、坏 JSON 或不支持的语义 block → error，不能猜成 stop。

error 终止消息使用 `content: []`、`stopReason: "error" | "aborted"` 与 `errorMessage`。已流出的 partial 不进入失败消息；尤其不能带尚未完成的 toolCall。token usage 若已收到则保留。这个终止记录是历史里的诊断，不是完整模型回复；下一次请求转换时跳过 error/aborted assistant。

core 对 terminal error/aborted **无条件先短路**，即使一个坏 StreamFn 把 toolCall 放进失败消息，也不能执行它。只发当前 turn_end 与 agent_end，不再请求模型、不再由 Agent 合成第二条失败消息。Agent 原有契约违反/loop 异常兜底保留。

### 2.2 JSON 参数只在 message_stop 解析

- 每个 tool_use block 独立保存 raw JSON 字符串，按 provider index 定位；不能把两个工具的片段拼到一起。
- `toolcall_delta.delta` 是原始字符串片段；partial.arguments 在完整解析前保持 `{}`，不能拿来执行。
- `toolcall_end` 只表示 block 传输结束，不承诺 arguments 已解析；message_stop 才决定完整响应是否可用。
- 空参数且没有 input_json_delta 时使用 content_block_start.input（必须是对象）。
- 完整响应里的非法 JSON、数组或 null 参数 → error；不使用宽松解析或修补 JSON。
- **max_tokens 且某个参数不完整**：保留 toolCall 的 id/name，以 `{}` 占位并记录 `errorMessage` 说明参数截断，仍产生 done(length)。core 的既有 length 分支会对**整批**调用生成明确 isError toolResult，包括参数完整的另一调用，execute 计数必须为 0。
- `truncated.sse` 必须有 max_tokens 和 message_stop；另用断网测试表示真正 EOF，不混淆两个场景。

### 2.3 消息转换与 usage

- 当前 system 仍为 `context.system.content`；messages 中的 system 不再次塞入 Anthropic messages。阶段 8 再改变这条读取规则。
- text → text；toolCall → tool_use（id/name/input）；Tool.parameters → input_schema，不携带 execute/replay/executionMode。
- toolResult → user/tool_result（tool_use_id/content/is_error）；连续结果合并，保持原始数组顺序，不排序。
- 相邻同角色 wire messages 合并 blocks；terminal error/aborted assistant 跳过，避免下次 prompt 发送空 assistant 或把诊断当模型回答。
- source messages、content 与 arguments 不得被转换器改写；用精确 wire 类型，不用 `as any` 穿透边界。
- `Usage.inputTokens` = input_tokens + cache_read_input_tokens + cache_creation_input_tokens，表示总输入；新增可选 cacheReadTokens/cacheWriteTokens 保留子计数。没有 cache 字段时这两项按协议视为 0。
- output_tokens 是累计值；message_delta 覆盖既有 outputTokens，不能把累计值逐帧相加。成功流缺少必要 usage 时显式报协议错误，不捏造计数；失败流可保留已收到的部分 usage。
- 不添加 cost 字段；阶段文档记录成本延期，后续计价需要区分 uncached/cache-read/cache-write。

## 3. File Structure 与共享接口

| 文件 | 职责 |
|---|---|
| Modify `packages/ai/src/types.ts` | 公共事件、AssistantMessage.errorMessage、Usage 子计数 |
| Modify `packages/ai/src/event-stream.ts` / `stream-fn.ts` / `fake.ts` | 统一 terminal 契约 |
| Create `packages/ai/src/anthropic-messages.ts` | wire 类型与纯请求转换 |
| Create `packages/ai/src/sse.ts` | 字节流 → SSE 帧，不认识消息 IR |
| Create `packages/ai/src/anthropic-stream.ts` | SSE JSON → partial / terminal 状态机 |
| Create `packages/ai/src/anthropic.ts` | 配置验证、fetch、后台泵、失败归一化 |
| Modify `packages/ai/src/index.ts` | 只公开 createAnthropicStreamFn 与配置类型 |
| Modify `packages/core/src/stream-assistant.ts` / `agent-loop.ts` | 统一事件映射与错误短路 |
| Modify `packages/cli/src/index.ts` | 配置组装与显示，不承担 wire 转换 |
| Create `packages/ai/fixtures/{text,toolcall,mixed,error,truncated}.sse` | 五个无凭据协议样本 |
| Create `packages/ai/test/anthropic-{messages,stream,cli}.test.ts`、`anthropic.test.ts`、`sse.test.ts` | 转换、状态机、子进程、HTTP 与分片测试 |
| Modify ai/core 既有相关测试 | 公共契约与生命周期回归 |
| Create `docs/stages/07-anthropic-sse.md` | 教学交付与联调偏差 |

不要为每种 event 再建文件；四个 provider 文件对应四个真实边界。预算目标：转换约 65 行、SSE 约 50 行、状态机约 120 行、HTTP 约 85 行、既有接口/消费链净增约 60 行，共约 380 行；超预算先检查职责重复，不能压缩可读性或删除错误检查来凑数。

共享签名（各任务不得自行另起名字）：

```ts
// types.ts：保留既有字段，新增如下。
interface AssistantMessage { errorMessage?: string }
interface Usage { cacheReadTokens?: number; cacheWriteTokens?: number }

// text_start/text_end/toolcall_start/toolcall_end:
// { type; contentIndex: number; partial: AssistantMessage }
// text_delta/toolcall_delta:
// { type; contentIndex: number; delta: string; partial: AssistantMessage }
// error:
// { type: "error"; reason: "error" | "aborted"; error: AssistantMessage }
// start 与 done 保持现有形状。

// anthropic.ts：不增加 fetch 工厂，测试 stub globalThis.fetch。
export interface AnthropicStreamOptions {
	apiKey: string;
	baseUrl?: string;
	model?: string;
	maxTokens?: number;
}
export function createAnthropicStreamFn(options: AnthropicStreamOptions): StreamFn;

// anthropic-messages.ts：同时定义精确 AnthropicRequest/wire block 类型。
export function toAnthropicRequest(
	context: StreamContext,
	options: { model: string; maxTokens: number },
): AnthropicRequest;

// sse.ts：event 默认为 message；解析器不擅自 JSON.parse。
export interface SseFrame { event: string; data: string }
export function readSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame>;

// anthropic-stream.ts：状态只属于一次请求，不跨请求复用。
export function createAnthropicStreamState(
	stream: AssistantMessageEventStream,
): {
	accept(frame: SseFrame): void;
	fail(reason: "error" | "aborted", message: string): void;
	readonly completed: boolean;
};
```

`AnthropicRequest` 必须固定 `stream: true`，且本阶段不包含 `thinking` 字段。`accept` 校验并解析 unknown JSON，遇到畸形协议可抛给 HTTP 泵；只有泵负责把它归一为 error。`fail` 幂等，不得覆盖已产生的 terminal。

---

### Task 1: 贯通统一 terminal 事件与消费契约

**Files:** Modify ai 的 `types.ts`、`event-stream.ts`、`stream-fn.ts`、`fake.ts`，core 的 `stream-assistant.ts`、`agent-loop.ts`；Test 对应既有 `event-stream.test.ts`、`stream-fn.test.ts`、`fake.test.ts`、`stream-assistant.test.ts`、`agent-loop.test.ts`、`agent.test.ts`。

**Interfaces:** 产生上述 9 变体与 errorMessage/usage 类型；保留 StreamFn、consumeAssistantMessage 与 streamAssistantMessage 原签名。后续任务消费这一终止契约，不重复实现 Agent 故障兜底。

- [ ] **Step 1: 写失败测试 `settles_error_terminal_for_iteration_and_result` 与 `maps_all_block_events_and_error`**

手工 push start、六种 block 起止/增量、error 后 end；断言事件保序，`result()` 与 `consumeAssistantMessage()` 返回同一 error.error，durationMs 非负。done 后 push error 和 error 后 push done 都不能产生第二个 terminal；裸 end 仍令 result() reject，consume 报缺少终止事件。

core 断言六种 block 事件全部转为 message_update，error 只转一次 message_end；慢 update listener 用 deferred gate 阻塞下一次交付，reject 保留原错误。

- [ ] **Step 2: 写失败测试 `stops_before_tools_on_error_or_aborted` 与 fake 中止测试**

带 toolCall 的 error/aborted terminal 替身：execute spy 为 0，streamFn 调用为 1，turn_end/toolResults 为空，agent_end 恰一次。通过 Agent 跑同一替身：只有一条 terminal assistant，waitForIdle settle，isStreaming false；listener reject 原样 reject 而非补发 error lifecycle。

fake 的预中止、流中中止与坏脚本均发一个 terminal error，不挂起；正常脚本仍保持既有 start/text_delta/done 事件序列。

旧测试若断言 fake abort 后裸 end/无 terminal，必须更新为新的明确契约；不能删除「半截 content 不进历史」或 listener reject 的断言。

- [ ] **Step 3: 跑 targeted tests 确认失败**

Run: `pnpm --filter @mini-agent/ai test -- event-stream stream-fn fake && pnpm --filter @mini-agent/core test -- stream-assistant agent-loop agent`

Expected: 新事件缺失或 terminal 未被消费导致 FAIL。两个包可分别执行以观察各自红灯，不修改旧测试来掩盖新断言。

- [ ] **Step 4: 实现协议与消费链**

AssistantMessageEventStream 把 done/error 都视为 completion 并从对应字段提取结果；consume 用 terminal 而非 done 单一判定。fake 也在失败前保证 start，失败诊断不携带半截 content。core 在把 terminal 入历史后、筛选工具前检查 stopReason，关闭 turn/run 后 return。无 completion 的 provider 仍由 Agent 的已有兜底处理；不 catch listener 错误。

- [ ] **Step 5: 验证与提交**

运行 Step 3 命令与 `pnpm check`，Expected: PASS。精确暂存上述变更，提交 `feat(stage-7): unify assistant stream terminal events`。

### Task 2: 实现消息 IR 到 Anthropic 请求的纯转换

**Files:** Create `packages/ai/src/anthropic-messages.ts`、`packages/ai/test/anthropic-messages.test.ts`。

**Interfaces:** 消费 Task 1 的 StreamContext / Message；产生 `AnthropicRequest` 与 `toAnthropicRequest(context, { model, maxTokens })`，供 Task 5 使用。

- [ ] **Step 1: 写失败测试 `converts_mixed_history_and_groups_tool_results`**

输入 user、assistant(text + c1 + c2)、toolResult(c1)、toolResult(c2)、user；精确断言 wire roles 为 `[user, assistant, user]`，最后的 user blocks 为 `[tool_result(c1), tool_result(c2), text]`。断言 is_error、tool_use_id、tool_use.input、tools.input_schema、system、model、max_tokens、stream:true，且不存在 `thinking`；不含内部 ToolDef 字段。

- [ ] **Step 2: 写失败测试 `keeps_history_immutable_and_skips_terminal_failures`**

冻结输入并转换两次：IR 深度相等且两次请求相等。覆盖多个 system、空 tools、相邻 user、error/aborted 后再次 user；不发送空 assistant，不把 errorMessage 作为模型回答，不重复 system。正常 mixed content 顺序必须原样保留。

- [ ] **Step 3: 确认红灯**

Run: `pnpm --filter @mini-agent/ai test -- anthropic-messages`。Expected: 模块/函数不存在而 FAIL。

- [ ] **Step 4: 实现纯转换**

明确 wire block 联合类型。仅按角色与内容块转换，不执行工具、不改历史、不访问环境变量；相邻同角色的合并只作用于新建 wire arrays。本阶段工具结果只支持 text blocks，非 text 结果显式报 unsupported，而不是错误地编码为 tool_use。

- [ ] **Step 5: 验证与提交**

Run: Step 3 命令与 `pnpm --filter @mini-agent/ai check`。Expected: PASS。提交 `feat(stage-7): convert message IR to Anthropic requests`。

### Task 3: 手写对网络分片不敏感的 SSE 帧解析器

**Files:** Create `packages/ai/src/sse.ts`、`packages/ai/test/sse.test.ts`。

**Interfaces:** 消费 ReadableStream<Uint8Array>；产生 `SseFrame` / `readSse(body)`，不依赖 Anthropic 状态。

- [ ] **Step 1: 写失败测试 `parses_identically_at_every_byte_boundary`**

用含中文、LF/CRLF 与多个 event 的同一 UTF-8 字节数组，遍历每个切分点送入 ReadableStream；结果均等于未分片帧列表。另覆盖每字节一 chunk、一个 chunk 多帧、CR 与 LF 分开、分隔空行分开。

- [ ] **Step 2: 写失败测试 `handles_sse_fields_and_releases_reader`**

断言多条 data 行按 `\n` 拼接；注释、id、retry 不改变 payload；冒号后最多去掉一个空格，无 event 时默认为 message；仅注释帧不产出。EOF 无空行的残帧不派发；完整帧已派发但未出现 message_stop 的判定留给上层。

消费者提前 break 时 cancel 并释放 reader；正常 EOF 释放锁；底层 read reject 原样 reject；不主动重试。

另断言 cancel reject 不产生未处理 rejection、锁仍释放；若已有 read/protocol 错误，保留原错误为主诊断，把 cleanup 错误作为 cause，而非静默吞掉或覆盖。

- [ ] **Step 3: 确认红灯**

Run: `pnpm --filter @mini-agent/ai test -- sse`。Expected: readSse 不存在而 FAIL。

- [ ] **Step 4: 实现 readSse**

用流式 TextDecoder（fatal:true）避免把半个中文字符替换成乱码；以行缓冲处理 LF、CRLF、CR，空行才派发完整事件。finally 负责 reader 生命周期；不得对每个网络 chunk 单独 split/JSON.parse，也不把坏 UTF-8 静默替换。

- [ ] **Step 5: 验证与提交**

Run: Step 3 命令与 ai check。Expected: PASS。提交 `feat(stage-7): parse SSE across arbitrary byte chunks`。

### Task 4: 把 Anthropic 生命周期映射为统一事件

**Files:** Create `packages/ai/src/anthropic-stream.ts`、`packages/ai/test/anthropic-stream.test.ts`、五个 `packages/ai/fixtures/*.sse`。

**Interfaces:** 消费 Tasks 1/3 的 event stream 与 SseFrame；产生 `createAnthropicStreamState(stream)`，Task 5 用 accept/fail/completed 驱动它。

- [ ] **Step 1: 写五个脱敏 fixtures 与对应失败测试**

| fixture | 必须钉住的断言 |
|---|---|
| text.sse | 中文分片文本完整；start → text_start → text_delta×n → text_end → done(stop) |
| toolcall.sse | c1/read，参数 `{"path":"package.json"}` 分片累积；message_stop 后 arguments 深度相等，done(toolUse) |
| mixed.sse | text + c1/slow_read(`{"path":"a.txt"}`) + c2/fast_read(`{"path":"b.txt"}`)，content 源顺序不变，所有 contentIndex 对应正确 |
| error.sse | SSE error（如 overloaded_error）→ 一个 error(error)，可读 errorMessage |
| truncated.sse | max_tokens + message_stop + 一个半截 JSON、一个完整工具 → done(length)，两工具 id/name 保留 |

样本固定 input_tokens=10、cache_read_input_tokens=20、cache_creation_input_tokens=5；output_tokens 先 2 后 7，最终 usage 为 `{ inputTokens:35, outputTokens:7, cacheReadTokens:20, cacheWriteTokens:5 }`。记录样本是手写协议样本还是实际脱敏录制，不能把手写数据声称为真实录制。

- [ ] **Step 2: 写失败测试 `does_not_finish_or_parse_arguments_before_message_stop`**

喂到 content_block_stop/message_delta 时，assert completed=false、没有 done、partial.stopReason 为 pending；直到 message_stop 才出现最终 stopReason 与解析后的 arguments。无参数 delta 的空对象工具得到 `{}`；两个工具各自 raw buffer，不串参数。

- [ ] **Step 3: 写失败测试 `rejects_invalid_protocol_without_success_fallback`**

完整响应里坏 JSON/数组/null tool input、重复 index、不存在 block 的 delta、缺少 message_start/stop_reason/usage、未知 stop_reason、不支持的 thinking block 均产生明确错误（accept 抛出的错误由测试调用 fail 归一）。正常未知非语义 SSE event 与 ping 可以忽略；已支持事件的畸形 payload 不可忽略。event 字段与 JSON type 不一致时报错（event=message 默认值除外）。

fail 两次只产一个 terminal；terminal content 为空且不携带部分工具。收到 max_tokens 但没有 message_stop 仍未完成，不能自行猜 length。

参数化非整数/负数 index、空 tool id/name、重复 tool id、负数/非有限 token 计数、tool_use stop_reason 但没有工具块；均不能变成成功消息。未知工具名本身合法，仍由 core 的 prepare 回喂错误。

- [ ] **Step 4: 确认红灯**

Run: `pnpm --filter @mini-agent/ai test -- anthropic-stream`。Expected: 状态机不存在而 FAIL。

- [ ] **Step 5: 实现一次请求的响应状态**

stream 的 start 由调用 createAnthropicStreamState 时发一次；message_start 只初始化协议与 usage，不再发第二个 start。维护 block 索引、独立 JSON buffer、block open/closed、stopReason 与累计 usage；在 message_stop 一次性 finalize。所有正常已开启 blocks 必须已 closed；length 可容许尚未闭合的截断 block。与已有 partial 一样，这是 live 数据，不宣称事件时快照。

未知 JSON 输入必须先缩窄再读字段；协议错误带 event/block index，不包含完整上下文或凭据。

- [ ] **Step 6: 验证与提交**

Run: Step 4 命令及 ai 的 `sse event-stream stream-fn` tests、ai check。Expected: PASS。提交 `feat(stage-7): map Anthropic SSE to assistant events`。

### Task 5: 实现真实 StreamFn 的 HTTP 泵与取消

**Files:** Create `packages/ai/src/anthropic.ts`、`packages/ai/test/anthropic.test.ts`；Modify `packages/ai/src/index.ts`。

**Interfaces:** 消费 Tasks 2–4；产生公共 `createAnthropicStreamFn(options): StreamFn` 与 `AnthropicStreamOptions`。内部转换器/状态机不从包 index 导出。

- [ ] **Step 1: 写失败测试 `posts_streaming_messages_and_returns_stream_immediately`**

stub globalThis.fetch，用 deferred 阻塞 response；调用 streamFn 同步得到 AssistantMessageEventStream，不等待 HTTP。默认 model 为 kimi-for-coding、maxTokens=4096、baseUrl=https://api.kimi.com/coding/；有无尾斜杠都请求 `/coding/v1/messages`，不能丢 `/coding/` 前缀，已以 `/v1` 结尾的 baseUrl 不再重复加 v1。

断言 POST、content-type:application/json、anthropic-version:2023-06-01、x-api-key、原始 AbortSignal、精确请求 body，且 body 不含 `thinking`。使用测试占位 key，不读真实环境变量；每个测试恢复 fetch stub。

- [ ] **Step 2: 写失败测试 `all_provider_failures_resolve_one_terminal`**

参数化 HTTP 401/500（含 JSON 与纯文本错误）、fetch reject、无 response.body、非 SSE content-type、SSE error、body read reject、正常帧后 EOF 但没有 message_stop、坏 UTF-8/JSON、请求转换错误。断言同步调用不 throw，for-await 不 reject，result() resolves(error assistant)，errorMessage 能区分 HTTP status/网络/协议错误；不存在 done 或半截工具。

错误文本限长 1024 字符，至少移除当前配置 apiKey，不能输出请求 headers/body；不返回「空白成功」。

另单测工厂：空 key/model、maxTokens 为 0/负数/小数、非法 URL/非 http(s)/URL 内嵌凭据都在工厂调用时明确 throw，fetch spy 为 0；这不是 StreamFn 的运行期失败。

- [ ] **Step 3: 写失败测试 `abort_settles_and_releases_transport`**

覆盖调用前 signal 已 abort（fetch 为 0）、等待 response 时 abort、读取 text/toolcall delta 后 abort。已 abort 时仍按 start/error 契约结束；不是 HTTP error。断言 stopReason=aborted、只有一个 terminal、reader 被取消/释放。done 已到达后的 abort 不改变结果；message_stop 后立即停止读取，不等待网关关闭连接。

用 deferred gates，不靠 sleep 猜 race；不要留下未 settle 的测试 stream 或 promise。

- [ ] **Step 4: 确认红灯**

Run: `pnpm --filter @mini-agent/ai test -- anthropic.test`。Expected: 工厂不存在而 FAIL。

- [ ] **Step 5: 实现工厂与后台泵**

工厂验证 apiKey/model 非空、maxTokens 为正整数、baseUrl 为 http/https URL 且无内嵌凭据；配置错误在 Agent 生命周期前明确抛出。StreamFn 内先创建 stream/state 再用 queueMicrotask 启动泵；请求转换、fetch、读帧都在泵的错误边界内。

`accept` 后 completed 为真即 break；正常 EOF 若未 completed 则 fail(error)。catch 优先检查调用方 signal.aborted，否则 fail(error)；finally 完成 reader 清理与 stream.end。不得只 catch 后裸 end，也不对 HTTP 故障自动重试；重试涉及工具副作用与计费，不属于本阶段。

- [ ] **Step 6: 验证与提交**

Run: `pnpm --filter @mini-agent/ai test && pnpm --filter @mini-agent/ai check`。Expected: PASS。提交 `feat(stage-7): add fetch-based Anthropic stream provider`。

### Task 6: 接 CLI、证明工具回喂与阶段 6 顺序不变

**Files:** Modify `packages/cli/src/index.ts`、`packages/core/test/agent-loop.test.ts`、`packages/core/test/agent.test.ts`；Create `packages/ai/test/anthropic-cli.test.ts`、`docs/stages/07-anthropic-sse.md`。

**Interfaces:** CLI 消费 Task 5 的公共工厂；core 集成测试使用公共 StreamFn，不 import ai 内部 provider 模块。当前没有 Web/server 包，本任务不得创建。

- [ ] **Step 1: 写失败测试 `round_trips_two_tools_in_source_order` 与 `length_never_executes_tools`**

stub fetch 第一轮返回 mixed.sse，第二轮返回 text.sse。用两个受 gate 控制的 spy 工具让 c2 先完成；断言 tool_execution_end 为 `[c2,c1]`，历史 toolResult 为 `[c1,c2]`，第二次请求的 user/tool_result blocks 也是 `[c1,c2]`。messages roles 为 `[user,assistant,toolResult,toolResult,assistant]`，最终 stopReason=stop。

spy 工具名与参数严格匹配 mixed.sse 的 slow_read/fast_read；core 测试用 `readFile(new URL("../../ai/fixtures/mixed.sse", import.meta.url), "utf8")` 读取共享 fixture，不复制一份协议样本，也不向 ai 包新增 core 依赖。

第一轮换 truncated.sse：所有工具 execute 为 0，两个 isError 结果回喂，第二轮完整文本正常结束。另对 HTTP 500、tool JSON 流中 EOF 和 abort 断言 prompt settle、无半截 assistant/工具结果、只一个 terminal assistant/agent_end；listener reject 仍原样 reject。

- [ ] **Step 2: 写失败测试 `cli_uses_real_provider_and_reports_configuration_errors`**

在 ai 测试中通过 node:child_process 启动 CLI 的绝对源文件路径，cwd 指向临时目录；本地 `127.0.0.1` HTTP server 提供 fixtures，显式 env 设置测试 key/baseUrl/model。第一轮 toolcall.sse 指向临时目录 `package.json` 的 read 工具，第二轮 text.sse；stdin 输入 prompt 与 `/exit`，断言输出逐段文本、read 卡片行、最终文本及 stage 7 banner，进程正常退出。

清除 `ANTHROPIC_API_KEY` 后启动：非零退出、stderr 有配置错误、不悄悄切回 fake。HTTP 500 输出可读诊断后允许下一次 prompt；用完整第二次成功响应证明失败历史转换不报错。测试结束关闭 server/child 与准确命名的临时文件，不能访问外网。

- [ ] **Step 3: 确认红灯**

Run: `pnpm --filter @mini-agent/core test -- agent-loop agent && pnpm --filter @mini-agent/ai test -- anthropic-cli`。Expected: CLI 仍注入 fake 或新集成断言不满足而 FAIL。

- [ ] **Step 4: 修改 CLI 组装根与错误显示**

凭据只取 `ANTHROPIC_API_KEY`（不把真实值打印出来），其余取 ANTHROPIC_BASE_URL/ANTHROPIC_MODEL；缺省使用 Task 5 默认值。不增加 dotenv，不隐式加载文件，也不静默 fallback 到 fake。

安装真实函数后再构造 Agent。banner 改为 `mini-agent (stage 7) — type /exit to quit`；error message_end 优先显示 errorMessage，兼容旧 Agent 兜底的 text content；length 诊断也显示，不让截断看似成功。只打印 text_delta 文本，toolcall_delta 不直接输出 raw JSON；执行阶段沿用既有工具日志。保留 SIGINT、readline 与 Agent 单飞逻辑。

- [ ] **Step 5: 完成自动化验收与边界检查**

Run: `pnpm test && pnpm check`。Expected: 当前所有 workspace 包全绿；不得通过重新引入 Web/server 包来满足任何测试。若已有无关失败，记录原因，不把它算作本阶段通过。

Run: `git grep -n -E 'fake|anthropic' -- packages/core/src`。Expected: 无输出（退出码 1 表示无匹配）。逐个检查本阶段 src 文件行数 <200，比较实施前后源码净增量 <400；仓库没有独立 lint 命令，不添加 lint/build 工具。

- [ ] **Step 6: 手动真实联调（需有凭据与外发上下文授权）**

仅在用户明确允许向所选 provider 发送测试内容后执行；凭据配置不等于授权外发仓库代码。先在只含自建无敏感 `package.json` 的临时目录启动 CLI，输入「读一下 package.json 然后总结」；观察流式文本、read、总结，确认 tool result 成功回喂。不要自动发送本仓库代码、配置或完整 fixtures。

再做一次 Ctrl+C：返回 prompt，isStreaming 清理且没有半截工具执行。记录网关 stop_reason、usage/cache 字段与 `x-api-key` 兼容性；确认请求未发送 `thinking` 字段。若网关仍主动返回 thinking 语义块，按不支持协议记录并新增脱敏回归 fixture，不能通过静默忽略来「修好」。

没有授权/凭据/可用网络时，本项标未完成，不声称真实联调通过。官方文档检索本次遇到区域重定向/失效页面，不能把搜索摘要当已验证的 Kimi 协议事实；上述兼容性必须以实际响应确认，不伪造官方依据或 User-Agent 身份。

- [ ] **Step 7: 写教学文档与提交**

`docs/stages/07-anthropic-sse.md` 按既有四段结构写：问题 / Pi 决策（总设计引用 ai/src/types.ts:801，标注本地 Pi 源码未复核）/ 替代方案代价 / 回测决策点；补充已知代价与实际联调偏差。

至少留下五个可追问问题：为何 error 是事件而非 throw；为何 block_stop 不能代表 done；为何 raw JSON 不能直接执行；为何 length 与 EOF 必须分开；为何连续 toolResult 要合并为 user。明确 thinking 与成本延期，fake 的正常序列未扩成 block 起止事件是兼容性选择。

精确暂存本任务文件，提交 `feat(stage-7): wire real provider into the CLI`；每个任务提交结尾使用 `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`，不得夹带或重新引入 Web/server 代码。

## 4. 完成标准与自审映射

| 总设计阶段 7 要求 | 实施任务 |
|---|---|
| Anthropic 消息转换，toolResult 合并成 user | Task 2；Task 6 验证第二次 HTTP 请求 |
| 手写 SSE，text 与多个 tool call 共存且有序 | Tasks 3–4；mixed fixture |
| 参数分片累积，message_stop 才解析/done | Task 4 |
| 五种 fixtures 全通过 | Tasks 4–5 |
| truncated → length，整批工具判失败 | Tasks 4、6 |
| HTTP 500 不 throw，以 error 收尾 | Tasks 1、5、6 |
| token usage 与 durationMs | Tasks 1、4；成本按用户确认延期 |
| CLI 真实 read/总结与 Ctrl+C | Task 6 手动联调；无授权时明确未完成 |
| core 不认识 provider，真实 provider 只在 CLI 组装根接线 | Tasks 1、6 |
| 阶段学习文档与可追问决策点 | Task 6 |

本文件只交付计划，不实现源码、不替用户填写回测答案、不宣称阶段 7 已完成。执行顺序为 Tasks 1 → 2 → 3 → 4 → 5 → 6；Task 2/3 的实现互不依赖，但本项目按任务顺序推进即可，无需并行工作流。
