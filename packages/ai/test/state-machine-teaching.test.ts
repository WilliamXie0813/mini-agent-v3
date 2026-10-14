import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createAnthropicStreamState } from "../src/anthropic-stream.ts";
import { createAssistantMessageEventStream } from "../src/event-stream.ts";
import type { AssistantMessage, AssistantMessageEvent, StopReason } from "../src/types.ts";
import type { SseFrame } from "../src/sse.ts";

type Action = { kind: "frame"; frame: SseFrame } | { kind: "eof" | "abort" };
type Snapshot = {
	partial: AssistantMessage;
	blocks: { open: boolean; json: string; input: Record<string, unknown> }[];
	started: boolean; completed: boolean; stopReason: StopReason;
};
type Trace = {
	before: Snapshot | null; after: Snapshot;
	emitted: AssistantMessageEvent[]; events: AssistantMessageEvent[];
};
type Scenario = { name: string; actions: Action[] };
type Lesson = {
	scenarios: Record<string, Scenario>;
	buildTrace: (scenario: Scenario) => Trace[];
};

class Element {
	textContent = ""; innerHTML = ""; value = ""; disabled = false; className = "";
	children: Element[] = [];
	private handlers = new Map<string, () => void>();
	classList = { toggle: (_name: string, _enabled: boolean) => {} };
	setAttribute(_name: string, _value: string) {}
	addEventListener(type: string, handler: () => void) { this.handlers.set(type, handler); }
	append(...children: Element[]) { this.children.push(...children); }
	replaceChildren(...children: Element[]) { this.children = children; }
	dispatch(type: string) { this.handlers.get(type)?.(); }
	click() { if (!this.disabled) this.dispatch("click"); }
}

async function page() {
	const html = await readFile(new URL("../../../docs/stages/07-anthropic-state-machine-explained.html", import.meta.url), "utf8");
	const elements = new Map<string, Element>();
	for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element());
	const get = (id: string) => {
		const element = elements.get(id);
		if (!element) throw new Error(`missing element ${id}`);
		return element;
	};
	let tick: (() => void) | undefined;
	const context = createContext({
		structuredClone,
		document: {
			getElementById: get, createElement: () => new Element(), addEventListener: () => {},
		},
		setInterval: (fn: () => void) => { tick = fn; return 1; },
		clearInterval: () => { tick = undefined; },
	});
	const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
	expect(scripts.length).toBeGreaterThan(0);
	for (const [, script] of scripts) runInContext(script, context);
	const lesson = runInContext("({ scenarios, buildTrace })", context) as Lesson;
	const select = (key: string) => { get("scenario").value = key; get("scenario").dispatch("change"); };
	return { get, select, lesson, tick: () => tick?.() };
}

describe("state-machine teaching simulation", () => {
	it.each([
		["text", "done", "stop"],
		["tool", "done", "toolUse"],
		["mixed", "done", "toolUse"],
		["length", "done", "length"],
		["eof", "error", "error"],
		["abort", "error", "aborted"],
		["thinking", "error", "error"],
		["badJson", "error", "error"],
	] as const)("shows the actual %s terminal and matches production at every step", async (key, terminalType, reason) => {
		const { lesson } = await page();
		const scenario = lesson.scenarios[key]!;
		const traces = lesson.buildTrace(scenario);
		const stream = createAssistantMessageEventStream();
		const actualEvents: AssistantMessageEvent[] = [];
		const push = stream.push.bind(stream);
		stream.push = (event) => { actualEvents.push(structuredClone(event)); push(event); };
		const state = createAnthropicStreamState(stream);
		expect(traces[0]!.events).toEqual(actualEvents);
		for (const [index, action] of scenario.actions.entries()) {
			try {
				if (action.kind === "frame") state.accept(action.frame);
				else if (!state.completed) state.fail(
					action.kind === "abort" ? "aborted" : "error",
					action.kind === "abort" ? "Operation aborted" : "Anthropic stream ended without message_stop",
				);
			} catch (error) {
				state.fail("error", error instanceof Error ? error.message : String(error));
			}
			expect(traces[index + 1]!.events).toEqual(actualEvents);
			expect(traces[index + 1]!.after.completed).toBe(state.completed);
		}
		const terminals = traces.at(-1)!.events.filter((event) => event.type === "done" || event.type === "error");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]!.type).toBe(terminalType);
		const terminal = terminals[0]!;
		const message = terminal.type === "done" ? terminal.message : terminal.error;
		expect(message.stopReason).toBe(reason);
		if (terminalType === "error") expect(message.content).toEqual([]);
		if (key === "text") expect(message.content[0]).toMatchObject({ type: "text" });
		if (key === "length") expect(message.errorMessage).toMatch(/truncated/i);
		if (key === "thinking") expect(message.errorMessage).toMatch(/unsupported content block/i);
		if (key === "badJson") expect(message.errorMessage).toMatch(/invalid tool JSON/i);
	});

	it("keeps raw tool JSON separate from authoritative arguments until message_stop", async () => {
		const { get } = await page();
		get("next").click(); // message_start
		get("next").click(); // tool block start
		get("next").click(); // first JSON fragment
		const snapshot = () => JSON.parse(get("after").textContent) as Snapshot;
		expect(snapshot().blocks[0]!.json).toBe('{"path":');
		expect(snapshot().partial.content[0]).toMatchObject({ arguments: {} });
		get("next").click(); // second JSON fragment
		get("next").click(); // block_stop
		expect(snapshot().blocks[0]!.open).toBe(false);
		expect(snapshot().blocks[0]!.json).toBe('{"path":"package.json"}');
		expect(snapshot().partial.content[0]).toMatchObject({ arguments: {} });
		expect(get("decision").textContent).toContain("不能");
		get("next").click(); // message_delta
		expect(snapshot().stopReason).toBe("toolUse");
		expect(snapshot().partial.stopReason).toBe("pending");
		expect(snapshot().completed).toBe(false);
		get("next").click(); // message_stop
		expect(snapshot().partial.content[0]).toMatchObject({ arguments: { path: "package.json" } });
		expect(snapshot().completed).toBe(true);
		expect(get("terminal").textContent).toContain('"stopReason": "toolUse"');
		expect(get("decision").textContent).toContain("交给 core");
		expect(get("next").disabled).toBe(true);
		get("prev").click();
		expect(snapshot().completed).toBe(false);
		expect(snapshot().partial.content[0]).toMatchObject({ arguments: {} });
	});

	it("exposes independent per-index buffers and frozen before/after snapshots", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.mixed!);
		const finished = trace.at(-1)!;
		expect(finished.after.blocks).toHaveLength(3);
		expect(finished.after.blocks[1]!.json).toBe('{"path":"a.txt"}');
		expect(finished.after.blocks[2]!.json).toBe('{"path":"b.txt"}');
		expect(trace[0]!.after.partial.content).toEqual([]);
		expect(finished.before!.partial.content.filter((block) => block.type === "toolCall")).toMatchObject([
			{ arguments: {} }, { arguments: {} },
		]);
		expect(finished.after.partial.usage).toEqual({
			inputTokens: 35, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 5,
		});
	});

	it("stops playback on reset, scenario change, timeline navigation, and the last step", async () => {
		const { get, tick, select } = await page();
		get("play").click();
		tick();
		expect(get("step-title").textContent).toContain("message_start");
		get("reset").click();
		tick();
		expect(get("step-title").textContent).toContain("创建");
		get("play").click();
		select("abort");
		tick();
		expect(get("step-title").textContent).toContain("创建");
		get("play").click();
		get("timeline").children[2]!.click();
		tick();
		expect(get("step-title").textContent).toContain("content_block_start");
		get("play").click();
		for (let i = 0; i < 40; i++) tick();
		expect(get("next").disabled).toBe(true);
		expect(get("play").disabled).toBe(true);
		expect(get("terminal").textContent).toContain('"stopReason": "aborted"');
		select("length");
		get("jump-end").click();
		expect(get("decision").textContent).toContain("整批不执行");
		select("eof");
		get("jump-end").click();
		expect(get("terminal").textContent).toContain("without message_stop");
	});
});
