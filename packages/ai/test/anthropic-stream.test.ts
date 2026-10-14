import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createAnthropicStreamState } from "../src/anthropic-stream.ts";
import { createAssistantMessageEventStream } from "../src/event-stream.ts";
import { readSse } from "../src/sse.ts";
import type { SseFrame } from "../src/sse.ts";
import type { AssistantMessageEvent } from "../src/types.ts";

async function frames(name: string): Promise<SseFrame[]> {
	const source = await readFile(new URL(`../fixtures/${name}.sse`, import.meta.url));
	const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(source); c.close(); } });
	const result = [];
	for await (const frame of readSse(body)) result.push(frame);
	return result;
}
function frame(value: Record<string, unknown>): SseFrame {
	return { event: String(value.type), data: JSON.stringify(value) };
}
const start = () => frame({
	type: "message_start", message: { role: "assistant", usage: { input_tokens: 10, output_tokens: 0 } },
});
const tool = (index = 0, input: unknown = {}, id = "c1") => frame({
	type: "content_block_start", index, content_block: { type: "tool_use", id, name: "read", input },
});
async function eventsFor(input: SseFrame[]) {
	const stream = createAssistantMessageEventStream();
	const state = createAnthropicStreamState(stream);
	try { for (const entry of input) state.accept(entry); }
	catch (error) { state.fail("error", error instanceof Error ? error.message : String(error)); }
	if (!state.completed) state.fail("error", "Missing message_stop");
	stream.end();
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

describe("Anthropic response state", () => {
	it.each([
		["text", "stop"], ["toolcall", "toolUse"], ["mixed", "toolUse"], ["truncated", "length"],
	] as const)("maps %s fixture to %s", async (name, stopReason) => {
		const { events, message } = await eventsFor(await frames(name));
		expect(message.stopReason).toBe(stopReason);
		expect(message.usage).toEqual({ inputTokens: 35, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 5 });
		expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
		if (name === "text") {
			expect(message.content).toEqual([{ type: "text", text: "你好，文件已读。" }]);
			expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		}
		if (name === "toolcall") expect(message.content).toEqual([
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "package.json" } },
		]);
		if (name === "mixed") {
			expect(message.content).toEqual([
				{ type: "text", text: "先读两个文件。" },
				{ type: "toolCall", id: "c1", name: "slow_read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "c2", name: "fast_read", arguments: { path: "b.txt" } },
			]);
			expect(events.filter((e) => e.type === "toolcall_delta").map((e) => e.contentIndex)).toEqual([1, 1, 2]);
		}
		if (name === "truncated") {
			expect(message.content).toMatchObject([{ id: "c1", arguments: { path: "a.txt" } }, { id: "c2", arguments: {} }]);
			expect(message.errorMessage).toMatch(/truncated/i);
		}
	});

	// 真实联调记录：Kimi 网关在未请求 thinking 时仍主动返回 thinking block
	//（thinking_delta + signature_delta，文本在 index 1）。显式报错，不静默丢弃。
	it("rejects a proactively returned thinking block with an explicit error", async () => {
		const { events, message } = await eventsFor(await frames("thinking"));
		expect(events.filter((e) => e.type === "done")).toHaveLength(0);
		expect(message).toMatchObject({
			stopReason: "error", content: [],
			errorMessage: expect.stringMatching(/unsupported content block 0/),
		});
	});

	it("does not finalize or parse arguments until message_stop", async () => {
		const stream = createAssistantMessageEventStream();
		const state = createAnthropicStreamState(stream);
		const entries = await frames("toolcall");
		for (const entry of entries.slice(0, -1)) state.accept(entry);
		expect(state.completed).toBe(false);
		const iterator = stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		if (first.value?.type !== "start") throw new Error("missing start");
		expect(first.value.partial.stopReason).toBe("pending");
		expect(first.value.partial.content).toMatchObject([{ arguments: {} }]);
		state.accept(entries.at(-1)!);
		expect(state.completed).toBe(true);
		await expect(stream.result()).resolves.toMatchObject({ content: [{ arguments: { path: "package.json" } }] });
		stream.end();
	});

	it("preserves an initial object when there are no JSON deltas", async () => {
		const { message } = await eventsFor([
			start(), tool(0, { path: "initial" }),
			frame({ type: "content_block_stop", index: 0 }),
			frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
			frame({ type: "message_stop" }),
		]);
		expect(message.content).toMatchObject([{ arguments: { path: "initial" } }]);
	});

	it("maps SSE error and makes fail idempotent", async () => {
		const { events, message } = await eventsFor(await frames("error"));
		expect(events.map((e) => e.type)).toEqual(["start", "error"]);
		expect(message).toMatchObject({ stopReason: "error", content: [], errorMessage: expect.stringMatching(/overloaded/i) });
		const stream = createAssistantMessageEventStream();
		const state = createAnthropicStreamState(stream);
		state.fail("aborted", "Operation aborted");
		state.fail("error", "late");
		stream.end();
		await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted" });
	});

	it.each([
		[start(), tool(-1)], [start(), tool(0.5)], [start(), tool(1)],
		[start(), tool(), tool()], [start(), tool(), tool(1, {}, "c1")],
		[start(), tool(0, null)], [start(), tool(0, [])],
		[start(), tool(0, {}, "")],
		[start(), frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "", input: {} } })],
		[start(), frame({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })],
		[start(), frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } })],
		[start(), frame({ type: "message_delta", delta: { stop_reason: "unknown" }, usage: { output_tokens: 1 } })],
		[frame({ type: "message_stop" })],
		[frame({ type: "message_start", message: { usage: { input_tokens: -1, output_tokens: 0 } } })],
		[frame({ type: "message_start", message: { role: "assistant" } })],
		[frame({ type: "message_start", message: { role: "assistant", usage: { input_tokens: -1, output_tokens: 0 } } })],
		[start(), frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: null } })],
		[start(), frame({ type: "message_stop" })],
		[start(), frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }), frame({ type: "message_stop" })],
	].map((entries) => ({ entries })))("turns malformed lifecycle %# into an explicit error", async ({ entries }) => {
		const { message } = await eventsFor(entries);
		expect(message).toMatchObject({ stopReason: "error", content: [], errorMessage: expect.any(String) });
	});

	it.each(["{", "[]", "null"])("rejects complete invalid tool JSON %s", async (json) => {
		const entries = await frames("toolcall");
		const input = entries.filter((f) => !f.data.includes("input_json_delta"));
		input.splice(2, 0, frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json } }));
		expect((await eventsFor(input)).message).toMatchObject({ stopReason: "error", content: [] });
	});

	it("ignores unknown nonsemantic events but rejects a mismatched event name", async () => {
		const input = await frames("text");
		expect((await eventsFor([frame({ type: "ping" }), frame({ type: "future_keepalive" }), ...input])).message.stopReason).toBe("stop");
		expect((await eventsFor([{ event: "message_stop", data: JSON.stringify({ type: "message_start" }) }])).message.stopReason).toBe("error");
	});
});
