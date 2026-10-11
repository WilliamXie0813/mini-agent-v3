import { describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	Message,
} from "@mini-agent/ai";
import { prepareToolCall } from "../src/tool-call.ts";
import type {
	BeforeToolCall,
	ToolCall,
	ToolDef,
} from "../src/tool.ts";

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [],
	stopReason: "toolUse",
};

const call: ToolCall = {
	type: "toolCall",
	id: "c1",
	name: "write",
	arguments: {
		path: "a.txt",
		options: { mode: "safe" },
	},
};

function makeTool(
	execute = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "done" }],
	})),
): ToolDef<any> {
	return {
		name: "write",
		description: "write a file",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				options: {
					type: "object",
					properties: {
						mode: { enum: ["fast", "safe"] },
					},
					required: ["mode"],
				},
			},
			required: ["path", "options"],
		},
		execute,
	};
}

function textOf(outcome: Awaited<ReturnType<typeof prepareToolCall>>): string {
	if (outcome.kind !== "immediate")
		throw new Error("expected immediate outcome");
	return outcome.result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function prepare(overrides: Partial<Parameters<typeof prepareToolCall>[0]> = {}) {
	return prepareToolCall({
		toolCall: call,
		assistantMessage,
		messages: [],
		tools: [makeTool()],
		startedAt: 12,
		...overrides,
	});
}

describe("prepareToolCall", () => {
	it("returns a prepared call for a known tool with valid arguments", async () => {
		const tool = makeTool();
		const outcome = await prepare({ tools: [tool] });

		expect(outcome).toMatchObject({
			kind: "prepared",
			toolCall: call,
			tool,
			args: call.arguments,
			startedAt: 12,
		});
	});

	it("returns an immediate error for an unknown tool", async () => {
		const outcome = await prepare({ tools: [] });

		expect(outcome).toMatchObject({
			kind: "immediate",
			isError: true,
		});
		expect(textOf(outcome)).toMatch(/write.*not found/i);
	});

	it("rejects nested invalid arguments before hook or execute", async () => {
		const execute = vi.fn(async () => ({ content: [] }));
		const hook = vi.fn<BeforeToolCall>();
		const invalidCall: ToolCall = {
			...call,
			arguments: {
				path: 42,
				options: { mode: "dangerous" },
			},
		};

		const outcome = await prepare({
			toolCall: invalidCall,
			tools: [makeTool(execute)],
			beforeToolCall: hook,
		});

		expect(outcome).toMatchObject({ kind: "immediate", isError: true });
		expect(textOf(outcome)).toContain(
			"arguments.path: expected string, got number",
		);
		expect(textOf(outcome)).toContain(
			'arguments.options.mode: expected one of ["fast","safe"]',
		);
		expect(hook).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("passes validated context and a copied messages array to the hook", async () => {
		const messages: Message[] = [{
			role: "user",
			content: [{ type: "text", text: "write it" }],
		}];
		const seen: Parameters<BeforeToolCall>[0][] = [];
		const hook: BeforeToolCall = (context) => {
			seen.push(context);
		};

		const outcome = await prepare({
			messages,
			beforeToolCall: hook,
		});

		expect(outcome.kind).toBe("prepared");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			assistantMessage,
			toolCall: call,
			args: call.arguments,
			messages,
		});
		expect(seen[0].messages).not.toBe(messages);
	});

	it("turns a blocked call into an immediate error with the hook reason", async () => {
		const outcome = await prepare({
			beforeToolCall: async () => ({
				block: true,
				reason: "Denied by policy",
			}),
		});

		expect(outcome).toMatchObject({
			kind: "immediate",
			isError: true,
		});
		expect(textOf(outcome)).toBe("Denied by policy");
	});

	it("uses a default reason when a blocked call omits one", async () => {
		const outcome = await prepare({
			beforeToolCall: () => ({ block: true }),
		});

		expect(textOf(outcome)).toBe("Tool execution was blocked");
	});

	it("copies terminate only from a blocked result", async () => {
		const blocked = await prepare({
			beforeToolCall: () => ({ block: true, terminate: true }),
		});
		expect(blocked).toMatchObject({
			kind: "immediate",
			result: { terminate: true },
		});

		const allowed = await prepare({
			beforeToolCall: () => ({ block: false, terminate: true }),
		});
		expect(allowed.kind).toBe("prepared");
	});

	it("turns a hook exception into an immediate tool error", async () => {
		const outcome = await prepare({
			beforeToolCall: () => {
				throw new Error("policy unavailable");
			},
		});

		expect(outcome).toMatchObject({ kind: "immediate", isError: true });
		expect(textOf(outcome)).toBe("policy unavailable");
	});

	it("returns Operation aborted when the signal changes during the hook", async () => {
		const controller = new AbortController();
		const outcome = await prepare({
			signal: controller.signal,
			beforeToolCall: () => {
				controller.abort();
			},
		});

		expect(outcome).toMatchObject({ kind: "immediate", isError: true });
		expect(textOf(outcome)).toBe("Operation aborted");
	});
});
