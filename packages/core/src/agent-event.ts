import type {
	AssistantMessageEvent,
	Message,
	ToolResultMessage,
} from "@mini-agent/ai";

// 分层生命周期：agent > turn > message，tool_execution 嵌在 turn 内。
// 四层各自成对（start/end），监听方只消费事件流就能渲染 CLI，无需读内部状态。
// 失败路径也会补齐配对：Agent.handleRunFailure 合成 error/aborted 消息走完整序列。
export type AgentEvent =
	// 一次 prompt() 运行的边界。agent_end 的 messages 只含本次新增，
	// 不含历史——历史在 Agent.state.messages。
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	// 一轮 = 一次 streamFn 往返 + 一批工具执行；模型不再发 toolCall 时循环收敛。
	| { type: "turn_start" }
	| {
			type: "turn_end";
			message: Message; // 本轮模型返回的 assistant 消息
			toolResults: ToolResultMessage[]; // 本轮的工具结果；无工具调用时是 []
	  }
	// message 层包裹每一条进历史的消息，包括 user 和 toolResult，
	// 不只是 assistant——监听方靠它把每条消息恰好渲染一次。
	| { type: "message_start"; message: Message }
	| {
			type: "message_update";
			// 截至当前的半截消息，渲染用，不进历史；
			// 进历史的是 message_end 携带的完整消息（delta 是传输层碎块）。
			message: Message;
			assistantMessageEvent: AssistantMessageEvent; // 原始 delta，需要流式文本时取这里
	  }
	| { type: "message_end"; message: Message }
	// 工具三段式：start → (update)* → end。
	// 截断的参数也走完整三段（failTruncatedToolCalls），只是 end 必带 isError: true。
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			// 部分结果来自工具的 onUpdate 回调（阶段 5 起），执行期间可发多次；
			// 只供 UI 即时显示，不进历史——进历史的仍是 toolResult 消息。
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
			durationMs?: number; // performance.now() 差值；不用 Date.now()，避免时钟回拨
	  };

// 返回 Promise 是有意的：慢 listener 对整个 run 施加 backpressure，
// 事件顺序因此可预期；listener 抛错会中断运行（AgentListenerFailure 包装后冒泡原始错误）。
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
export type AgentEventListener = AgentEventSink;
