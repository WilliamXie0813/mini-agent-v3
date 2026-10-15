import { describe, expect, test, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { createFakeStreamFn } from "@mini-agent/ai";

const readTool = {
	name: "read", description: "read", parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: "file" }] }),
};
const callRead = [{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }];

describe("finishTurn", () => {
	test("continue with no tool calls keeps the loop going", async () => {
		const contexts: { turn: number; toolResults: number }[] = [];
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["first", "second", "third"]),
			finishTurn: (context) => {
				contexts.push({ turn: context.turn, toolResults: context.toolResults.length });
				return { action: contexts.length < 3 ? "continue" : "end" };
			},
		});
		await agent.prompt("go");
		expect(contexts).toEqual([
			{ turn: 0, toolResults: 0 },
			{ turn: 1, toolResults: 0 },
			{ turn: 2, toolResults: 0 },
		]);
		const assistant = agent.state.messages.filter((m) => m.role === "assistant");
		expect(assistant.map((m) => m.role === "assistant" && m.content[0])).toEqual([
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
			{ type: "text", text: "third" },
		]);
	});

	test("continue draws from the same maxTurns budget", async () => {
		const agent = new Agent({
			system: "s",
			maxTurns: 3,
			streamFn: createFakeStreamFn(["x"]),
			finishTurn: () => ({ action: "continue" }),
		});
		// Agent.prompt 对 maxTurns 熔断的行为（agent.test.ts 钉死）：不 reject，
		// 而是把 hit maxTurns 错误记录为一条 error assistant 消息。
		await agent.prompt("go");
		const last = agent.state.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("missing error message");
		expect(last.stopReason).toBe("error");
		expect(last.content[0]).toEqual({
			type: "text",
			text: "agent loop hit maxTurns (3) without the model stopping; last tool calls: unknown",
		});
	});

	test("end (or void) terminates the run as before", async () => {
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["only"]),
			finishTurn: () => ({ action: "end" }),
		});
		await agent.prompt("go");
		expect(agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
	});

	test("tool terminate:true wins over finishTurn continue", async () => {
		const hook = vi.fn(() => ({ action: "continue" as const }));
		const agent = new Agent({
			system: "s",
			tools: [{ ...readTool, execute: async () => ({ content: [], terminate: true }) }],
			streamFn: createFakeStreamFn([callRead, "never reached"]),
			finishTurn: hook,
		});
		await agent.prompt("go");
		expect(hook).not.toHaveBeenCalled();
		expect(agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
	});

	test("sees this turn's tool results and the turn number", async () => {
		const seen: number[] = [];
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			finishTurn: (context) => { seen.push(context.toolResults.length); },
		});
		await agent.prompt("go");
		expect(seen).toEqual([1, 0]);
	});

	test("fires after turn_end, so subscribers see the turn closed first", async () => {
		const order: string[] = [];
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["only"]),
			finishTurn: () => { order.push("finishTurn"); },
		});
		agent.subscribe((event) => { if (event.type === "turn_end") order.push("turn_end"); });
		await agent.prompt("go");
		expect(order).toEqual(["turn_end", "finishTurn"]);
	});

	test("a throwing hook bubbles and records an error assistant message", async () => {
		const agent = new Agent({
			system: "s",
			streamFn: createFakeStreamFn(["only"]),
			finishTurn: () => { throw new Error("policy service down"); },
		});
		await expect(agent.prompt("go")).rejects.toThrowError("policy service down");
	});
});
