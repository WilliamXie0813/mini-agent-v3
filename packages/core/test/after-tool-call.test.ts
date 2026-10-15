import { describe, expect, test, vi } from "vitest";
import { applyAfterToolCall } from "../src/after-tool-call.ts";
import type { FinalizedToolCallOutcome } from "../src/finalize-tool-call.ts";
import type { AfterToolCall } from "../src/agent-options.ts";
import { Agent } from "../src/agent.ts";
import { createFakeStreamFn } from "@mini-agent/ai";

const toolCall = { type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "a.txt" } };
const outcome = (): FinalizedToolCallOutcome => ({
	toolCall,
	result: { content: [{ type: "text", text: "raw" }] },
	isError: false,
	durationMs: 42,
	message: {
		role: "toolResult", toolCallId: "c1", toolName: "read",
		content: [{ type: "text", text: "raw" }],
		isError: false,
	},
});
const context = {
	toolCall, args: { path: "a.txt" }, result: outcome().result,
	isError: false, durationMs: 42, messages: [],
};

describe("applyAfterToolCall", () => {
	test("returns the outcome untouched when no hook is installed", async () => {
		const before = outcome();
		expect(await applyAfterToolCall(before, undefined, context)).toBe(before);
	});

	test("returns the outcome untouched when the hook returns void", async () => {
		const before = outcome();
		expect(await applyAfterToolCall(before, () => {}, context)).toBe(before);
	});

	test("rewrites content in both result and message", async () => {
		const next = await applyAfterToolCall(
			outcome(),
			() => ({ content: [{ type: "text", text: "redacted" }] }),
			context,
		);
		expect(next.result.content).toEqual([{ type: "text", text: "redacted" }]);
		expect(next.message.content).toEqual([{ type: "text", text: "redacted" }]);
	});

	test("rewrites isError in both result and message", async () => {
		const next = await applyAfterToolCall(outcome(), () => ({ isError: true }), context);
		expect(next.isError).toBe(true);
		expect(next.result.isError).toBe(true);
		expect(next.message.isError).toBe(true);
	});

	test("ignores attempts to change durationMs or terminate", async () => {
		const rogue = (() => ({ content: [], durationMs: 9999, terminate: true })) as unknown as AfterToolCall;
		const next = await applyAfterToolCall(outcome(), rogue, context);
		expect(next.durationMs).toBe(42);
		expect(next.result.terminate).toBeUndefined();
	});

	test("does not mutate the input outcome", async () => {
		const before = outcome();
		await applyAfterToolCall(before, () => ({ content: [] }), context);
		expect(before.result.content).toEqual([{ type: "text", text: "raw" }]);
	});

	test("a throwing hook propagates (decision hooks bubble)", async () => {
		await expect(
			applyAfterToolCall(outcome(), () => { throw new Error("formatter down"); }, context),
		).rejects.toThrowError("formatter down");
	});

	test("passes the real durationMs to the hook", async () => {
		const hook = vi.fn(() => {});
		await applyAfterToolCall(outcome(), hook, context);
		expect(hook).toHaveBeenCalledWith(context);
	});
});

function callTwo() {
	return [{
		type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "a.txt" },
	}, {
		type: "toolCall" as const, id: "c2", name: "read", arguments: { path: "b.txt" },
	}];
}

describe("afterToolCall through the agent loop", () => {
	test("sequential path applies the hook to executed results", async () => {
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "secret" }] }) }],
			streamFn: createFakeStreamFn([callTwo(), "done"]),
			toolExecution: "sequential",
			afterToolCall: () => ({ content: [{ type: "text", text: "redacted" }] }),
		});
		await agent.prompt("go");
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.role === "toolResult" && result.content).toEqual([{ type: "text", text: "redacted" }]);
		}
	});

	test("parallel path applies the hook inside the thunk", async () => {
		const seen: string[] = [];
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async (args) => ({ content: [{ type: "text", text: String(args.path) }] }) }],
			streamFn: createFakeStreamFn([callTwo(), "done"]),
			afterToolCall: (ctx) => { seen.push(ctx.toolCall.id); return { isError: true }; },
		});
		await agent.prompt("go");
		expect(seen.sort()).toEqual(["c1", "c2"]);
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results.every((m) => m.role === "toolResult" && m.isError === true)).toBe(true);
	});

	test("parallel path applies the hook to blocked calls too (finishImmediate)", async () => {
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([callTwo(), "done"]),
			beforeToolCall: () => ({ block: true, reason: "nope" }),
			afterToolCall: () => ({ content: [{ type: "text", text: "blocked-and-rewritten" }] }),
		});
		await agent.prompt("go");
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results[0]?.role === "toolResult" && results[0].content[0]).toEqual({ type: "text", text: "blocked-and-rewritten" });
	});

	test("tool_execution_end reports the rewritten content and the original duration", async () => {
		const events: { isError: boolean; durationMs: number | undefined; result: unknown }[] = [];
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "secret" }] }) }],
			streamFn: createFakeStreamFn([callTwo(), "done"]),
			afterToolCall: () => ({ content: [{ type: "text", text: "redacted" }] }),
		});
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end")
				events.push({ isError: event.isError, durationMs: event.durationMs, result: event.result });
		});
		await agent.prompt("go");
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event.result).toEqual({ content: [{ type: "text", text: "redacted" }], isError: false });
			expect(Number.isFinite(event.durationMs)).toBe(true);
		}
	});

	test("truncated calls are NOT passed through afterToolCall", async () => {
		const hook = vi.fn(() => ({}));
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([{ content: callTwo(), stopReason: "length" }, "done"]),
			afterToolCall: hook,
		});
		await agent.prompt("go");
		expect(hook).not.toHaveBeenCalled();
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results.every((m) => m.role === "toolResult" && m.isError === true)).toBe(true);
	});
});
