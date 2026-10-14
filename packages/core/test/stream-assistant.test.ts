import { describe, expect, it } from "vitest";
import { createFakeStreamFn, createAssistantMessageEventStream } from "@mini-agent/ai";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ContentBlock,
} from "@mini-agent/ai";
import { streamAssistantMessage } from "../src/stream-assistant.ts";
import type { AgentEvent } from "../src/agent-event.ts";

function streamFor(text: string): AssistantMessageEventStream {
	return createFakeStreamFn([text], { delayMs: 2 })({
		system: { role: "system", sections: [{ text: "test" }] },
		messages: [],
		tools: [],
	});
}

function textOf(message: { content: ContentBlock[] }): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("streamAssistantMessage", () => {
	it("maps every block event and closes an error message exactly once", async () => {
		const stream = createAssistantMessageEventStream();
		const partial: AssistantMessage = { role: "assistant", content: [], stopReason: "pending" };
		stream.push({ type: "start", partial });
		for (const type of ["text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end"] as const) {
			if (type === "text_delta" || type === "toolcall_delta")
				stream.push({ type, partial, contentIndex: 0, delta: "x" });
			else stream.push({ type, partial, contentIndex: 0 });
		}
		const error: AssistantMessage = { role: "assistant", content: [], stopReason: "error" };
		stream.push({ type: "error", reason: "error", error });
		stream.end(error);
		const events: AgentEvent[] = [];
		await expect(streamAssistantMessage(stream, (event) => { events.push(event); })).resolves.toBe(error);
		expect(events.map((event) => event.type)).toEqual([
			"message_start", ...Array(6).fill("message_update"), "message_end",
		]);
	});

	it("maps start, deltas, and done to message lifecycle events", async () => {
		const events: AgentEvent[] = [];
		const message = await streamAssistantMessage(
			streamFor("ab"),
			async (event) => {
				events.push(event);
			},
		);

		expect(events.map((event) => event.type)).toEqual([
			"message_start",
			"message_update",
			"message_update",
			"message_end",
		]);
		const updates = events.filter(
			(event) => event.type === "message_update",
		);
		expect(
			updates.map((event) => event.assistantMessageEvent.type),
		).toEqual(["text_delta", "text_delta"]);
		const lastUpdate = updates.at(-1)!;
		expect(lastUpdate.message.role).toBe("assistant");
		if (lastUpdate.message.role !== "assistant")
			throw new Error("message_update must carry an assistant message");
		expect(textOf(lastUpdate.message)).toBe(textOf(message));
		expect(events.at(-1)).toEqual({ type: "message_end", message });
	});

	it("waits for one message update listener before emitting the next", async () => {
		const gate = deferred();
		const firstUpdate = deferred();
		const updates: AssistantMessage[] = [];

		const consuming = streamAssistantMessage(
			streamFor("ab"),
			async (event) => {
				if (event.type !== "message_update") return;
				updates.push(event.message as AssistantMessage);
				if (updates.length === 1) {
					firstUpdate.resolve();
					await gate.promise;
				}
			},
		);

		await firstUpdate.promise;
		expect(updates).toHaveLength(1);
		gate.resolve();
		await consuming;
		expect(updates).toHaveLength(2);
	});
});
