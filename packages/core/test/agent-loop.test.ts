import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeEach } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { setDefaultStreamFn, createFakeStreamFn, createAssistantMessageEventStream } from "@mini-agent/ai";
import type { Message, StreamFn, ToolResultMessage } from "@mini-agent/ai";
import type { AgentEvent } from "../src/agent-event.ts";
import type { ToolDef } from "../src/tool.ts";

// 工厂而非共享对象：agentLoop 就地追加 messages（验收要求同一引用），
// 共享数组会让测试间互相污染。
const base = () => ({ messages: [] as Message[], system: "you are a test" });

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("agentLoop (stage 1: single round trip)", () => {
	beforeEach(() => setDefaultStreamFn(undefined));

	it("appends user then assistant, and stops with stopReason 'stop'", async () => {
		const messages = await agentLoop({ ...base(), prompt: "hi", streamFn: createFakeStreamFn(["hello from fake"]) });
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "user" });
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("wraps the prompt as a single text content block", async () => {
		const messages = await agentLoop({ ...base(), prompt: "ping", streamFn: createFakeStreamFn(["x"]) });
		expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "ping" }] });
	});

	it("falls back to the installed default stream fn", async () => {
		setDefaultStreamFn(createFakeStreamFn(["from slot"]));
		const messages = await agentLoop({ ...base(), prompt: "hi" });
		expect(messages[1].content).toEqual([{ type: "text", text: "from slot" }]);
	});

	it("throws a named error when no stream fn is available at all", async () => {
		await expect(agentLoop({ ...base(), prompt: "hi" })).rejects.toThrow(/no default stream fn/i);
	});

	it("appends to existing history instead of replacing it", async () => {
		const history: Message[] = [
			{ role: "user", content: [{ type: "text", text: "old" }] },
			{ role: "assistant", content: [{ type: "text", text: "old reply" }], stopReason: "stop" },
		];
		const messages = await agentLoop({ ...base(), messages: history, prompt: "new",
			streamFn: createFakeStreamFn(["new reply"]) });
		expect(messages).toHaveLength(4);
		expect(messages).toBe(history);
	});

	it("returns without touching history when the signal is already aborted", async () => {
		const messages = await agentLoop({ ...base(), prompt: "hi", signal: AbortSignal.abort(),
			streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toHaveLength(0);
	});

	it("returns without touching history for a whitespace-only prompt", async () => {
		const messages = await agentLoop({ ...base(), prompt: "   ", streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toHaveLength(0);
	});

	it("still records an assistant message when the model returns empty text", async () => {
		const messages = await agentLoop({ ...base(), prompt: "hi", streamFn: createFakeStreamFn([""]) });
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});

const echoTool: ToolDef<{ text: string }> = {
	name: "echo",
	description: "echo back",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: async (p) => ({ content: [{ type: "text", text: p.text }] }),
};

describe("agentLoop (stage 2: tool loop)", () => {
	it("runs a full tool round and ends when the model stops asking for tools", async () => {
		const messages = await agentLoop({
			...base(), prompt: "read it", tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{ type: "text", text: "looking" }, { type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } }],
				"I saw hi",
			]),
		});
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("keeps the assistant toolCall message and its result adjacent, in call order", async () => {
		const messages = await agentLoop({
			...base(), prompt: "go", tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "first" } },
					{ type: "toolCall", id: "c2", name: "echo", arguments: { text: "second" } }],
				"done",
			]),
		});
		expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "c1" });
		expect(messages[3]).toMatchObject({ role: "toolResult", toolCallId: "c2" });
		expect(messages[4]).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("records the intermediate assistant message with stopReason 'toolUse'", async () => {
		const messages = await agentLoop({
			...base(), prompt: "go", tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }], "done",
			]),
		});
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
	});

	it("does not execute anything when stopReason is 'length' and feeds back one error per call", async () => {
		const log: string[] = [];
		const spy: ToolDef<any> = {
			...echoTool,
			execute: async (p: { text: string }) => { log.push("called"); return echoTool.execute(p); },
		};
		const messages = await agentLoop({
			...base(), prompt: "go", tools: [spy],
			streamFn: createFakeStreamFn([
				// length 场景：内容块仍是 toolCall（半截 JSON 被尽力解析出来），但 stopReason 是 length
				{ content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "a" } },
				            { type: "toolCall", id: "c2", name: "echo", arguments: { text: "b" } }],
				  stopReason: "length" },
				"recovered",
			]),
		});
		expect(log).toEqual([]);                                   // 整批不执行
		expect(messages.slice(2, 4).map((m) => (m as ToolResultMessage).isError)).toEqual([true, true]);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" }); // 循环继续并收敛
	});

	it("feeds back an error and lets the model recover from an unknown tool", async () => {
		const messages = await agentLoop({
			...base(), prompt: "go", tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "nope", arguments: {} }], "sorry, retrying",
			]),
		});
		expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "nope", isError: true });
		expect(messages).toHaveLength(4);
	});

	it("throws a named error when the model keeps calling tools past maxTurns", async () => {
		await expect(agentLoop({
			...base(), prompt: "go", tools: [echoTool], maxTurns: 3,
			streamFn: createFakeStreamFn([[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }]]),
		})).rejects.toThrow(/maxTurns/i);
		await expect(agentLoop({
			...base(), prompt: "go", tools: [echoTool], maxTurns: 3,
			streamFn: createFakeStreamFn([[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }]]),
		})).rejects.toThrow(/echo/); // 错误信息必须带上模型反复调用的工具名，否则无从排查
	});

	it("returns immediately for a whitespace-only prompt without touching history", async () => {
		const messages = await agentLoop({ ...base(), prompt: "  ", tools: [echoTool],
			streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toHaveLength(0);
	});

	it("returns without touching history when the signal is already aborted", async () => {
		const messages = await agentLoop({ ...base(), prompt: "go", tools: [echoTool], signal: AbortSignal.abort(),
			streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toHaveLength(0);
	});

	it("settles an aborted provider without re-asking the model", async () => {
		const controller = new AbortController();
		const messages: Message[] = [];
		const inner = createFakeStreamFn([
			[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }],
			// 第二轮带 stopReason "length"：走 continue 路径回到循环顶部——abort 检查点就在那里。
			{ content: [{ type: "toolCall", id: "c2", name: "echo", arguments: { text: "y" } }], stopReason: "length" },
		]);
		let modelCalls = 0;
		const streamFn: typeof inner = (context, signal) => {
			modelCalls++;
			if (modelCalls === 2) controller.abort();
			return inner(context, signal);
		};
		await expect(agentLoop({
			...base(), messages, prompt: "go", tools: [echoTool],
			signal: controller.signal, streamFn,
		})).resolves.toBe(messages);
		expect(modelCalls).toBe(2); // 没有第三次请求
		// signal 已在第二批执行前中止：不为尚未开始的 c2 伪造 toolResult。
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted", content: [] });
		expect(
			messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.toolCallId === "c2",
			),
		).toBe(false);
	});
});

describe("agentLoop (stage 3: streaming)", () => {
	beforeEach(() => setDefaultStreamFn(undefined));

	it("keeps one assistant message per response no matter how many deltas", async () => {
		const messages = await agentLoop({
			...base(), prompt: "hi", streamFn: createFakeStreamFn(["forty characters long string, give or take"]),
		});
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ role: "assistant" });
		expect(messages[1].content).toEqual([{ type: "text", text: "forty characters long string, give or take" }]);
	});

	it("emits every delta in order, and the joined deltas equal the stored text", async () => {
		const events: AgentEvent[] = [];
		const deltas: string[] = [];
		const messages = await agentLoop({
			...base(), prompt: "hi",
			emit: (event) => {
				events.push(event);
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					deltas.push(event.assistantMessageEvent.delta);
				}
			},
			streamFn: createFakeStreamFn(["hello"]),
		});
		expect(deltas).toEqual(["h", "e", "l", "l", "o"]);
		expect(events.filter((event) => event.type === "message_update"))
			.toHaveLength(5);
		const assistant = messages[1];
		if (assistant.role !== "assistant")
			throw new Error("expected assistant message");
		expect(assistant.content[0]).toEqual({
			type: "text",
			text: deltas.join(""),
		});
	});

	it("throws a named error when a provider ends the stream without a done event", async () => {
		const broken: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.end());
			return stream;
		};
		await expect(agentLoop({ ...base(), prompt: "hi", streamFn: broken })).rejects.toThrow(
			/without a done or error event/,
		);
	});

	it("records only a terminal diagnostic when aborted mid-stream", async () => {
		const controller = new AbortController();
		const deltas: string[] = [];
		const messages: Message[] = [];
		await expect(
			agentLoop({
				...base(), messages, prompt: "hi", signal: controller.signal,
				emit: (event) => {
					if (
						event.type === "message_update" &&
						event.assistantMessageEvent.type === "text_delta"
					) {
						deltas.push(event.assistantMessageEvent.delta);
						controller.abort();
					}
				},
				streamFn: createFakeStreamFn(["abcdef"], { delayMs: 30 }),
			}),
		).resolves.toBe(messages);
		expect(deltas).toEqual(["a"]);
		expect(messages.at(-1)).toMatchObject({ stopReason: "aborted", content: [] });
	});
});

describe("agentLoop (stage 4: lifecycle events)", () => {
	it("emits a complete no-tool lifecycle in order", async () => {
		const events: AgentEvent[] = [];
		await agentLoop({
			...base(),
			prompt: "hi",
			streamFn: createFakeStreamFn(["ok"]),
			emit: (event) => {
				events.push(event);
			},
		});

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
	});

	it("keeps old history out of agent_end.messages", async () => {
		const history: Message[] = [
			{ role: "user", content: [{ type: "text", text: "old" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "old reply" }],
				stopReason: "stop",
			},
		];
		const events: AgentEvent[] = [];
		const result = await agentLoop({
			...base(),
			messages: history,
			prompt: "new",
			streamFn: createFakeStreamFn(["new reply"]),
			emit: (event) => {
				events.push(event);
			},
		});

		const end = events.find((event) => event.type === "agent_end");
		if (end?.type !== "agent_end") throw new Error("missing agent_end");
		expect(end.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(result).toBe(history);
		expect(result).toHaveLength(4);
	});

	it("waits for user message listeners before calling the model", async () => {
		const gate = deferred();
		const listenerReached = deferred();
		const inner = createFakeStreamFn(["done"]);
		let modelCalls = 0;
		const streamFn: StreamFn = (context, signal) => {
			modelCalls++;
			return inner(context, signal);
		};

		const running = agentLoop({
			...base(),
			prompt: "hi",
			streamFn,
			emit: async (event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "user"
				) {
					listenerReached.resolve();
					await gate.promise;
				}
			},
		});

		await listenerReached.promise;
		expect(modelCalls).toBe(0);
		gate.resolve();
		await running;
		expect(modelCalls).toBe(1);
	});

	it("emits tool execution before its result message and starts the next turn", async () => {
		const events: AgentEvent[] = [];
		await agentLoop({
			...base(),
			prompt: "go",
			tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{
					type: "toolCall",
					id: "c1",
					name: "echo",
					arguments: { text: "hello" },
				}],
				"done",
			]),
			emit: (event) => {
				events.push(event);
			},
		});

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"turn_start",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const turns = events.filter((event) => event.type === "turn_end");
		expect(turns).toHaveLength(2);
		expect(turns[0]).toMatchObject({
			type: "turn_end",
			toolResults: [{ role: "toolResult", toolCallId: "c1" }],
		});
		expect(turns[1]).toMatchObject({
			type: "turn_end",
			toolResults: [],
		});
	});

	describe("agentLoop (stage 5: interception)", () => {
		it("ends after a terminating blocked batch without another model request", async () => {
			const inner = createFakeStreamFn([
				[{
					type: "toolCall",
					id: "c1",
					name: "echo",
					arguments: { text: "blocked" },
				}],
				"must not run",
			]);
			let modelCalls = 0;
			const events: AgentEvent[] = [];

			const messages = await agentLoop({
				...base(),
				prompt: "go",
				tools: [echoTool],
				streamFn: (context, signal) => {
					modelCalls++;
					return inner(context, signal);
				},
				beforeToolCall: () => ({ block: true, terminate: true }),
				emit: (event) => {
					events.push(event);
				},
			});

			expect(modelCalls).toBe(1);
			expect(messages.at(-1)).toMatchObject({
				role: "toolResult",
				isError: true,
			});
			expect(events.at(-1)?.type).toBe("agent_end");
		});
	});

	describe("agentLoop (stage 6: execution mode)", () => {
		it("passes sequential mode to the tool batch", async () => {
			const calls = [
				{ type: "toolCall" as const, id: "c1", name: "slow", arguments: {} },
				{ type: "toolCall" as const, id: "c2", name: "fast", arguments: {} },
			];
			const tools: ToolDef<any>[] = [
				{
					name: "slow",
					description: "slow",
					parameters: { type: "object" },
					execute: async () => {
						await sleep(50);
						return { content: [] };
					},
				},
				{
					name: "fast",
					description: "fast",
					parameters: { type: "object" },
					execute: async () => {
						await sleep(5);
						return { content: [] };
					},
				},
			];
			const endOrder: string[] = [];

			await agentLoop({
				...base(),
				prompt: "go",
				tools,
				toolExecution: "sequential",
				streamFn: createFakeStreamFn([calls, "done"]),
				emit: (event) => {
					if (event.type === "tool_execution_end")
						endOrder.push(event.toolCallId);
				},
			});

			expect(endOrder).toEqual(["c1", "c2"]);
		});
	});
});
