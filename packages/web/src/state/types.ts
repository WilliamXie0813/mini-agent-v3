import type {
	AgentEventEnvelope,
	ClientCommand,
	ServerMessage,
	SessionSnapshot,
} from "@mini-agent/protocol";

// Web 只允许 import @mini-agent/protocol；core 的事实类型经由 protocol 的
// type-only 引用结构化派生，保证 src 永远不触碰 core/ai/server。
export type { AgentEventEnvelope, ClientCommand, ServerMessage, SessionSnapshot };

export type SessionEntry = SessionSnapshot["entries"][number];
export type AgentEvent = AgentEventEnvelope["event"];
export type Message = Extract<SessionEntry, { type: "message" }>["message"];
export type UserMessage = Extract<Message, { role: "user" }>;
export type AssistantMessage = Extract<Message, { role: "assistant" }>;
export type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
export type ContentBlock = AssistantMessage["content"][number];
export type ToolCallBlock = Extract<ContentBlock, { type: "toolCall" }>;
export type Usage = NonNullable<AssistantMessage["usage"]>;
export type ToolResult = Extract<
	SessionEntry,
	{ type: "tool_outcome" }
>["result"];
export type AssistantMessageEvent = Extract<
	AgentEvent,
	{ type: "message_update" }
>["assistantMessageEvent"];

export interface SessionViewState {
	sessionId: string;
	leafId: string | null;
	status: SessionSnapshot["status"];
	// snapshot.status 只反映连接时刻；连接期间的 live status 由事件对推导，
	// 两个 active 标记区分 mid-run threshold compaction 与独立 compact 操作。
	agentActive: boolean;
	compactionActive: boolean;
	entries: SessionSnapshot["entries"];
	events: AgentEventEnvelope[];
	latestSequence: number;
	diagnostics: Array<{ id: string; message: string }>;
}

export interface AppState {
	connection:
		| "connecting"
		| "connected"
		| "reconnecting"
		| "disconnected"
		| "incompatible";
	session?: SessionViewState;
	prompt: string;
	selectedTimelineItemId?: string;
	pendingRequests: Record<string, ClientCommand["type"]>;
	lastProtocolError?: { code: string; message: string };
}

export type AppAction =
	| { type: "connection.changed"; connection: AppState["connection"] }
	| { type: "server.message"; message: ServerMessage }
	| { type: "prompt.changed"; prompt: string }
	| { type: "timeline.selected"; itemId?: string }
	| { type: "local.error"; code: string; message: string };

export interface ChatMessageView {
	kind: "message";
	id: string;
	role: "user" | "assistant" | "toolResult";
	text: string;
	streaming: boolean;
	stopReason?:
		| "pending"
		| "stop"
		| "length"
		| "toolUse"
		| "error"
		| "aborted";
	toolCallId?: string;
	toolCallIds: string[];
}

export type ChatItem = ChatMessageView;

export interface ToolCardView {
	id: string;
	toolCallId: string;
	toolName: string;
	sourceIndex: number;
	status: "pending" | "running" | "completed" | "error";
	args: unknown;
	partialResult?: unknown;
	result?: unknown;
	durationMs?: number;
	isError?: boolean;
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface TimelineItem {
	id: string;
	source: "journal" | "live" | "diagnostic";
	kind:
		| "submission"
		| "message"
		| "tool-intent"
		| "tool-update"
		| "tool-outcome"
		| "run-end"
		| "compaction"
		| "agent"
		| "turn"
		| "message-lifecycle"
		| "assistant-stream"
		| "tool-start"
		| "tool-update-live"
		| "tool-end"
		| "diagnostic";
	label: string;
	raw: unknown[];
	sequence?: number;
	elapsedMs?: number;
	toolCallId?: string;
	warning?: string;
}
