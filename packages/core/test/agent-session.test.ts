import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createFakeStreamFn } from "@mini-agent/ai";
import type { Message, StreamFn } from "@mini-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/agent-session.ts";
import type { AgentEvent } from "../src/agent-event.ts";
import type { ToolDef, ToolResult } from "../src/tool.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mini-agent-agent-session-"));
	directories.push(directory);
	return directory;
}

async function diskEntries(path: string): Promise<Record<string, unknown>[]> {
	return (await readFile(path, "utf8"))
		.trimEnd()
		.split("\n")
		.slice(1)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function text(message: Message): string {
	if (!("content" in message)) return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

const echoTool: ToolDef<{ text: string }> = {
	name: "echo",
	description: "echo",
	replay: "safe",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	execute: async ({ text: value }) => ({
		content: [{ type: "text", text: value }],
	}),
};

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

describe("AgentSession", () => {
	it("persists a complete run in reconstructable order", async () => {
		const directory = await temporaryDirectory();
		const session = await AgentSession.create({
			directory,
			system: "test",
			tools: [],
			streamFn: createFakeStreamFn(["hello"]),
		});
		const initial = await readFile(session.filePath, "utf8");

		const submission = await session.submit({
			requestId: "req-1",
			prompt: "hi",
		});
		const after = await readFile(session.filePath, "utf8");
		const entries = session.entries;

		expect(submission).toMatchObject({
			type: "submission",
			requestId: "req-1",
			prompt: "hi",
		});
		expect(entries.map(({ type }) => type)).toEqual([
			"message",
			"submission",
			"message",
			"run_end",
		]);
		expect(entries[0]).toMatchObject({
			type: "message",
			message: { role: "system" },
		});
		expect(entries[2]).toMatchObject({
			type: "message",
			message: { role: "assistant" },
		});
		expect(entries[3]).toMatchObject({
			type: "run_end",
			submissionId: submission.id,
			status: "completed",
		});
		expect(session.state.messages.map(({ role }) => role)).toEqual([
			"system",
			"user",
			"assistant",
		]);
		expect(text(session.state.messages.at(-1)!)).toBe("hello");
		expect(after.startsWith(initial)).toBe(true);
		expect((await diskEntries(session.filePath)).map(({ id }) => id))
			.toEqual(entries.map(({ id }) => id));
	});

	it("persists intents, updates, outcomes, and source-ordered result messages", async () => {
		const directory = await temporaryDirectory();
		const executionSawIntentBarrier: boolean[] = [];
		let session!: AgentSession;
		const slow: ToolDef = {
			name: "slow",
			description: "slow",
			replay: "safe",
			parameters: { type: "object" },
			execute: async (_args, _signal, onUpdate) => {
				executionSawIntentBarrier.push(
					session.entries.filter(({ type }) => type === "tool_intent").length === 2,
				);
				onUpdate?.({ content: [{ type: "text", text: "one" }] });
				onUpdate?.({ content: [{ type: "text", text: "two" }] });
				await sleep(30);
				return { content: [{ type: "text", text: "slow done" }] };
			},
		};
		const fast: ToolDef = {
			name: "fast",
			description: "fast",
			replay: "safe",
			parameters: { type: "object" },
			execute: async () => {
				executionSawIntentBarrier.push(
					session.entries.filter(({ type }) => type === "tool_intent").length === 2,
				);
				await sleep(1);
				return { content: [{ type: "text", text: "fast done" }] };
			},
		};
		session = await AgentSession.create({
			directory,
			system: "test",
			tools: [slow, fast],
			streamFn: createFakeStreamFn([
				[
					{ type: "toolCall", id: "c1", name: "slow", arguments: {} },
					{ type: "toolCall", id: "c2", name: "fast", arguments: {} },
				],
				"done",
			]),
		});
		const durableAtExternalDelivery: boolean[] = [];
		session.subscribe(async (event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant"
			) {
				const entries = await diskEntries(session.filePath);
				durableAtExternalDelivery.push(entries.some((entry) =>
					entry.type === "message" &&
					(entry.message as { role?: string }).role === "assistant"
				));
			}
			if (event.type === "tool_execution_update") {
				const entries = await diskEntries(session.filePath);
				durableAtExternalDelivery.push(entries.at(-1)?.type === "tool_update");
			}
			if (event.type === "tool_execution_end") {
				const entries = await diskEntries(session.filePath);
				durableAtExternalDelivery.push(entries.at(-1)?.type === "tool_outcome");
			}
			if (
				event.type === "message_end" &&
				event.message.role === "toolResult"
			) {
				const entries = await diskEntries(session.filePath);
				durableAtExternalDelivery.push(entries.at(-1)?.type === "message");
			}
		});

		await session.submit({ requestId: "tools", prompt: "go" });

		const entries = session.entries;
		const types = entries.map(({ type }) => type);
		const assistantIndex = entries.findIndex((entry) =>
			entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some((block) => block.type === "toolCall")
		);
		const intents = entries.filter((entry) => entry.type === "tool_intent");
		const outcomes = entries.filter((entry) => entry.type === "tool_outcome");
		expect(intents.map(({ sourceIndex }) => sourceIndex)).toEqual([0, 1]);
		expect(entries.indexOf(intents[0]!)).toBeGreaterThan(assistantIndex);
		expect(entries.indexOf(intents[1]!)).toBeGreaterThan(assistantIndex);
		expect(executionSawIntentBarrier).toEqual([true, true]);
		expect(outcomes.map(({ intentId }) =>
			intents.find(({ id }) => id === intentId)?.toolCallId
		)).toEqual(["c2", "c1"]);
		expect(entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? [entry.message.toolCallId]
				: []
		)).toEqual(["c1", "c2"]);
		expect(entries.filter((entry) =>
			entry.type === "tool_update" &&
			entry.intentId === intents[0]!.id
		)).toHaveLength(2);
		expect(types.at(-1)).toBe("run_end");
		expect(durableAtExternalDelivery.every(Boolean)).toBe(true);
	});

	it("propagates external listener failures after internal persistence", async () => {
		const directory = await temporaryDirectory();
		const session = await AgentSession.create({
			directory,
			system: "test",
			streamFn: createFakeStreamFn(["hello"]),
		});
		const failure = new Error("external delivery failed");
		session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant"
			) throw failure;
		});

		await expect(session.submit({
			requestId: "listener",
			prompt: "hi",
		})).rejects.toBe(failure);
		expect(session.entries.some((entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant"
		)).toBe(true);
	});

	it.each(["update", "outcome"] as const)(
		"rejects a non-JSON %s after preserving the tool intent",
		async (failurePoint) => {
			const directory = await temporaryDirectory();
			const invalid = 1n as unknown as string;
			const tool: ToolDef = {
				name: "bad",
				description: "bad",
				replay: "unsafe",
				parameters: { type: "object" },
				execute: async (_args, _signal, onUpdate) => {
					if (failurePoint === "update") {
						onUpdate?.({
							content: [{ type: "text", text: invalid }],
						});
						return { content: [] };
					}
					return {
						content: [{ type: "text", text: invalid }],
					};
				},
			};
			const session = await AgentSession.create({
				directory,
				system: "test",
				tools: [tool],
				streamFn: createFakeStreamFn([
					[{ type: "toolCall", id: "c1", name: "bad", arguments: {} }],
				]),
			});

			await expect(session.submit({
				requestId: `bad-${failurePoint}`,
				prompt: "go",
			})).rejects.toThrow();
			expect(session.entries.filter(({ type }) => type === "tool_intent"))
				.toHaveLength(1);
			expect(session.entries.some((entry) =>
				entry.type === "run_end" && entry.status === "completed"
			)).toBe(false);
		},
	);

	it("deduplicates concurrent and repeated request IDs", async () => {
		const directory = await temporaryDirectory();
		const inner = createFakeStreamFn(["hello"]);
		const provider = vi.fn<StreamFn>((context, signal) =>
			inner(context, signal)
		);
		const session = await AgentSession.create({
			directory,
			system: "test",
			streamFn: provider,
		});

		const [left, right] = await Promise.all([
			session.submit({ requestId: "same", prompt: "one" }),
			session.submit({ requestId: "same", prompt: "one" }),
		]);
		const again = await session.submit({
			requestId: "same",
			prompt: "different prompt is ignored",
		});

		expect(left.id).toBe(right.id);
		expect(again.id).toBe(left.id);
		expect(provider).toHaveBeenCalledTimes(1);
		expect(session.entries.filter((entry) =>
			entry.type === "submission" && entry.requestId === "same"
		)).toHaveLength(1);
	});

	it.each([
		{ requestId: "", prompt: "hello", match: /requestId/i },
		{ requestId: "id", prompt: "   ", match: /prompt/i },
	])("rejects invalid submission %# before writing", async ({
		requestId,
		prompt,
		match,
	}) => {
		const directory = await temporaryDirectory();
		const session = await AgentSession.create({
			directory,
			system: "test",
			streamFn: createFakeStreamFn(["never"]),
		});
		const before = await readFile(session.filePath, "utf8");
		await expect(session.submit({ requestId, prompt })).rejects.toThrow(match);
		expect(await readFile(session.filePath, "utf8")).toBe(before);
	});

	it("journals system and tool changes before mutating Agent state", async () => {
		const directory = await temporaryDirectory();
		const session = await AgentSession.create({
			directory,
			system: "base",
			tools: [echoTool],
			streamFn: createFakeStreamFn(["never"]),
		});
		const sections = [{ tag: "workspace", text: "repo only" }];

		await session.appendSystemSections(sections);
		sections[0]!.text = "mutated";
		const lastMessage = session.entries.findLast((entry) =>
			entry.type === "message"
		);
		expect(lastMessage).toMatchObject({
			message: {
				role: "system",
				sections: [{ tag: "workspace", text: "repo only" }],
			},
		});
		expect(session.state.messages.at(-1)).toEqual(
			(lastMessage as { message: Message }).message,
		);

		const count = session.entries.length;
		await session.setTools([{ ...echoTool, execute: vi.fn(echoTool.execute) }]);
		expect(session.entries).toHaveLength(count);

		const replacement: ToolDef<{ text: string }> = {
			...echoTool,
			description: "echo v2",
		};
		await session.setTools([replacement]);
		expect(session.entries.at(-1)).toMatchObject({
			type: "message",
			message: {
				role: "system",
				toolsRemoved: ["echo"],
				toolsAdded: [{ name: "echo", description: "echo v2" }],
			},
		});
	});

	it("rejects session mutations during a run and before a failed journal append changes state", async () => {
		const directory = await temporaryDirectory();
		const session = await AgentSession.create({
			directory,
			system: "base",
			tools: [echoTool],
			streamFn: createFakeStreamFn(["hello"]),
		});
		const gate = deferred();
		session.subscribe((event) => {
			if (event.type === "agent_end") return gate.promise;
		});
		const running = session.submit({ requestId: "active", prompt: "hi" });
		await vi.waitFor(() => expect(session.state.isStreaming).toBe(true));
		await expect(session.appendSystemSections([{ text: "nope" }]))
			.rejects.toThrow(/active run/i);
		await expect(session.setTools([])).rejects.toThrow(/active run/i);
		session.abort();
		gate.resolve();
		await running;

		const stable = await AgentSession.create({
			directory: await temporaryDirectory(),
			system: "base",
			tools: [echoTool],
			streamFn: createFakeStreamFn(["never"]),
		});
		const messagesBefore = stable.state.messages.slice();
		const toolsBefore = stable.state.tools.slice();
		const backup = `${stable.filePath}.backup`;
		await rename(stable.filePath, backup);
		await mkdir(stable.filePath);
		try {
			await expect(stable.appendSystemSections([{ text: "cannot persist" }]))
				.rejects.toThrow();
			expect(stable.state.messages).toEqual(messagesBefore);
			await expect(stable.setTools([])).rejects.toThrow();
			expect(stable.state.tools).toEqual(toolsBefore);
		} finally {
			await rmdir(stable.filePath);
			await rename(backup, stable.filePath);
		}
	});
});
