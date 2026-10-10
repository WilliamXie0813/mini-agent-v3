import { describe, it, expect } from "vitest";
import { createFakeStreamFn } from "../src/fake.ts";
import type { StreamFn } from "../src/stream-fn.ts";
import type { AssistantMessage, AssistantMessageEvent, ContentBlock } from "../src/types.ts";

// round 参数是文档性的：假模型内部按被调用次数索引脚本（见 src/fake.ts），
// 测试不必构造历史，只需按顺序调用。
async function run(fn: StreamFn, round = 1): Promise<AssistantMessageEvent[]> {
	void round;
	const events: AssistantMessageEvent[] = [];
	for await (const event of fn({ system: { role: "system", content: "s" }, messages: [], tools: [] })) {
		events.push(event);
	}
	return events;
}

// 收窄到最后一条必须是 done：Task 2 之后事件是联合类型，
// 用 as 断言绕过会让「取错了变体」编译期不报错。
function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
	const last = events.at(-1)!;
	if (last.type !== "done") throw new Error(`expected done, got ${last.type}`);
	return last.message;
}

function textOfPartial(message: AssistantMessage): string {
	return message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}

describe("createFakeStreamFn", () => {
	it("emits start, then deltas, then done, in that order", async () => {
		const events = await run(createFakeStreamFn(["hi"]));
		expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "done"]);
	});

	it("returns the script entry matching the conversation round", async () => {
		const fn = createFakeStreamFn(["first", "second"]);
		const r1 = await run(fn, 1);
		const r2 = await run(fn, 2);
		expect(doneMessage(r1).content).toEqual([{ type: "text", text: "first" }]);
		expect(doneMessage(r2).content).toEqual([{ type: "text", text: "second" }]);
	});

	it("reuses the last script entry once the script is exhausted", async () => {
		const fn = createFakeStreamFn(["only"]);
		const a = await run(fn, 1);
		const b = await run(fn, 5);
		expect(doneMessage(a).content[0]).toMatchObject({ text: "only" });
		expect(doneMessage(b).content[0]).toMatchObject({ text: "only" });
	});

	it("still produces a complete message when the script entry is an empty string", async () => {
		const events = await run(createFakeStreamFn([""]));
		const done = doneMessage(events);
		expect(done.content).toEqual([{ type: "text", text: "" }]);
		expect(done.stopReason).toBe("stop");
	});

	const readCall: ContentBlock = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } };

	it("reports stopReason 'toolUse' when the script entry contains a toolCall block", async () => {
		const events = await run(createFakeStreamFn([[readCall]]));
		const done = doneMessage(events);
		expect(done.stopReason).toBe("toolUse");
		expect(done.content).toEqual([readCall]);
	});

	it("reports stopReason 'stop' when the script entry only has text blocks", async () => {
		const events = await run(createFakeStreamFn([[{ type: "text", text: "done" }]]));
		expect(doneMessage(events).stopReason).toBe("stop");
	});

	it("keeps a plain string script entry working, normalized to a text block", async () => {
		const events = await run(createFakeStreamFn(["legacy"]));
		expect(doneMessage(events).content).toEqual([{ type: "text", text: "legacy" }]);
	});

	it("preserves text-then-toolCall order inside one entry", async () => {
		const events = await run(createFakeStreamFn([[
			{ type: "text", text: "let me look" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
		]]));
		const done = doneMessage(events);
		expect(done.content.map((c) => c.type)).toEqual(["text", "toolCall"]);
	});
});

describe("createFakeStreamFn (stage 3: delta sequence)", () => {
	it("emits start, one delta per character, then done", async () => {
		const events = await run(createFakeStreamFn(["abc"]));
		expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "text_delta", "done"]);
	});

	it("concatenates all deltas into the text of done's message", async () => {
		const events = await run(createFakeStreamFn(["hello world"]));
		const joined = events
			.filter((e) => e.type === "text_delta")
			.map((e) => e.delta)
			.join("");
		expect(joined).toBe("hello world");
		expect(textOfPartial(doneMessage(events))).toBe("hello world");
	});

	it("still emits one empty delta when the script entry is an empty string", async () => {
		const events = await run(createFakeStreamFn([""]));
		expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
		expect(events[1]).toMatchObject({ type: "text_delta", delta: "" });
	});

	it("chunks by the configured size instead of by character", async () => {
		const events = await run(createFakeStreamFn(["abcdef"], { chunkSize: 3 }));
		const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
		expect(deltas).toEqual(["abc", "def"]);
	});

	it("hands a partial that is still live, not a frozen snapshot", async () => {
		const stream = createFakeStreamFn(["abc"], { delayMs: 5 })({
			system: { role: "system", content: "s" }, messages: [], tools: [],
		});
		const seen: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta") seen.push(textOfPartial(event.partial));
		}
		expect(seen).toEqual(["a", "ab", "abc"]);
	});

	it("rejects a nonsensical chunk size instead of looping forever", () => {
		expect(() => createFakeStreamFn(["x"], { chunkSize: 0 })).toThrow(/chunkSize/);
	});
});
