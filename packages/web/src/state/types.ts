import type {
	AgentEventEnvelope,
	DemoScenarioSummary,
	ServerMessage,
} from "@mini-agent/protocol";

type WireEvent = AgentEventEnvelope["event"];
type WireMessage = Extract<WireEvent, { type: "message_end" }>["message"];

export type ChatMessage = Exclude<WireMessage, { role: "system" }>;
export type ToolResultMessage = Extract<WireMessage, { role: "toolResult" }>;
export type ConnectionState =
	| "connecting"
	| "connected"
	| "disconnected"
	| "incompatible";
export type RunStatus =
	| "running"
	| "completed"
	| "aborted"
	| "error"
	| "failed";

export interface RunDiagnostic {
	code: string;
	message: string;
	sequence?: number;
}

export interface RunViewState {
	runId: string;
	status: RunStatus;
	envelopes: AgentEventEnvelope[];
	diagnostics: RunDiagnostic[];
}

export interface AppState {
	connection: ConnectionState;
	scenarios: DemoScenarioSummary[];
	selectedScenarioId?: string;
	prompt: string;
	run?: RunViewState;
	selectedTimelineItemId?: string;
	lastProtocolError?: { code: string; message: string };
}

export type AppAction =
	| { type: "connection.changed"; connection: ConnectionState }
	| { type: "server.message"; message: ServerMessage }
	| { type: "scenario.selected"; scenarioId: string }
	| { type: "prompt.changed"; prompt: string }
	| { type: "timeline.selected"; itemId?: string }
	| { type: "workspace.cleared" };

export interface TimelineEventItem {
	kind: "event";
	id: string;
	eventType: string;
	envelopes: AgentEventEnvelope[];
}

export interface TimelineAssistantStreamItem {
	kind: "assistant-stream";
	id: string;
	count: number;
	envelopes: AgentEventEnvelope[];
}

export interface TimelineDiagnosticItem {
	kind: "diagnostic";
	id: string;
	code: string;
	message: string;
	envelopes: AgentEventEnvelope[];
}

export type TimelineLeafItem =
	| TimelineEventItem
	| TimelineAssistantStreamItem
	| TimelineDiagnosticItem;

export interface TimelineTurnItem {
	kind: "turn";
	id: string;
	turnNumber: number;
	start: AgentEventEnvelope;
	end?: AgentEventEnvelope;
	items: TimelineLeafItem[];
}

export type TimelineItem = TimelineLeafItem | TimelineTurnItem;

export interface ChatMessageItem {
	kind: "message";
	id: string;
	status: "streaming" | "complete";
	message: ChatMessage;
}

export interface ToolCardItem {
	kind: "tool";
	id: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "pending" | "running" | "completed" | "error";
	durationMs?: number;
	partialResult?: unknown;
	executionResult?: unknown;
	resultMessage?: ToolResultMessage;
	resultText?: string;
}

export type ChatItem = ChatMessageItem | ToolCardItem;
