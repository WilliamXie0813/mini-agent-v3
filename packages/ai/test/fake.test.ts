import { describe, it, expect } from "vitest";
import { createFakeStreamFn } from "../src/fake.ts";
import type { AssistantMessage, AssistantMessageEvent, ContentBlock } from "../src/types.ts";

// round 参数是文档性的：假模型内部按被调用次数索引脚本（见 src/fake.ts），
// 测试不必构造历史，只需按顺序调用。
async function run(fn: ReturnType<typeof createFakeStreamFn>, round = 1) {
	void round;
	const events: AssistantMessageEvent[] = [];
	for await (const e of fn({ system: { role: "system", content: "s" }, messages: [], tools: [] }))
		events.push(e);
	return events;
}

describe("createFakeStreamFn", () => {
	it("yields start then done, in that order", async () => {
		const events = await run(createFakeStreamFn(["hi"]));
		expect(events.map((e) => e.type)).toEqual(["start", "done"]);
	});

	it("returns the script entry matching the conversation round", async () => {
		const fn = createFakeStreamFn(["first", "second"]);
		const r1 = await run(fn, 1);
		const r2 = await run(fn, 2);
		expect((r1.at(-1)!.message as AssistantMessage).content).toEqual([{ type: "text", text: "first" }]);
		expect((r2.at(-1)!.message as AssistantMessage).content).toEqual([{ type: "text", text: "second" }]);
	});

	it("reuses the last script entry once the script is exhausted", async () => {
		const fn = createFakeStreamFn(["only"]);
		const a = await run(fn, 1);
		const b = await run(fn, 5);
		expect((a.at(-1)!.message as AssistantMessage).content[0]).toMatchObject({ text: "only" });
		expect((b.at(-1)!.message as AssistantMessage).content[0]).toMatchObject({ text: "only" });
	});

	it("still produces a complete message when the script entry is an empty string", async () => {
		const events = await run(createFakeStreamFn([""]));
		const done = events.at(-1)!.message as AssistantMessage;
		expect(done.content).toEqual([{ type: "text", text: "" }]);
		expect(done.stopReason).toBe("stop");
	});

	const readCall: ContentBlock = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } };

	it("reports stopReason 'toolUse' when the script entry contains a toolCall block", async () => {
		const events = await run(createFakeStreamFn([[readCall]]));
		const done = events.at(-1)!.message as AssistantMessage;
		expect(done.stopReason).toBe("toolUse");
		expect(done.content).toEqual([readCall]);
	});

	it("reports stopReason 'stop' when the script entry only has text blocks", async () => {
		const events = await run(createFakeStreamFn([[{ type: "text", text: "done" }]]));
		expect((events.at(-1)!.message as AssistantMessage).stopReason).toBe("stop");
	});

	it("keeps a plain string script entry working, normalized to a text block", async () => {
		const events = await run(createFakeStreamFn(["legacy"]));
		expect((events.at(-1)!.message as AssistantMessage).content).toEqual([{ type: "text", text: "legacy" }]);
	});

	it("preserves text-then-toolCall order inside one entry", async () => {
		const events = await run(createFakeStreamFn([[
			{ type: "text", text: "let me look" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
		]]));
		const done = events.at(-1)!.message as AssistantMessage;
		expect(done.content.map((c) => c.type)).toEqual(["text", "toolCall"]);
	});
});
