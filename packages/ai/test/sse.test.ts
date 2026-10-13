import { describe, expect, it } from "vitest";
import { readSse } from "../src/sse.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}
async function collect(stream: ReadableStream<Uint8Array>) {
	const frames = [];
	for await (const frame of readSse(stream)) frames.push(frame);
	expect(stream.locked).toBe(false);
	return frames;
}

describe("readSse", () => {
	it("parses identically at every byte boundary", async () => {
		const source = bytes("event: text\r\ndata: 中文\r\n\r\ndata: two\n\n");
		const expected = [{ event: "text", data: "中文" }, { event: "message", data: "two" }];
		for (let index = 0; index <= source.length; index++) {
			expect(await collect(body([source.slice(0, index), source.slice(index)]))).toEqual(expected);
		}
		expect(await collect(body([...source].map((byte) => Uint8Array.of(byte))))).toEqual(expected);
	});

	it("handles comments, CR lines, multiple data fields and unfinished EOF", async () => {
		expect(await collect(body([bytes(
			": heartbeat\r\rid: 7\rretry: 10\rdata: a\rdata:  b\r\rdata: lost",
		)]))).toEqual([{ event: "message", data: "a\n b" }]);
		expect(await collect(body([bytes("data: no blank line\n")]))).toEqual([]);
		expect(await collect(body([bytes("event: ignored\n\n")]))).toEqual([]);
	});

	it("cancels an open reader on early break", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(bytes("data: one\n\n")); },
			cancel() { cancelled = true; },
		});
		for await (const frame of readSse(stream)) {
			expect(frame.data).toBe("one");
			break;
		}
		expect(cancelled).toBe(true);
		expect(stream.locked).toBe(false);
	});

	it("releases an errored reader and propagates its original failure", async () => {
		const error = new Error("socket lost");
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(error); } });
		await expect(collect(stream)).rejects.toBe(error);
		expect(stream.locked).toBe(false);
	});

	it("surfaces cancellation failure without leaving the stream locked", async () => {
		const error = new Error("cancel failed");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(bytes("data: one\n\n")); },
			cancel() { throw error; },
		});
		const drain = async () => { for await (const _ of readSse(stream)) break; };
		await expect(drain()).rejects.toBe(error);
		expect(stream.locked).toBe(false);
	});

	it("preserves decoding failure when cancellation also fails", async () => {
		const cleanup = new Error("cancel failed");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(Uint8Array.of(255)); },
			cancel() { throw cleanup; },
		});
		await expect(collect(stream)).rejects.toMatchObject({ name: "TypeError", cause: cleanup });
		expect(stream.locked).toBe(false);
	});

	it("rejects incomplete UTF-8 at EOF", async () => {
		await expect(collect(body([Uint8Array.of(0xe4)]))).rejects.toThrow();
	});
});
