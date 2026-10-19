import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import type { Message } from "@mini-agent/ai";
import { describe, expect, it } from "vitest";
import {
	estimateContextTokens,
	findCutPoint,
	shouldCompact,
} from "../src/compaction.ts";
import {
	projectSessionContext,
	streamContextFromSessionPath,
} from "../src/session-context.ts";
import type { SessionEntry, SessionEntryData } from "../src/session-types.ts";

class Element {
	value = "";
	disabled = false;
	hidden = false;
	open = false;
	className = "";
	children: Element[] = [];
	private text = "";
	private attributes = new Map<string, string>();
	private handlers = new Map<string, () => void>();
	get textContent(): string {
		return this.text + this.children.map((child) => child.textContent).join("");
	}
	set textContent(value: string) {
		this.text = value;
		this.children = [];
	}
	addEventListener(type: string, handler: () => void) {
		this.handlers.set(type, handler);
	}
	replaceChildren(...children: Element[]) {
		this.text = "";
		this.children = children;
	}
	setAttribute(name: string, value: string) { this.attributes.set(name, value); }
	getAttribute(name: string) { return this.attributes.get(name); }
	dispatch(type: string) { this.handlers.get(type)?.(); }
	click() { if (!this.disabled) this.dispatch("click"); }
}

type State = {
	entries: SessionEntry[];
	leafId: string | null;
	requestMessages: Message[];
	summaryInput: Message[];
	summaryCalls: number;
	providerCalls: number;
	estimatedTokens: number;
	cut: string | null;
	events: string[];
	error: string;
};
type Step = {
	phase: string;
	question: string;
	added: SessionEntry[];
	after: State;
};
type Scenario = {
	entries: Array<SessionEntryData & { id: string }>;
	steps: unknown[];
};
type Lesson = {
	scenarios: Record<string, Scenario>;
	buildTrace(scenario: unknown): Step[];
};

async function page() {
	const html = await readFile(new URL(
		"../../../docs/stages/10-context-compaction-explained.html",
		import.meta.url,
	), "utf8");
	const elements = new Map<string, Element>();
	for (const [, id] of html.matchAll(/id="([^"]+)"/g))
		elements.set(id!, new Element());
	const get = (id: string) => {
		const result = elements.get(id);
		if (!result) throw new Error(`Missing lesson element: ${id}`);
		return result;
	};
	const context = createContext({
		structuredClone,
		document: { getElementById: get, createElement: () => new Element() },
	});
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
	expect(scripts).toHaveLength(1);
	runInContext(scripts[0]![1]!, context);
	const lesson = runInContext("({ scenarios, buildTrace })", context) as Lesson;
	return {
		get,
		lesson,
		select(name: string) {
			get("scenario").value = name;
			get("scenario").dispatch("change");
		},
	};
}

function pathTo(state: State): SessionEntry[] {
	const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	for (let id = state.leafId; id !== null;) {
		const entry = byId.get(id);
		if (!entry) throw new Error(`Missing entry: ${id}`);
		path.unshift(entry);
		id = entry.parentId;
	}
	return path;
}

describe("Stage 10 beginner compaction lesson", () => {
	it("starts with manual compression and reveals readable history and request cards only after a guess", async () => {
		const { get } = await page();
		expect(get("scenario").value).toBe("manual");
		expect(get("step-answer").hidden).toBe(true);
		get("reveal").click();
		expect(get("step-answer").hidden).toBe(false);
		expect(get("journal-cards").children.length).toBeGreaterThan(0);
		expect(get("request-cards").textContent).toContain("src/total.ts");
		expect(get("history-details").open).toBe(false);
		get("history-details").open = true;
		get("reveal").click();
		expect(get("step-answer").hidden).toBe(true);
		expect(get("reveal").getAttribute("aria-expanded")).toBe("false");
		expect(get("history-details").open).toBe(false);
		get("reveal").click();
		get("history-details").open = true;
		get("next").click();
		expect(get("step-answer").hidden).toBe(true);
		expect(get("history-details").open).toBe(false);
		get("reveal").click();
		get("prev").click();
		expect(get("step-answer").hidden).toBe(true);
		get("jump-end").click();
		expect(get("step-answer").hidden).toBe(true);
		get("reveal").click();
		get("reset").click();
		expect(get("step-answer").hidden).toBe(true);
		get("reveal").click();
		get("timeline").children.at(-1)!.click();
		expect(get("step-answer").hidden).toBe(true);
	});

	it("identifies the exact cards removed and added when the request projection changes", async () => {
		const { get } = await page();
		for (let index = 0; index < 3; index++) get("next").click();
		get("reveal").click();
		expect(get("change-summary").textContent).toContain("不再直接发送：u1、a1、u2");
		expect(get("change-summary").textContent).toContain("新进入请求材料：C1");
		const omitted = get("journal-cards").children.filter((card) =>
			card.textContent.includes("本步不再直接发送"));
		expect(omitted).toHaveLength(3);
		expect(omitted.every((card) => card.className.includes("changed"))).toBe(true);
		expect(get("request-cards").textContent).toContain("本步新进入请求材料");
	});

	it("marks the selected original-text boundary in both columns before any summary request", async () => {
		const { get } = await page();
		get("next").click();
		get("reveal").click();
		for (const id of ["journal-cards", "request-cards"]) {
			const boundary = get(id).children.filter((card) =>
				card.textContent.includes("本步选定保留起点"));
			expect(boundary).toHaveLength(1);
			expect(boundary[0]!.textContent).toContain("a2");
			expect(boundary[0]!.className).toContain("boundary");
		}
		expect(get("status-output").textContent).toContain("摘要请求 0 次");
		get("next").click();
		get("reveal").click();
		expect(get("request-cards").textContent).not.toContain("本步选定保留起点");
		expect(get("request-cards").textContent).toContain("原文保留起点");
	});

	it("shows no-candidate cuts as zero-request, zero-event, zero-write operations", async () => {
		const { lesson } = await page();
		const manual = lesson.scenarios.manual!;
		for (const entries of [
			manual.entries.slice(0, 2),
			manual.entries.filter((entry) => ["a2", "r2", "a3"].includes(entry.id)),
		]) {
			const trace = lesson.buildTrace({ ...manual, entries, steps: [manual.steps[0]] });
			const final = trace.at(-1)!.after;
			expect(findCutPoint(projectSessionContext(pathTo(final)).entries, 2)).toBeUndefined();
			expect(final.cut).toBeNull();
			expect(final.summaryInput).toEqual([]);
			expect(final.entries).toEqual(trace[0]!.after.entries);
			expect(final.events).toEqual([]);
			expect(final.summaryCalls).toBe(0);
			expect(final.providerCalls).toBe(0);
		}
	});

	it("ignores failed assistants when choosing cuts and replays every system/tool update", async () => {
		const { lesson, get, select } = await page();
		const manual = lesson.scenarios.manual!;
		const scenario: Scenario = {
			...manual,
			entries: [
				...manual.entries.slice(0, 2),
				{ id: "system-update", type: "message", message: {
					role: "system", sections: [{ text: "所有金额需验证下限。" }],
					toolsRemoved: ["read"],
				} },
				...manual.entries.slice(2),
				...(["error", "aborted"] as const).map<SessionEntryData & { id: string }>((stopReason) => ({
					id: stopReason, type: "message", message: {
						role: "assistant", content: [{ type: "text", text: "失败诊断" }],
						stopReason, usage: { inputTokens: 9000, outputTokens: 50 },
					},
				})),
			],
			steps: manual.steps.slice(0, 3),
		};
		const trace = lesson.buildTrace(scenario);
		const final = trace.at(-1)!.after;
		const actual = streamContextFromSessionPath(pathTo(final));
		expect(final.cut).toBe("a2");
		expect(final.requestMessages).toEqual(actual.messages);
		expect(final.requestMessages.filter((message) => message.role === "system")).toHaveLength(2);
		expect(actual.tools).toEqual([]);
		expect(final.summaryInput.every((message) => message.role !== "system")).toBe(true);
		expect(final.estimatedTokens).toBe(estimateContextTokens(projectSessionContext(pathTo(final))));
		lesson.scenarios.manual = scenario;
		select("manual");
		get("jump-end").click();
		get("reveal").click();
		expect(get("request-cards").textContent).toContain("新增工具声明：read");
		expect(get("request-cards").textContent).toContain("移除工具声明：read");
	});

	it("keeps task requests separate from summary generation and commits only after a summary exists", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.manual);
		const selected = trace.find((step) => step.phase === "cut");
		expect(selected, "the lesson must show the selected boundary before summarizing").toBeDefined();
		expect(selected!.after.cut).toBe("a2");
		expect(selected!.after.summaryCalls).toBe(0);
		const summarizing = trace.find((step) => step.phase === "summarizing")!;
		expect(summarizing.after.summaryCalls).toBe(1);
		expect(summarizing.after.providerCalls).toBe(0);
		expect(summarizing.added).toEqual([]);
		expect(summarizing.after.events).toEqual(["compaction_start"]);
		const committed = trace.find((step) => step.phase === "committed")!;
		expect(committed.added).toHaveLength(1);
		expect(committed.added[0]?.type).toBe("compaction");
		expect(committed.after.events).toEqual(["compaction_start", "compaction_end:completed"]);
		expect(committed.after.entries.slice(0, -1)).toEqual(trace[0]!.after.entries);
		expect(trace.at(-1)!.after.providerCalls).toBe(1);
	});

	it("uses the same cut and summary input as the implemented assistant-turn algorithm", async () => {
		const { lesson } = await page();
		for (const name of ["manual", "cutpoint", "threshold", "overflow", "recompact"]) {
			const trace = lesson.buildTrace(lesson.scenarios[name]);
			const cuts = trace.filter((candidate) => candidate.phase === "cut");
			expect(cuts.length).toBeGreaterThan(0);
			for (const step of cuts) {
				const actual = findCutPoint(projectSessionContext(pathTo(step.after)).entries, 2);
				expect(step.after.cut).toBe(actual?.firstKeptEntryId);
				expect(step.after.summaryInput).toEqual(actual?.messagesToSummarize);
				expect(step.after.summaryInput.some((message) => message.role === "system")).toBe(false);
			}
		}
	});

	it("preserves all old entries and matches the real request projection at every step", async () => {
		const { lesson } = await page();
		for (const scenario of Object.values(lesson.scenarios)) {
			const trace = lesson.buildTrace(scenario);
			for (const [index, step] of trace.entries()) {
				expect(step.after.requestMessages)
					.toEqual(streamContextFromSessionPath(pathTo(step.after)).messages);
				expect(step.after.estimatedTokens)
					.toBe(estimateContextTokens(projectSessionContext(pathTo(step.after))));
				if (index > 0) {
					const before = trace[index - 1]!.after.entries;
					expect(step.after.entries.slice(0, before.length)).toEqual(before);
				}
			}
		}
	});

	it("keeps the complete tool call and result together and rejects a result-only boundary without a write", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.cutpoint);
		const rejected = trace.find((step) => step.phase === "invalid-cut");
		expect(rejected, "readers must see why cutting at a tool result is invalid").toBeDefined();
		expect(rejected!.added).toEqual([]);
		expect(rejected!.after.error).not.toBe("");
		const final = trace.at(-1)!.after;
		expect(final.cut).toBe("a2");
		expect(final.requestMessages.map((message) => message.role))
			.toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
	});

	it("demonstrates the strict budget boundary through the range control", async () => {
		const { get } = await page();
		for (const tokens of [79, 80, 81]) {
			get("budget-input").value = String(tokens);
			get("budget-input").dispatch("input");
			expect(get("budget-decision").getAttribute("data-compact")).toBe(
				String(shouldCompact(tokens, 100, { enabled: true, reserveTokens: 20, keepRecentTurns: 2 })),
			);
			expect(get("budget-used").textContent).toBe(String(tokens));
		}
	});

	it("checks the request budget before sending the task request", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.threshold);
		const check = trace.find((step) => step.phase === "budget");
		expect(check, "show the equal-to-threshold decision before the new input").toBeDefined();
		expect(estimateContextTokens(projectSessionContext(pathTo(check!.after)))).toBe(800);
		const committed = trace.findIndex((step) => step.phase === "committed");
		const request = trace.findIndex((step) => step.phase === "request");
		expect(committed).toBeGreaterThan(0);
		expect(request).toBeGreaterThan(committed);
		expect(trace[committed]!.after.providerCalls).toBe(0);
	});

	it("keeps overflow diagnostics on disk but excludes them from requests and stops after one retry", async () => {
		const { lesson } = await page();
		const final = lesson.buildTrace(lesson.scenarios.overflow).at(-1)!.after;
		expect(final.providerCalls).toBe(2);
		expect(final.summaryCalls).toBe(1);
		expect(final.entries.filter((entry) => entry.type === "message" &&
			entry.message.role === "assistant" && entry.message.errorKind === "context_overflow"))
			.toHaveLength(2);
		expect(final.requestMessages.some((message) => message.role === "assistant" &&
			message.errorKind === "context_overflow")).toBe(false);
		expect(final.error).not.toBe("");
	});

	it("restores the entire original conversation before compaction and retains the unused branch on disk", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.branch);
		const raw = trace.find((step) => step.phase === "raw-branch");
		expect(raw, "branching before compaction must be visible").toBeDefined();
		expect(raw!.after.leafId).toBe("a3");
		expect(raw!.after.requestMessages.map((message) => message.role))
			.toEqual(["system", "user", "assistant", "user", "assistant", "toolResult", "assistant"]);
		const final = trace.at(-1)!.after;
		expect(final.entries.some((entry) => entry.id === "C1")).toBe(true);
		expect(final.entries.at(-1)?.parentId).toBe("a3");
		expect(pathTo(final).some((entry) => entry.id === "C1")).toBe(false);
	});

	it("includes the previous summary in recompaction and does not claim a repeat command is always a no-op", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.recompact);
		const cuts = trace.filter((step) => step.phase === "cut");
		expect(cuts).toHaveLength(2);
		expect(cuts[0]!.after.summaryInput[0]?.role).toBe("user");
		expect(JSON.stringify(cuts[0]!.after.summaryInput)).toContain("S1");
		expect(JSON.stringify(cuts[0]!.after.summaryInput)).not.toContain("保留现有导出接口");
		const final = trace.at(-1)!.after;
		expect(final.summaryInput).toHaveLength(1);
		expect(JSON.stringify(final.summaryInput)).toContain("S2");
		expect(final.cut).toBe("a3");
		expect(JSON.stringify(final.requestMessages)).not.toContain("S1");
	});

	it("does not save a failed summary or report completed", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.failure);
		expect(trace, "the lesson must include a failed-summary example").toBeDefined();
		const final = trace.at(-1)!.after;
		expect(final.entries).toEqual(trace[0]!.after.entries);
		expect(final.summaryCalls).toBe(1);
		expect(final.providerCalls).toBe(0);
		expect(final.events).toEqual(["compaction_start", "compaction_end:error"]);
		expect(final.error).not.toBe("");
	});

	it("pairs every summary start with exactly one completed or error event", async () => {
		const { lesson } = await page();
		for (const scenario of Object.values(lesson.scenarios)) {
			const trace = lesson.buildTrace(scenario);
			for (const step of trace) {
				let pending = 0;
				for (const event of step.after.events) {
					if (event === "compaction_start") {
						expect(pending).toBe(0);
						pending++;
					} else {
						expect(["compaction_end:completed", "compaction_end:error"]).toContain(event);
						expect(pending).toBe(1);
						pending--;
					}
				}
				expect(pending).toBe(step.phase === "summarizing" ? 1 : 0);
			}
		}
	});

	it("guides every lesson step, resets answers on scene changes, and collapses optional JSON", async () => {
		const { get } = await page();
		for (const name of ["manual", "cutpoint", "threshold", "overflow", "branch", "recompact", "failure"]) {
			expect(get("scenario").value).toBe(name);
			expect(get("step-answer").hidden).toBe(true);
			expect(get("history-details").open).toBe(false);
			for (;;) {
				expect(get("prediction").textContent.trim()).not.toBe("");
				get("reveal").click();
				expect(get("change-summary").textContent.trim()).not.toBe("");
				expect(get("journal-cards").children.length).toBeGreaterThan(0);
				expect(get("request-cards").children.length).toBeGreaterThan(0);
				if (get("next").disabled) break;
				get("next").click();
				expect(get("step-answer").hidden).toBe(true);
			}
			get("history-details").open = true;
			get("next-scenario").click();
		}
		expect(get("next-scenario").disabled).toBe(true);
	});
});
