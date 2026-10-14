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
		expect(agent.state.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "toolResult", "assistant"]);
		expect(agent.state.messages.slice(3, 5)).toMatchObject([
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
		expect(agent.state.messages).toHaveLength(3);
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
		expect(agent.state.messages).toHaveLength(2); // system + 已交付的 user
		expect(agent.state.isStreaming).toBe(false);
	});

	it("can prompt again after aborting a sequential tool batch", async () => {
		const first = await fixture("mixed"), second = await fixture("text");
		const requests: unknown[] = [];
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return sse(requests.length === 1 ? first : second);
		}));
		const executed: string[] = [];
		const tools: ToolDef<{ path: string }>[] = ["slow_read", "fast_read"].map((name) => ({
			name, description: "read", parameters: { type: "object" },
			execute: async ({ path }) => {
				executed.push(path);
				return { content: [{ type: "text", text: path }] };
			},
		}));
		const agent = new Agent({
			system: "test", tools, toolExecution: "sequential",
			streamFn: createAnthropicStreamFn({ apiKey: "test-key" }),
		});
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolCallId === "c1") agent.abort();
		});
		await agent.prompt("go");
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results).toMatchObject([{ toolCallId: "c1", isError: false }]);
		expect(executed).toEqual(["a.txt"]);
		await agent.prompt("second");
		expect(requests[1]).toMatchObject({
			messages: [{ role: "user" }, { role: "assistant" }, {
				role: "user", content: [
					{ type: "tool_result", tool_use_id: "c1", is_error: false },
					{ type: "tool_result", tool_use_id: "c2", is_error: true },
					{ type: "text", text: "second" },
				],
			}],
		});
		expect(agent.state.messages.filter((m) => m.role === "toolResult")).toEqual(results);
		expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
	});

	it("releases an open response after a listener rejects without changing the rejection", async () => {
		const source = (await fixture("text")).split("event: message_stop")[0];
		let body!: ReadableStream<Uint8Array>;
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let signal: AbortSignal | null | undefined;
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
			signal = init?.signal;
			body = new ReadableStream({
				start(c) {
					controller = c;
					c.enqueue(new TextEncoder().encode(source));
					signal?.addEventListener("abort", () => c.error(new DOMException("abort", "AbortError")), { once: true });
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		}));
		const agent = new Agent({ system: "test", streamFn: createAnthropicStreamFn({ apiKey: "test-key" }) });
		const failure = new Error("delivery failed");
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "message_update") throw failure;
		});
		try {
			await expect(agent.prompt("go")).rejects.toBe(failure);
			await agent.waitForIdle();
			await vi.waitFor(() => expect(body.locked).toBe(false), { timeout: 500 });
			expect(events.some((event) => event.type === "agent_end")).toBe(false);
			expect(agent.state.messages).toHaveLength(2); // system + 已交付的 user
			expect(agent.state.isStreaming).toBe(false);
		} finally {
			if (!signal?.aborted) controller.close();
		}
	});
});
