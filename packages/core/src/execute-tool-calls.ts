import type { ContentBlock, ToolResultMessage } from "@mini-agent/ai";
import type { AgentEventSink } from "./agent-event.ts";
import type { ToolDef, ToolResult } from "./tool.ts";

export interface ExecutedToolBatch { messages: ToolResultMessage[] }

export async function executeToolCalls(
	toolCalls: ContentBlock[],
	tools: ToolDef<any>[],
	signal?: AbortSignal,
	emit?: AgentEventSink,
): Promise<ExecutedToolBatch> {
	const messages: ToolResultMessage[] = [];
	const emitEvent = emit ?? (() => {});
	for (const block of toolCalls) {
		if (signal?.aborted) break; // 已执行的调用都已配对；未启动的不合成结果（见测试最后一条）
		if (block.type !== "toolCall") continue;
		const startedAt = performance.now();
		await emitEvent({
			type: "tool_execution_start",
			toolCallId: block.id,
			toolName: block.name,
			args: block.arguments,
		});
		const result = await executeOne(block, tools, signal);
		messages.push(await emitResult(block, result, startedAt, emitEvent));
	}
	return { messages };
}

export async function failTruncatedToolCalls(
	toolCalls: ContentBlock[],
	emit?: AgentEventSink,
): Promise<ExecutedToolBatch> {
	const messages: ToolResultMessage[] = [];
	const emitEvent = emit ?? (() => {});
	for (const block of toolCalls) {
		if (block.type !== "toolCall") continue;
		const startedAt = performance.now();
		await emitEvent({
			type: "tool_execution_start",
			toolCallId: block.id,
			toolName: block.name,
			args: block.arguments,
		});
		const result = errorResult(
			`Tool "${block.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
		);
		messages.push(await emitResult(block, result, startedAt, emitEvent));
	}
	return { messages };
}

// 不导出：阶段 5 拆三段式时如果这里有第二个入口，会让人以为分离是为并行服务的。
async function executeOne(
	block: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> },
	tools: ToolDef<any>[],
	signal?: AbortSignal,
): Promise<ToolResult> {
	const tool = tools.find((t) => t.name === block.name);
	if (!tool) return errorResult(`Tool "${block.name}" not found`);

	const missing = findMissingRequired(tool, block.arguments);
	if (missing !== undefined) {
		return errorResult(
			`Tool "${tool.name}" is missing required parameter "${missing}"`,
		);
	}

	try {
		const result = await tool.execute(block.arguments, signal);
		return {
			content: result.content ?? [],
			isError: result.isError === true,
		};
	} catch (e) {
		return errorResult(e instanceof Error ? e.message : String(e));
	}
}

// 只查必填字段的存在性与顶层 typeof。完整 JSON Schema 校验是阶段 5 的事。
function findMissingRequired(tool: ToolDef<any>, args: Record<string, unknown>): string | undefined {
	const required = (tool.parameters["required"] ?? []) as string[];
	const properties = (tool.parameters["properties"] ?? {}) as Record<string, { type?: string }>;
	for (const name of required) {
		if (!(name in args)) return name;
		const declared = properties[name]?.type;
		if (declared !== undefined && !matchesDeclaredType(args[name], declared)) return name;
	}
	return undefined;
}

// typeof 映射用对象字面量而不是 enum（erasableSyntaxOnly 禁 enum）。
// array 需要 Array.isArray：typeof [] === "object"，不特判的话声明 "object" 的字段会收下数组。
const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
	string: (v) => typeof v === "string",
	number: (v) => typeof v === "number",
	boolean: (v) => typeof v === "boolean",
	object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
	array: (v) => Array.isArray(v),
};

function matchesDeclaredType(value: unknown, declared: string): boolean {
	return TYPE_CHECKS[declared]?.(value) ?? true;
}

async function emitResult(
	block: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> },
	result: ToolResult,
	startedAt: number,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: block.id,
		toolName: block.name,
		content: result.content ?? [],
		isError: result.isError === true,
	};
	await emit({
		type: "tool_execution_end",
		toolCallId: block.id,
		toolName: block.name,
		result,
		isError: message.isError,
		durationMs: performance.now() - startedAt,
	});
	await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	return message;
}

function errorResult(text: string): ToolResult {
	return {
		content: [{ type: "text", text }],
		isError: true,
	};
}
