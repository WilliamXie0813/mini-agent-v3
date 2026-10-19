import { describe, expect, test, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { createFakeStreamFn } from "@mini-agent/ai";
import type { Message } from "@mini-agent/ai";

const seen: Message[][] = [];

describe("transformContext", () => {
	test("runs after prepareRequest: prepareRequest output is what transformContext sees", async () => {
		const sentinel: Message = { role: "user", content: [{ type: "text", text: "injected-by-prepareRequest" }] };
		const hook = vi.fn((messages: readonly Message[]) => [...messages, sentinel]);
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["done"]),
			prepareRequest: (input) => ({ ...input.context, messages: [...input.context.messages, sentinel] }),
			transformContext: hook,
		});
		await agent.prompt("go");
		expect(hook).toHaveBeenCalledTimes(1);
		const received = hook.mock.calls[0]![0] as Message[];
		expect(received.at(-1)).toBe(sentinel);
	});

	test("the transformed context is what the provider receives; transcript is untouched", async () => {
		const captured: Message[][] = [];
		const streamFn = createFakeStreamFn(["done"]);
		const agent = new Agent({
			system: "s",
			streamFn: (context, signal) => { captured.push([...context.messages]); return streamFn(context, signal); },
			transformContext: (messages) => messages.filter((m) => m.role !== "user"),
		});
		await agent.prompt("go");
		expect(captured[0]!.some((m) => m.role === "user")).toBe(false);
		expect(agent.state.messages.some((m) => m.role === "user")).toBe(true);
	});

	test("rejects a fabricated message object with a TypeError", async () => {
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["done"]),
			transformContext: () => [{ role: "user", content: [{ type: "text", text: "ghost" }] }],
		});
		await expect(agent.prompt("go")).rejects.toThrowError(TypeError);
		await expect(agent.prompt("go")).rejects.toThrowError(
			"transformContext must only filter or reorder the messages it received",
		);
	});

	test("rejects an empty result array", async () => {
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["done"]),
			transformContext: () => [],
		});
		await expect(agent.prompt("go")).rejects.toThrowError(
			"transformContext must return a non-empty message array",
		);
	});

	test("allows reordering existing messages", async () => {
		const first: Message = { role: "user", content: [{ type: "text", text: "1" }] };
		const second: Message = { role: "assistant", content: [{ type: "text", text: "2" }], stopReason: "stop" };
		const agent = new Agent({
			system: "",
			messages: [first, second],
			streamFn: createFakeStreamFn(["done"]),
			transformContext: (messages) => [...messages].reverse(),
		});
		await agent.prompt("go");
		expect(agent.state.messages.slice(0, 2).map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	test("runs on every turn, not just the first", async () => {
		const calls: number[] = [];
		let turn = 0;
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			transformContext: (messages) => { calls.push(messages.length); return [...messages]; },
		});
		await agent.prompt("go");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toBeLessThan(calls[1]!);
	});

	test("absent hook leaves the context object identical", async () => {
		const received: unknown[] = [];
		const streamFn = createFakeStreamFn(["done"]);
		const agent = new Agent({
			system: "s",
			streamFn: (context, signal) => { received.push(context); return streamFn(context, signal); },
		});
		await agent.prompt("go");
		expect(received).toHaveLength(1);
	});
});
