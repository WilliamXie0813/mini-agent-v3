import { describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	Message,
} from "@mini-agent/ai";
import {
	executePreparedToolCall,
	finalizeToolCall,
	prepareToolCall,
} from "../src/tool-call.ts";
import type { PreparedToolCall } from "../src/tool-call.ts";
import type {
	BeforeToolCall,
	ToolCall,
	ToolDef,
	ToolUpdateHandler,
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
	execute: ToolDef<any>["execute"] = vi.fn(async () => ({
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

async function preparedWith(execute: ToolDef<any>["execute"]): Promise<PreparedToolCall> {
	const outcome = await prepare({ tools: [makeTool(execute)] });
	if (outcome.kind !== "prepared")
		throw new Error("expected prepared outcome");
	return outcome;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
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

	describe("finalizeToolCall", () => {
		it("creates a protocol message while keeping terminate in the result", () => {
			const finalized = finalizeToolCall({
				toolCall: call,
				result: {
					content: [{ type: "text", text: "done" }],
					isError: false,
					terminate: true,
				},
				isError: false,
				startedAt: performance.now() - 5,
			});

			expect(finalized.result).toMatchObject({
				isError: false,
				terminate: true,
			});
			expect(finalized.message).toEqual({
				role: "toolResult",
				toolCallId: "c1",
				toolName: "write",
				content: [{ type: "text", text: "done" }],
				isError: false,
			});
			expect("terminate" in finalized.message).toBe(false);
			expect(finalized.durationMs).toEqual(expect.any(Number));
			expect(finalized.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("finalizes immediate blocked outcomes through the same path", async () => {
			const blocked = await prepare({
				beforeToolCall: () => ({ block: true, terminate: true }),
			});
			if (blocked.kind !== "immediate")
				throw new Error("expected immediate outcome");

			const finalized = finalizeToolCall(blocked);

			expect(finalized).toMatchObject({
				toolCall: call,
				isError: true,
				result: { isError: true, terminate: true },
				message: { role: "toolResult", isError: true },
			});
		});
	});

	describe("executePreparedToolCall", () => {
		it("normalizes a successful tool result", async () => {
			const prepared = await preparedWith(async () => ({
				content: [{ type: "text", text: "done" }],
			}));

			const outcome = await executePreparedToolCall(
				prepared,
				undefined,
				() => {},
			);

			expect(outcome).toMatchObject({
				toolCall: call,
				isError: false,
				startedAt: 12,
				result: {
					content: [{ type: "text", text: "done" }],
					isError: false,
				},
			});
		});

		it("turns a thrown tool error into an error result", async () => {
			const prepared = await preparedWith(async () => {
				throw new Error("disk unavailable");
			});

			const outcome = await executePreparedToolCall(
				prepared,
				undefined,
				() => {},
			);

			expect(outcome.isError).toBe(true);
			expect(resultText(outcome.result)).toBe("disk unavailable");
		});

		it("delivers partial updates to the sink in source order", async () => {
			const prepared = await preparedWith(async (_params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "one" }] });
				onUpdate?.({ content: [{ type: "text", text: "two" }] });
				return { content: [{ type: "text", text: "done" }] };
			});
			const updates: string[] = [];

			await executePreparedToolCall(prepared, undefined, (partial) => {
				updates.push(resultText(partial));
			});

			expect(updates).toEqual(["one", "two"]);
		});

		it("waits for accepted update promises before resolving", async () => {
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let updateReached = () => {};
			const reached = new Promise<void>((resolve) => {
				updateReached = resolve;
			});
			const prepared = await preparedWith(async (_params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "partial" }] });
				return { content: [{ type: "text", text: "done" }] };
			});
			let settled = false;

			const executing = executePreparedToolCall(
				prepared,
				undefined,
				async () => {
					updateReached();
					await gate;
				},
			).then((outcome) => {
				settled = true;
				return outcome;
			});

			await reached;
			await Promise.resolve();
			expect(settled).toBe(false);
			release();
			await executing;
			expect(settled).toBe(true);
		});

		it("serializes update delivery when an earlier sink is asynchronous", async () => {
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let firstReached = () => {};
			const reached = new Promise<void>((resolve) => {
				firstReached = resolve;
			});
			const prepared = await preparedWith(async (_params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "one" }] });
				onUpdate?.({ content: [{ type: "text", text: "two" }] });
				return { content: [{ type: "text", text: "done" }] };
			});
			const observed: string[] = [];

			const executing = executePreparedToolCall(
				prepared,
				undefined,
				async (partial) => {
					const text = resultText(partial);
					if (text === "one") {
						firstReached();
						await gate;
					}
					observed.push(text);
				},
			);

			await reached;
			await Promise.resolve();
			await Promise.resolve();
			expect(observed).toEqual([]);
			release();
			await executing;
			expect(observed).toEqual(["one", "two"]);
		});

		it("does not call execute when the signal is already aborted", async () => {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "unexpected" }],
			}));
			const prepared = await preparedWith(execute);
			const controller = new AbortController();
			controller.abort();

			const outcome = await executePreparedToolCall(
				prepared,
				controller.signal,
				() => {},
			);

			expect(execute).not.toHaveBeenCalled();
			expect(outcome.isError).toBe(true);
			expect(resultText(outcome.result)).toBe("Operation aborted");
		});

		it("ignores updates fired after the tool promise settles", async () => {
			let lateUpdate: ToolUpdateHandler = () => {};
			const prepared = await preparedWith(async (_params, _signal, onUpdate) => {
				lateUpdate = onUpdate ?? (() => {});
				return { content: [{ type: "text", text: "done" }] };
			});
			const updates: string[] = [];

			await executePreparedToolCall(prepared, undefined, (partial) => {
				updates.push(resultText(partial));
			});
			lateUpdate({ content: [{ type: "text", text: "late" }] });

			expect(updates).toEqual([]);
		});

		it("keeps accepted updates when an aborted tool throws", async () => {
			const controller = new AbortController();
			const prepared = await preparedWith(async (_params, signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "before abort" }] });
				controller.abort();
				if (signal?.aborted)
					throw new DOMException("Operation aborted", "AbortError");
				return { content: [] };
			});
			const updates: string[] = [];

			const outcome = await executePreparedToolCall(
				prepared,
				controller.signal,
				(partial) => {
					updates.push(resultText(partial));
				},
			);

			expect(updates).toEqual(["before abort"]);
			expect(outcome.isError).toBe(true);
			expect(resultText(outcome.result)).toBe("Operation aborted");
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
