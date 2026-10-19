import { describe, expect, test, vi } from "vitest";
import {
	consumeAssistantMessage,
	createFakeStreamFn,
	getDefaultStreamFn,
	setDefaultStreamFn,
} from "@mini-agent/ai";
import type { StreamContext, StreamFn } from "@mini-agent/ai";
import { createSecondStreamFn } from "../src/second-stream-fn.ts";

const context: StreamContext = {
	system: { role: "system", sections: [] },
	messages: [],
	tools: [],
};

describe("createSecondStreamFn", () => {
	test("delegates to the wrapped StreamFn and yields the same message", async () => {
		const inner = createFakeStreamFn([{ content: [{ type: "text", text: "from inner" }], stopReason: "stop" }]);
		const streamFn = createSecondStreamFn(inner);
		const message = await consumeAssistantMessage(streamFn(context));
		expect(message.role).toBe("assistant");
		expect(message.content).toEqual([{ type: "text", text: "from inner" }]);
		expect(message.stopReason).toBe("stop");
	});

	test("decorate rewrites the context the inner fn receives", async () => {
		const inner = vi.fn(createFakeStreamFn(["ok"]));
		const streamFn = createSecondStreamFn(inner, {
			decorate: (ctx) => ({ ...ctx, messages: [...ctx.messages, { role: "user", content: [{ type: "text", text: "prepended" }] }] }),
		});
		await consumeAssistantMessage(streamFn(context));
		expect(inner.mock.calls[0]![0].messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "prepended" }] });
	});

	test("decorate may be async", async () => {
		const inner = createFakeStreamFn(["ok"]);
		const seen: string[] = [];
		const streamFn = createSecondStreamFn(inner, {
			decorate: async (ctx) => { seen.push("decorated"); return ctx; },
		});
		await consumeAssistantMessage(streamFn(context));
		expect(seen).toEqual(["decorated"]);
	});

	test("onCall reports the pre-decoration context, duration, and success", async () => {
		const records: { messages: number; ok: boolean; finite: boolean }[] = [];
		const streamFn = createSecondStreamFn(createFakeStreamFn(["ok"]), {
			decorate: (ctx) => ({ ...ctx, messages: [...ctx.messages, { role: "user", content: [] }] }),
			onCall: (record) => records.push({
				messages: record.context.messages.length,
				ok: record.ok,
				finite: Number.isFinite(record.durationMs),
			}),
		});
		await consumeAssistantMessage(streamFn(context));
		expect(records).toEqual([{ messages: 0, ok: true, finite: true }]);
	});

	test("forwards the abort signal to the inner fn", async () => {
		const controller = new AbortController();
		const inner = vi.fn(createFakeStreamFn(["ok"]));
		await consumeAssistantMessage(createSecondStreamFn(inner)(context, controller.signal));
		expect(inner.mock.calls[0]![1]).toBe(controller.signal);
	});

	test("an error message from the inner fn still reports ok:false", async () => {
		const records: boolean[] = [];
		const streamFn = createSecondStreamFn(createFakeStreamFn([{ content: [{ type: "text", text: "boom" }], stopReason: "error" }]), {
			onCall: (record) => records.push(record.ok),
		});
		await consumeAssistantMessage(streamFn(context));
		expect(records).toEqual([false]);
	});

	test("is installable as the default and retrievable through getDefaultStreamFn", () => {
		// 模块级 default-StreamFn 槽是 vitest worker 里所有文件共享的单例：
		// 记下入槽前的状态，断言完在 finally 里还原，不干扰其他测试文件。
		let previous: StreamFn | undefined;
		try {
			previous = getDefaultStreamFn();
		} catch {
			previous = undefined;
		}
		const inner = createFakeStreamFn(["ok"]);
		const streamFn = createSecondStreamFn(inner);
		try {
			setDefaultStreamFn(streamFn);
			expect(getDefaultStreamFn()).toBe(streamFn);
		} finally {
			setDefaultStreamFn(previous);
		}
	});
});
