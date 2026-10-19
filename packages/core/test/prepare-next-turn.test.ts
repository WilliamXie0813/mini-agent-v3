import { describe, expect, test } from "vitest";
import { Agent } from "../src/agent.ts";
import { createFakeStreamFn } from "@mini-agent/ai";

const readTool = {
	name: "read", description: "read", parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: "file" }] }),
};
const callRead = [{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }];

describe("prepareNextTurnWithContext", () => {
	test("is not called for turn 0 and is called with turn >= 1", async () => {
		const turns: number[] = [];
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: (context) => { turns.push(context.turn); },
		});
		await agent.prompt("go");
		expect(turns).toEqual([1]);
	});

	test("appended sections become part of the transcript and the next request", async () => {
		const seenSystem: string[] = [];
		const base = createFakeStreamFn([callRead, "done"]);
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: (context, signal) => { seenSystem.push(JSON.stringify(context.system)); return base(context, signal); },
			prepareNextTurnWithContext: () => ({
				sections: [{ text: "current time: 12:00" }],
			}),
		});
		await agent.prompt("go");
		expect(seenSystem).toHaveLength(2);
		expect(seenSystem[0]).not.toContain("current time");
		expect(seenSystem[1]).toContain("current time");
		// 真的进 transcript（system 消息可由 replay 重建），不是只改了本次请求
		const systemMessages = agent.state.messages.filter((m) => m.role === "system");
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages.at(-1)?.role === "system" && systemMessages.at(-1)!.sections[0]!.text).toBe("current time: 12:00");
	});

	test("toolsAdded and toolsRemoved are recorded as a SystemMessage too", async () => {
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: () => ({ toolsRemoved: ["read"] }),
		});
		await agent.prompt("go");
		// 末尾是收敛轮的 assistant 消息；hook 追加的 SystemMessage 在 system 序列的尾部。
		const last = agent.state.messages.filter((m) => m.role === "system").at(-1);
		expect(last?.role === "system" && last.toolsRemoved).toEqual(["read"]);
	});

	test("a void result appends nothing", async () => {
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: () => undefined,
		});
		await agent.prompt("go");
		expect(agent.state.messages.filter((m) => m.role === "system")).toHaveLength(1);
	});

	test("adds exactly one system message per turn even with all three fields", async () => {
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: () => ({
				sections: [{ text: "note" }],
				toolsAdded: [{ name: "echo", description: "e", parameters: {} }],
				toolsRemoved: ["read"],
			}),
		});
		await agent.prompt("go");
		const messages = agent.state.messages.filter((m) => m.role === "system");
		expect(messages).toHaveLength(2);
		expect(messages.at(-1)?.role === "system" && messages.at(-1)!.toolsAdded).toHaveLength(1);
	});

	test("a throwing hook bubbles", async () => {
		const agent = new Agent({
			system: "s",
			tools: [readTool],
			streamFn: createFakeStreamFn([callRead, "done"]),
			prepareNextTurnWithContext: () => { throw new Error("clock unavailable"); },
		});
		await expect(agent.prompt("go")).rejects.toThrowError("clock unavailable");
	});
});
