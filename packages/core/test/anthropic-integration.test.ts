import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicStreamFn } from "@mini-agent/ai";
import { Agent } from "../src/agent.ts";
import type { AgentEvent } from "../src/agent-event.ts";
import type { ToolDef } from "../src/tool.ts";

const fixture = (name: string) => readFile(new URL(`../../ai/fixtures/${name}.sse`, import.meta.url), "utf8");
const sse = (source: string) => new Response(source, { headers: { "content-type": "text/event-stream" } });
afterEach(() => vi.unstubAllGlobals());

describe("real stream protocol through Agent", () => {
	it.each(["mixed", "truncated"])("round trips %s without losing source order or length protection", async (name) => {
		const first = await fixture(name), second = await fixture("text");
		const requests: unknown[] = [];
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return sse(requests.length === 1 ? first : second);
		}));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const executed: string[] = [], ends: string[] = [];
		const tools: ToolDef<{ path: string }>[] = ["slow_read", "fast_read"].map((toolName) => ({
			name: toolName, description: "read", parameters: {
				type: "object", properties: { path: { type: "string" } }, required: ["path"],
			},
			execute: async ({ path }) => {
				executed.push(path);
				if (toolName === "slow_read") await gate;
				return { content: [{ type: "text", text: path }] };
			},
		}));
		const agent = new Agent({ system: "test", tools, streamFn: createAnthropicStreamFn({ apiKey: "test-key" }) });
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end") {
				ends.push(event.toolCallId);
				if (event.toolCallId === "c2") release();
			}
		});
		await agent.prompt("go");
		expect(agent.state.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
		expect(agent.state.messages.slice(2, 4)).toMatchObject([
			{ toolCallId: "c1", isError: name === "truncated" },
			{ toolCallId: "c2", isError: name === "truncated" },
		]);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({
			messages: [{ role: "user" }, { role: "assistant" }, {
				role: "user", content: [
					{ type: "tool_result", tool_use_id: "c1", is_error: name === "truncated" },
					{ type: "tool_result", tool_use_id: "c2", is_error: name === "truncated" },
				],
			}],
		});
		if (name === "mixed") {
			expect(ends).toEqual(["c2", "c1"]);
			expect(executed).toEqual(["a.txt", "b.txt"]);
		} else expect(executed).toEqual([]);
		expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
	});

	it.each(["http", "eof", "abort"])("settles a %s failure with no partial tools", async (kind) => {
		const source = (await fixture("toolcall")).split("event: content_block_stop")[0];
		let body: ReadableStream<Uint8Array> | undefined;
		const fn = createAnthropicStreamFn({ apiKey: "test-key" });
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
			if (kind === "http") return new Response(null, { status: 500 });
			if (kind === "eof") return sse(source);
			body = new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode(source));
					init?.signal?.addEventListener("abort", () => c.error(new DOMException("abort", "AbortError")), { once: true });
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		}));
		const execute = vi.fn();
		const agent = new Agent({ system: "test", streamFn: fn, tools: [
			{ name: "read", description: "read", parameters: { type: "object" }, execute },
		] });
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
			if (kind === "abort" && event.type === "message_update" &&
				event.assistantMessageEvent.type === "toolcall_delta") agent.abort();
		});
		await agent.prompt("go");
		await agent.waitForIdle();
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages.at(-1)).toMatchObject({
			stopReason: kind === "abort" ? "aborted" : "error", content: [],
		});
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
		expect(agent.state.isStreaming).toBe(false);
		if (body) expect(body.locked).toBe(false);
	});

	it("propagates an update listener rejection without a synthetic provider error", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => sse(await fixture("text"))));
		const agent = new Agent({ system: "test", streamFn: createAnthropicStreamFn({ apiKey: "test-key" }) });
		const failure = new Error("delivery failed");
		agent.subscribe((event) => { if (event.type === "message_update") throw failure; });
		await expect(agent.prompt("go")).rejects.toBe(failure);
		expect(agent.state.messages).toHaveLength(1);
		expect(agent.state.isStreaming).toBe(false);
	});
});
