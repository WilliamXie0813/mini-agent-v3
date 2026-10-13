import { setTimeout } from "node:timers/promises";
import { describe, it, expect, beforeEach } from "vitest";
import {
	consumeAssistantMessage,
	getDefaultStreamFn,
	setDefaultStreamFn,
} from "../src/stream-fn.ts";
import type { StreamFn } from "../src/stream-fn.ts";
import { createAssistantMessageEventStream } from "../src/event-stream.ts";
import type { AssistantMessageEventStream } from "../src/event-stream.ts";
import type { AssistantMessage } from "../src/types.ts";

// 空流而不是空生成器：StreamFn 现在返回 AssistantMessageEventStream。
// 这个替身只用来验证插槽存了什么，不需要发任何事件。
function emptyStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.end();
	return stream;
}

function textMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

function pendingMessage(text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "pending",
	};
}

describe("stream-fn slot", () => {
	beforeEach(() => setDefaultStreamFn(undefined));

	it("throws a named error when no implementation is installed", () => {
		expect(() => getDefaultStreamFn()).toThrow(/no default stream fn/i);
	});

	it("returns the installed implementation", () => {
		const fn: StreamFn = emptyStream;
		setDefaultStreamFn(fn);
		expect(getDefaultStreamFn()).toBe(fn);
	});

	it("can be cleared back to the uninstalled state", () => {
		setDefaultStreamFn(emptyStream);
		setDefaultStreamFn(undefined);
		expect(() => getDefaultStreamFn()).toThrow(/no default stream fn/i);
	});
});

describe("consumeAssistantMessage", () => {
	it("returns the error terminal as the authoritative message", async () => {
		const stream = createAssistantMessageEventStream();
		const error: AssistantMessage = {
			role: "assistant", content: [], stopReason: "aborted", errorMessage: "Operation aborted",
		};
		stream.push({ type: "start", partial: pendingMessage() });
		stream.push({ type: "error", reason: "aborted", error });
		stream.end(error);
		await expect(consumeAssistantMessage(stream)).resolves.toBe(error);
	});

	it("awaits each event handler before consuming the next event", async () => {
		let active = 0;
		let maxActive = 0;
		const seen: string[] = [];

		const message = textMessage("a");
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: pendingMessage() });
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "a",
			partial: pendingMessage("a"),
		});
		stream.push({ type: "done", message });
		stream.end(message);

		await expect(
			consumeAssistantMessage(stream, async (event) => {
				active++;
				maxActive = Math.max(maxActive, active);
				seen.push(event.type);
				await setTimeout(2);
				active--;
			}),
		).resolves.toBe(message);

		expect(seen).toEqual(["start", "text_delta", "done"]);
		expect(maxActive).toBe(1);
		expect(active).toBe(0);
	});
});
