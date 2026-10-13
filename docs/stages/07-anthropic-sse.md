# 阶段 7 —— 真实 LLM 适配器（手写 SSE）

> spec：`docs/specs/2026-10-09-mini-agent-v3-design.md` §5 阶段 7  
> 计划：`docs/plans/2026-10-13-stage-7-anthropic-sse.md`  
> 交互图解：[`07-anthropic-sse-explained.html`](07-anthropic-sse-explained.html)

## 这个阶段解决了什么问题

前六阶段的工具、循环与事件已经能工作，但数据来自确定性 fake。真实模型不一次返回完整对象，而是在 HTTP 连接上逐段发字节；一次读取可能只有半个中文字符，也可能包含多条 SSE 事件。

阶段 7 把这些传输细节关在 `ai` 包里：

```text
StreamContext
  → toAnthropicRequest
  → fetch POST /v1/messages
  → readSse（字节 → 帧）
  → createAnthropicStreamState（帧 → 统一事件）
  → AssistantMessageEventStream
  → core / Agent / CLI
```

core 仍只认识 StreamFn、消息 IR 与统一事件。CLI 是组装根：它把默认函数从 fake 换成 `createAnthropicStreamFn`，不用重写工具调度。

### 两种事件、三条时间线

- **网络时间线**：字节 chunks，不等于 JSON，也不等于语义边界。
- **显示时间线**：start、text/toolcall 起止与 delta，CLI 立即打印 text_delta。
- **历史时间线**：done 携带的完整响应，或 error 携带的终止诊断；半截 partial 不能当作模型回复。

Provider 的统一事件共九种：start、text_start/delta/end、toolcall_start/delta/end、done、error。AgentEvent 在外层把它们包成 message_start/update/end；这不是两套重复事件，而是两个不同抽象层。

## Pi 的哪条决策是答案

总设计引用 Pi `ai/src/types.ts:801` 与 `agent/src/types.ts:27–31`。本阶段未读取本地 Pi 源码，这些行号沿用总设计，不声称已复核。

### 1. 用函数缝，不让 core 认识 provider

`createAnthropicStreamFn(options)` 先验证配置，返回一个 StreamFn。调用这个函数时立刻得到 event stream，再由 queueMicrotask 启动 HTTP 泵。网络不等 UI 的 next()，事件先入队，消费者按自己的速度读。

唯一跨层改变是补齐原先只有 done 的终止协议；没有引入 Provider 类或第二套 agent。

### 2. SSE 解析与语义解析分开

`sse.ts` 用流式 TextDecoder 保存跨 chunk 的半个字符，用行缓冲识别 LF/CRLF/CR；只有空行才派发帧。多条 data 行用换行连接，注释/id/retry 不进入 payload。EOF 没有空行的残帧不派发。

它不认识 tool_use、usage 或 stop_reason。`anthropic-stream.ts` 才检查 JSON 与生命周期，维护 contentIndex、每个工具独立的 raw JSON buffer、block open/closed 与 usage。

提前结束读帧会 cancel reader，并在 finally 释放锁；解码/read 错误不能被取消错误覆盖。若已成功终止后 cleanup 才失败，只输出脱敏 cleanup 诊断，不再发第二个 terminal。

### 3. block_stop 不等于 message_stop

一个 block 结束后，后面还可能有另一个 tool_use；message_delta 才报告 stop_reason 和累计用量；message_stop 才确认整次响应完成。

因此：

```text
input_json_delta '{"path":'
input_json_delta '"package.json"}'
content_block_stop          → toolcall_end，但 arguments 仍不是权威值
message_delta(tool_use)     → 内部记住 toolUse，partial 仍是 pending
message_stop                → JSON.parse → done(toolUse)
```

JSON 参数不做宽松修补。正常完成时，坏 JSON、null、数组都报协议错误。max_tokens 时，无法解析的工具保留 id/name，用 `{}` 占位并记录截断诊断；这个占位只供配对，不供执行。

### 4. length 与 error 是不同的事实

| 现场 | 终止 | 工具行为 |
|---|---|---|
| max_tokens **且有 message_stop** | done，stopReason=length | 整批不执行，所有工具收到 isError 结果，模型可重发 |
| 网络 EOF，**没有 message_stop** | error，stopReason=error | 不保存半截工具，不自动重试 |
| HTTP 非 2xx / SSE error / 坏协议 | error | 可读诊断，run 收敛 |
| 用户 abort | error，reason/stopReason=aborted | 不保存半截响应，返回输入状态 |

error 的终止消息有 `content: []` 和 errorMessage。Agent 通过正常 message_end/turn_end/agent_end 收尾，不需要再合成第二条错误回复；下一次请求跳过诊断 assistant，并合并相邻 user 消息。

listener reject 仍是交付故障，原样让 prompt reject；Agent 同时 abort 自己拥有的 run signal，停止无人消费的 HTTP 读取，但不向 listener 递归交付第二套错误生命周期。缺少任何 terminal 的坏 StreamFn 仍由 Agent 既有兜底处理。

### 5. toolResult 必须变成 user/tool_result

```text
IR:
assistant [text, toolCall(c1), toolCall(c2)]
toolResult(c1)
toolResult(c2)

Wire:
assistant [text, tool_use(c1), tool_use(c2)]
user      [tool_result(c1), tool_result(c2)]
```

这是 Anthropic 的协议，不是 UI 偏好。阶段 6 的完成顺序 `[c2,c1]` 只影响 tool_execution_end；历史与 wire 仍是 `[c1,c2]`。转换器不对调用排序，也不修改原始 IR。

顺序批次若在 c1 完成后中止，c2 没有实际结果，不能只跳过 aborted 诊断后继续发送缺配对的历史。转换器在 **wire 副本** 中按调用源顺序保留已记录结果，并为缺失结果补 `is_error: true` 的 tool_result，明确说明前一回合中断、不能假定工具成功。它不执行剩余工具，不假造成功或修改原始历史；即便工具曾产生副作用但结果未入历史，也不自动重试。

### 6. usage 不是每帧相加

inputTokens 表示总输入：`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。另保留 cacheReadTokens/cacheWriteTokens。

样本的 `10 + 20 + 5 = 35`；output_tokens 从 2 到 7 是累计值更新，最终输出是 7，不是 9。durationMs 仍由统一 event stream 用单调时钟结算。

没有价格表，成本未知；本阶段不新增 cost 字段，不用 0 假装已知费用。

## 替代方案为什么更差

| 替代方案 | 失去什么 |
|---|---|
| 引入 SDK 后只取最终对象 | 本阶段要理解的字节分片、参数拼接与终止边界不可见 |
| 对每个 fetch chunk 单独 JSON.parse | chunk 没有协议边界，中文与 JSON 都可能被切断 |
| toolcall_end 就执行 | 还不知道 max_tokens；半截参数可能产生错误副作用 |
| EOF 一律猜成 stop 或 length | 把断网伪装成成功/可恢复截断 |
| HTTP 泵只 catch 后裸 end | consume/result 要么报契约违反，要么挂起，失去原始诊断 |
| provider catch listener 错误 | 网络故障与 UI/落盘故障混淆，可能补发重复生命周期 |
| 自动重试失败请求 | 是否重复计费、工具是否已产生副作用都不明确 |

## 决策点（供回测）

1. 为什么 StreamFn 同步返回流，却不能同步抛出 HTTP 故障？
2. 为什么 text_end / toolcall_end 之后还不能把 assistant 放入历史？
3. 如果一个工具 JSON 完整、另一个被截断，为什么连完整的那个也不执行？
4. 为什么 EOF 与 max_tokens 不能走同一条分支？
5. toolResult 为什么是 user 消息，不是新的 tool 角色？
6. 为什么 output_tokens=2 → 7 的最终值不是 9？
7. listener reject 与 provider error 的区别，在哪个边界被保留？

## 运行与当前验收范围

```bash
# 在自己的终端配置；不要把 key 写进仓库或提交。
export ANTHROPIC_API_KEY='<your-key>'
export ANTHROPIC_BASE_URL='https://api.kimi.com/coding/'
export ANTHROPIC_MODEL='kimi-for-coding'
pnpm dev
```

仅支持 API key → x-api-key；不读取 ANTHROPIC_AUTH_TOKEN，不加载 .env，不退回 fake。baseUrl 保留 `/coding/` 前缀，拼接 `/v1/messages`；已带 `/v1` 不重复拼接。缺 key 在生命周期前报配置错误。

`pnpm dev` 的工作目录是 `packages/cli`，工具相对路径以它为准；「读一下 package.json」会读 CLI 包文件。测试则把 CLI 子进程放进临时目录，只读取自建无敏感文件。

五个 SSE fixtures 都是**手写协议样本**，不是实际 Kimi 录制。自动化覆盖本地 HTTP 子进程、工具回喂、双顺序、截断保护、HTTP/协议错误与取消。

教学 HTML 的交互测试运行实际脚本，覆盖播放器与两个实验；尚未做真实浏览器视觉验收。CLI 子进程测试确认本地请求与文本/工具往返，不单凭 stdout 分块断言文本一定在响应完成之前到达。

**真实 API 联调未执行。** 用户选择暂不发送真实请求，之后手动补充 API key。不能据此宣称 Kimi 网关兼容性已验证；thinking 字段不发送，但若网关主动返回 thinking block，当前会明确报不支持。不要伪造客户端身份或静默丢弃 thinking 来绕过问题。

**真实补验清单：** 自建无敏感目录中运行 CLI，确认流式文本 → read → 最终总结；流中按 Ctrl+C 确认回到 prompt；记录认证、stop_reason 与 cache usage 差异。发现差异后先补脱敏回归测试再调整实现。

## 实施中明确的取舍

- 状态机增加内部可选诊断 formatter，保证 SSE error 也在 terminal 发出前脱敏；公共工厂 API 不变。
- HTTP 错误只显示状态码，不输出可能回显上下文的错误 body；拒绝自动 redirect，避免携带 x-api-key 跟随跳转。
- provider-through-Agent 用单独的 integration test 文件，避免进一步膨胀已有生命周期测试。
- fake 保留正常 start/text_delta/done 序列；仅失败与中止对齐新 terminal 契约。
- 源码仍遵守单文件 <200 行、阶段净增量 <400 行；没有新增运行时依赖、Web 包或下一阶段功能。
