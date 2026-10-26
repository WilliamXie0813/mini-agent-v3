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
	onCall?: () => void,
) {
	const contexts: StreamContext[] = [];
	const inner = createFakeStreamFn(script);
	const streamFn: StreamFn = (context, signal) => {
		contexts.push(structuredClone(context));
		onCall?.();
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

describe("Agent.steer", () => {
	it("injects steering after the complete tool turn and before the next provider request", async () => {
		const timeline: string[] = [];
		const { contexts, streamFn } = captureContexts(
			[toolCall("c1"), "middle", "final"],
			() => timeline.push("provider"),
		);
		const agent = new Agent({ system: "test", tools: [echoTool], streamFn });
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
			const isSteeringStart =
				event.type === "message_start" &&
				event.message.role === "user" &&
				textOf(event.message) === "改这个";
			timeline.push(isSteeringStart ? "steering_start" : event.type);
			if (event.type === "tool_execution_end") agent.steer("改这个");
		});

		await agent.prompt("go");

		expect(contexts).toHaveLength(2);
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"system", "user", "assistant", "toolResult", "user", "assistant",
		]);
		expect(contexts[1]!.messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "改这个" }],
		});
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		const firstTurnEnd = timeline.indexOf("turn_end");
		const steeringStart = timeline.indexOf("steering_start");
		const secondProvider = timeline.indexOf("provider", timeline.indexOf("provider") + 1);
		expect(firstTurnEnd).toBeGreaterThan(-1);
		expect(steeringStart).toBeGreaterThan(firstTurnEnd);
		expect(secondProvider).toBeGreaterThan(steeringStart);
		const end = events.find((event) => event.type === "agent_end");
		if (end?.type !== "agent_end") throw new Error("missing agent_end");
		expect(end.messages).toContainEqual({
			role: "user",
			content: [{ type: "text", text: "改这个" }],
		});
	});

	it("drains one default steering message at each of two checkpoints", async () => {
		const { contexts, streamFn } = captureContexts(["first", "second", "third"]);
		const agent = new Agent({ system: "test", streamFn });
		let checkpoint = 0;
		agent.subscribe((event) => {
			if (event.type !== "turn_end") return;
			checkpoint++;
			if (checkpoint === 1) agent.steer("one");
			if (checkpoint === 2) agent.steer("two");
		});

		await agent.prompt("go");

		expect(contexts).toHaveLength(3);
		expect(contexts[1]!.messages.at(-1)).toMatchObject({
			role: "user", content: [{ type: "text", text: "one" }],
		});
		expect(contexts[2]!.messages.at(-1)).toMatchObject({
			role: "user", content: [{ type: "text", text: "two" }],
		});
		expect(
			agent.state.messages
				.filter((message) => message.role === "user")
				.map((message) => textOf(message)),
		).toEqual(["go", "one", "two"]);
	});

	it("finishes a no-tool turn before steering instead of ending the run", async () => {
		const timeline: string[] = [];
		const { contexts, streamFn } = captureContexts(["first", "second"], () => {
			timeline.push("provider");
		});
		const agent = new Agent({ system: "test", streamFn });
		let steered = false;
		agent.subscribe((event) => {
			const isSteeringStart =
				event.type === "message_start" &&
				event.message.role === "user" &&
				textOf(event.message) === "redirect";
			timeline.push(isSteeringStart ? "steering_start" : event.type);
			if (event.type === "message_update" && !steered) {
				steered = true;
				agent.steer("redirect");
			}
		});

		await agent.prompt("go");

		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.messages.at(-1)).toMatchObject({
			role: "user", content: [{ type: "text", text: "redirect" }],
		});
		const assistants = agent.state.messages.filter((message) => message.role === "assistant");
		expect(assistants.map((message) => textOf(message))).toEqual(["first", "second"]);
		const firstTurnEnd = timeline.indexOf("turn_end");
		const steeringStart = timeline.indexOf("steering_start");
		const secondProvider = timeline.indexOf("provider", timeline.indexOf("provider") + 1);
		expect(steeringStart).toBeGreaterThan(firstTurnEnd);
		expect(secondProvider).toBeGreaterThan(steeringStart);
		expect(timeline.indexOf("agent_end")).toBeGreaterThan(secondProvider);
		expect(timeline.slice(firstTurnEnd + 1, steeringStart)).toEqual(["turn_start"]);
	});

	it("drains an all-mode head and later entries in FIFO order", async () => {
		const { contexts, streamFn } = captureContexts(["first", "second"]);
		const agent = new Agent({ system: "test", streamFn });
		let steered = false;
		agent.subscribe((event) => {
			if (event.type === "turn_end" && !steered) {
				steered = true;
				agent.steer("one", "all");
				agent.steer("two");
			}
		});

		await agent.prompt("go");

		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.messages.slice(-2)).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "one" }] },
			{ role: "user", content: [{ type: "text", text: "two" }] },
		]);
	});

	it("treats whitespace steering during an active run as a no-op", async () => {
		const { contexts, streamFn } = captureContexts(["only"]);
		const agent = new Agent({ system: "test", streamFn });
		let steered = false;
		agent.subscribe((event) => {
			if (event.type === "message_update" && !steered) {
				steered = true;
				agent.steer("   ");
			}
		});

		await expect(agent.prompt("go")).resolves.toBeUndefined();

		expect(contexts).toHaveLength(1);
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"system", "user", "assistant",
		]);
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
									agent.steer("late");
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

		const users = agent.state.messages
			.filter((message) => message.role === "user")
			.map((message) => textOf(message));
		if (accepted) expect(users).toContain("late");
		expect(contexts).toHaveLength(1);
		expect(lateError).toBeInstanceOf(Error);
		expect((lateError as Error).message).toMatch(/Cannot steer.*active run/);
		expect(users).toEqual(["go"]);
	});

	it("treats idle and agent_end blank calls as no-ops and rejects nonblank calls", async () => {
		const agent = new Agent({ system: "test", streamFn: createFakeStreamFn(["done"]) });
		expect(() => agent.steer(" \t\n")).not.toThrow();
		expect(() => agent.steer("x")).toThrow(/Cannot steer.*active run/);
		let lateError: unknown;
		agent.subscribe((event) => {
			if (event.type !== "agent_end") return;
			expect(() => agent.steer(" \t\n")).not.toThrow();
			try {
				agent.steer("late");
			} catch (error) {
				lateError = error;
			}
		});

		await expect(agent.prompt("go")).resolves.toBeUndefined();

		expect(lateError).toBeInstanceOf(Error);
		expect((lateError as Error).message).toMatch(/Cannot steer.*active run/);
	});

	it("clears steering left behind by a terminal turn before the next run", async () => {
		const { contexts, streamFn } = captureContexts([toolCall("c1"), "next response"]);
		const terminatingTool: ToolDef<{ text: string }> = {
			...echoTool,
			execute: async () => ({ content: [], terminate: true }),
		};
		const agent = new Agent({ system: "test", tools: [terminatingTool], streamFn });
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end") agent.steer("stale");
		});

		await agent.prompt("first");
		await agent.prompt("next");

		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.messages.at(-1)).toMatchObject({
			role: "user", content: [{ type: "text", text: "next" }],
		});
		expect(
			agent.state.messages
				.filter((message) => message.role === "user")
				.map((message) => textOf(message)),
		).toEqual(["first", "next"]);
	});
});
