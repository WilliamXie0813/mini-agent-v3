import { beforeEach, describe, expect, it } from "vitest";
import {
	createAssistantMessageEventStream,
	createFakeStreamFn,
	setDefaultStreamFn,
} from "@mini-agent/ai";
import type {
	ContentBlock,
	Message,
	StreamFn,
} from "@mini-agent/ai";
import { Agent } from "../src/agent.ts";
import type { AgentEvent } from "../src/agent-event.ts";
import type { ToolDef } from "../src/tool.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function textOf(content: ContentBlock[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

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

describe("Agent", () => {
	beforeEach(() => setDefaultStreamFn(undefined));

	it("copies initial arrays and reduces message_end before listeners run", async () => {
		const initialMessages: Message[] = [];
		const tools = [echoTool];
		const agent = new Agent({
			system: "test",
			messages: initialMessages,
			tools,
			streamFn: createFakeStreamFn(["hello"]),
		});
		tools.length = 0;
		const listenerStates: number[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_end") {
				listenerStates.push(agent.state.messages.length);
				expect(agent.state.messages.at(-1)).toBe(event.message);
			}
		});

		await agent.prompt("hi");

		expect(initialMessages).toEqual([]);
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(agent.state.tools).toEqual([echoTool]);
		expect(listenerStates).toEqual([1, 2]);
	});

	it("emits the complete lifecycle with run-local agent_end messages", async () => {
		const agent = new Agent({
			system: "test",
			streamFn: createFakeStreamFn(["ok"]),
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("hi");

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const end = events.at(-1);
		if (end?.type !== "agent_end") throw new Error("missing agent_end");
		expect(end.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("stops notifying an unsubscribed listener", async () => {
		const agent = new Agent({
			system: "test",
			streamFn: createFakeStreamFn(["first", "second"]),
		});
		const events: AgentEvent[] = [];
		const unsubscribe = agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("one");
		unsubscribe();
		const count = events.length;
		await agent.prompt("two");

		expect(events).toHaveLength(count);
		expect(agent.state.messages).toHaveLength(4);
	});

	it("does nothing for a whitespace-only prompt", async () => {
		const agent = new Agent({
			system: "test",
			streamFn: createFakeStreamFn(["never"]),
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("   ");

		expect(events).toEqual([]);
		expect(agent.state.messages).toEqual([]);
	});

	it("copies tools before external mutation", async () => {
		const tools = [echoTool];
		const agent = new Agent({
			system: "test",
			tools,
			streamFn: createFakeStreamFn([
				[{
					type: "toolCall",
					id: "c1",
					name: "echo",
					arguments: { text: "kept" },
				}],
				"done",
			]),
		});
		tools.length = 0;

		await agent.prompt("go");

		expect(agent.state.messages[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "c1",
			isError: false,
		});
	});

	it("requires a stream function before starting a lifecycle", () => {
		expect(() => new Agent({ system: "test" })).toThrow(
			/no default stream fn/i,
		);
	});

	it("waits for listeners and rejects concurrent prompts until agent_end settles", async () => {
		const agent = new Agent({
			system: "test",
			streamFn: createFakeStreamFn(["ok"]),
		});
		const gate = deferred();
		const endReached = deferred();
		let secondListenerCalled = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				endReached.resolve();
				await gate.promise;
			}
		});
		agent.subscribe((event) => {
			if (event.type === "agent_end") secondListenerCalled = true;
		});

		let promptSettled = false;
		const prompt = agent.prompt("hi").then(() => {
			promptSettled = true;
		});
		await endReached.promise;
		let idleSettled = false;
		const idle = agent.waitForIdle().then(() => {
			idleSettled = true;
		});

		await Promise.resolve();
		expect(promptSettled).toBe(false);
		expect(idleSettled).toBe(false);
		expect(secondListenerCalled).toBe(false);
		expect(agent.state.isStreaming).toBe(true);
		await expect(agent.prompt("again")).rejects.toThrow(
			/already processing|active run/i,
		);

		gate.resolve();
		await prompt;
		await idle;
		expect(secondListenerCalled).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("turns a missing done event into an error message", async () => {
		const broken: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end());
			return stream;
		};
		const agent = new Agent({ system: "test", streamFn: broken });
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
		});

		await expect(agent.prompt("hi")).resolves.toBeUndefined();

		const last = agent.state.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("missing error message");
		expect(last.stopReason).toBe("error");
		expect(textOf(last.content)).toMatch(/without a done event/);
		expect(events.slice(-4).map((event) => event.type)).toEqual([
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("turns maxTurns into a visible error message", async () => {
		const agent = new Agent({
			system: "test",
			tools: [echoTool],
			maxTurns: 1,
			streamFn: createFakeStreamFn([[
				{
					type: "toolCall",
					id: "c1",
					name: "echo",
					arguments: { text: "loop" },
				},
			]]),
		});

		await agent.prompt("go");

		const last = agent.state.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("missing error message");
		expect(last.stopReason).toBe("error");
		expect(textOf(last.content)).toMatch(/maxTurns.*echo/i);
	});

	it("propagates listener failures without synthesizing an error message", async () => {
		const agent = new Agent({
			system: "test",
			streamFn: createFakeStreamFn(["abc"], { delayMs: 2 }),
		});
		agent.subscribe((event) => {
			if (event.type === "message_update")
				throw new Error("listener broke");
		});

		await expect(agent.prompt("hi")).rejects.toThrow("listener broke");
		expect(
			agent.state.messages.filter(
				(message) =>
					message.role === "assistant" &&
					message.stopReason === "error",
			),
		).toHaveLength(0);
		expect(agent.state.isStreaming).toBe(false);
		await expect(agent.waitForIdle()).resolves.toBeUndefined();
	});

	it("does not recurse when a fallback listener fails", async () => {
		const broken: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end());
			return stream;
		};
		const agent = new Agent({ system: "test", streamFn: broken });
		agent.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "error"
			) {
				throw new Error("fallback listener broke");
			}
		});

		await expect(agent.prompt("hi")).rejects.toThrow(
			"fallback listener broke",
		);
		expect(
			agent.state.messages.filter(
				(message) =>
					message.role === "assistant" &&
					message.stopReason === "error",
			),
		).toHaveLength(1);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("closes a partial message as aborted without storing the half response", async () => {
		const agent = new Agent({
			system: "test",
			streamFn: createFakeStreamFn(["abcdef"], { delayMs: 5 }),
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "message_update") agent.abort();
		});

		await expect(agent.prompt("hi")).resolves.toBeUndefined();

		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		const last = agent.state.messages.at(-1);
		if (last?.role !== "assistant")
			throw new Error("missing aborted message");
		expect(last.stopReason).toBe("aborted");
		expect(textOf(last.content)).toBe("");
		expect(events.slice(-3).map((event) => event.type)).toEqual([
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("keeps an aborted tool result before the terminal aborted message", async () => {
		const abortAwareTool: ToolDef<Record<string, never>> = {
			name: "wait",
			description: "stops when aborted",
			parameters: { type: "object" },
			execute: async (_params, signal) => {
				if (signal?.aborted)
					throw new DOMException("Operation aborted", "AbortError");
				return { content: [{ type: "text", text: "unexpected" }] };
			},
		};
		const agent = new Agent({
			system: "test",
			tools: [abortAwareTool],
			streamFn: createFakeStreamFn([
				[{
					type: "toolCall",
					id: "c1",
					name: "wait",
					arguments: {},
				}],
				"never",
			]),
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "tool_execution_start") agent.abort();
		});

		await agent.prompt("go");

		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(agent.state.messages[2]).toMatchObject({
			role: "toolResult",
			isError: true,
		});
		expect(agent.state.messages[3]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
		const firstTurnEnd = events.findIndex(
			(event) => event.type === "turn_end",
		);
		const terminalTurnStart = events.findIndex(
			(event, index) =>
				index > firstTurnEnd && event.type === "turn_start",
		);
		const abortedEnd = events.findIndex(
			(event) =>
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "aborted",
		);
		expect(firstTurnEnd).toBeGreaterThan(-1);
		expect(terminalTurnStart).toBeGreaterThan(firstTurnEnd);
		expect(abortedEnd).toBeGreaterThan(terminalTurnStart);
	});
});
