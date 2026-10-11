import type {
	AssistantMessage,
	Message,
} from "@mini-agent/ai";
import { validateJsonSchema } from "./json-schema.ts";
import type {
	BeforeToolCall,
	ToolCall,
	ToolDef,
	ToolResult,
} from "./tool.ts";

export type PreparedToolCall = {
	kind: "prepared";
	toolCall: ToolCall;
	tool: ToolDef<any>;
	args: Record<string, unknown>;
	startedAt: number;
};

export type ImmediateToolCallOutcome = {
	kind: "immediate";
	toolCall: ToolCall;
	result: ToolResult;
	isError: boolean;
	startedAt: number;
};

export interface PrepareToolCallOptions {
	toolCall: ToolCall;
	assistantMessage: AssistantMessage;
	messages: readonly Message[];
	tools: readonly ToolDef<any>[];
	beforeToolCall?: BeforeToolCall;
	signal?: AbortSignal;
	startedAt: number;
}

export async function prepareToolCall(
	options: PrepareToolCallOptions,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = options.tools.find(
		(candidate) => candidate.name === options.toolCall.name,
	);
	if (!tool) {
		return immediate(
			options,
			errorResult(`Tool "${options.toolCall.name}" not found`),
		);
	}

	const issues = validateJsonSchema(
		options.toolCall.arguments,
		tool.parameters,
	);
	if (issues.length > 0) {
		const details = issues
			.map((issue) => `${issue.path}: ${issue.message}`)
			.join("; ");
		return immediate(
			options,
			errorResult(
				`Tool "${tool.name}" arguments failed validation: ${details}`,
			),
		);
	}

	let beforeResult;
	try {
		beforeResult = await options.beforeToolCall?.(
			{
				assistantMessage: options.assistantMessage,
				toolCall: options.toolCall,
				args: options.toolCall.arguments,
				messages: options.messages.slice(),
			},
			options.signal,
		);
	} catch (error) {
		return immediate(
			options,
			errorResult(error instanceof Error ? error.message : String(error)),
		);
	}

	if (options.signal?.aborted) {
		return immediate(options, errorResult("Operation aborted"));
	}
	if (beforeResult?.block) {
		const result = errorResult(
			beforeResult.reason ?? "Tool execution was blocked",
		);
		if (beforeResult.terminate === true) result.terminate = true;
		return immediate(options, result);
	}
	return {
		kind: "prepared",
		toolCall: options.toolCall,
		tool,
		args: options.toolCall.arguments,
		startedAt: options.startedAt,
	};
}

function immediate(
	options: PrepareToolCallOptions,
	result: ToolResult,
): ImmediateToolCallOutcome {
	return {
		kind: "immediate",
		toolCall: options.toolCall,
		result,
		isError: true,
		startedAt: options.startedAt,
	};
}

function errorResult(text: string): ToolResult {
	return {
		content: [{ type: "text", text }],
		isError: true,
	};
}
