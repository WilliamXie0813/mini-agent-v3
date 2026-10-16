import type { ToolDef } from "@mini-agent/core";
import type { Extension } from "./types.ts";

// demo 扩展：阶段 11 四个能力各给一个最小样例——自定义工具、权限规则、
// context 剪枝、CLI 命令。它不是产品功能，是每个能力的「活文档」。

const wordCountTool: ToolDef<{ text: string }> = {
	name: "word_count",
	description: "Count the words in a text",
	parameters: {
		type: "object",
		properties: { text: { type: "string", description: "text to count" } },
		required: ["text"],
	},
	// 纯函数：进程崩溃后重放安全，让阶段 9 的 replay 字段有第二个使用者。
	replay: "safe",
	execute: async ({ text }) => ({
		content: [{
			type: "text",
			text: String(text.trim().split(/\s+/).filter(Boolean).length),
		}],
	}),
};

export function createDemoExtension(): Extension {
	return {
		name: "demo",
		factory(api) {
			api.registerTool(wordCountTool);
			// 权限规则：bash 永远 block（fail-closed，reason 进 tool_outcome 的 error 文本）。
			api.on("tool_call", ({ toolCall }) => {
				if (toolCall.name === "bash") {
					return { block: true, reason: "demo extension: bash is disabled" };
				}
				return undefined;
			});
			// 剪枝：丢掉被截断的工具结果，减轻 context 负担；journal 里的事实源不动。
			api.on("context", (messages) =>
				messages.filter((message) =>
					!(message.role === "toolResult" &&
						message.content[0]?.type === "text" &&
						message.content[0].text.startsWith("[truncated"))
				),
			);
			// 命令：打印自身已注册的工具名与规则。
			api.registerCommand({
				name: "demo",
				description: "List the tools and rules registered by the demo extension",
				run: ({ context }) => {
					context.log("demo extension tools: word_count");
					context.log("demo extension rules: bash is disabled");
				},
			});
		},
	};
}
