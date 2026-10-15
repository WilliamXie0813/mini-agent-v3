import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Entry = {
	id: string;
	parentId: string | null;
	type: string;
	requestId?: string;
	content?: string;
	isError?: boolean;
};
type Snapshot = {
	entries: Entry[];
	leafId: string | null;
	path: string[];
	transcript: { role: string; content: string; isError?: boolean }[];
	executions: number;
	modelRequests: number;
	error: string;
};
type Trace = { title: string; after: Snapshot };
type Lesson = {
	scenarios: Record<string, unknown>;
	buildTrace: (scenario: unknown) => Trace[];
};

class Element {
	textContent = "";
	value = "";
	disabled = false;
	className = "";
	children: Element[] = [];
	private handlers = new Map<string, () => void>();
	addEventListener(type: string, handler: () => void) {
		this.handlers.set(type, handler);
	}
	replaceChildren(...children: Element[]) { this.children = children; }
	setAttribute(_name: string, _value: string) {}
	dispatch(type: string) { this.handlers.get(type)?.(); }
	click() { if (!this.disabled) this.dispatch("click"); }
}

async function page() {
	const html = await readFile(new URL(
		"../../../docs/stages/09-session-persistence-explained.html",
		import.meta.url,
	), "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	expect(html, "Stage 9 interactive lesson must exist").not.toBe("");
	const elements = new Map<string, Element>();
	for (const [, id] of html.matchAll(/id="([^"]+)"/g))
		elements.set(id, new Element());
	const get = (id: string) => {
		const element = elements.get(id);
		if (!element) throw new Error(`missing element ${id}`);
		return element;
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
		select: (key: string) => {
			get("scenario").value = key;
			get("scenario").dispatch("change");
		},
	};
}

describe("Stage 9 journal and recovery teaching simulator", () => {
	it.each([
		["safe", 2, "read complete", false],
		["unsafe", 1, "partial output\ninterrupted", true],
		["outcome", 1, "durable result", false],
	] as const)("recovers %s with the correct side-effect count and result", async (key, count, content, isError) => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios[key]);
		const final = trace.at(-1)!.after;
		expect(final.executions).toBe(count);
		expect(final.modelRequests).toBe(1);
		expect(final.transcript).toEqual([
			{ role: "system", content: "You are a minimal coding agent." },
			{ role: "user", content: "Run the tool" },
			{ role: "assistant", content: "toolCall" },
			{ role: "toolResult", content, isError },
		]);
		expect(final.entries.at(-1)!.type).toBe("run_end");
	});

	it("branches without deleting old descendants and reopens the latest ancestor path", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.branch);
		const branch = trace.find((step) => step.title === "branch(A)")!;
		const prior = trace[trace.indexOf(branch) - 1]!.after;
		expect(branch.after.entries).toEqual(prior.entries);
		expect(branch.after.leafId).toBe("A");
		const final = trace.at(-1)!.after;
		expect(final.entries.map(({ id }) => id)).toEqual(["A", "B", "C", "D", "E"]);
		expect(final.entries.find(({ id }) => id === "D")!.parentId).toBe("A");
		expect(final.path).toEqual(["A", "D", "E"]);
		expect(final.transcript.map(({ content }) => content)).toEqual([
			"You are a minimal coding agent.", "new branch", "new answer",
		]);
	});

	it("does not execute any prepared tool when a parallel intent commit fails", async () => {
		const { lesson } = await page();
		const final = lesson.buildTrace(lesson.scenarios.barrier).at(-1)!.after;
		expect(final.executions).toBe(0);
		expect(final.entries.filter(({ type }) => type === "tool_intent")).toHaveLength(1);
		expect(final.entries.some(({ type }) => type === "tool_outcome")).toBe(false);
		expect(final.error).toContain("fsync failed");
	});

	it("deduplicates a request after reopening and branching across the whole journal", async () => {
		const { lesson } = await page();
		const final = lesson.buildTrace(lesson.scenarios.dedupe).at(-1)!.after;
		expect(final.modelRequests).toBe(1);
		expect(final.entries.filter(({ type }) => type === "submission")).toHaveLength(1);
		expect(final.leafId).toBe("A");
		expect(final.transcript.map(({ role }) => role)).toEqual(["system"]);
	});

	it("navigates panels and resets scenario state through real event handlers", async () => {
		const { get, select } = await page();
		expect(get("step-title").textContent).toBe("起点");
		expect(get("prev").disabled).toBe(true);
		get("next").click();
		expect(get("journal-output").textContent).toContain('"type": "submission"');
		get("jump-end").click();
		expect(get("execution-output").textContent).toContain('"executeCalls": 2');
		expect(get("next").disabled).toBe(true);
		select("unsafe");
		expect(get("step-title").textContent).toBe("起点");
		get("timeline").children.at(-1)!.click();
		expect(get("transcript-output").textContent).toContain("partial output");
		expect(get("transcript-output").textContent).toContain("interrupted");
		get("prev").click();
		expect(get("next").disabled).toBe(false);
		get("reset").click();
		expect(get("execution-output").textContent).toContain('"executeCalls": 0');
		select("barrier");
		get("jump-end").click();
		expect(get("error-output").textContent).toContain("fsync failed");
		select("branch");
		get("jump-end").click();
		expect(get("path-output").textContent).toContain('A → D → E');
	});
});
