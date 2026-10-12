import { setTimeout } from "node:timers/promises";
import type {
	ToolDef,
	ToolResult,
} from "@mini-agent/core";

function textResult(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

export function createLookupTool(
	onExecute?: () => void,
): ToolDef<{ topic: string }> {
	return {
		name: "lookup",
		description: "Return a deterministic explanation for a topic.",
		parameters: {
			type: "object",
			properties: {
				topic: { type: "string" },
			},
			required: ["topic"],
			additionalProperties: false,
		},
		execute: async ({ topic }) => {
			onExecute?.();
			return textResult(`Lookup result for ${topic}.`);
		},
	};
}

export function createDelayTool(
	name: string,
	delayMs: number,
	resultText: string,
): ToolDef<Record<string, never>> {
	return {
		name,
		description: `Wait ${delayMs}ms, then return a deterministic result.`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		execute: async (_params, signal) => {
			await setTimeout(delayMs, undefined, { signal });
			return textResult(resultText);
		},
	};
}
