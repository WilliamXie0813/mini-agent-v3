import type { Message } from "@mini-agent/ai";
import type { AgentEvent } from "./agent-event.ts";
import type { ToolDef } from "./tool.ts";

export interface AgentState {
	messages: Message[];
	tools: ToolDef<any>[];
	isStreaming: boolean;
}

export function createAgentState(
	messages: Message[],
	tools: ToolDef<any>[],
): AgentState {
	return {
		messages: messages.slice(),
		tools: tools.slice(),
		isStreaming: false,
	};
}

export function reduceAgentState(
	state: AgentState,
	event: AgentEvent,
): void {
	if (event.type === "message_end") state.messages.push(event.message);
}
