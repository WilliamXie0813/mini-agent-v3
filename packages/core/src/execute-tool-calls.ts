import type { ContentBlock, ToolResultMessage } from "@mini-agent/ai";
import type { ToolDef, ToolResult } from "./tool.ts";

export interface ExecutedToolBatch { messages: ToolResultMessage[] }

export async function executeToolCalls(
	toolCalls: ContentBlock[],
	tools: ToolDef<any>[],
	signal?: AbortSignal,
): Promise<ExecutedToolBatch> {
	const messages: ToolResultMessage[] = [];
	for (const block of toolCalls) {
		if (signal?.aborted) break; // 已执行的调用都已配对；未启动的不合成结果（见测试最后一条）
		if (block.type !== "toolCall") continue;
		messages.push(await executeOne(block, tools, signal));
	}
	return { messages };
}

// 不导出：阶段 5 拆三段式时如果这里有第二个入口，会让人以为分离是为并行服务的。
async function executeOne(
	block: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> },
	tools: ToolDef<any>[],
	signal?: AbortSignal,
): Promise<ToolResultMessage> {
	const tool = tools.find((t) => t.name === block.name);
	if (!tool) return errorMessage(block, `Tool "${block.name}" not found`);

	const missing = findMissingRequired(tool, block.arguments);
	if (missing !== undefined) {
		return errorMessage(block, `Tool "${tool.name}" is missing required parameter "${missing}"`);
	}

	let result: ToolResult;
	try {
		result = await tool.execute(block.arguments, signal);
	} catch (e) {
		return errorMessage(block, e instanceof Error ? e.message : String(e));
	}

	return {
		role: "toolResult",
		toolCallId: block.id,
		toolName: tool.name,
		// content 缺省归一为 []：不能让 undefined 进历史，阶段 1 的 createToolResultMessage 在 Pi 里做了同一件事。
		content: result.content ?? [],
		// isError 缺省是 false 而不是 undefined——下游按布尔消费，undefined 会把分支判断搞浑。
		isError: result.isError === true,
	};
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

function errorMessage(
	block: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> },
	text: string,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: block.id,
		toolName: block.name,
		content: [{ type: "text", text }],
		isError: true,
	};
}
