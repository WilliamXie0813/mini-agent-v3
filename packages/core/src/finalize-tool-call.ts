import type { ToolResultMessage } from "@mini-agent/ai";
import type { ExecutedToolCallOutcome, ImmediateToolCallOutcome } from "./tool-call.ts";
import type { ToolCall, ToolResult } from "./tool.ts";

export interface FinalizedToolCallOutcome {
	toolCall: ToolCall; result: ToolResult; message: ToolResultMessage;
	isError: boolean; durationMs: number;
}

export function finalizeToolCall(outcome: ExecutedToolCallOutcome | ImmediateToolCallOutcome): FinalizedToolCallOutcome {
	const result: ToolResult = {
		content: outcome.result.content ?? [],
		isError: outcome.isError,
		terminate: outcome.result.terminate,
	};
	return {
		toolCall: outcome.toolCall,
		result,
		isError: outcome.isError,
		durationMs: Math.max(0, performance.now() - outcome.startedAt),
		message: {
			role: "toolResult",
			toolCallId: outcome.toolCall.id,
			toolName: outcome.toolCall.name,
			content: result.content,
			isError: outcome.isError,
		},
	};
}
