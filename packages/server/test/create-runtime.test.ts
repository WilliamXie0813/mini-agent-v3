import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeStreamFn } from "@mini-agent/ai";
import type { ToolDef } from "@mini-agent/core";
import type { Extension } from "@mini-agent/extensions";
import type { ServerMessage } from "@mini-agent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/create-runtime.ts";
import type { SessionHost } from "../src/session-host.ts";

const directories: string[] = [];
const runtimes: SessionHost[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mini-agent-runtime-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

function collector(): { messages: ServerMessage[]; sink: (message: ServerMessage) => void } {
	const messages: ServerMessage[] = [];
	return { messages, sink: (message) => messages.push(message) };
}

async function runPrompt(
	runtime: SessionHost,
	requestId: string,
	prompt: string,
): Promise<ServerMessage[]> {
	const client = collector();
	runtime.attach(client.sink);
	runtime.handle({ type: "prompt.submit", requestId, prompt }, client.sink);
	await vi.waitFor(() => {
		expect(client.messages.some(
			(message) =>
				message.type === "command.completed" && message.requestId === requestId,
		)).toBe(true);
	});
	return client.messages;
}

describe("createRuntime session selection", () => {
	it("creates a fresh session when continueSession is false", async () => {
		const directory = await temporaryDirectory();
		const first = await createRuntime({
			directory, env: {}, streamFn: createFakeStreamFn(["a"]),
		});
		runtimes.push(first);
		const second = await createRuntime({
			directory, env: {}, streamFn: createFakeStreamFn(["b"]),
		});
		runtimes.push(second);
		expect(first.snapshot().status).toBe("idle");
		expect(second.snapshot().status).toBe("idle");
		expect(second.snapshot().sessionId).not.toBe(first.snapshot().sessionId);
	});

	it("opens the latest session when continueSession is true", async () => {
		const directory = await temporaryDirectory();
		const first = await createRuntime({
			directory, env: {}, streamFn: createFakeStreamFn(["persisted answer"]),
		});
		await runPrompt(first, "r1", "remember this");
		const firstId = first.snapshot().sessionId;
		await first.close();

		const resumed = await createRuntime({
			continueSession: true,
			directory,
			env: {},
			streamFn: createFakeStreamFn(["unused"]),
		});
		runtimes.push(resumed);
		const snapshot = resumed.snapshot();
		expect(snapshot.sessionId).toBe(firstId);
		expect(snapshot.status).toBe("idle");
		expect(snapshot.entries.at(-1))
			.toMatchObject({ type: "run_end", status: "completed" });
	});

	it("rejects an invalid ANTHROPIC_CONTEXT_WINDOW with the CLI's named error", async () => {
		const directory = await temporaryDirectory();
		for (const value of ["abc", "0", "-5", "1.5"]) {
			await expect(createRuntime({
				directory,
				env: { ANTHROPIC_CONTEXT_WINDOW: value },
				streamFn: createFakeStreamFn(["unused"]),
			})).rejects.toThrow(
				`ANTHROPIC_CONTEXT_WINDOW must be a positive integer, got ${JSON.stringify(value)}`,
			);
		}
	});
});

describe("createRuntime assembly", () => {
	it("runs a full prompt with an injected streamFn and no API key", async () => {
		const runtime = await createRuntime({
			directory: await temporaryDirectory(),
			// 没有 ANTHROPIC_API_KEY：注入 fake 后整条链路绝不触碰网络/密钥。
			env: {},
			streamFn: createFakeStreamFn(["pong"]),
		});
		runtimes.push(runtime);
		const messages = await runPrompt(runtime, "r1", "ping");

		const envelopes = messages.flatMap((message) =>
			message.type === "agent.event" ? [message.envelope] : []
		);
		expect(envelopes.length).toBeGreaterThan(0);
		expect(envelopes.at(-1)?.event.type).toBe("agent_end");

		const completed = messages.find(
			(message): message is Extract<ServerMessage, { type: "command.completed" }> =>
				message.type === "command.completed" && message.requestId === "r1",
		);
		if (completed?.command !== "prompt.submit")
			throw new Error("expected a prompt.submit completion");
		const submission = runtime.snapshot().entries.find(
			(entry) => entry.type === "submission",
		);
		expect(completed.result.submissionId).toBe(submission!.id);
		expect(runtime.snapshot().entries.at(-1))
			.toMatchObject({ type: "run_end", status: "completed" });
	});

	it("wires extension tools and decision hooks around the default tools", async () => {
		const seenToolCalls: string[] = [];
		const probeTool: ToolDef = {
			name: "probe_tool",
			description: "probe extension tool",
			parameters: { type: "object", properties: {} },
			replay: "safe",
			execute: async () => ({ content: [{ type: "text", text: "probe-ok" }] }),
		};
		const probe: Extension = {
			name: "probe",
			factory(api) {
				api.registerTool(probeTool);
				api.on("tool_call", ({ toolCall }) => {
					seenToolCalls.push(toolCall.name);
					// block 默认工具 read 成功，同时证明 createDefaultTools() 与 hooks 都在线：
					// 工具缺失会得到 "not found"，而不是这条 reason。
					if (toolCall.name === "read")
						return { block: true, reason: "probe blocked read" };
					return undefined;
				});
			},
		};
		const runtime = await createRuntime({
			directory: await temporaryDirectory(),
			env: {},
			extensions: [probe],
			streamFn: createFakeStreamFn([
				[
					{ type: "toolCall", id: "call-probe", name: "probe_tool", arguments: {} },
					{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "x" } },
				],
				"done",
			]),
		});
		runtimes.push(runtime);
		await runPrompt(runtime, "r1", "use tools");

		expect(seenToolCalls).toEqual(expect.arrayContaining(["probe_tool", "read"]));
		const toolResults = runtime.snapshot().entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? [entry.message]
				: []
		);
		const probeResult = toolResults.find((m) => m.toolCallId === "call-probe");
		const readResult = toolResults.find((m) => m.toolCallId === "call-read");
		expect(probeResult?.isError).toBeFalsy();
		expect(probeResult?.content[0]).toMatchObject({ type: "text", text: "probe-ok" });
		expect(readResult?.isError).toBe(true);
		expect(readResult?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("probe blocked read"),
		});
		expect(runtime.snapshot().entries.at(-1))
			.toMatchObject({ type: "run_end", status: "completed" });
	});

	it("notifies extension observers via onEvent and survives their failures", async () => {
		const observed: string[] = [];
		const observers: Extension[] = [
			{
				name: "failing-observer",
				factory(api) {
					api.on("message_end", () => {
						throw new Error("observer boom");
					});
				},
			},
			{
				name: "recording-observer",
				factory(api) {
					api.on("message_end", (event) => {
						observed.push(event.message.role);
					});
				},
			},
		];
		// runner 用 console.error 记录 observer 失败；spy 掉保持测试输出干净。
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const runtime = await createRuntime({
				directory: await temporaryDirectory(),
				env: {},
				extensions: observers,
				streamFn: createFakeStreamFn(["hello observer"]),
			});
			runtimes.push(runtime);
			await runPrompt(runtime, "r1", "hi");

			expect(observed).toContain("assistant");
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining("observer boom"),
			);
			// observer 失败不杀 run：run_end 仍是 completed。
			expect(runtime.snapshot().entries.at(-1))
				.toMatchObject({ type: "run_end", status: "completed" });
		} finally {
			consoleError.mockRestore();
		}
	});
});
