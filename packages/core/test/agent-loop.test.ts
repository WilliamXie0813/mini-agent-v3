import { describe, it, expect, beforeEach } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { setDefaultStreamFn, createFakeStreamFn } from "@mini-agent/ai";
import type { Message, ToolResultMessage } from "@mini-agent/ai";
import type { ToolDef } from "../src/tool.ts";

// 工厂而非共享对象：agentLoop 就地追加 messages（验收要求同一引用），
// 共享数组会让测试间互相污染。
const base = () => ({ messages: [] as Message[], system: "you are a test" });

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

	it("stops at the top of the loop instead of re-asking the model after an abort between turns", async () => {
		const controller = new AbortController();
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
		const messages = await agentLoop({
			...base(), prompt: "go", tools: [echoTool], signal: controller.signal, streamFn,
		});
		expect(modelCalls).toBe(2); // 没有第三次请求
		// history 以配对的 toolResult 收尾：两条 assistant toolCall 都不悬空
		expect(messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "c2" });
	});
});
