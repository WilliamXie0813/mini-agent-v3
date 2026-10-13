import { describe, it, expect } from "vitest";
import { EventStream, createAssistantMessageEventStream } from "../src/event-stream.ts";
import type { AssistantMessage } from "../src/types.ts";

function textMessage(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

describe("EventStream", () => {
	it("delivers events pushed before anyone consumes, in order", async () => {
		const stream = new EventStream<number, number>((n) => n === 3, (n) => n);
		stream.push(1);
		stream.push(2);
		stream.push(3);
		stream.end(3);
		const seen: number[] = [];
		for await (const n of stream) seen.push(n);
		expect(seen).toEqual([1, 2, 3]);
		expect(await stream.result()).toBe(3);
	});

	it("hands an event directly to a consumer that is already waiting", async () => {
		const stream = new EventStream<number, number>((n) => n === 2, (n) => n);
		const seen: number[] = [];
		const drain = (async () => {
			for await (const n of stream) seen.push(n);
		})();
		await Promise.resolve(); // 让 drain 抵达等待点
		stream.push(1);
		stream.push(2);
		stream.end(2);
		await drain;
		expect(seen).toEqual([1, 2]);
	});

	it("drops events pushed after the stream is done", async () => {
		const stream = new EventStream<number, number>((n) => n === 1, (n) => n);
		stream.push(1);
		stream.push(2);
		stream.end(1);
		const seen: number[] = [];
		for await (const n of stream) seen.push(n);
		expect(seen).toEqual([1]);
	});

	it("ends iteration without a result when end() is called early", async () => {
		const stream = new EventStream<number, number>(() => false, (n) => n);
		stream.push(1);
		stream.end();
		const seen: number[] = [];
		for await (const n of stream) seen.push(n);
		expect(seen).toEqual([1]);
	});
});

describe("AssistantMessageEventStream", () => {
	it("settles an error terminal and ignores subsequent terminals", async () => {
		const stream = createAssistantMessageEventStream();
		const error: AssistantMessage = {
			role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 500",
		};
		stream.push({ type: "error", reason: "error", error });
		stream.push({ type: "done", message: textMessage("too late") });
		stream.end();
		const seen = [];
		for await (const event of stream) seen.push(event.type);
		expect(seen).toEqual(["error"]);
		await expect(stream.result()).resolves.toBe(error);
		expect(error.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("rejects result when ended without any terminal", async () => {
		const stream = createAssistantMessageEventStream();
		stream.end();
		await expect(stream.result()).rejects.toThrow(/completion event/);
	});

	it("stamps durationMs on the done message", async () => {
		const stream = createAssistantMessageEventStream();
		const message = textMessage("hi");
		stream.push({ type: "start", partial: { ...message } });
		await new Promise((resolve) => setTimeout(resolve, 12));
		stream.push({ type: "done", message });
		stream.end(message);
		expect(await stream.result()).toBe(message);
		expect(typeof message.durationMs).toBe("number");
		expect(message.durationMs).toBeGreaterThanOrEqual(5);
	});

	it("keeps a durationMs the message already carries", async () => {
		const stream = createAssistantMessageEventStream();
		const message = { ...textMessage("hi"), durationMs: 7 };
		stream.push({ type: "done", message });
		stream.end(message);
		expect(message.durationMs).toBe(7);
	});
});
