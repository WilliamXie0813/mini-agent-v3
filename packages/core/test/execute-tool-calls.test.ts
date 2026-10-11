import { describe, it, expect } from "vitest";
import { executeToolCalls } from "../src/execute-tool-calls.ts";
import type { AgentEvent } from "../src/agent-event.ts";
import type { ToolDef } from "../src/tool.ts";
import type { ContentBlock } from "@mini-agent/ai";

// 每次调用记录一次，用于断言「按原始顺序执行」与「失败的不执行」。
function makeTools(log: string[]): ToolDef<any>[] {
	return [
		{
			name: "echo",
			description: "echo back",
			parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			execute: async (p: { text: string }) => {
				log.push(`echo:${p.text}`);
				return { content: [{ type: "text", text: p.text }] };
			},
		},
		{
			name: "boom",
			description: "always throws",
			parameters: { type: "object" },
			execute: async () => {
				log.push("boom");
				throw new Error("kaboom");
			},
		},
		{
			name: "fail",
			description: "returns an error result",
			parameters: { type: "object" },
			execute: async () => {
				log.push("fail");
				return { content: [{ type: "text", text: "bad input" }], isError: true };
			},
		},
	];
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): ContentBlock =>
	({ type: "toolCall", id, name, arguments: args });

describe("executeToolCalls (stage 2: serial)", () => {
	it("executes in the model's original call order and returns results in that same order", async () => {
		const log: string[] = [];
		const batch = await executeToolCalls(
			[call("c1", "echo", { text: "first" }), call("c2", "echo", { text: "second" })],
			makeTools(log),
		);
		expect(log).toEqual(["echo:first", "echo:second"]);
		expect(batch.messages.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
	});

	it("pairs each result with its toolCallId and toolName", async () => {
		const batch = await executeToolCalls([call("c1", "echo", { text: "x" })], makeTools([]));
		expect(batch.messages[0]).toMatchObject({
			role: "toolResult", toolCallId: "c1", toolName: "echo", isError: false,
		});
	});

	it("feeds back an error result for an unknown tool name instead of throwing", async () => {
		const log: string[] = [];
		const batch = await executeToolCalls([call("c1", "nonexistent")], makeTools(log));
		expect(log).toEqual([]);
		expect(batch.messages[0].isError).toBe(true);
		expect(toolResultText(batch.messages[0])).toMatch(/nonexistent.*not found|not found.*nonexistent/i);
	});

	it("converts a thrown error into an isError result", async () => {
		const batch = await executeToolCalls([call("c1", "boom")], makeTools([]));
		expect(batch.messages[0].isError).toBe(true);
		expect(toolResultText(batch.messages[0])).toBe("kaboom");
	});

	it("passes through an isError result from the tool itself", async () => {
		const batch = await executeToolCalls([call("c1", "fail")], makeTools([]));
		expect(batch.messages[0].isError).toBe(true);
		expect(toolResultText(batch.messages[0])).toBe("bad input");
	});

	it("reports a missing required parameter as an error result and never calls execute", async () => {
		const log: string[] = [];
		const batch = await executeToolCalls([call("c1", "echo", {})], makeTools(log));
		expect(log).toEqual([]);
		expect(batch.messages[0].isError).toBe(true);
		expect(toolResultText(batch.messages[0])).toContain("text");
	});

	it("produces one result per tool call, including mixed success and failure", async () => {
		const batch = await executeToolCalls(
			[call("c1", "echo", { text: "a" }), call("c2", "boom"), call("c3", "echo", { text: "b" })],
			makeTools([]),
		);
		expect(batch.messages).toHaveLength(3);
		expect(batch.messages.map((m) => m.isError)).toEqual([false, true, false]);
	});

	it("stops before later calls once the signal is aborted, and still pairs every executed call", async () => {
		const log: string[] = [];
		const events: AgentEvent[] = [];
		const controller = new AbortController();
		const tools = makeTools(log);
		// 第一个工具的中途 abort：结果必须成对（有 toolCall 就有 toolResult），不能半途而废。
		const original = tools[0].execute;
		tools[0] = { ...tools[0], execute: async (p, s) => { controller.abort(); return original(p, s); } };
		const batch = await executeToolCalls(
			[call("c1", "echo", { text: "a" }), call("c2", "echo", { text: "b" })],
			tools,
			controller.signal,
			(event) => {
				events.push(event);
			},
		);
		expect(log).toEqual(["echo:a"]);
		expect(batch.messages.map((m) => m.toolCallId)).toEqual(["c1"]);
		expect(
			events
				.filter((event) => "toolCallId" in event)
				.map((event) => event.toolCallId),
		).toEqual(["c1", "c1"]);
	});
});

describe("executeToolCalls (stage 4: lifecycle events)", () => {
	it("emits execution before the tool-result message", async () => {
		const events: AgentEvent[] = [];
		await executeToolCalls(
			[call("c1", "echo", { text: "hello" })],
			makeTools([]),
			undefined,
			(event) => {
				events.push(event);
			},
		);

		expect(events.map((event) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		expect(events[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "echo",
			args: { text: "hello" },
		});
		const end = events[1];
		if (end.type !== "tool_execution_end")
			throw new Error("missing tool_execution_end");
		expect(end.isError).toBe(false);
		expect(end.durationMs).toEqual(expect.any(Number));
		expect(end.durationMs).toBeGreaterThanOrEqual(0);
		expect(events[3]).toMatchObject({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "c1", isError: false },
		});
	});

	it("emits balanced lifecycles for unknown and invalid calls without executing", async () => {
		const log: string[] = [];
		const events: AgentEvent[] = [];
		const batch = await executeToolCalls(
			[
				call("c1", "missing"),
				call("c2", "echo", {}),
			],
			makeTools(log),
			undefined,
			(event) => {
				events.push(event);
			},
		);

		expect(log).toEqual([]);
		expect(batch.messages.map((message) => message.isError)).toEqual([
			true,
			true,
		]);
		expect(events.map((event) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
	});

	it("marks both execution and message events as errors when a tool throws", async () => {
		const events: AgentEvent[] = [];
		await executeToolCalls(
			[call("c1", "boom")],
			makeTools([]),
			undefined,
			(event) => {
				events.push(event);
			},
		);

		expect(events[1]).toMatchObject({
			type: "tool_execution_end",
			isError: true,
		});
		expect(events[3]).toMatchObject({
			type: "message_end",
			message: { role: "toolResult", isError: true },
		});
	});
});

function toolResultText(message: { content: ContentBlock[] }): string {
	return message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}
