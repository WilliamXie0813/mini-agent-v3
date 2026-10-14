import { describe, expect, it } from "vitest";
import {
	createInitialSystemMessage,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	toolDeclarationsEqual,
} from "../src/transcript.ts";
import type { Message, Tool } from "../src/types.ts";

const read: Tool = {
	name: "read",
	description: "read a file",
	parameters: { type: "object" },
};
const edit: Tool = {
	name: "edit",
	description: "edit a file",
	parameters: { type: "object" },
};

function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value)) freeze(child);
	}
}

describe("transcript replay", () => {
	it("replays_sections_and_tool_deltas_in_transcript_order", () => {
		const messages: Message[] = [
			{
				role: "system",
				sections: [{ tag: "base", text: "You are a coding agent." }],
				toolsAdded: [read],
			},
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{
				role: "system",
				sections: [{ tag: "workspace", text: "Work only in this repository." }],
				toolsRemoved: ["read"],
				toolsAdded: [edit],
			},
		];

		expect(getCurrentSystemPrompt(messages)).toBe(
			"You are a coding agent.\n\nWork only in this repository.",
		);
		expect(getCurrentTools(messages)).toEqual([edit]);
		expect(getCurrentSystemMessage(messages)).toEqual({
			role: "system",
			sections: [
				{ tag: "base", text: "You are a coding agent." },
				{ tag: "workspace", text: "Work only in this repository." },
			],
			toolsAdded: [edit],
		});
	});

	it("treats an unknown toolsRemoved name as a no-op", () => {
		const messages: Message[] = [
			{ role: "system", sections: [{ text: "base" }], toolsAdded: [read] },
			{ role: "system", sections: [], toolsRemoved: ["never-added"] },
		];
		expect(getCurrentTools(messages)).toEqual([read]);
	});

	it("lets a same-message remove + add replace the tool definition", () => {
		const updated: Tool = {
			name: "read",
			description: "read a file v2",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		};
		const messages: Message[] = [
			{ role: "system", sections: [], toolsAdded: [read] },
			{
				role: "system",
				sections: [],
				toolsRemoved: ["read"],
				toolsAdded: [updated],
			},
		];
		expect(getCurrentTools(messages)).toEqual([updated]);
		expect(getCurrentSystemMessage(messages).toolsAdded).toEqual([updated]);
	});

	it("keeps first-seen order and moves a re-added tool to the end", () => {
		const messages: Message[] = [
			{ role: "system", sections: [], toolsAdded: [read, edit] },
			{ role: "system", sections: [], toolsRemoved: ["read"] },
			{ role: "system", sections: [], toolsAdded: [read] },
		];
		expect(getCurrentTools(messages).map((tool) => tool.name)).toEqual([
			"edit",
			"read",
		]);
	});

	it("ignores non-system messages during replay", () => {
		const messages: Message[] = [
			{ role: "system", sections: [{ text: "base" }], toolsAdded: [read] },
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				stopReason: "stop",
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "data" }],
			},
		];
		expect(getCurrentSystemPrompt(messages)).toBe("base");
		expect(getCurrentTools(messages)).toEqual([read]);
	});
});

describe("getToolStateChanges", () => {
	it("computes_minimal_model_visible_tool_changes", () => {
		// 结构相同但引用不同 → 没有 delta（对象身份不重要，声明内容才算数）
		const same: Tool = { ...read, parameters: { type: "object" } };
		expect(getToolStateChanges([read], [same])).toEqual({
			toolsAdded: [],
			toolsRemoved: [],
		});

		// 新增工具 → 只在 toolsAdded
		expect(getToolStateChanges([read], [read, edit])).toEqual({
			toolsAdded: [edit],
			toolsRemoved: [],
		});

		// 删除工具 → 只在 toolsRemoved
		expect(getToolStateChanges([read, edit], [read])).toEqual({
			toolsAdded: [],
			toolsRemoved: ["edit"],
		});

		// 同名 description/schema 变化 → 同时 remove 旧名字并 add 新定义
		const updated: Tool = { ...edit, description: "edit v2" };
		const changed = getToolStateChanges([read, edit], [read, updated]);
		expect(changed.toolsRemoved).toEqual(["edit"]);
		expect(changed.toolsAdded).toEqual([updated]);
	});

	it("copies added declarations instead of sharing mutable parameters", () => {
		const input: Tool = {
			name: "edit",
			description: "edit a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		};
		const { toolsAdded } = getToolStateChanges([], [input]);
		expect(toolsAdded).toEqual([input]);
		expect(toolsAdded[0]).not.toBe(input);
		expect(toolsAdded[0]!.parameters).not.toBe(input.parameters);
		// 改写输出不得回流到输入
		(toolsAdded[0]!.parameters as Record<string, unknown>).type = "mutated";
		expect(input.parameters.type).toBe("object");
	});
});

describe("toolDeclarationsEqual", () => {
	it("compares only the model-visible declaration fields", () => {
		type RuntimeTool = Tool & {
			execute?: () => Promise<unknown>;
			replay?: "safe" | "unsafe";
			executionMode?: "sequential" | "parallel";
		};
		const left: RuntimeTool = {
			...read,
			execute: async () => ({}),
			replay: "unsafe",
			executionMode: "sequential",
		};
		const right: RuntimeTool = {
			...read,
			parameters: { type: "object" },
			execute: async () => ({ different: true }),
			replay: "safe",
		};
		expect(toolDeclarationsEqual(left, right)).toBe(true);
		expect(toolDeclarationsEqual(read, { ...read, name: "write" })).toBe(false);
		expect(toolDeclarationsEqual(read, { ...read, description: "other" })).toBe(false);
		expect(
			toolDeclarationsEqual(read, { ...read, parameters: { type: "array" } }),
		).toBe(false);
	});
});

describe("createInitialSystemMessage", () => {
	it("returns undefined for an empty prompt without tools", () => {
		expect(createInitialSystemMessage("", [])).toBeUndefined();
		expect(createInitialSystemMessage("")).toBeUndefined();
	});

	it("builds one leading system message from a prompt and tools", () => {
		expect(createInitialSystemMessage("base", [read])).toEqual({
			role: "system",
			sections: [{ text: "base" }],
			toolsAdded: [read],
		});
		// 只有 tools、没有 prompt 时也要记录工具声明
		expect(createInitialSystemMessage("", [read])).toEqual({
			role: "system",
			sections: [],
			toolsAdded: [read],
		});
	});

	it("copies tool declarations so later caller mutation stays out of history", () => {
		const tool: Tool = {
			name: "read",
			description: "read",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		};
		const message = createInitialSystemMessage("base", [tool])!;
		expect(message.toolsAdded).toEqual([tool]);
		expect(message.toolsAdded![0]).not.toBe(tool);
		expect(message.toolsAdded![0]!.parameters).not.toBe(tool.parameters);
		tool.parameters.type = "mutated";
		expect(message.toolsAdded![0]!.parameters.type).toBe("object");
	});
});

describe("trimming and immutability", () => {
	it("preserves_replay_after_conversation_trimming", () => {
		const round = (index: number): Message[] => [
			{ role: "user", content: [{ type: "text", text: `q${index}` }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: `a${index}` },
					{ type: "toolCall", id: `c${index}`, name: "read", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: `c${index}`,
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: `r${index}` }],
			},
		];
		const transcript: Message[] = [
			{ role: "system", sections: [{ text: "base" }], toolsAdded: [read] },
			...round(1),
			...round(2),
			{
				role: "system",
				sections: [{ tag: "extra", text: "more" }],
				toolsAdded: [edit],
			},
			...round(3),
		];
		// 只保留全部 system entries 与最近一轮 conversation——阶段 10 才做真正的
		// compaction entry，这里只验证纯函数性质：裁剪不破坏重放。
		const recentCut = transcript.length - 3;
		const trimmed = transcript.filter(
			(message, index) => message.role === "system" || index >= recentCut,
		);
		expect(getCurrentSystemPrompt(trimmed)).toBe(getCurrentSystemPrompt(transcript));
		expect(getCurrentTools(trimmed)).toEqual(getCurrentTools(transcript));
	});

	it("returns empty snapshots for an empty transcript", () => {
		expect(getCurrentSystemMessage([])).toEqual({
			role: "system",
			sections: [],
		});
		expect(getCurrentSystemPrompt([])).toBe("");
		expect(getCurrentTools([])).toEqual([]);
	});

	it("skips empty section text without trimming the sections themselves", () => {
		const messages: Message[] = [{
			role: "system",
			sections: [{ text: "  padded  " }, { text: "" }, { text: "tail" }],
		}];
		expect(getCurrentSystemPrompt(messages)).toBe("  padded  \n\ntail");
	});

	it("never mutates a frozen transcript and replays deterministically", () => {
		const messages: Message[] = [
			{
				role: "system",
				sections: [{ tag: "base", text: "base" }],
				toolsAdded: [read],
			},
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "system",
				sections: [{ text: "extra" }],
				toolsRemoved: ["read"],
				toolsAdded: [edit],
			},
		];
		const before = structuredClone(messages);
		freeze(messages);

		const snapshotA = getCurrentSystemMessage(messages);
		const promptA = getCurrentSystemPrompt(messages);
		const toolsA = getCurrentTools(messages);
		const snapshotB = getCurrentSystemMessage(messages);
		const promptB = getCurrentSystemPrompt(messages);
		const toolsB = getCurrentTools(messages);

		expect(messages).toEqual(before);
		expect(snapshotA).toEqual(snapshotB);
		expect(promptA).toBe(promptB);
		expect(toolsA).toEqual(toolsB);
	});
});
