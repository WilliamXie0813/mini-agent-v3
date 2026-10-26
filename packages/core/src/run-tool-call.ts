import type { AssistantMessage, Message } from "@mini-agent/ai";
import type { AfterToolCall } from "./agent-options.ts";
import { applyAfterToolCall } from "./after-tool-call.ts";
import {
	executePreparedToolCall,
	prepareToolCall,
} from "./tool-call.ts";
import type {
	ExecutedToolCallOutcome,
	ImmediateToolCallOutcome,
} from "./tool-call.ts";
import type { FinalizedToolCallOutcome } from "./finalize-tool-call.ts";
import { finalizeToolCall } from "./finalize-tool-call.ts";
import { toolCallContext } from "./execute-tool-calls.ts";
import type { BeforeToolCall, ToolCall, ToolDef } from "./tool.ts";

export interface RunToolCallOptions {
	assistantMessage: AssistantMessage;
	messages: readonly Message[];
	tools: readonly ToolDef<any>[];
	signal?: AbortSignal;
	beforeToolCall?: BeforeToolCall;
	afterToolCall?: AfterToolCall;
}

// 独立入口：单个工具调用脱离循环执行。与 executeToolCalls 走完全相同的
// prepare / execute / finalize / afterToolCall 管道，但不发事件、不写消息
// 或 journal，partial update 直接被空 sink 吞掉。不接受 emit / toolExecution /
// commitToolIntent：需要 durable recovery 的调用必须走 AgentSession。
export async function runToolCall(
	toolCall: ToolCall,
	options: RunToolCallOptions,
): Promise<FinalizedToolCallOutcome> {
	const startedAt = performance.now();
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
		outcome = await executePreparedToolCall(
			preparation,
			options.signal,
			() => {},
		);
	}
	const base = finalizeToolCall(outcome);
	return applyAfterToolCall(
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
}
