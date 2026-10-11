import type {
	AssistantMessageEvent,
	Message,
	ToolResultMessage,
} from "@mini-agent/ai";

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	| { type: "turn_start" }
	| {
			type: "turn_end";
			message: Message;
			toolResults: ToolResultMessage[];
	  }
	| { type: "message_start"; message: Message }
	| {
			type: "message_update";
			message: Message;
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| { type: "message_end"; message: Message }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
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
			durationMs?: number;
	  };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
export type AgentEventListener = AgentEventSink;
