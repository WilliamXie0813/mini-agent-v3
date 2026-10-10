import { describe, it, expect, beforeEach } from "vitest";
import { setDefaultStreamFn, getDefaultStreamFn } from "../src/stream-fn.ts";
import type { StreamFn } from "../src/stream-fn.ts";
import { createAssistantMessageEventStream } from "../src/event-stream.ts";
import type { AssistantMessageEventStream } from "../src/event-stream.ts";

// 空流而不是空生成器：StreamFn 现在返回 AssistantMessageEventStream。
// 这个替身只用来验证插槽存了什么，不需要发任何事件。
function emptyStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.end();
	return stream;
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
