import type { ContentBlock, StreamContext } from "./types.ts";

type Text = { type: "text"; text: string };
type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResult = { type: "tool_result"; tool_use_id: string; is_error: boolean; content: Text[] };
type WireBlock = Text | ToolUse | ToolResult;
export interface AnthropicRequest {
	model: string; max_tokens: number; stream: true; system: string;
	messages: { role: "user" | "assistant"; content: WireBlock[] }[];
	tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
}

function block(value: ContentBlock): Text | ToolUse {
	return value.type === "text" ? { ...value } : {
		type: "tool_use", id: value.id, name: value.name, input: structuredClone(value.arguments),
	};
}

export function toAnthropicRequest(
	context: StreamContext,
	options: { model: string; maxTokens: number },
): AnthropicRequest {
	const messages: AnthropicRequest["messages"] = [];
	for (const message of context.messages) {
		if (message.role === "system") continue;
		if (message.role === "assistant" &&
			(message.stopReason === "error" || message.stopReason === "aborted")) continue;
		const role = message.role === "assistant" ? "assistant" : "user";
		const content: WireBlock[] = message.role === "toolResult" ? [{
			type: "tool_result", tool_use_id: message.toolCallId, is_error: message.isError,
			content: message.content.map((value) => {
				if (value.type !== "text") throw new Error("Tool result supports only text blocks");
				return { ...value };
			}),
		}] : message.content.map(block);
		const last = messages.at(-1);
		if (last?.role === role) last.content.push(...content);
		else messages.push({ role, content });
	}
	return {
		model: options.model, max_tokens: options.maxTokens, stream: true,
		system: context.system.content, messages,
		tools: context.tools.map((tool) => ({
			name: tool.name, description: tool.description,
			input_schema: structuredClone(tool.parameters),
		})),
	};
}
