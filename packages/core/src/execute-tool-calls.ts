import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mini-agent/ai";
import type { AgentEventSink } from "./agent-event.ts";
import { executeToolCallsParallel } from "./execute-tool-calls-parallel.ts";
import {
	executePreparedToolCall,
	prepareToolCall,
} from "./tool-call.ts";
import {
	emitToolEnd,
	emitToolResultMessage,
	emitToolStart,
} from "./tool-call-events.ts";
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
	const mode = options.toolExecution ?? "parallel";
	if (shouldExecuteSequential(toolCalls, options.tools, mode))
		return executeToolCallsSequential(toolCalls, options);
	return executeToolCallsParallel(toolCalls, options);
}

async function executeToolCallsSequential(
	toolCalls: ToolCall[],
	options: ExecuteToolCallsOptions,
): Promise<ExecutedToolBatch> {
	const finalized: FinalizedToolCallOutcome[] = [];
	const emit = options.emit ?? (() => {});
	for (const toolCall of toolCalls) {
		if (options.signal?.aborted) break;
		const startedAt = performance.now();
		await emitToolStart(toolCall, emit);
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
		await emitToolEnd(result, emit);
		await emitToolResultMessage(result.message, emit);
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
		await emitToolStart(toolCall, emitEvent);
		const outcome = finalizeToolCall({
			kind: "immediate",
			toolCall,
			result: errorResult(
				`Tool "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
			startedAt,
		});
		await emitToolEnd(outcome, emitEvent);
		await emitToolResultMessage(outcome.message, emitEvent);
		finalized.push(outcome);
	}
	return {
		messages: finalized.map((outcome) => outcome.message),
		terminate: false,
	};
}

function errorResult(text: string): ToolResult {
	return {
		content: [{ type: "text", text }],
		isError: true,
	};
}
