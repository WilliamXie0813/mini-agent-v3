import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mini-agent/ai";
import type { AgentEventSink } from "./agent-event.ts";
import {
	executePreparedToolCall,
	prepareToolCall,
} from "./tool-call.ts";
import { finalizeToolCall } from "./finalize-tool-call.ts";
import type { FinalizedToolCallOutcome } from "./finalize-tool-call.ts";
import type {
	BeforeToolCall,
	ToolCall,
	ToolDef,
	ToolExecutionMode,
	ToolResult,
} from "./tool.ts";

export interface ExecuteToolCallsOptions {
	assistantMessage: AssistantMessage;
	messages: readonly Message[];
	tools: readonly ToolDef<any>[];
	signal?: AbortSignal;
	emit?: AgentEventSink;
	beforeToolCall?: BeforeToolCall;
	toolExecution?: ToolExecutionMode;
}

export interface ExecutedToolBatch {
	messages: ToolResultMessage[];
	terminate: boolean;
}

export function shouldExecuteSequential(
	toolCalls: ToolCall[],
	tools: readonly ToolDef<any>[],
	mode: ToolExecutionMode,
): boolean {
	if (mode === "sequential") return true;
	return toolCalls.some(
		(toolCall) =>
			tools.find((tool) => tool.name === toolCall.name)?.executionMode ===
			"sequential",
	);
}

export async function executeToolCalls(
	toolCalls: ToolCall[],
	options: ExecuteToolCallsOptions,
): Promise<ExecutedToolBatch> {
	const finalized: FinalizedToolCallOutcome[] = [];
	const emit = options.emit ?? (() => {});
	for (const toolCall of toolCalls) {
		if (options.signal?.aborted) break;
		const startedAt = performance.now();
		await emitStart(toolCall, emit);
		const preparation = await prepareToolCall({
			toolCall,
			assistantMessage: options.assistantMessage,
			messages: options.messages,
			tools: options.tools,
			beforeToolCall: options.beforeToolCall,
			signal: options.signal,
			startedAt,
		});
		const outcome = preparation.kind === "immediate"
			? preparation
			: await executePreparedToolCall(
					preparation,
					options.signal,
					(partialResult) => emit({
						type: "tool_execution_update",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: toolCall.arguments,
						partialResult,
					}),
				);
		const result = finalizeToolCall(outcome);
		await emitFinalized(result, emit);
		finalized.push(result);
	}
	return {
		messages: finalized.map((outcome) => outcome.message),
		terminate:
			finalized.length > 0 &&
			finalized.every((outcome) => outcome.result.terminate === true),
	};
}

export async function failTruncatedToolCalls(
	toolCalls: ToolCall[],
	signal?: AbortSignal,
	emit?: AgentEventSink,
): Promise<ExecutedToolBatch> {
	const emitEvent = emit ?? (() => {});
	const finalized: FinalizedToolCallOutcome[] = [];
	for (const toolCall of toolCalls) {
		if (signal?.aborted) break;
		const startedAt = performance.now();
		await emitStart(toolCall, emitEvent);
		const outcome = finalizeToolCall({
			kind: "immediate",
			toolCall,
			result: errorResult(
				`Tool "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
			startedAt,
		});
		await emitFinalized(outcome, emitEvent);
		finalized.push(outcome);
	}
	return {
		messages: finalized.map((outcome) => outcome.message),
		terminate: false,
	};
}

async function emitStart(
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

async function emitFinalized(
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
	await emit({ type: "message_start", message: outcome.message });
	await emit({ type: "message_end", message: outcome.message });
}

function errorResult(text: string): ToolResult {
	return {
		content: [{ type: "text", text }],
		isError: true,
	};
}
