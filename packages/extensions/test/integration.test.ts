import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AgentSession } from "@mini-agent/core";
import {
	createFakeStreamFn,
	getDefaultStreamFn,
	setDefaultStreamFn,
} from "@mini-agent/ai";
import type { StreamContext } from "@mini-agent/ai";
import { bootstrapExtensions } from "../src/bootstrap.ts";
import { createDemoExtension } from "../src/demo.ts";

const readTool = {
	name: "read", description: "read", parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: "file" }] }),
};
const callRead = [{ type: "toolCall" as const, id: "c1", name: "read", arguments: {} }];

function session(directory: string, streamFn = createFakeStreamFn([callRead, "done"])) {
	return AgentSession.create({ directory, system: "s", tools: [readTool], streamFn });
}

describe("extensions end to end", () => {
	test("an extension tool is callable through a real session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const extension = {
			name: "echo",
			factory: (api: any) => {
				api.registerTool({
					name: "echo", description: "echo", parameters: {},
					execute: async (args: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: String(args.text) }] }),
				});
			},
		};
		const { runner, hooks } = await bootstrapExtensions({ extensions: [extension] });
		const session = await AgentSession.create({
			directory, system: "s", tools: runner.tools, hooks,
			streamFn: createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "echo", arguments: { text: "hi" } }], "done"]),
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		const result = session.state.messages.find((m) => m.role === "toolResult");
		expect(result?.role === "toolResult" && result.content[0]).toEqual({ type: "text", text: "hi" });
	});

	test("a transformContext prune reaches the provider but not the journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const seen: string[][] = [];
		const base = createFakeStreamFn([callRead, "done"]);
		const prune = {
			name: "prune",
			factory: (api: any) => { api.on("context", (messages: readonly { role: string }[]) => messages.filter((m) => m.role !== "toolResult")); },
		};
		const { hooks } = await bootstrapExtensions({ extensions: [prune] });
		const session = await AgentSession.create({
			directory, system: "s", tools: [readTool], hooks,
			streamFn: (context, signal) => { seen.push(context.messages.map((m) => m.role)); return base(context, signal); },
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		// 第二轮请求：provider 看不到 toolResult，而 transcript 里有——剪枝没污染事实源
		expect(seen[1]).toEqual(["system", "user", "assistant"]);
		expect(session.state.messages.some((m) => m.role === "toolResult")).toBe(true);
		expect(readFileSync(session.filePath, "utf8")).toContain("tool_outcome");
	});

	test("prepareNextTurnWithContext writes a real system entry into the journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const clock = {
			name: "clock",
			factory: (api: any) => { api.on("next_turn", () => ({ sections: [{ text: "time: 12:00" }] })); },
		};
		const { hooks } = await bootstrapExtensions({ extensions: [clock] });
		const session = await AgentSession.create({
			directory, system: "s", tools: [readTool], hooks,
			streamFn: createFakeStreamFn([callRead, "done"]),
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		const entries = session.entries.filter((entry) => entry.type === "message" && entry.message.role === "system");
		expect(entries).toHaveLength(2);
	});

	test("a blocked tool is journaled as a tool_outcome with isError", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const executed = vi.fn(async () => ({ content: [] }));
		const guard = {
			name: "guard",
			factory: (api: any) => { api.on("tool_call", () => ({ block: true, reason: "denied" })); },
		};
		const { hooks } = await bootstrapExtensions({ extensions: [guard] });
		const session = await AgentSession.create({
			directory, system: "s", hooks,
			tools: [{ name: "read", description: "read", parameters: {}, execute: executed }],
			streamFn: createFakeStreamFn([callRead, "done"]),
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(executed).not.toHaveBeenCalled();
		const entries = session.entries.filter((entry) => entry.type === "tool_outcome");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.type === "tool_outcome" && entries[0].isError).toBe(true);
	});

	test("observer handlers receive replayed events and cannot break the session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const observed: string[] = [];
		const noisy = {
			name: "noisy",
			factory: (api: any) => {
				api.on("message_end", () => { throw new Error("renderer offline"); });
			},
		};
		const quiet = {
			name: "quiet",
			factory: (api: any) => { api.on("tool_execution_end", (event: { toolName: string }) => { observed.push(event.toolName); }); },
		};
		const logs: string[] = [];
		const { runner, hooks } = await bootstrapExtensions({ extensions: [noisy, quiet], log: (m) => logs.push(m) });
		const session = await AgentSession.create({
			directory, system: "s", tools: [readTool], hooks,
			streamFn: createFakeStreamFn([callRead, "done"]),
		});
		session.subscribe((event) => { void runner.notify(event); });
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(observed).toEqual(["read"]);
		// 一次 run 会发出多条 message_end（user / assistant / toolResult），
		// 每条都会触发 noisy 的抛错并被隔离记录——断言钉住的是日志行格式与软隔离。
		expect(logs).toContain('extension "noisy" handler for "message_end" failed: renderer offline');
	});

	test("the demo extension registers a tool, a guard, and a command", async () => {
		const { runner, hooks } = await bootstrapExtensions({ extensions: [createDemoExtension()] });
		expect(runner.tools.map((tool) => tool.name)).toEqual(["word_count"]);
		expect(runner.commands.map((command) => command.name)).toEqual(["demo"]);
		expect(typeof hooks.beforeToolCall).toBe("function");
		expect(typeof hooks.transformContext).toBe("function");
	});

	test("installStreamFn wraps the current default without changing the call site", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const calls: string[] = [];
		const base = createFakeStreamFn([[{ type: "toolCall" as const, id: "c1", name: "word_count", arguments: { text: "a b c" } }], "done"]);
		setDefaultStreamFn((context, signal) => { calls.push(context.messages.at(-1)?.role ?? "none"); return base(context, signal); });
		const { runner, installStreamFn } = await bootstrapExtensions({ extensions: [createDemoExtension()] });
		installStreamFn();
		const session = await AgentSession.create({
			directory, system: "s", tools: runner.tools,
			streamFn: getDefaultStreamFn(),
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(calls).toHaveLength(2);
		const result = session.state.messages.find((m) => m.role === "toolResult");
		expect(result?.role === "toolResult" && result.content[0]).toEqual({ type: "text", text: "3" });
	});

	test("with zero extensions the session behaves exactly like stage 10", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const { hooks, tools } = await bootstrapExtensions({ extensions: [] });
		expect(hooks).toEqual({});
		expect(tools([readTool])).toEqual([readTool]);
		const s = await session(directory);
		await s.submit({ requestId: "r1", prompt: "go" });
		expect(s.state.messages.some((m) => m.role === "toolResult")).toBe(true);
	});

	test("before_provider_request decorates the request without touching the journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "mini-agent-ext-"));
		const seen: string[] = [];
		const base = createFakeStreamFn([callRead, "done"]);
		const stamp = {
			name: "stamp",
			factory: (api: any) => {
				api.on("before_provider_request", (input: { context: StreamContext }) => ({
					...input.context,
					messages: [...input.context.messages, { role: "user", content: [{ type: "text", text: "stamped" }] }],
				}));
			},
		};
		const { hooks } = await bootstrapExtensions({ extensions: [stamp] });
		const session = await AgentSession.create({
			directory, system: "s", tools: [readTool], hooks,
			streamFn: (context, signal) => {
				seen.push(String(context.messages.at(-1)?.role === "user" && JSON.stringify(context.messages.at(-1))));
				return base(context, signal);
			},
		});
		await session.submit({ requestId: "r1", prompt: "go" });
		expect(seen[0]).toContain("stamped");
		const journal = readFileSync(session.filePath, "utf8");
		expect(journal).not.toContain("stamped");
	});
});
