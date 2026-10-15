import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { setDefaultStreamFn, createFakeStreamFn, createAssistantMessageEventStream, createInitialSystemMessage } from "@mini-agent/ai";
import type { AssistantMessage, Message, StreamContext, StreamFn, Tool, ToolResultMessage } from "@mini-agent/ai";
import type { AgentEvent } from "../src/agent-event.ts";
import type { ToolDef } from "../src/tool.ts";

// 工厂而非共享对象：agentLoop 就地追加 messages（验收要求同一引用），
// 共享数组会让测试间互相污染。阶段 8 起初始 transcript 自带一条 leading system message；
// 用工具的用例必须把声明写进 transcript——重放结果是本轮可见/可执行工具集的唯一权威。
const base = (tools: Tool[] = []) =>
	({ messages: [createInitialSystemMessage("you are a test", tools)!] as Message[] });

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
		expect(messages).toHaveLength(3);
		expect(messages[0]).toMatchObject({ role: "system" });
		expect(messages[1]).toMatchObject({ role: "user" });
		expect(messages[2]).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("wraps the prompt as a single text content block", async () => {
		const messages = await agentLoop({ ...base(), prompt: "ping", streamFn: createFakeStreamFn(["x"]) });
		expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "ping" }] });
	});

	it("falls back to the installed default stream fn", async () => {
		setDefaultStreamFn(createFakeStreamFn(["from slot"]));
		const messages = await agentLoop({ ...base(), prompt: "hi" });
		expect(messages[2]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "from slot" }] });
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
		const initial = base().messages;
		const messages = await agentLoop({ messages: initial, prompt: "hi", signal: AbortSignal.abort(),
			streamFn: createFakeStreamFn(["never"]) });
		// 不是空数组：初始 system transcript 原样保留。
		expect(messages).toEqual(initial);
		expect(messages).toHaveLength(1);
	});

	it("returns without touching history for a whitespace-only prompt", async () => {
		const initial = base().messages;
		const messages = await agentLoop({ messages: initial, prompt: "   ", streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toEqual(initial);
		expect(messages).toHaveLength(1);
	});

	it("still records an assistant message when the model returns empty text", async () => {
		const messages = await agentLoop({ ...base(), prompt: "hi", streamFn: createFakeStreamFn([""]) });
		expect(messages).toHaveLength(3);
		expect(messages[2]).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});

const echoTool: ToolDef<{ text: string }> = {
	name: "echo",
	description: "echo back",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: async (p) => ({ content: [{ type: "text", text: p.text }] }),
};
// echo 的 model-visible 声明：写进 transcript 的 toolsAdded 用。
const echoDecl: Tool = {
	name: echoTool.name,
	description: echoTool.description,
	parameters: echoTool.parameters,
};

describe("agentLoop (stage 2: tool loop)", () => {
	it("runs a full tool round and ends when the model stops asking for tools", async () => {
		const messages = await agentLoop({
			...base([echoDecl]), prompt: "read it", tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{ type: "text", text: "looking" }, { type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } }],
				"I saw hi",
			]),
		});
		expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
	});

	it("keeps the assistant toolCall message and its result adjacent, in call order", async () => {
		const messages = await agentLoop({
			...base([echoDecl]), prompt: "go", tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "first" } },
					{ type: "toolCall", id: "c2", name: "echo", arguments: { text: "second" } }],
				"done",
			]),
		});
		expect(messages[3]).toMatchObject({ role: "toolResult", toolCallId: "c1" });
		expect(messages[4]).toMatchObject({ role: "toolResult", toolCallId: "c2" });
		expect(messages[5]).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("records the intermediate assistant message with stopReason 'toolUse'", async () => {
		const messages = await agentLoop({
			...base([echoDecl]), prompt: "go", tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }], "done",
			]),
		});
		expect(messages[2]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
	});

	it("does not execute anything when stopReason is 'length' and feeds back one error per call", async () => {
		const log: string[] = [];
		const spy: ToolDef<any> = {
			...echoTool,
			execute: async (p: { text: string }) => { log.push("called"); return echoTool.execute(p); },
		};
		const messages = await agentLoop({
			...base([echoDecl]), prompt: "go", tools: [spy],
			streamFn: createFakeStreamFn([
				// length 场景：内容块仍是 toolCall（半截 JSON 被尽力解析出来），但 stopReason 是 length
				{ content: [{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "a" } },
				            { type: "toolCall", id: "c2", name: "echo", arguments: { text: "b" } }],
				  stopReason: "length" },
				"recovered",
			]),
		});
		expect(log).toEqual([]);                                   // 整批不执行
		expect(messages.slice(3, 5).map((m) => (m as ToolResultMessage).isError)).toEqual([true, true]);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" }); // 循环继续并收敛
	});

	it("feeds back an error and lets the model recover from an unknown tool", async () => {
		const messages = await agentLoop({
			...base([echoDecl]), prompt: "go", tools: [echoTool],
			streamFn: createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "nope", arguments: {} }], "sorry, retrying",
			]),
		});
		expect(messages[3]).toMatchObject({ role: "toolResult", toolName: "nope", isError: true });
		expect(messages).toHaveLength(5);
	});

	it("throws a named error when the model keeps calling tools past maxTurns", async () => {
		await expect(agentLoop({
			...base([echoDecl]), prompt: "go", tools: [echoTool], maxTurns: 3,
			streamFn: createFakeStreamFn([[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }]]),
		})).rejects.toThrow(/maxTurns/i);
		await expect(agentLoop({
			...base([echoDecl]), prompt: "go", tools: [echoTool], maxTurns: 3,
			streamFn: createFakeStreamFn([[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }]]),
		})).rejects.toThrow(/echo/); // 错误信息必须带上模型反复调用的工具名，否则无从排查
	});

	it("returns immediately for a whitespace-only prompt without touching history", async () => {
		const initial = base().messages;
		const messages = await agentLoop({ messages: initial, prompt: "  ", tools: [echoTool],
			streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toEqual(initial);
		expect(messages).toHaveLength(1);
	});

	it("returns without touching history when the signal is already aborted", async () => {
		const initial = base().messages;
		const messages = await agentLoop({ messages: initial, prompt: "go", tools: [echoTool], signal: AbortSignal.abort(),
			streamFn: createFakeStreamFn(["never"]) });
		expect(messages).toEqual(initial);
		expect(messages).toHaveLength(1);
	});

	it("settles an aborted provider without re-asking the model", async () => {
		const controller = new AbortController();
		const messages: Message[] = [createInitialSystemMessage("you are a test", [echoDecl])!];
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
		expect(messages).toHaveLength(3);
		expect(messages[2]).toMatchObject({ role: "assistant",
			content: [{ type: "text", text: "forty characters long string, give or take" }] });
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
		const assistant = messages[2];
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
			...base([echoDecl]),
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
				...base([echoDecl]),
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
				...base(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))),
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

describe("agentLoop (stage 8: transcript replay)", () => {
	it("derives the provider context from a fresh replay on every round", async () => {
		const readDecl: Tool = {
			name: "read", description: "read a file", parameters: { type: "object" },
		};
		const echoDecl: Tool = {
			name: "echo", description: "echo back",
			parameters: structuredClone(echoTool.parameters),
		};
		const messages: Message[] = [
			createInitialSystemMessage("base prompt", [readDecl])!,
			{ role: "user", content: [{ type: "text", text: "old" }] },
			{ role: "assistant", content: [{ type: "text", text: "old reply" }], stopReason: "stop" },
			{ role: "system", sections: [{ text: "extra" }], toolsRemoved: ["read"], toolsAdded: [echoDecl] },
		];
		const contexts: StreamContext[] = [];
		const inner = createFakeStreamFn([
			[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }],
			"done",
		]);
		const streamFn: StreamFn = (context, signal) => {
			contexts.push(structuredClone(context));
			return inner(context, signal);
		};

		await agentLoop({ messages, prompt: "go", tools: [echoTool], streamFn });

		expect(contexts).toHaveLength(2);
		// 1. context.system 是累计 snapshot：两条 system entry 的 sections 按序合并，
		//    toolsAdded 只剩重放后的当前声明。
		expect(contexts[0]!.system).toEqual({
			role: "system",
			sections: [{ text: "base prompt" }, { text: "extra" }],
			toolsAdded: [echoDecl],
		});
		// 2. context.tools 是 toolsAdded/toolsRemoved 之后的当前声明（read 已移除）。
		expect(contexts[0]!.tools).toEqual([echoDecl]);
		// 3. context.messages 保留原始多条 system history，供阶段 9 持久化。
		expect(contexts[0]!.messages.filter((m) => m.role === "system")).toEqual([
			messages[0], messages[3],
		]);
		// 4. 第二轮从当时的 transcript 重新派生：snapshot 相同，messages 多了第一轮的产出。
		expect(contexts[1]!.system).toEqual(contexts[0]!.system);
		expect(contexts[1]!.tools).toEqual(contexts[0]!.tools);
		expect(contexts[1]!.messages).toHaveLength(contexts[0]!.messages.length + 2);
	});

	it("neither shows nor executes a tool the transcript removed, even with the closure registered", async () => {
		const execute = vi.fn(echoTool.execute);
		const registry: ToolDef<any>[] = [{ ...echoTool, execute }];
		const echoDecl: Tool = {
			name: "echo", description: "echo back",
			parameters: structuredClone(echoTool.parameters),
		};
		const messages: Message[] = [
			createInitialSystemMessage("base", [echoDecl])!,
			{ role: "system", sections: [], toolsRemoved: ["echo"] },
		];
		const contexts: StreamContext[] = [];
		const inner = createFakeStreamFn([
			[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "x" } }],
			"recovered",
		]);
		const streamFn: StreamFn = (context, signal) => {
			contexts.push(structuredClone(context));
			return inner(context, signal);
		};

		const result = await agentLoop({ messages, prompt: "go", tools: registry, streamFn });

		// provider 看不见已移除的声明，注册表里的闭包也不被执行。
		expect(contexts[0]!.tools).toEqual([]);
		expect(execute).not.toHaveBeenCalled();
		// 走既有 unknown-tool 的 model-fixable 错误路径，而不是偷偷执行旧闭包。
		const toolResult = result.find((m) => m.role === "toolResult");
		expect(toolResult).toMatchObject({ role: "toolResult", isError: true });
		if (toolResult?.role !== "toolResult") throw new Error("missing tool result");
		expect(toolResult.content).toEqual([{
			type: "text", text: expect.stringContaining('Tool "echo" not found'),
		}]);
	});
});

describe("agentLoop (stage 10: prepareRequest)", () => {
	it("prepares the final context immediately before streaming", async () => {
		const calls: string[] = [];
		const contexts: StreamContext[] = [];
		const inner = createFakeStreamFn([
			[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } }],
			"final answer",
		]);
		const streamFn: StreamFn = (context, signal) => {
			calls.push("streamFn");
			contexts.push(structuredClone(context));
			return inner(context, signal);
		};
		const messages = await agentLoop({
			...base([echoDecl]), prompt: "go", tools: [echoTool], streamFn,
			prepareRequest: ({ context }) => {
				calls.push("prepareRequest");
				return {
					...context,
					messages: [
						...context.messages,
						{ role: "user", content: [{ type: "text", text: "prepared" }] },
					],
				};
			},
		});

		// 每个 provider turn 调一次：prepareRequest 先于 streamFn，streamFn 只见替换后 context。
		expect(calls).toEqual([
			"prepareRequest", "streamFn", "prepareRequest", "streamFn",
		]);
		expect(contexts).toHaveLength(2);
		for (const context of contexts) {
			const last = context.messages.at(-1)!;
			expect(last.role === "user" && last.content
				.some((block) => block.type === "text" && block.text === "prepared"))
				.toBe(true);
		}
		// 注入只活在请求 context：transcript 不被 prepared 污染。
		expect(messages.filter((message) =>
			message.role === "user" && message.content
				.some((block) => block.type === "text" && block.text === "prepared")
		)).toHaveLength(0);
		// prepared context 仍声明 echo → 工具正常执行。
		expect(messages.some((message) =>
			message.role === "toolResult" && !message.isError
		)).toBe(true);
	});

	it("only executes tools still declared by the prepared context", async () => {
		const execute = vi.fn(echoTool.execute);
		const messages = await agentLoop({
			...base([echoDecl]), prompt: "go",
			tools: [{ ...echoTool, execute }],
			streamFn: createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } }],
				"stopped",
			]),
			// prepared context 移除了 echo 声明：注册表里闭包还在，也不许执行。
			prepareRequest: ({ context }) => ({ ...context, tools: [] }),
		});
		expect(execute).not.toHaveBeenCalled();
		expect(messages.some((message) =>
			message.role === "toolResult" && message.isError
		)).toBe(true);
	});
});

describe("agentLoop (stage 10: context overflow recovery)", () => {
	const overflowMessage: AssistantMessage = {
		role: "assistant", content: [], stopReason: "error",
		errorKind: "context_overflow", errorMessage: "prompt is too long",
	};

	function terminalStream(message: AssistantMessage) {
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "start",
			partial: { role: "assistant", content: [], stopReason: "pending" },
		});
		if (message.stopReason === "error" || message.stopReason === "aborted")
			stream.push({ type: "error", reason: message.stopReason, error: message });
		else stream.push({ type: "done", message });
		stream.end();
		return stream;
	}

	it("recovers a context overflow exactly once per run", async () => {
		const events: string[] = [];
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			return calls === 1
				? terminalStream(overflowMessage)
				: terminalStream({
						role: "assistant",
						content: [{ type: "text", text: "recovered" }],
						stopReason: "stop",
					});
		};
		const recoverContextOverflow = vi.fn(() => true);
		const messages = await agentLoop({
			...base(), prompt: "go", streamFn, recoverContextOverflow,
			emit: (event) => {
				events.push(event.type);
			},
		});

		expect(calls).toBe(2);
		expect(recoverContextOverflow).toHaveBeenCalledTimes(1);
		// overflow turn 先 turn_end，hook 成功后新 turn_start 再重新请求。
		//（每段 message_start/message_end 对的第一对是 user prompt。）
		expect(events).toEqual([
			"agent_start", "turn_start",
			"message_start", "message_end", "message_start", "message_end",
			"turn_end",
			"turn_start", "message_start", "message_end", "turn_end", "agent_end",
		]);
		expect(messages.at(-1)).toMatchObject({ stopReason: "stop" });
		// overflow 诊断保留在本地 transcript（journal 供审计是 session 层的断言）。
		expect(messages.some((message) =>
			message.role === "assistant" && message.errorKind === "context_overflow"
		)).toBe(true);
	});

	it("does not retry a second overflow in the same run", async () => {
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			return terminalStream(overflowMessage);
		};
		const recoverContextOverflow = vi.fn(() => true);
		const messages = await agentLoop({
			...base(), prompt: "go", streamFn, recoverContextOverflow,
		});
		expect(calls).toBe(2);
		expect(recoverContextOverflow).toHaveBeenCalledTimes(1);
		expect(messages.at(-1)).toMatchObject({
			stopReason: "error", errorKind: "context_overflow",
		});
	});

	it("does not recover a plain provider error or output length", async () => {
		const recoverContextOverflow = vi.fn(() => true);
		// 无 errorKind 的普通 error
		await agentLoop({
			...base(), prompt: "go", recoverContextOverflow,
			streamFn: () => terminalStream({
				role: "assistant", content: [], stopReason: "error",
				errorMessage: "boom",
			}),
		});
		// provider kind
		await agentLoop({
			...base(), prompt: "go", recoverContextOverflow,
			streamFn: () => terminalStream({
				role: "assistant", content: [], stopReason: "error",
				errorKind: "provider", errorMessage: "overloaded",
			}),
		});
		// length：保持阶段 2 的截断整批保护，不触发 overflow 恢复。
		let calls = 0;
		const messages = await agentLoop({
			...base([echoDecl]), prompt: "go", tools: [echoTool], recoverContextOverflow,
			streamFn: () => {
				calls++;
				return calls === 1
					? terminalStream({
							role: "assistant",
							content: [{ type: "toolCall", id: "c1", name: "echo", arguments: {} }],
							stopReason: "length",
						})
					: terminalStream({
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							stopReason: "stop",
						});
			},
		});
		expect(recoverContextOverflow).not.toHaveBeenCalled();
		expect(messages.some((message) =>
			message.role === "toolResult" && message.isError
		)).toBe(true);
		expect(messages.at(-1)).toMatchObject({ stopReason: "stop" });
	});

	it("ends the run when the hook declines or is absent", async () => {
		const events: string[] = [];
		const messages = await agentLoop({
			...base(), prompt: "go",
			streamFn: () => terminalStream(overflowMessage),
			recoverContextOverflow: () => false,
			emit: (event) => {
				events.push(event.type);
			},
		});
		expect(messages.at(-1)).toMatchObject({ stopReason: "error" });
		expect(events).toEqual([
			"agent_start", "turn_start",
			"message_start", "message_end", "message_start", "message_end",
			"turn_end", "agent_end",
		]);
		// 无 hook：overflow 按普通 error 结束。
		const plain = await agentLoop({
			...base(), prompt: "go",
			streamFn: () => terminalStream(overflowMessage),
		});
		expect(plain.at(-1)).toMatchObject({ stopReason: "error" });
	});
});

// 终审修复：recovery hook 必须拿到本次 run 的 signal——否则 abort 穿不进恢复摘要。
describe("agentLoop (stage 10: recovery signal)", () => {
	it("passes the run signal to the recovery hook", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const stream = createAssistantMessageEventStream();
		const streamFn: StreamFn = () => {
			const s = createAssistantMessageEventStream();
			s.push({
				type: "start",
				partial: { role: "assistant", content: [], stopReason: "pending" },
			});
			s.push({
				type: "error", reason: "error",
				error: {
					role: "assistant", content: [], stopReason: "error",
					errorKind: "context_overflow", errorMessage: "prompt is too long",
				},
			});
			s.end();
			return s;
		};
		void stream;
		await agentLoop({
			...base(), prompt: "go", signal: controller.signal, streamFn,
			recoverContextOverflow: (input) => {
				seen = input.signal;
				return false;
			},
		});
		expect(seen).toBe(controller.signal);
	});
});
