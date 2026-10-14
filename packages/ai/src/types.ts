// 消息 IR（spec §4 的最小集）。
// content 是块数组而不是字符串：一次 assistant 响应里 text 与 toolCall 可以共存，
// 且顺序有意义（模型先说"我要读文件"，再发 read 调用）。扁平化成字符串会丢结构。
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

// 从第 1 阶段就用全集，避免后续每加一个成员就要在消费方加分支。
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
export type Role = "system" | "user" | "assistant" | "toolResult";

// 阶段 8：system prompt 是 append-only 的增量段落历史（spec §3.2b）。
// section 只按 transcript 顺序追加，不覆盖旧 section；tag 是元数据，不进 prompt 文本。
// 工具集变化同样记为历史：toolsAdded/toolsRemoved 是 delta，不是当前全集。
export interface SystemSection {
	tag?: string;
	text: string;
}
export interface SystemMessage {
	role: "system";
	sections: SystemSection[];
	toolsAdded?: Tool[];
	toolsRemoved?: string[];
}
export interface UserMessage { role: "user"; content: ContentBlock[] }
export interface AssistantMessage {
	role: "assistant";
	content: ContentBlock[];
	stopReason: StopReason;
	usage?: Usage;
	durationMs?: number;
	errorMessage?: string;
}
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ContentBlock[];
	isError: boolean;
}
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Usage {
	inputTokens: number; outputTokens: number;
	cacheReadTokens?: number; cacheWriteTokens?: number;
}

// 手写 JSON Schema。本阶段只用到 required 与 properties 的 type 字段；完整校验在阶段 5。
export type JSONSchema = Record<string, unknown>;

// 本阶段只是声明，不实现执行；阶段 2 换成 JSONSchema 类型并接进循环。
export interface Tool {
	name: string;
	description: string;
	parameters: JSONSchema;
}

export interface StreamContext { system: SystemMessage; messages: Message[]; tools: Tool[] }

// 流式事件协议（spec §5 阶段 3）。本阶段只有文本 delta——
// text 起止、toolcall_* 与 error 是阶段 7 随真实 SSE 一起加；
// thinking_* 不在当前阶段启用，也不发送对应请求字段。
//
// 字段名两种：delta 类变体用 partial（"到目前为止攒出来的东西"，不是快照——
// text 块靠 *_delta 增长，只有 done 里那份才是权威），done 用 message。
// Pi 同样如此（types.ts:794-799 明说 partial 不是 event-time snapshot）。
//
// 注意 partial 只是本层的名字，别外推：阶段 4 的 message_update 顶层字段是 message
// （{...partialMessage} 的快照），内层才是把整个事件原样放进 assistantMessageEvent。
// 两个名字指的是两种东西：live 的在 partial 里，agent 层拿到的是死值。
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_start" | "text_end" | "toolcall_start" | "toolcall_end";
		contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "error"; reason: "error" | "aborted"; error: AssistantMessage }
	| { type: "done"; message: AssistantMessage };
