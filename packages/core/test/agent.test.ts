import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import type {
	BeforeToolCallContext,
	ToolDef,
} from "../src/tool.ts";

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

	it.each([
		["error", "error"], ["aborted", "error"], ["error", "done"], ["aborted", "done"],
	] as const)("does not execute calls with stopReason %s via %s", async (reason, terminal) => {
		const execute = vi.fn(echoTool.execute);
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			const partial = { role: "assistant" as const, content: [], stopReason: "pending" as const };
			const error = {
				role: "assistant" as const, stopReason: reason,
				content: [{ type: "toolCall" as const, id: "bad", name: "echo", arguments: { text: "never" } }],
			};
			stream.push({ type: "start", partial });
			if (terminal === "error") stream.push({ type: "error", reason, error });
			else stream.push({ type: "done", message: error });
			stream.end(error);
			return stream;
		};
		const provider = vi.fn(streamFn);
		const agent = new Agent({ system: "test", streamFn: provider, tools: [{ ...echoTool, execute }] });
		const events: AgentEvent[] = [];
		agent.subscribe((event) => { events.push(event); });
		await agent.prompt("go");
		await agent.waitForIdle();
		expect(execute).not.toHaveBeenCalled();
		expect(provider).toHaveBeenCalledTimes(1);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: reason });
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(events.filter((event) => event.type === "turn_end")).toMatchObject([{ toolResults: [] }]);
		expect(agent.state.isStreaming).toBe(false);
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

	describe("Agent (stage 5: tool interception)", () => {
		beforeEach(() => setDefaultStreamFn(undefined));

		it("blocks a tool before execute and lets the model recover", async () => {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "unexpected" }],
			}));
			const bashTool: ToolDef<{ command: string }> = {
				name: "bash",
				description: "bash",
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
				},
				execute,
			};
			const inner = createFakeStreamFn([
				[{
					type: "toolCall",
					id: "c1",
					name: "bash",
					arguments: { command: "rm -rf /tmp/nope" },
				}],
				"recovered",
			]);
			let modelCalls = 0;
			const agent = new Agent({
				system: "test",
				tools: [bashTool],
				streamFn: (context, signal) => {
					modelCalls++;
					return inner(context, signal);
				},
			});
			let hookContext: BeforeToolCallContext | undefined;
			agent.beforeToolCall = (context) => {
				hookContext = context;
				return { block: true, reason: "Denied by policy" };
			};

			await agent.prompt("go");

			expect(execute).not.toHaveBeenCalled();
			expect(modelCalls).toBe(2);
			expect(agent.state.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(agent.state.messages[2]).toMatchObject({
				role: "toolResult",
				isError: true,
				content: [{ type: "text", text: "Denied by policy" }],
			});
			expect(hookContext).toMatchObject({
				toolCall: { id: "c1", name: "bash" },
				args: { command: "rm -rf /tmp/nope" },
				messages: [
					{ role: "user" },
					{ role: "assistant" },
				],
			});
		});

		describe("Agent (stage 6: parallel tools)", () => {
			beforeEach(() => setDefaultStreamFn(undefined));

			function delayedTool(
				name: string,
				delayMs: number,
				executionMode?: "sequential" | "parallel",
			): ToolDef<Record<string, never>> {
				return {
					name,
					description: name,
					parameters: { type: "object" },
					executionMode,
					execute: async () => {
						await sleep(delayMs);
						return { content: [{ type: "text", text: name }] };
					},
				};
			}

			const batch = [
				{ type: "toolCall" as const, id: "c1", name: "slow", arguments: {} },
				{ type: "toolCall" as const, id: "c2", name: "fast", arguments: {} },
				{ type: "toolCall" as const, id: "c3", name: "medium", arguments: {} },
			];

			it("uses parallel execution by default while keeping history source ordered", async () => {
				const agent = new Agent({
					system: "test",
					tools: [
						delayedTool("slow", 100),
						delayedTool("fast", 20),
						delayedTool("medium", 30),
					],
					streamFn: createFakeStreamFn([batch, "done"]),
				});
				const endOrder: string[] = [];
				agent.subscribe((event) => {
					if (event.type === "tool_execution_end")
						endOrder.push(event.toolCallId);
				});

				await agent.prompt("go");

				expect(endOrder).toEqual(["c2", "c3", "c1"]);
				expect(
					agent.state.messages
						.filter((message) => message.role === "toolResult")
						.map((message) =>
							message.role === "toolResult" ? message.toolCallId : "never",
						),
				).toEqual(["c1", "c2", "c3"]);
			});

			it("delivers the same completion order to every asynchronous subscriber", async () => {
				const agent = new Agent({
					system: "test",
					tools: [
						delayedTool("first", 10),
						delayedTool("second", 20),
					],
					streamFn: createFakeStreamFn([[
						{ type: "toolCall", id: "c1", name: "first", arguments: {} },
						{ type: "toolCall", id: "c2", name: "second", arguments: {} },
					], "done"]),
				});
				const observed: string[] = [];
				agent.subscribe(async (event) => {
					if (
						event.type === "tool_execution_end" &&
						event.toolCallId === "c1"
					) {
						await sleep(50);
					}
				});
				agent.subscribe((event) => {
					if (event.type === "tool_execution_end")
						observed.push(event.toolCallId);
				});

				await agent.prompt("go");

				expect(observed).toEqual(["c1", "c2"]);
			});

			it("switches between sequential and parallel modes without rebuilding Agent", async () => {
				const agent = new Agent({
					system: "test",
					tools: [
						delayedTool("slow", 80),
						delayedTool("fast", 10),
						delayedTool("medium", 20),
					],
					streamFn: createFakeStreamFn([
						batch, "first done",
						batch, "second done",
					]),
				});
				const orders: string[][] = [[], []];
				let run = -1;
				agent.subscribe((event) => {
					if (event.type === "agent_start") run++;
					if (event.type === "tool_execution_end")
						orders[run].push(event.toolCallId);
				});

				agent.toolExecution = "sequential";
				await agent.prompt("first");
				agent.toolExecution = "parallel";
				await agent.prompt("second");

				expect(orders[0]).toEqual(["c1", "c2", "c3"]);
				expect(orders[1]).toEqual(["c2", "c3", "c1"]);
			});

			it("downgrades the whole batch when one tool is sequential", async () => {
				const agent = new Agent({
					system: "test",
					tools: [
						delayedTool("slow", 60),
						delayedTool("fast", 10, "sequential"),
						delayedTool("medium", 20),
					],
					streamFn: createFakeStreamFn([batch, "done"]),
				});
				const endOrder: string[] = [];
				agent.subscribe((event) => {
					if (event.type === "tool_execution_end")
						endOrder.push(event.toolCallId);
				});

				await agent.prompt("go");

				expect(endOrder).toEqual(["c1", "c2", "c3"]);
			});

			it("finalizes every call as aborted when prepare aborts before phase two", async () => {
				const executes = [vi.fn(), vi.fn(), vi.fn()];
				const tools: ToolDef<any>[] = ["one", "two", "three"].map(
					(name, index) => ({
						name,
						description: name,
						parameters: { type: "object" },
						execute: executes[index],
					}),
				);
				const calls = [
					{ type: "toolCall" as const, id: "c1", name: "one", arguments: {} },
					{ type: "toolCall" as const, id: "c2", name: "two", arguments: {} },
					{ type: "toolCall" as const, id: "c3", name: "three", arguments: {} },
				];
				const agent = new Agent({
					system: "test",
					tools,
					streamFn: createFakeStreamFn([calls, "must not run"]),
				});
				agent.beforeToolCall = ({ toolCall }) => {
					if (toolCall.id === "c2") agent.abort();
				};

				await expect(agent.prompt("go")).resolves.toBeUndefined();

				expect(executes.every((execute) => execute.mock.calls.length === 0))
					.toBe(true);
				const results = agent.state.messages.filter(
					(message) => message.role === "toolResult",
				);
				expect(results.map((message) =>
					message.role === "toolResult" ? message.toolCallId : "never",
				)).toEqual(["c1", "c2", "c3"]);
				expect(results.map((message) =>
					message.role === "toolResult" ? textOf(message.content) : "never",
				)).toEqual(["Operation aborted", "Operation aborted", "Operation aborted"]);
				expect(agent.state.messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason: "aborted",
				});
				expect(agent.state.isStreaming).toBe(false);
			});
		});

		it("feeds schema violations back without calling hook or execute", async () => {
			const execute = vi.fn(async () => ({ content: [] }));
			const hook = vi.fn();
			const tool: ToolDef<any> = {
				name: "configure",
				description: "configure",
				parameters: {
					type: "object",
					properties: {
						options: {
							type: "object",
							properties: { mode: { enum: ["safe", "fast"] } },
							required: ["mode"],
						},
					},
					required: ["options"],
				},
				execute,
			};
			const agent = new Agent({
				system: "test",
				tools: [tool],
				streamFn: createFakeStreamFn([
					[{
						type: "toolCall",
						id: "c1",
						name: "configure",
						arguments: { options: { mode: "danger" } },
					}],
					"fixed",
				]),
			});
			agent.beforeToolCall = hook;

			await agent.prompt("go");

			expect(hook).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
			const result = agent.state.messages[2];
			if (result.role !== "toolResult")
				throw new Error("expected tool result");
			expect(textOf(result.content)).toContain(
				'arguments.options.mode: expected one of ["safe","fast"]',
			);
		});

		it("ends the run after a terminating blocked call", async () => {
			const inner = createFakeStreamFn([
				[{
					type: "toolCall",
					id: "c1",
					name: "bash",
					arguments: { command: "blocked" },
				}],
				"must not run",
			]);
			let modelCalls = 0;
			const agent = new Agent({
				system: "test",
				tools: [{
					name: "bash",
					description: "bash",
					parameters: { type: "object" },
					execute: async () => ({ content: [] }),
				}],
				streamFn: (context, signal) => {
					modelCalls++;
					return inner(context, signal);
				},
			});
			const events: AgentEvent[] = [];
			agent.beforeToolCall = () => ({ block: true, terminate: true });
			agent.subscribe((event) => {
				events.push(event);
			});

			await agent.prompt("go");

			expect(modelCalls).toBe(1);
			expect(agent.state.messages.at(-1)).toMatchObject({
				role: "toolResult",
				isError: true,
			});
			expect(events.filter((event) => event.type === "turn_start"))
				.toHaveLength(1);
			expect(events.at(-1)?.type).toBe("agent_end");
		});

		it("continues when only one call in the batch terminates", async () => {
			const agent = new Agent({
				system: "test",
				tools: [
					{
						name: "first",
						description: "first",
						parameters: { type: "object" },
						execute: async () => ({ content: [] }),
					},
					{
						name: "second",
						description: "second",
						parameters: { type: "object" },
						execute: async () => ({ content: [] }),
					},
				],
				streamFn: createFakeStreamFn([
					[
						{ type: "toolCall", id: "c1", name: "first", arguments: {} },
						{ type: "toolCall", id: "c2", name: "second", arguments: {} },
					],
					"continued",
				]),
			});
			agent.beforeToolCall = ({ toolCall }) => ({
				block: true,
				terminate: toolCall.name === "first",
			});

			await agent.prompt("go");

			expect(agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
			});
		});

		it("emits tool updates before execution end", async () => {
			const agent = new Agent({
				system: "test",
				tools: [{
					name: "stream",
					description: "stream",
					parameters: { type: "object" },
					execute: async (_params, _signal, onUpdate) => {
						onUpdate?.({
							content: [{ type: "text", text: "partial" }],
						});
						return { content: [{ type: "text", text: "done" }] };
					},
				}],
				streamFn: createFakeStreamFn([
					[{
						type: "toolCall",
						id: "c1",
						name: "stream",
						arguments: { raw: true },
					}],
					"done",
				]),
			});
			const events: AgentEvent[] = [];
			agent.subscribe((event) => {
				events.push(event);
			});

			await agent.prompt("go");

			const update = events.find(
				(event) => event.type === "tool_execution_update",
			);
			expect(update).toMatchObject({
				type: "tool_execution_update",
				toolCallId: "c1",
				toolName: "stream",
				args: { raw: true },
				partialResult: {
					content: [{ type: "text", text: "partial" }],
				},
			});
			expect(events.findIndex((event) => event.type === "tool_execution_update"))
				.toBeLessThan(
					events.findIndex((event) => event.type === "tool_execution_end"),
				);
		});

		it("feeds hook exceptions back instead of rejecting prompt", async () => {
			const agent = new Agent({
				system: "test",
				tools: [echoTool],
				streamFn: createFakeStreamFn([
					[{
						type: "toolCall",
						id: "c1",
						name: "echo",
						arguments: { text: "x" },
					}],
					"recovered",
				]),
			});
			agent.beforeToolCall = () => {
				throw new Error("permission service unavailable");
			};

			await expect(agent.prompt("go")).resolves.toBeUndefined();

			expect(agent.state.messages[2]).toMatchObject({
				role: "toolResult",
				isError: true,
				content: [{
					type: "text",
					text: "permission service unavailable",
				}],
			});
		});

		it("prefers aborted terminal state over a terminating tool result", async () => {
			const agent = new Agent({
				system: "test",
				tools: [{
					name: "stop",
					description: "stop",
					parameters: { type: "object" },
					execute: async () => ({
						content: [],
						terminate: true,
					}),
				}],
				streamFn: createFakeStreamFn([
					[{
						type: "toolCall",
						id: "c1",
						name: "stop",
						arguments: {},
					}],
					"must not run",
				]),
			});
			agent.subscribe((event) => {
				if (event.type === "tool_execution_start") agent.abort();
			});

			await agent.prompt("go");

			expect(agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "aborted",
			});
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
		expect(textOf(last.content)).toMatch(/without a done or error event/);
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
