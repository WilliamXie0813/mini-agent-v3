import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import {
	createFakeStreamFn,
	getDefaultStreamFn,
	setDefaultStreamFn,
} from "@mini-agent/ai";
import type { Message, StreamFn } from "@mini-agent/ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { AgentSession } from "../src/agent-session.ts";
import {
	bootstrapExtensions,
	createDemoExtension,
	createSecondStreamFn,
	ExtensionRunner,
} from "../../extensions/src/index.ts";
import type { Extension, ExtensionAPI } from "../../extensions/src/types.ts";

class Element {
	textContent = "";
	value = "";
	disabled = false;
	hidden = false;
	open = false;
	className = "";
	children: Element[] = [];
	attributes = new Map<string, string>();
	private handlers = new Map<string, () => void>();
	addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler); }
	setAttribute(name: string, value: string) { this.attributes.set(name, value); }
	replaceChildren(...children: Element[]) { this.children = children; }
	dispatch(event: string) { this.handlers.get(event)?.(); }
	click() { if (!this.disabled) this.dispatch("click"); }
}

type Snapshot = {
	mode: string;
	tools: string[];
	virtualExecutions: number;
	actualModelRequests: number;
	actualToolExecutions: number;
	handlersVisited: string[];
	errorResult: boolean;
	requestOrder: string[];
	historyCards: string[];
	requestCards: string[];
	failure: string;
	resultText: string;
	resultIsError: boolean;
	nextSections: string[];
	turns: number;
	provider: string;
	oldSessionProvider: string;
	explicitProvider: string;
	coreEdits: number;
};

async function page() {
	const html = await readFile(new URL(
		"../../../docs/stages/11-extension-system-explained.html", import.meta.url,
	), "utf8");
	const elements = new Map<string, Element>();
	for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element());
	const get = (id: string) => {
		const element = elements.get(id);
		if (!element) throw new Error(`Missing lesson element: ${id}`);
		return element;
	};
	// No network, process, filesystem or import capabilities are given to the page.
	const context = createContext({
		document: { getElementById: get, createElement: () => new Element() },
	});
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
	expect(scripts).toHaveLength(1);
	runInContext(scripts[0]![1]!, context);
	return {
		html,
		get,
		select: (id: string) => {
			get("lesson").value = id;
			get("lesson").dispatch("change");
		},
		snapshot: () => JSON.parse(get("snapshot-output").textContent) as Snapshot,
	};
}

function finish(get: (id: string) => Element) {
	for (let index = 0; index < 3; index++) {
		get("reveal").click();
		if (index < 2) get("next").click();
	}
}

function tool(name: string, execute = async () => ({ content: [{ type: "text" as const, text: "ok" }] })) {
	return {
		name, description: name, parameters: { type: "object", properties: {} },
		replay: "safe" as const, execute,
	};
}
function call(name: string) {
	return [{ type: "toolCall" as const, id: "c1", name, arguments: {} }];
}
function extension(name: string, factory: (api: ExtensionAPI) => void): Extension {
	return { name, factory };
}
async function withDirectory(run: (directory: string) => Promise<void>) {
	const directory = join(process.cwd(), `.stage11-teaching-${randomUUID()}`);
	try { await run(directory); }
	finally { await rm(directory, { recursive: true, force: true }); }
}

describe("Stage 11 offline lesson, checked against implemented extension behavior", () => {
	// The runnable 05-section example now lives as a real, independently tested file:
	// packages/examples/src/stage11-cart.ts (packages/examples/test/stage11-cart.test.ts
	// checks it matches this page's <pre id="runnable-example"> block byte-for-byte and
	// that running it behaves as documented).

	it("gates progression on reveal and clears answers on navigation and reset", async () => {
		const { get, select } = await page();
		expect(get("answer").hidden).toBe(true);
		expect(get("next").disabled).toBe(true);
		expect(get("prev").disabled).toBe(true);
		expect(get("snapshot-output").textContent).toBe("");
		get("timeline").children[2]!.click();
		get("next").click();
		expect(get("position").textContent).toBe("1 / 3");
		get("reveal").click();
		expect(get("answer").hidden).toBe(false);
		expect(get("cards").children.length).toBeGreaterThan(0);
		expect(get("reveal").attributes.get("aria-expanded")).toBe("true");
		get("next").click();
		get("reveal").click();
		for (const navigate of [
			() => get("prev").click(),
			() => get("timeline").children[0]!.click(),
			() => get("reset").click(),
			() => select("permission"),
		]) {
			get("advanced").open = true;
			navigate();
			expect(get("answer").hidden).toBe(true);
			expect(get("advanced").open).toBe(false);
			expect(get("cards").children).toEqual([]);
			expect(get("snapshot-output").textContent).toBe("");
			expect(get("reveal").attributes.get("aria-expanded")).toBe("false");
			get("reveal").click();
		}
		get("reset").click();
		expect(get("timeline").children[1]!.disabled).toBe(true);
	});

	it("models real registration, tool coexistence and the explicit duplicate-name rejection", async () => {
		const { get, select, snapshot } = await page();
		finish(get);
		expect(snapshot().coreEdits).toBe(3);
		select("inline");
		finish(get);
		let executions = 0;
		const lint = tool("lint_cart", async () => {
			executions++;
			return { content: [{ type: "text", text: "ok" }] };
		});
		const boot = await bootstrapExtensions({
			extensions: [extension("cart", (api) => api.registerTool(lint))],
		});
		const combined = boot.tools([tool("read"), tool("edit"), tool("bash")]);
		const agent = new Agent({
			system: "s", tools: combined, ...boot.hooks,
			streamFn: createFakeStreamFn([call("lint_cart"), "done"]),
		});
		await agent.prompt("给 src/cart.ts 加优惠券折扣");
		expect(snapshot().tools).toEqual(combined.map(({ name }) => name));
		expect(snapshot().virtualExecutions).toBe(executions);
		expect(snapshot().coreEdits).toBe(0);
		expect(() => boot.tools([tool("lint_cart")])).toThrow('duplicate tool name: "lint_cart"');
		expect(() => boot.runner.registerTool(lint)).toThrow('duplicate tool name: "lint_cart"');
		expect(get("cards").children.map((card) => card.textContent).join(" ")).toContain("lint_cart");
	});

	it("matches the first-defined short circuit: undefined falls through; even {} stops later guards", async () => {
		const { get, select, snapshot } = await page();
		select("permission");
		get("reveal").click();
		get("next").click();
		get("reveal").click();
		let executions = 0;
		const visited: string[] = [];
		const runner = new ExtensionRunner({ log: () => {} });
		await runner.use(extension("first", (api) => {
			api.on("tool_call", () => { visited.push("A"); return undefined; });
			api.on("tool_call", () => { visited.push("B"); return { block: true, reason: "bash disabled" }; });
			api.on("tool_call", () => { visited.push("C"); return undefined; });
		}));
		const agent = new Agent({
			system: "s", ...runner.sessionHooks(), tools: [tool("bash", async () => {
				executions++;
				return { content: [] };
			})],
			streamFn: createFakeStreamFn([call("bash"), "done"]),
		});
		await agent.prompt("go");
		expect(snapshot().handlersVisited).toEqual(visited);
		expect(snapshot().virtualExecutions).toBe(executions);
		expect(snapshot().errorResult).toBe(agent.state.messages.some((m) => m.role === "toolResult" && m.isError));
		get("next").click();
		get("reveal").click();
		const allowedVisits: string[] = [];
		const allow = new ExtensionRunner();
		await allow.use(extension("allow-first", (api) => {
			api.on("tool_call", () => { allowedVisits.push("A"); return {}; });
			api.on("tool_call", () => { allowedVisits.push("B"); return { block: true }; });
		}));
		const allowed = new Agent({
			system: "s", ...allow.sessionHooks(), tools: [tool("lint_cart", async () => {
				executions++;
				return { content: [] };
			})],
			streamFn: createFakeStreamFn([call("lint_cart"), "done"]),
		});
		await allowed.prompt("go");
		expect(snapshot().handlersVisited).toEqual(allowedVisits);
		expect(snapshot().virtualExecutions).toBe(executions);
		expect(snapshot().errorResult).toBe(false);
	});

	it("matches prepareRequest before pruning, reference-preserving filters, and fabricated-object rejection", async () => {
		const { get, select, snapshot } = await page();
		select("context");
		get("reveal").click();
		const history: Message[] = [
			{ role: "user", content: [{ type: "text", text: "给 src/cart.ts 加优惠券折扣" }] },
			{ role: "assistant", content: call("read"), stopReason: "toolUse" },
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "same cart" }], isError: false },
			{ role: "assistant", content: [{ ...call("read")[0]!, id: "c2" }], stopReason: "toolUse" },
		];
		// Use two complete read groups, not a fabricated provider message protocol.
		history.push({
			role: "toolResult", toolCallId: "c2", toolName: "read",
			content: [{ type: "text", text: "same cart" }], isError: false,
		});
		const before = structuredClone(history);
		const requestOrder: string[] = [];
		const seen: Message[][] = [];
		const base = createFakeStreamFn(["done"]);
		const runner = new ExtensionRunner({ log: () => {} });
		await runner.use(extension("cart", (api) => {
			api.on("before_provider_request", ({ context }) => { requestOrder.push("before_provider_request"); return context; });
			api.on("context", (messages: readonly Message[]) => {
				requestOrder.push("context");
				return messages.filter((m) =>
					!(m.role === "assistant" && m.content.some((block) => block.type === "toolCall" && block.id === "c1")) &&
					!(m.role === "toolResult" && m.toolCallId === "c1"));
			});
		}));
		const agent = new Agent({
			system: "s", messages: history, ...runner.sessionHooks(),
			streamFn: (context, signal) => {
				requestOrder.push("streamFn");
				seen.push(context.messages);
				return base(context, signal);
			},
		});
		await agent.prompt("继续");
		get("next").click();
		get("reveal").click();
		expect(snapshot().requestOrder).toEqual(requestOrder);
		expect(history).toEqual(before);
		expect(agent.state.messages.some((m) => m.role === "toolResult" && m.toolCallId === "c1")).toBe(true);
		expect(seen[0]!.some((m) => m.role === "toolResult" && m.toolCallId === "c1")).toBe(false);
		expect(snapshot().historyCards).toHaveLength(4);
		expect(snapshot().requestCards).toEqual(["任务", "read#2 调用+结果", "lint_cart 检查结果"]);
		get("next").click();
		get("reveal").click();
		let modelCalls = 0;
		const bad = new Agent({
			system: "s",
			streamFn: (context, signal) => { modelCalls++; return base(context, signal); },
			transformContext: (messages) => messages.map((m) => ({ ...m })),
		});
		await expect(bad.prompt("go")).rejects.toThrow("transformContext must only filter or reorder the messages it received");
		expect(modelCalls).toBe(0);
		expect(snapshot().failure).toBe("TypeError");
	});

	it("matches result merging without falsely saying each handler sees the previous override", async () => {
		const { get, select, snapshot } = await page();
		select("result");
		finish(get);
		const inputs: string[] = [];
		const runner = new ExtensionRunner();
		await runner.use(extension("results", (api) => {
			api.on("tool_result", (event) => {
				inputs.push(event.result.content[0]?.type === "text" ? event.result.content[0].text : "");
				return { content: [{ type: "text", text: "coupon checked" }] };
			});
			api.on("tool_result", (event) => {
				inputs.push(event.result.content[0]?.type === "text" ? event.result.content[0].text : "");
				return { isError: true };
			});
		}));
		const agent = new Agent({
			system: "s", ...runner.sessionHooks(), tools: [tool("lint_cart")],
			streamFn: createFakeStreamFn([call("lint_cart"), "done"]),
		});
		let eventContent: unknown;
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end") eventContent = event.result;
		});
		await agent.prompt("go");
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(inputs).toEqual(["ok", "ok"]);
		expect(snapshot().resultText).toBe(result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "");
		expect(snapshot().resultIsError).toBe(result?.role === "toolResult" && result.isError);
		expect(eventContent).toMatchObject({ content: [{ type: "text", text: "coupon checked" }], isError: true });
	});

	it("matches turn continuation, registered-order next-turn merges, durable system history and reopening", async () => {
		const { get, select, snapshot } = await page();
		select("turns");
		finish(get);
		await withDirectory(async (directory) => {
			const boot = await bootstrapExtensions({
				extensions: [
					extension("A", (api) => {
						api.on("turn_end", ({ turn }) => ({ action: turn === 0 ? "continue" : "end" }));
						api.on("next_turn", () => ({ sections: [{ text: "coupon checked" }], toolsRemoved: ["bash"] }));
					}),
					extension("B", (api) => {
						api.on("next_turn", () => ({ sections: [{ text: "report discount" }], toolsRemoved: ["bash"] }));
					}),
				],
			});
			let calls = 0;
			const base = createFakeStreamFn(["first", "second"]);
			const session = await AgentSession.create({
				directory, system: "s", tools: [tool("bash")], hooks: boot.hooks, maxTurns: 2,
				streamFn: (context, signal) => { calls++; return base(context, signal); },
			});
			await session.submit({ requestId: "r1", prompt: "go" });
			const added = session.entries.filter((entry) => entry.type === "message" && entry.message.role === "system").at(-1);
			expect(added?.type === "message" && added.message).toMatchObject({
				role: "system", sections: [{ text: "coupon checked" }, { text: "report discount" }], toolsRemoved: ["bash"],
			});
			expect(snapshot().nextSections).toEqual(["coupon checked", "report discount"]);
			expect(snapshot().turns).toBe(calls);
			const reopened = await AgentSession.open({
				path: session.filePath, system: "s", hooks: boot.hooks, tools: [tool("bash")],
				streamFn: createFakeStreamFn(["unused"]),
			});
			expect(reopened.state.messages).toEqual(session.state.messages);
		});
	});

	it("distinguishes installed wrappers, explicit StreamFn precedence and existing Agent capture", async () => {
		const { get, select, snapshot } = await page();
		select("provider");
		finish(get);
		let previous: StreamFn | undefined;
		try { previous = getDefaultStreamFn(); } catch { previous = undefined; }
		try {
			const calls: string[] = [];
			const base = createFakeStreamFn(["ok"]);
			setDefaultStreamFn((context, signal) => { calls.push("base"); return base(context, signal); });
			const oldAgent = new Agent({ system: "s" });
			const boot = await bootstrapExtensions({ extensions: [] });
			boot.installStreamFn();
			const wrapped = getDefaultStreamFn();
			const recorded: boolean[] = [];
			setDefaultStreamFn(createSecondStreamFn(wrapped, { onCall: (record) => recorded.push(record.ok) }));
			const newer = new Agent({ system: "s" });
			const explicit = new Agent({
				system: "s",
				streamFn: (context, signal) => { calls.push("explicit"); return base(context, signal); },
			});
			await oldAgent.prompt("old");
			expect(recorded).toEqual([]);
			await newer.prompt("new");
			expect(recorded).toEqual([true]);
			await explicit.prompt("explicit");
			expect(recorded).toEqual([true]);
			expect(calls).toEqual(["base", "base", "explicit"]);
			expect(snapshot().provider).toBe("wrapper → base");
			expect(snapshot().oldSessionProvider).toBe("base");
			expect(snapshot().explicitProvider).toBe("explicit");
		} finally { setDefaultStreamFn(previous); }
	});

	it("matches guard failure, isolated observer failure and propagated decision failure", async () => {
		const { get, select, snapshot } = await page();
		select("failure");
		const logs: string[] = [];
		let executions = 0;
		const runner = new ExtensionRunner({ log: (message) => logs.push(message) });
		await runner.use(extension("broken", (api) => {
			api.on("tool_call", () => { throw new Error("rule offline"); });
			api.on("message_end", () => { throw new Error("renderer offline"); });
		}));
		const guarded = new Agent({
			system: "s", ...runner.sessionHooks(), tools: [tool("lint_cart", async () => {
				executions++;
				return { content: [] };
			})],
			streamFn: createFakeStreamFn([call("lint_cart"), "done"]),
		});
		guarded.subscribe((event) => runner.notify(event));
		await guarded.prompt("go");
		get("reveal").click();
		expect(snapshot().virtualExecutions).toBe(executions);
		expect(snapshot().failure).toBe("error result; run continues");
		get("next").click();
		get("reveal").click();
		expect(logs.some((line) => line.includes("renderer offline"))).toBe(true);
		expect(guarded.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(snapshot().failure).toBe("logged; run continues");
		const bad = new ExtensionRunner({ log: () => {} });
		await bad.use(extension("bad-context", (api) => {
			api.on("context", () => { throw new Error("pruner crashed"); });
		}));
		const agent = new Agent({ system: "s", streamFn: createFakeStreamFn(["unused"]), ...bad.sessionHooks() });
		await expect(agent.prompt("go")).rejects.toThrow("pruner crashed");
		get("next").click();
		get("reveal").click();
		expect(snapshot().failure).toBe("reject original error");
	});

	it("records a known blocked call with hooks without executing it, and preserves its error on reopen", async () => {
		await withDirectory(async (directory) => {
			let executions = 0;
			const boot = await bootstrapExtensions({ extensions: [createDemoExtension()] });
			const bash = tool("bash", async () => { executions++; return { content: [] }; });
			const session = await AgentSession.create({
				directory, system: "s", tools: boot.tools([bash]), hooks: boot.hooks,
				streamFn: createFakeStreamFn([call("bash"), "done"]),
			});
			await session.submit({ requestId: "r1", prompt: "go" });
			expect(executions).toBe(0);
			expect(session.entries.filter((entry) => entry.type === "tool_intent")).toHaveLength(1);
			expect(session.entries.find((entry) => entry.type === "tool_outcome")).toMatchObject({ isError: true });
			const reopened = await AgentSession.open({
				path: session.filePath, system: "s", tools: boot.tools([bash]), hooks: boot.hooks,
				streamFn: createFakeStreamFn(["unused"]),
			});
			expect(executions).toBe(0);
			expect(reopened.state.messages).toEqual(session.state.messages);
		});
	});

	it("walks all eight lessons without hidden real requests or tool execution", async () => {
		const { get, snapshot } = await page();
		for (const lesson of ["naive", "inline", "permission", "context", "result", "turns", "provider", "failure"]) {
			expect(get("lesson").value).toBe(lesson);
			expect(get("next-lesson").disabled).toBe(true);
			for (let index = 0; index < 3; index++) {
				expect(get("answer").hidden).toBe(true);
				expect(get("prediction").textContent.trim()).not.toBe("");
				get("reveal").click();
				expect(get("change").textContent.trim()).not.toBe("");
				expect(snapshot().mode).toBe("implemented-behavior-simulation");
				expect(snapshot().actualToolExecutions).toBe(0);
				expect(snapshot().actualModelRequests).toBe(0);
				if (index < 2) get("next").click();
			}
			expect(get("next-lesson").disabled).toBe(lesson === "failure");
			get("next-lesson").click();
		}
	});
});
