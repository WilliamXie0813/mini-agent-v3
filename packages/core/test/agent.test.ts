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
	StreamContext,
	StreamFn,
	SystemSection,
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

// 捕获每次 provider 调用的 context 快照，用来断言 transcript 重放结果。
function captureContexts(script: Parameters<typeof createFakeStreamFn>[0]) {
	const contexts: StreamContext[] = [];
	const inner = createFakeStreamFn(script);
	const streamFn: StreamFn = (context, signal) => {
		contexts.push(structuredClone(context));
		return inner(context, signal);
	};
	return { contexts, streamFn };
}

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
			"system",
			"user",
			"assistant",
		]);
		expect(agent.state.tools).toEqual([echoTool]);
		expect(listenerStates).toEqual([2, 3]);
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
		expect(agent.state.messages).toHaveLength(5);
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
		// 空白 prompt 不追加任何消息，但初始 system transcript 本来就在。
		expect(agent.state.messages).toEqual([
			{ role: "system", sections: [{ text: "test" }] },
		]);
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
		expect(agent.state.messages).toHaveLength(3);
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

		expect(agent.state.messages[3]).toMatchObject({
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
				"system",
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(agent.state.messages[3]).toMatchObject({
				role: "toolResult",
				isError: true,
				content: [{ type: "text", text: "Denied by policy" }],
			});
			expect(hookContext).toMatchObject({
				toolCall: { id: "c1", name: "bash" },
				args: { command: "rm -rf /tmp/nope" },
				messages: [
					{ role: "system" },
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
			const result = agent.state.messages[3];
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

			expect(agent.state.messages[3]).toMatchObject({
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
			"system",
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
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(agent.state.messages[3]).toMatchObject({
			role: "toolResult",
			isError: true,
		});
		expect(agent.state.messages[4]).toMatchObject({
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

	describe("Agent (stage 8: transcript-backed system state)", () => {
		it("stores one leading system message and never duplicates it across prompts", async () => {
			const agent = new Agent({
				system: "base",
				tools: [echoTool],
				streamFn: createFakeStreamFn(["one", "two"]),
			});
			await agent.prompt("first");
			await agent.prompt("second");
			expect(agent.state.messages.filter((message) => message.role === "system"))
				.toEqual([{
					role: "system",
					sections: [{ text: "base" }],
					toolsAdded: [expect.objectContaining({ name: "echo" })],
				}]);
		});

		it("treats an existing system history as authoritative instead of prepending", async () => {
			const history: Message[] = [
				{ role: "system", sections: [{ text: "one" }] },
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "system", sections: [{ text: "two" }], toolsRemoved: ["ghost"] },
			];
			const before = structuredClone(history);
			const contexts: { system: unknown }[] = [];
			const inner = createFakeStreamFn(["ok"]);
			const streamFn: StreamFn = (context, signal) => {
				contexts.push({ system: structuredClone(context.system) });
				return inner(context, signal);
			};
			const agent = new Agent({
				system: "must not be prepended",
				messages: history,
				streamFn,
			});

			expect(agent.state.messages.filter((m) => m.role === "system")).toHaveLength(2);
			expect(agent.state.messages[0]).toMatchObject({ sections: [{ text: "one" }] });
			expect(history).toEqual(before); // 不修改调用方数组

			await agent.prompt("go");

			expect(agent.state.messages.filter((m) => m.role === "system")).toHaveLength(2);
			// provider 看到的 prompt 来自 transcript 重放，而不是 options.system
			expect(contexts[0]!.system).toEqual({
				role: "system",
				sections: [{ text: "one" }, { text: "two" }],
			});
		});
	});

	describe("Agent (stage 8: incremental system history)", () => {
		it("appends system sections as a new entry without touching the old one", async () => {
			const { contexts, streamFn } = captureContexts(["one", "two"]);
			const agent = new Agent({ system: "base", streamFn });
			await agent.prompt("first");
			const firstSystem = agent.state.messages[0];

			agent.appendSystemSections([{ tag: "workspace", text: "repo only" }]);
			await agent.prompt("second");

			expect(agent.state.messages.filter((message) => message.role === "system"))
				.toHaveLength(2);
			// 旧 entry 原样保留（同一引用），新 section 只出现在追加的 entry 里。
			expect(agent.state.messages[0]).toBe(firstSystem);
			expect(contexts[1]!.system.sections).toEqual([
				{ text: "base" },
				{ tag: "workspace", text: "repo only" },
			]);
		});

		it("keeps the recorded sections immutable against later caller mutation", async () => {
			const { streamFn } = captureContexts(["one"]);
			const agent = new Agent({ system: "base", streamFn });
			const sections: SystemSection[] = [{ tag: "workspace", text: "repo only" }];

			agent.appendSystemSections(sections);
			sections[0]!.text = "mutated";
			sections.push({ text: "sneaky" });

			const recorded = agent.state.messages.at(-1);
			expect(recorded).toEqual({
				role: "system",
				sections: [{ tag: "workspace", text: "repo only" }],
			});
		});

		it("treats an empty section array as a no-op", () => {
			const agent = new Agent({
				system: "base",
				streamFn: createFakeStreamFn(["never"]),
			});
			agent.appendSystemSections([]);
			expect(agent.state.messages.filter((m) => m.role === "system")).toHaveLength(1);
		});

		it("records tool changes as minimal deltas and keeps the cache prefix stable", async () => {
			const { contexts, streamFn } = captureContexts(["one", "two", "three"]);
			const agent = new Agent({ system: "base", tools: [echoTool], streamFn });
			await agent.prompt("one");
			const systemCount = () =>
				agent.state.messages.filter((m) => m.role === "system").length;
			expect(systemCount()).toBe(1);

			// 相同声明 → registry 可更新但不新增 system entry（cache 前缀稳定）
			agent.setTools([echoTool]);
			expect(systemCount()).toBe(1);
			expect(agent.state.tools).toEqual([echoTool]);

			// 新增 read → 新 entry 只有 toolsAdded
			const readTool: ToolDef<{ path: string }> = {
				name: "read",
				description: "read a file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
				execute: async ({ path }) => ({ content: [{ type: "text", text: path }] }),
			};
			agent.setTools([echoTool, readTool]);
			expect(systemCount()).toBe(2);
			expect(agent.state.messages.at(-1)).toEqual({
				role: "system",
				sections: [],
				toolsAdded: [{
					name: "read",
					description: "read a file",
					parameters: readTool.parameters,
				}],
			});

			// 删除 echo → 下一条 entry 只有 toolsRemoved
			agent.setTools([readTool]);
			expect(systemCount()).toBe(3);
			expect(agent.state.messages.at(-1)).toEqual({
				role: "system",
				sections: [],
				toolsRemoved: ["echo"],
			});

			// 同名 read 的 description/schema 变化 → 同一 entry remove + add
			const readV2: ToolDef<{ path: string }> = {
				...readTool,
				description: "read a file v2",
			};
			agent.setTools([readV2]);
			expect(systemCount()).toBe(4);
			expect(agent.state.messages.at(-1)).toEqual({
				role: "system",
				sections: [],
				toolsRemoved: ["read"],
				toolsAdded: [{
					name: "read",
					description: "read a file v2",
					parameters: readTool.parameters,
				}],
			});
		});

		it("swaps the execute closure without a system delta when the declaration is unchanged", async () => {
			const oldExecute = vi.fn(echoTool.execute);
			const newExecute = vi.fn(async ({ text }: { text: string }) => ({
				content: [{ type: "text" as const, text: `new:${text}` }],
			}));
			const { streamFn } = captureContexts([
				[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }],
				"done",
			]);
			const agent = new Agent({
				system: "base",
				tools: [{ ...echoTool, execute: oldExecute }],
				streamFn,
			});
			const systemCount = () =>
				agent.state.messages.filter((m) => m.role === "system").length;

			agent.setTools([{ ...echoTool, execute: newExecute }]);
			expect(systemCount()).toBe(1); // 声明没变，无 delta

			await agent.prompt("go");
			expect(newExecute).toHaveBeenCalledTimes(1);
			expect(oldExecute).not.toHaveBeenCalled();
			expect(systemCount()).toBe(1);
		});

		it("copies the tools array so later caller mutation stays out of the registry", () => {
			const agent = new Agent({
				system: "base",
				streamFn: createFakeStreamFn(["never"]),
			});
			const tools = [echoTool];
			agent.setTools(tools);
			tools.length = 0;
			expect(agent.state.tools).toEqual([echoTool]);
		});

		it("rejects prompt and tool mutations during an active run", async () => {
			const agent = new Agent({
				system: "base",
				tools: [echoTool],
				streamFn: createFakeStreamFn(["ok"]),
			});
			const gate = deferred();
			const endReached = deferred();
			agent.subscribe(async (event) => {
				if (event.type === "agent_end") {
					endReached.resolve();
					await gate.promise;
				}
			});
			const prompt = agent.prompt("hi");
			await endReached.promise; // run 仍 active：agent_end listener 未放行

			const messagesBefore = agent.state.messages.slice();
			const toolsBefore = agent.state.tools.slice();
			expect(() => agent.appendSystemSections([{ text: "nope" }]))
				.toThrow(/appendSystemSections.*active run|active run.*appendSystemSections/i);
			expect(() => agent.setTools([]))
				.toThrow(/setTools.*active run|active run.*setTools/i);
			// 拒绝不得留下副作用：transcript 与 registry 完全不变
			expect(agent.state.messages).toEqual(messagesBefore);
			expect(agent.state.tools).toEqual(toolsBefore);

			gate.resolve();
			await prompt;
		});
	});
});
