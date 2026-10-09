import { describe, it, expect, beforeEach } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { setDefaultStreamFn, createFakeStreamFn } from "@mini-agent/ai";
import type { Message } from "@mini-agent/ai";

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
