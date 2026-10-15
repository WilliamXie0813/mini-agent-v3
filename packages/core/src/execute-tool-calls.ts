import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@mini-agent/ai";
import type { AgentEventSink } from "./agent-event.ts";
import type { AfterToolCall, AfterToolCallContext } from "./agent-options.ts";
import { applyAfterToolCall } from "./after-tool-call.ts";
import { executeToolCallsParallel } from "./execute-tool-calls-parallel.ts";
import {
	executePreparedToolCall,
	prepareToolCall,
} from "./tool-call.ts";
import type {
	ExecutedToolCallOutcome,
	ImmediateToolCallOutcome,
	PreparedToolCall,
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
	CommitToolIntent,
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
	afterToolCall?: AfterToolCall;
	toolExecution?: ToolExecutionMode;
	commitToolIntent?: CommitToolIntent;
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
	for (const [sourceIndex, toolCall] of toolCalls.entries()) {
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
		let outcome: ExecutedToolCallOutcome | ImmediateToolCallOutcome;
		if (preparation.kind === "immediate") {
			outcome = preparation;
		} else {
			await options.commitToolIntent?.({
				assistantMessage: options.assistantMessage,
				toolCall,
				tool: preparation.tool,
				args: preparation.args,
				sourceIndex,
			});
			outcome = await executePreparedToolCall(
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
		}
		const base = finalizeToolCall(outcome);
		const result = await applyAfterToolCall(
			base,
			options.afterToolCall,
			toolCallContext(
				outcome,
				preparation.kind === "prepared" ? preparation : undefined,
				base,
				options.messages,
			),
			options.signal,
		);
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

// 顺序与并行两条路径共用，避免两处把 tool / args 的取值规则写岔。
// finalized 必须作为参数传入而不是在里面重算：performance.now() 调两次
// 会得到不同值，hook 看到的 durationMs 必须与 tool_execution_end 报的一致。
// prepared 为 undefined 时（工具未找到 / 校验失败 / 被 block / 已中止）tool 就是 undefined。
export function toolCallContext(
	outcome: ExecutedToolCallOutcome | ImmediateToolCallOutcome,
	prepared: PreparedToolCall | undefined,
	finalized: FinalizedToolCallOutcome,
	messages: readonly Message[],
): AfterToolCallContext {
	return {
		toolCall: outcome.toolCall,
		tool: prepared?.tool,
		args: prepared?.args ?? outcome.toolCall.arguments,
		result: finalized.result,
		isError: finalized.isError,
		durationMs: finalized.durationMs,
		messages,
	};
}
