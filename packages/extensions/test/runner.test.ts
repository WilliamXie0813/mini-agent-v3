import { describe, expect, test, vi } from "vitest";
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
