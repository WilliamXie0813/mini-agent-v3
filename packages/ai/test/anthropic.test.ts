import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicStreamFn } from "../src/anthropic.ts";
import { AssistantMessageEventStream } from "../src/event-stream.ts";
import type { StreamContext } from "../src/types.ts";

const context: StreamContext = {
	system: { role: "system", content: "test system" },
	messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: [],
};
const key = "TEST_SECRET_KEY";
const fixture = (name: string) => readFile(new URL(`../fixtures/${name}.sse`, import.meta.url), "utf8");
const response = (body: ConstructorParameters<typeof Response>[0]) =>
	new Response(body, { headers: { "content-type": "text/event-stream" } });
async function drain(stream: AssistantMessageEventStream) {
	const events = [];
	for await (const event of stream) events.push(event);
	const message = await stream.result();
	expect(events.filter((e) => e.type === "error" || e.type === "done")).toHaveLength(1);
	return { events, message };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Anthropic HTTP provider", () => {
	it.each(["https://api.kimi.com/coding/", "https://api.kimi.com/coding", "https://api.kimi.com/coding/v1/"])(
		"returns immediately and preserves base prefix for %s", async (baseUrl) => {
			let release!: (value: Response) => void;
			const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
			vi.stubGlobal("fetch", fetcher);
			const signal = new AbortController().signal;
			const stream = createAnthropicStreamFn({ apiKey: key, baseUrl })(context, signal);
			expect(stream).toBeInstanceOf(AssistantMessageEventStream);
			await Promise.resolve();
			expect(fetcher).toHaveBeenCalledTimes(1);
			const [url, init] = fetcher.mock.calls[0];
			if (!init) throw new Error("missing RequestInit");
			expect(String(url)).toBe("https://api.kimi.com/coding/v1/messages");
			expect(init).toMatchObject({ method: "POST", signal });
			expect(init.headers).toMatchObject({
				"content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key,
			});
			expect(JSON.parse(String(init.body))).toEqual({
				model: "kimi-for-coding", max_tokens: 4096, stream: true, system: "test system",
				messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: [],
			});
			release(response(await fixture("text")));
			expect((await drain(stream)).message.stopReason).toBe("stop");
		},
	);

	it.each([
		{ apiKey: "" }, { apiKey: " " }, { apiKey: key, model: "" },
		{ apiKey: key, maxTokens: 0 }, { apiKey: key, maxTokens: -1 }, { apiKey: key, maxTokens: 0.5 },
		{ apiKey: key, baseUrl: "invalid" }, { apiKey: key, baseUrl: "file:///tmp" },
		{ apiKey: key, baseUrl: "https://user:secret@example.com" },
	])("rejects invalid configuration before fetch: %#", (options) => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		expect(() => createAnthropicStreamFn(options)).toThrow(/Anthropic|apiKey|maxTokens|model/i);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([
		["HTTP 401", () => new Response('{"error":{"message":"not authorized"}}', { status: 401 })],
		["HTTP 500", () => new Response("server failed", { status: 500 })],
		["body", () => response(null)],
		["SSE", () => new Response("not SSE")],
		["JSON", () => response("event: message_start\ndata: not-json\n\n")],
		["message_stop", async () => response((await fixture("toolcall")).split("event: message_stop")[0])],
		["overloaded", async () => response(await fixture("error"))],
		["socket lost", () => response(new ReadableStream({ start(c) { c.error(new Error("socket lost")); } }))],
		["encoded data", () => response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(255)); c.close(); } }))],
	] as const)("resolves one error terminal for %s", async (diagnostic, makeResponse) => {
		vi.stubGlobal("fetch", vi.fn(async () => makeResponse()));
		const { events, message } = await drain(createAnthropicStreamFn({ apiKey: key })(context));
		expect(events[0].type).toBe("start");
		expect(message).toMatchObject({
			stopReason: "error", content: [], errorMessage: expect.stringMatching(new RegExp(diagnostic, "i")),
		});
	});

	it("normalizes fetch rejection and conversion failure instead of throwing", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
		const fn = createAnthropicStreamFn({ apiKey: key });
		expect((await drain(fn(context))).message.errorMessage).toMatch(/network down/);
		const invalid: StreamContext = { ...context, messages: [{
			role: "toolResult", toolCallId: "c", toolName: "bad", isError: false,
			content: [{ type: "toolCall", id: "bad", name: "bad", arguments: {} }],
		}] };
		expect((await drain(fn(invalid))).message.errorMessage).toMatch(/tool result/i);
	});

	it("redacts credentials in SSE errors and bounds all diagnostics", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => response(
			`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `${key} ${"x".repeat(2000)}` } })}\n\n`,
		)));
		const { message } = await drain(createAnthropicStreamFn({ apiKey: key })(context));
		expect(message.errorMessage).not.toContain(key);
		expect(message.errorMessage!.length).toBeLessThanOrEqual(1024);
	});

	it("does not fetch for a pre-aborted signal", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		expect((await drain(createAnthropicStreamFn({ apiKey: key })(context, AbortSignal.abort()))).message)
			.toMatchObject({ stopReason: "aborted", content: [] });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("settles when aborted while waiting for HTTP", async () => {
		const controller = new AbortController();
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			entered();
		})));
		const stream = createAnthropicStreamFn({ apiKey: key })(context, controller.signal);
		await ready;
		controller.abort();
		expect((await drain(stream)).message.stopReason).toBe("aborted");
	});

	it.each(["text", "toolcall"])("aborts an open %s response without storing partial content", async (name) => {
		const controller = new AbortController();
		const source = (await fixture(name)).split("event: content_block_stop")[0];
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(source));
				controller.signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")), { once: true });
			},
		});
		vi.stubGlobal("fetch", vi.fn(async () => response(body)));
		const stream = createAnthropicStreamFn({ apiKey: key })(context, controller.signal);
		for await (const event of stream) if (event.type === "text_delta" || event.type === "toolcall_delta") controller.abort();
		await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted", content: [] });
		expect(body.locked).toBe(false);
	});

	it("stops reading at message_stop even when the socket stays open", async () => {
		let cancelled = false;
		const source = await fixture("text");
		const body = new ReadableStream<Uint8Array>({
			start(c) { c.enqueue(new TextEncoder().encode(source)); },
			cancel() { cancelled = true; },
		});
		vi.stubGlobal("fetch", vi.fn(async () => response(body)));
		const controller = new AbortController();
		const stream = createAnthropicStreamFn({ apiKey: key })(context, controller.signal);
		expect((await drain(stream)).message.stopReason).toBe("stop");
		await Promise.resolve();
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		controller.abort();
		expect((await stream.result()).stopReason).toBe("stop");
	});

	it("reports cleanup failure after success without replacing the terminal", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const source = await fixture("text");
		const body = new ReadableStream<Uint8Array>({
			start(c) { c.enqueue(new TextEncoder().encode(source)); },
			cancel() { throw new Error(`cancel failed ${key}`); },
		});
		vi.stubGlobal("fetch", vi.fn(async () => response(body)));
		const stream = createAnthropicStreamFn({ apiKey: key })(context);
		expect((await drain(stream)).message.stopReason).toBe("stop");
		await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Anthropic cleanup: cancel failed [redacted]"));
		expect(body.locked).toBe(false);
	});
});
