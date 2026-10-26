import { describe, expect, it } from "vitest";
import { createFakeStreamFn } from "@mini-agent/ai";
import type { Message, StreamContext, StreamFn } from "@mini-agent/ai";
import { Agent } from "../src/agent.ts";
import type { AgentEvent } from "../src/agent-event.ts";
import type { ToolDef } from "../src/tool.ts";

const echoTool: ToolDef<{ text: string }> = {
	name: "echo",
	description: "echo back",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	execute: async ({ text }) => ({
		content: [{ type: "text", text }],
	}),
};

function toolCall(id: string) {
	return [{ type: "toolCall" as const, id, name: "echo", arguments: { text: id } }];
}

function captureContexts(
	script: Parameters<typeof createFakeStreamFn>[0],
	options?: Parameters<typeof createFakeStreamFn>[1],
) {
	const contexts: StreamContext[] = [];
	const inner = createFakeStreamFn(script, options);
	const streamFn: StreamFn = (context, signal) => {
		contexts.push(structuredClone(context));
		return inner(context, signal);
	};
	return { contexts, streamFn };
}

function textOf(message: Message): string {
	if (message.role === "system") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function userTexts(messages: readonly Message[]): string[] {
	return messages
		.filter((message) => message.role === "user")
		.map((message) => textOf(message));
}

describe("Agent.followUp", () => {
	it("continues a normal stop in the same run with the queued user message", async () => {
		const { contexts, streamFn } = captureContexts(["first", "second"]);
		const agent = new Agent({ system: "test", streamFn });
		const events: AgentEvent[] = [];
		let followedUp = false;
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "turn_end" && !followedUp) {
				followedUp = true;
				agent.followUp("再跑个测试");
			}
		});

		await agent.prompt("go");

		expect(contexts).toHaveLength(2);
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"system", "user", "assistant", "user", "assistant",
		]);
		expect(contexts[1]!.messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "再跑个测试" }],
		});
		const followUpEnd = events.findIndex((event) =>
			event.type === "message_end" &&
			event.message.role === "user" &&
			textOf(event.message) === "再跑个测试"
		);
		const agentEnd = events.findIndex((event) => event.type === "agent_end");
		expect(followUpEnd).toBeGreaterThan(-1);
		expect(agentEnd).toBeGreaterThan(followUpEnd);
	});

	it("re-enters the inner loop after finishTurn requests end", async () => {
		const { contexts, streamFn } = captureContexts(["first", "second"]);
		const agent = new Agent({
			system: "test",
			streamFn,
			finishTurn: () => ({ action: "end" }),
		});
		let followedUp = false;
		agent.subscribe((event) => {
			if (event.type === "turn_end" && !followedUp) {
				followedUp = true;
				agent.followUp("again");
			}
		});

		await agent.prompt("go");

		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.messages.at(-1)).toMatchObject({
			role: "user", content: [{ type: "text", text: "again" }],
		});
		expect(userTexts(agent.state.messages)).toEqual(["go", "again"]);
	});

	it("waits for tool-driven turns instead of preempting their next request", async () => {
		const { contexts, streamFn } = captureContexts([
			toolCall("c1"), "middle", "final",
		]);
		const agent = new Agent({ system: "test", tools: [echoTool], streamFn });
		let followedUp = false;
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end" && !followedUp) {
				followedUp = true;
				agent.followUp("later");
			}
		});

		await agent.prompt("go");

		expect(contexts).toHaveLength(3);
		expect(JSON.stringify(contexts[1]!.messages)).not.toContain("later");
		expect(contexts[2]!.messages.at(-1)).toMatchObject({
			role: "user", content: [{ type: "text", text: "later" }],
		});
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"system", "user", "assistant", "toolResult", "assistant", "user", "assistant",
		]);
	});

	it("does not revive a terminating tool turn or leak its follow-up into the next run", async () => {
		const { contexts, streamFn } = captureContexts([toolCall("c1"), "next response"]);
		const terminatingTool: ToolDef<{ text: string }> = {
			...echoTool,
			execute: async () => ({ content: [], terminate: true }),
		};
		const agent = new Agent({ system: "test", tools: [terminatingTool], streamFn });
		let followedUp = false;
		agent.subscribe((event) => {
			if (event.type === "turn_end" && !followedUp) {
				followedUp = true;
				agent.followUp("stale");
			}
		});

		await agent.prompt("first");
		expect(contexts).toHaveLength(1);
		expect(userTexts(agent.state.messages)).toEqual(["first"]);

		await agent.prompt("next");
		expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1]!.messages)).not.toContain("stale");
		expect(userTexts(agent.state.messages)).toEqual(["first", "next"]);
	});

	it("does not revive a provider error or leak its follow-up into the next run", async () => {
		const { contexts, streamFn } = captureContexts([
			{ content: [{ type: "text", text: "provider failed" }], stopReason: "error" },
			"next response",
		]);
		const agent = new Agent({ system: "test", streamFn });
		let followedUp = false;
		agent.subscribe((event) => {
			if (event.type === "turn_end" && !followedUp) {
				followedUp = true;
				agent.followUp("stale");
			}
		});

		await agent.prompt("first");
		expect(contexts).toHaveLength(1);
		expect(userTexts(agent.state.messages)).toEqual(["first"]);

		await agent.prompt("next");
		expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1]!.messages)).not.toContain("stale");
		expect(userTexts(agent.state.messages)).toEqual(["first", "next"]);
	});

	it("does not revive an aborted run or leak its follow-up into the next run", async () => {
		const { contexts, streamFn } = captureContexts(
			["first", "next response"],
			{ delayMs: 5 },
		);
		const agent = new Agent({ system: "test", streamFn });
		let aborted = false;
		let followedUp = false;
		agent.subscribe((event) => {
			if (event.type === "message_update" && !aborted) {
				aborted = true;
				agent.abort();
			}
			if (event.type === "turn_end" && !followedUp) {
				followedUp = true;
				agent.followUp("stale");
			}
		});

		await agent.prompt("first");
		expect(contexts).toHaveLength(1);
		expect(userTexts(agent.state.messages)).toEqual(["first"]);

		await agent.prompt("next");
		expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1]!.messages)).not.toContain("stale");
		expect(userTexts(agent.state.messages)).toEqual(["first", "next"]);
	});

	it("shares maxTurns across the initial and follow-up segments", async () => {
		const { contexts, streamFn } = captureContexts([
			"first", toolCall("c2"), "must not run",
		]);
		const agent = new Agent({
			system: "test",
			tools: [echoTool],
			streamFn,
			maxTurns: 2,
		});
		let followedUp = false;
		agent.subscribe((event) => {
			if (event.type === "turn_end" && !followedUp) {
				followedUp = true;
				agent.followUp("again");
			}
		});

		await agent.prompt("go");

		expect(contexts).toHaveLength(2);
		const last = agent.state.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("missing error message");
		expect(last.stopReason).toBe("error");
		expect(textOf(last)).toContain("maxTurns (2)");
	});

	it("closes acceptance before final delivery so a post-drain microtask cannot be dropped", async () => {
		const { contexts, streamFn } = captureContexts(["done"]);
		const agent = new Agent({ system: "test", streamFn });
		let scheduled = false;
		let accepted = false;
		let lateError: unknown;
		let finishLateCall = () => {};
		const lateCalled = new Promise<void>((resolve) => {
			finishLateCall = resolve;
		});
		agent.subscribe((event) => {
			if (event.type !== "turn_end" || scheduled) return;
			scheduled = true;
			void Promise.resolve().then(() => {
				void Promise.resolve().then(() => {
					void Promise.resolve().then(() => {
						void Promise.resolve().then(() => {
							void Promise.resolve().then(() => {
								try {
									agent.followUp("late");
									accepted = true;
								} catch (error) {
									lateError = error;
								}
								finishLateCall();
							});
						});
					});
				});
			});
		});

		await expect(agent.prompt("go")).resolves.toBeUndefined();
		await lateCalled;

		const users = userTexts(agent.state.messages);
		if (accepted) expect(users).toContain("late");
		expect(contexts).toHaveLength(1);
		expect(lateError).toBeInstanceOf(Error);
		expect((lateError as Error).message).toMatch(/Cannot followUp.*active run/);
		expect(users).toEqual(["go"]);
	});

	it("treats blank input as a no-op and rejects idle or late nonblank calls", async () => {
		const { contexts, streamFn } = captureContexts(["done"]);
		const agent = new Agent({ system: "test", streamFn });
		expect(() => agent.followUp(" \t\n")).not.toThrow();
		let lateError: unknown;
		agent.subscribe((event) => {
			if (event.type === "message_update") agent.followUp("   ");
			if (event.type === "agent_end") {
				expect(() => agent.followUp(" \t\n")).not.toThrow();
				try {
					agent.followUp("late");
				} catch (error) {
					lateError = error;
				}
			}
		});

		await expect(agent.prompt("go")).resolves.toBeUndefined();

		expect(contexts).toHaveLength(1);
		expect(userTexts(agent.state.messages)).toEqual(["go"]);
		expect(lateError).toBeInstanceOf(Error);
		expect((lateError as Error).message).toMatch(/Cannot followUp.*active run/);
		expect(() => agent.followUp("idle")).toThrow(/Cannot followUp.*active run/);
	});
});
