// 消息 IR（spec §4 的最小集）。
// content 是块数组而不是字符串：一次 assistant 响应里 text 与 toolCall 可以共存，
// 且顺序有意义（模型先说"我要读文件"，再发 read 调用）。扁平化成字符串会丢结构。
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

// 从第 1 阶段就用全集，避免后续每加一个成员就要在消费方加分支。
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
export type Role = "system" | "user" | "assistant" | "toolResult";

// content 现在是 string；阶段 8 改写为增量段落数组（spec §3.2b，路线里唯一一次回头改）。
export interface SystemMessage { role: "system"; content: string }
export interface UserMessage { role: "user"; content: ContentBlock[] }
export interface AssistantMessage {
	role: "assistant";
	content: ContentBlock[];
	stopReason: StopReason;
	usage?: Usage;
	durationMs?: number;
}
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ContentBlock[];
	isError: boolean;
}
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Usage { inputTokens: number; outputTokens: number }

// 本阶段只是声明，不实现执行；阶段 2 换成 JSONSchema 类型并接进循环。
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface StreamContext { system: SystemMessage; messages: Message[]; tools: Tool[] }

// 阶段 3 在 start 与 done 之间插入 delta 变体。
export type AssistantMessageEvent =
	| { type: "start"; message: AssistantMessage }
	| { type: "done"; message: AssistantMessage };
