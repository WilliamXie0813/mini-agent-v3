import { describe, expect, test, vi } from "vitest";
import { Agent } from "@mini-agent/core";
import { createFakeStreamFn } from "@mini-agent/ai";
import { ExtensionRunner } from "../src/runner.ts";

const tool = (name: string) => ({
	name, description: name, parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: `${name} ran` }] }),
});

describe("ExtensionRunner registration", () => {
	test("runs factories in order and exposes their tools", async () => {
		const runner = new ExtensionRunner();
		const order: string[] = [];
		await runner.use({ name: "a", factory: () => { order.push("a"); } });
		await runner.use({ name: "b", factory: () => { order.push("b"); } });
		expect(order).toEqual(["a", "b"]);
		expect(runner.tools).toEqual([]);
	});

	test("collects registered tools and commands", async () => {
		const runner = new ExtensionRunner();
		await runner.use({
			name: "demo",
			factory: (api) => {
				api.registerTool(tool("echo"));
				api.registerCommand({ name: "hello", description: "say hi", run: () => {} });
			},
		});
		expect(runner.tools.map((t) => t.name)).toEqual(["echo"]);
		expect(runner.commands.map((c) => c.name)).toEqual(["hello"]);
	});

	test("rejects duplicate tool names at registration", async () => {
		const runner = new ExtensionRunner();
		runner.registerTool(tool("echo"));
		expect(() => runner.registerTool(tool("echo")))
			.toThrowError('duplicate tool name: "echo"');
	});

	test("rejects a duplicate command name", () => {
		const runner = new ExtensionRunner();
		runner.registerCommand({ name: "hello", description: "a", run: () => {} });
		expect(() => runner.registerCommand({ name: "hello", description: "b", run: () => {} }))
			.toThrowError('duplicate command name: "hello"');
	});

	test("a throwing factory names the extension and propagates", async () => {
		const runner = new ExtensionRunner();
		await expect(runner.use({
			name: "broken",
			factory: () => { throw new Error("boom"); },
		})).rejects.toThrowError('extension "broken" failed to initialize: boom');
	});
});

describe("ExtensionRunner.notify", () => {
	test("delivers observer events with the raw AgentEvent payload", async () => {
		const runner = new ExtensionRunner();
		const seen: string[] = [];
		await runner.use({
			name: "logger",
			factory: (api) => {
				api.on("message_end", (event) => { seen.push(`${event.message.role}:end`); });
				api.on("tool_execution_start", (event) => { seen.push(`tool:${event.toolName}`); });
			},
		});
		await runner.notify({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		});
		await runner.notify({
			type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {},
		});
		expect(seen).toEqual(["user:end", "tool:read"]);
	});

	test("ignores events it does not observe", async () => {
		const runner = new ExtensionRunner();
		const handler = vi.fn();
		await runner.use({ name: "all", factory: (api) => { api.on("message_end", handler); } });
		await runner.notify({ type: "turn_start" });
		await runner.notify({ type: "compaction_start", reason: "manual", contextTokens: 10 });
		expect(handler).not.toHaveBeenCalled();
	});

	test("a throwing observer is logged, isolated, and does not reject", async () => {
		const log = vi.fn();
		const runner = new ExtensionRunner({ log });
		const after = vi.fn();
		await runner.use({
			name: "a",
			factory: (api) => { api.on("message_end", () => { throw new Error("renderer bug"); }); },
		});
		await runner.use({ name: "b", factory: (api) => { api.on("message_end", after); } });
		await expect(runner.notify({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		})).resolves.toBeUndefined();
		expect(after).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith('extension "a" handler for "message_end" failed: renderer bug');
	});

	test("notify before any handler is registered is a no-op", async () => {
		const runner = new ExtensionRunner();
		await expect(runner.notify({ type: "agent_start" })).resolves.toBeUndefined();
	});
});

function callRead() {
	return [{ type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "a.txt" } }];
}

describe("tool_call decision hook", () => {
	test("blocks execution and surfaces the reason as an error result", async () => {
		const runner = new ExtensionRunner();
		const executed = vi.fn(async () => ({ content: [{ type: "text" as const, text: "file" }] }));
		await runner.use({
			name: "guard",
			factory: (api) => {
				api.on("tool_call", () => ({ block: true, reason: "read is disabled in this demo" }));
			},
		});
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: executed }],
			streamFn: createFakeStreamFn([callRead(), "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(executed).not.toHaveBeenCalled();
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true, toolName: "read" });
		expect(result?.role === "toolResult" && result.content[0]).toEqual({
			type: "text", text: "read is disabled in this demo",
		});
	});

	test("handlers short-circuit on the first non-undefined result", async () => {
		const runner = new ExtensionRunner();
		const second = vi.fn(() => undefined);
		await runner.use({
			name: "first",
			factory: (api) => { api.on("tool_call", () => ({ block: true, reason: "no" })); },
		});
		await runner.use({ name: "second", factory: (api) => { api.on("tool_call", second); } });
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([callRead(), "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(second).not.toHaveBeenCalled();
	});

	test("a handler returning undefined lets the call through to the next handler", async () => {
		const runner = new ExtensionRunner();
		const executed = vi.fn(async () => ({ content: [{ type: "text" as const, text: "file" }] }));
		const seen: string[] = [];
		await runner.use({ name: "a", factory: (api) => { api.on("tool_call", (e) => { seen.push(e.toolCall.name); }); } });
		await runner.use({ name: "b", factory: (api) => { api.on("tool_call", () => { seen.push("b"); }); } });
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: executed }],
			streamFn: createFakeStreamFn([callRead(), "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(seen).toEqual(["read", "b"]);
		expect(executed).toHaveBeenCalledTimes(1);
	});

	test("a throwing guard fails closed: tool does not run, run continues", async () => {
		const runner = new ExtensionRunner({ log: () => {} });
		const executed = vi.fn(async () => ({ content: [] }));
		await runner.use({
			name: "broken-guard",
			factory: (api) => { api.on("tool_call", () => { throw new Error("rule engine offline"); }); },
		});
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: executed }],
			streamFn: createFakeStreamFn([callRead(), "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(executed).not.toHaveBeenCalled();
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(result?.role === "toolResult" && result.content[0]).toEqual({
			type: "text", text: "rule engine offline",
		});
		expect(agent.state.messages.at(-1)?.role).toBe("assistant");
	});
});

describe("tool_result decision hook", () => {
	test("folds in registration order, last handler's fields win", async () => {
		const runner = new ExtensionRunner();
		await runner.use({
			name: "a",
			factory: (api) => { api.on("tool_result", (e) => ({ content: [{ type: "text" as const, text: `a:${e.result.content.length}` }] })); },
		});
		await runner.use({
			name: "b",
			factory: (api) => { api.on("tool_result", () => ({ isError: true })); },
		});
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "x" }] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(result?.role === "toolResult" && result.content[0]).toEqual({ type: "text", text: "a:1" });
	});

	test("a handler returning void leaves the previous fields intact", async () => {
		const runner = new ExtensionRunner();
		await runner.use({ name: "a", factory: (api) => { api.on("tool_result", () => ({ content: [{ type: "text" as const, text: "kept" }] })); } });
		await runner.use({ name: "b", factory: (api) => { api.on("tool_result", () => undefined); } });
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		const result = agent.state.messages.find((m) => m.role === "toolResult");
		expect(result?.role === "toolResult" && result.content[0]).toEqual({ type: "text", text: "kept" });
	});
});

describe("context decision hook", () => {
	test("folds across extensions: each sees the previous one's output", async () => {
		const runner = new ExtensionRunner();
		const sizes: number[] = [];
		await runner.use({ name: "drop-system", factory: (api) => { api.on("context", (m) => m.filter((x) => x.role !== "system")); } });
		await runner.use({ name: "count", factory: (api) => { api.on("context", (m) => { sizes.push(m.length); return [...m]; }); } });
		const agent = new Agent({
			system: "s", streamFn: createFakeStreamFn(["done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(sizes).toEqual([1]);
	});

	test("a throwing handler rejects the prompt with the original error", async () => {
		const runner = new ExtensionRunner({ log: () => {} });
		await runner.use({ name: "boom", factory: (api) => { api.on("context", () => { throw new Error("pruner crashed"); }); } });
		const agent = new Agent({ system: "s", streamFn: createFakeStreamFn(["done"]), ...runner.sessionHooks() });
		await expect(agent.prompt("go")).rejects.toThrowError("pruner crashed");
	});
});

describe("turn_end decision hook", () => {
	test("short-circuits on the first non-void result", async () => {
		const runner = new ExtensionRunner();
		const second = vi.fn(() => ({ action: "end" as const }));
		// 首个 handler 第一次返回 continue（再要一轮），第二次返回 end——
		// 若每次都 continue，maxTurns: 2 预算耗尽会让 prompt 以 hit maxTurns 熔断，
		// 与「正常收敛」的测试意图相悖。
		let calls = 0;
		await runner.use({
			name: "a",
			factory: (api) => {
				api.on("turn_end", () => (++calls === 1 ? { action: "continue" as const } : { action: "end" as const }));
			},
		});
		await runner.use({ name: "b", factory: (api) => { api.on("turn_end", second); } });
		const agent = new Agent({
			system: "s", maxTurns: 2,
			streamFn: createFakeStreamFn(["x", "y"]),
			...runner.sessionHooks(),
		});
		agent.subscribe(() => {});
		const turnEnds: number[] = [];
		agent.subscribe((e) => { if (e.type === "turn_end") turnEnds.push(1); });
		await agent.prompt("go");
		expect(second).not.toHaveBeenCalled();
		expect(turnEnds).toHaveLength(2);
	});

	test("a handler returning void lets the loop stop normally", async () => {
		const runner = new ExtensionRunner();
		await runner.use({ name: "observer-ish", factory: (api) => { api.on("turn_end", () => undefined); } });
		const agent = new Agent({ system: "s", streamFn: createFakeStreamFn(["only"]), ...runner.sessionHooks() });
		await agent.prompt("go");
		expect(agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
	});
});

describe("next_turn decision hook", () => {
	test("merges fields across extensions; later handlers win per field", async () => {
		const runner = new ExtensionRunner();
		await runner.use({
			name: "a",
			factory: (api) => { api.on("next_turn", () => ({ sections: [{ text: "clock" }] })); },
		});
		await runner.use({
			name: "b",
			factory: (api) => { api.on("next_turn", () => ({ toolsRemoved: ["read"] })); },
		});
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		// transcript 尾部是收敛轮的 assistant 消息；hook 追加的 SystemMessage 在 system 序列尾部。
		const last = agent.state.messages.filter((m) => m.role === "system").at(-1);
		expect(last?.role).toBe("system");
		expect(last?.role === "system" && last.sections[0]!.text).toBe("clock");
		expect(last?.role === "system" && last.toolsRemoved).toEqual(["read"]);
	});

	test("all handlers returning void appends nothing", async () => {
		const runner = new ExtensionRunner();
		await runner.use({ name: "noop", factory: (api) => { api.on("next_turn", () => undefined); } });
		const agent = new Agent({
			system: "s",
			tools: [{ name: "read", description: "read", parameters: {}, execute: async () => ({ content: [] }) }],
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }], "done"]),
			...runner.sessionHooks(),
		});
		await agent.prompt("go");
		expect(agent.state.messages.filter((m) => m.role === "system")).toHaveLength(1);
	});
});
