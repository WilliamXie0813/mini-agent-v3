import type { AgentEventSink } from "./agent-event.ts";
import type {
	ExecutedToolBatch,
	ExecuteToolCallsOptions,
} from "./execute-tool-calls.ts";
import { finalizeToolCall } from "./finalize-tool-call.ts";
import type { FinalizedToolCallOutcome } from "./finalize-tool-call.ts";
import {
	executePreparedToolCall,
	prepareToolCall,
} from "./tool-call.ts";
import type { ImmediateToolCallOutcome } from "./tool-call.ts";
import {
	emitToolEnd,
	emitToolResultMessage,
	emitToolStart,
} from "./tool-call-events.ts";
import type {
	ToolCall,
	ToolResult,
} from "./tool.ts";

type Entry =
	| FinalizedToolCallOutcome
	| (() => Promise<FinalizedToolCallOutcome>);

export async function executeToolCallsParallel(
	toolCalls: ToolCall[],
	options: ExecuteToolCallsOptions,
): Promise<ExecutedToolBatch> {
	const emit = options.emit ?? (() => {});
	const entries: Entry[] = [];

	for (const toolCall of toolCalls) {
		const startedAt = performance.now();
		await emitToolStart(toolCall, emit);
		if (options.signal?.aborted) {
			entries.push(await finishImmediate(
				aborted(toolCall, startedAt),
				emit,
			));
			continue;
		}
		const preparation = await prepareToolCall({
			toolCall,
			assistantMessage: options.assistantMessage,
			messages: options.messages,
			tools: options.tools,
			beforeToolCall: options.beforeToolCall,
			signal: options.signal,
			startedAt,
		});
		if (preparation.kind === "immediate") {
			entries.push(await finishImmediate(preparation, emit));
			continue;
		}
		entries.push(async () => {
			const outcome = options.signal?.aborted
				? aborted(toolCall, startedAt)
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
			const finalized = finalizeToolCall(outcome);
			await emitToolEnd(finalized, emit);
			return finalized;
		});
	}

	const ordered = await Promise.all(
		entries.map((entry) =>
			typeof entry === "function" ? entry() : Promise.resolve(entry),
		),
	);
	for (const outcome of ordered)
		await emitToolResultMessage(outcome.message, emit);
	return {
		messages: ordered.map((outcome) => outcome.message),
		terminate:
			ordered.length > 0 &&
			ordered.every((outcome) => outcome.result.terminate === true),
	};
}

async function finishImmediate(
	outcome: ImmediateToolCallOutcome,
	emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
	const finalized = finalizeToolCall(outcome);
	await emitToolEnd(finalized, emit);
	return finalized;
}

function aborted(
	toolCall: ToolCall,
	startedAt: number,
): ImmediateToolCallOutcome {
	const result: ToolResult = {
		content: [{ type: "text", text: "Operation aborted" }],
		isError: true,
	};
	return { kind: "immediate", toolCall, result, isError: true, startedAt };
}
