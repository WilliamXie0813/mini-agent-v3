import type { AssistantMessage, StreamFn } from "@mini-agent/ai";
import { Agent } from "./agent.ts";
import type { ToolDef, ToolResult } from "./tool.ts";

export interface SubagentToolOptions {
	system: string;
	streamFn: StreamFn;
	tools?: ToolDef<any>[];
	maxTurns?: number;
	name?: string;
	description?: string;
}

function textResult(text: string, isError?: boolean): ToolResult {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
	};
}

export function createSubagentTool(
	options: SubagentToolOptions,
): ToolDef<{ task: string }> {
	return {
		name: options.name ?? "delegate",
		description: options.description ?? "Delegate a task to an isolated subagent",
		parameters: {
			type: "object",
			properties: { task: { type: "string" } },
			required: ["task"],
		},
		replay: "unsafe",
		execute: async ({ task }, signal) => {
			if (task.trim() === "") return textResult("Task is required", true);

			const child = new Agent({
				system: options.system,
				messages: [],
				streamFn: options.streamFn,
				tools: [...(options.tools ?? [])],
				maxTurns: options.maxTurns,
			});
			const abort = () => child.abort();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				if (signal?.aborted) return textResult("Operation aborted", true);
				await child.prompt(task);

				let last: AssistantMessage | undefined;
				for (const message of child.state.messages) {
					if (message.role === "assistant") last = message;
				}
				if (!last) return textResult("");

				const text = last.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
				const fallback = text || last.errorMessage ||
					(last.stopReason === "aborted" ? "Operation aborted" : "");
				const isError = last.stopReason === "error" ||
					last.stopReason === "aborted" || last.stopReason === "length";
				return textResult(fallback, isError);
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		},
	};
}
