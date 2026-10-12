import type { ToolResultMessage } from "@mini-agent/ai";
import type { AgentEventSink } from "./agent-event.ts";
import type { FinalizedToolCallOutcome } from "./finalize-tool-call.ts";
import type { ToolCall } from "./tool.ts";

export async function emitToolStart(
	toolCall: ToolCall,
	emit: AgentEventSink,
): Promise<void> {
	await emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
}

export async function emitToolEnd(
	outcome: FinalizedToolCallOutcome,
	emit: AgentEventSink,
): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: outcome.toolCall.id,
		toolName: outcome.toolCall.name,
		result: outcome.result,
		isError: outcome.isError,
		durationMs: outcome.durationMs,
	});
}

export async function emitToolResultMessage(
	message: ToolResultMessage,
	emit: AgentEventSink,
): Promise<void> {
	await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
}
