import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Tool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};
type Replay = {
	sections: { tag?: string; text: string }[];
	prompt: string;
	tools: Tool[];
};
type Snapshot = {
	transcript: { role: string }[];
	replay: Replay;
	systemCount: number;
	conversationCount: number;
	requestCount: number;
	cacheStatus: string;
	lastRequest: { system: string; tools: Tool[] } | null;
};
type Trace = {
	title: string;
	before: Snapshot | null;
	after: Snapshot;
	explanation: string;
	decision: string;
};
type Scenario = {
	name: string;
	actions: unknown[];
};
type Lesson = {
	scenarios: Record<string, Scenario>;
	buildTrace: (scenario: Scenario) => Trace[];
	replayTranscript: (transcript: { role: string }[]) => Replay;
};

class Element {
	textContent = "";
	innerHTML = "";
	value = "";
	disabled = false;
	className = "";
	children: Element[] = [];
	style: Record<string, string> = {};
	private handlers = new Map<string, () => void>();
	classList = {
		toggle: (name: string, enabled: boolean) => {
			const values = new Set(this.className.split(/\s+/).filter(Boolean));
			if (enabled) values.add(name);
			else values.delete(name);
			this.className = [...values].join(" ");
		},
	};
	setAttribute(_name: string, _value: string) {}
	addEventListener(type: string, handler: () => void) {
		this.handlers.set(type, handler);
	}
	append(...children: Element[]) {
		this.children.push(...children);
	}
	replaceChildren(...children: Element[]) {
		this.children = children;
	}
	dispatch(type: string) {
		this.handlers.get(type)?.();
	}
	click() {
		if (!this.disabled) this.dispatch("click");
	}
}

async function page() {
	const html = await readFile(
		new URL(
			"../../../docs/stages/08-system-prompt-history-explained.html",
			import.meta.url,
		),
		"utf8",
	).catch(() => "");
	expect(html, "Stage 8 teaching HTML must exist").not.toBe("");

	const elements = new Map<string, Element>();
	for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
		elements.set(id, new Element());
	}
	const get = (id: string) => {
		const element = elements.get(id);
		if (!element) throw new Error(`missing element ${id}`);
		return element;
	};
	let tick: (() => void) | undefined;
	const context = createContext({
		structuredClone,
		document: {
			getElementById: get,
			createElement: () => new Element(),
			addEventListener: () => {},
		},
		setInterval: (fn: () => void) => {
			tick = fn;
			return 1;
		},
		clearInterval: () => {
			tick = undefined;
		},
	});
	const scripts = [
		...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
	];
	expect(scripts.length).toBeGreaterThan(0);
	for (const [, script] of scripts) runInContext(script, context);
	const lesson = runInContext(
		"({ scenarios, buildTrace, replayTranscript })",
		context,
	) as Lesson;
	const select = (key: string) => {
		get("scenario").value = key;
		get("scenario").dispatch("change");
	};
	return { get, lesson, select, tick: () => tick?.() };
}

describe("Stage 8 system history teaching simulator", () => {
	it.each([
		[
			"evolution",
			"You are a minimal coding agent.\n\nWork only inside the current repository.",
			["read", "edit"],
			2,
		],
		[
			"cache",
			"You are a minimal coding agent.",
			["read", "bash"],
			1,
		],
		[
			"trim",
			"You are a minimal coding agent.\n\nPrefer focused diffs.",
			["read", "edit"],
			2,
		],
		[
			"replace",
			"You are a minimal coding agent.",
			["read"],
			2,
		],
	] as const)(
		"replays the hand-derived %s final prompt and tools",
		async (key, prompt, tools, systemCount) => {
			const { lesson } = await page();
			const trace = lesson.buildTrace(lesson.scenarios[key]!);
			const final = trace.at(-1)!.after;
			expect(final.replay.prompt).toBe(prompt);
			expect(final.replay.tools.map((tool) => tool.name)).toEqual(tools);
			expect(final.systemCount).toBe(systemCount);
		},
	);

	it("keeps repeated requests cache-stable without adding system history", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.cache!);
		const requestSteps = trace.filter((step) => step.after.requestCount > 0);
		expect(requestSteps).toHaveLength(2);
		expect(requestSteps[0]!.after.cacheStatus).toContain("MISS");
		expect(requestSteps[1]!.after.cacheStatus).toContain("HIT");
		expect(requestSteps[1]!.after.systemCount).toBe(1);
		expect(requestSteps[1]!.after.lastRequest).toEqual(
			requestSteps[0]!.after.lastRequest,
		);
	});

	it("preserves replayed prompt and tools when old conversation is trimmed", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.trim!);
		const trim = trace.at(-1)!;
		expect(trim.title).toContain("裁剪");
		expect(trim.before!.replay).toEqual(trim.after.replay);
		expect(trim.after.conversationCount).toBeLessThan(
			trim.before!.conversationCount,
		);
		expect(trim.after.systemCount).toBe(trim.before!.systemCount);
	});

	it("treats a changed same-name tool as remove then add", async () => {
		const { lesson } = await page();
		const trace = lesson.buildTrace(lesson.scenarios.replace!);
		const final = trace.at(-1)!.after;
		expect(final.replay.tools).toEqual([
			{
				name: "read",
				description: "Read UTF-8 text with line ranges.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						startLine: { type: "number" },
					},
					required: ["path"],
				},
			},
		]);
	});

	it("drives scenario selection, timeline navigation, playback, and terminal panels", async () => {
		const { get, select, tick } = await page();
		expect(get("step-title").textContent).toContain("起点");
		get("next").click();
		expect(get("prompt-output").textContent).toContain(
			"You are a minimal coding agent.",
		);
		expect(get("tools-output").textContent).toContain('"read"');
		get("jump-end").click();
		expect(get("prompt-output").textContent).toContain(
			"Work only inside the current repository.",
		);
		expect(get("next").disabled).toBe(true);

		select("cache");
		expect(get("step-title").textContent).toContain("起点");
		get("play").click();
		for (let index = 0; index < 10; index++) tick();
		expect(get("cache-output").textContent).toContain("HIT");
		expect(get("play").disabled).toBe(true);

		select("trim");
		get("timeline").children.at(-1)!.click();
		expect(get("decision").textContent).toContain("system entries");
		expect(get("counts-output").textContent).toContain(
			'"conversationMessages": 2',
		);
		get("prev").click();
		expect(get("next").disabled).toBe(false);
		get("reset").click();
		expect(get("step-title").textContent).toContain("起点");
	});
});
