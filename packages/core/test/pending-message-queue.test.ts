import { describe, expect, it } from "vitest";
import type { UserMessage } from "@mini-agent/ai";
import { PendingMessageQueue } from "../src/pending-message-queue.ts";

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

const u1 = userMessage("first");
const u2 = userMessage("second");
const u3 = userMessage("third");

describe("PendingMessageQueue", () => {
	it("drains one FIFO message per checkpoint by default", () => {
		const queue = new PendingMessageQueue();
		queue.enqueue(u1);
		queue.enqueue(u2);
		expect(queue.drain()).toEqual([u1]);
		expect(queue.drain()).toEqual([u2]);
		expect(queue.drain()).toEqual([]);
	});

	it("drains the whole FIFO batch when the first entry uses all", () => {
		const queue = new PendingMessageQueue();
		queue.enqueue(u1, "all");
		queue.enqueue(u2);
		queue.enqueue(u3);
		expect(queue.drain()).toEqual([u1, u2, u3]);
		expect(queue.size).toBe(0);
	});

	it("uses the current head mode for mixed batches", () => {
		const queue = new PendingMessageQueue();
		queue.enqueue(u1);
		queue.enqueue(u2, "all");
		queue.enqueue(u3);
		expect(queue.drain()).toEqual([u1]);
		expect(queue.drain()).toEqual([u2, u3]);
	});

	it("clear drops every pending message", () => {
		const queue = new PendingMessageQueue();
		queue.enqueue(u1);
		queue.clear();
		expect(queue.size).toBe(0);
		expect(queue.drain()).toEqual([]);
	});
});
