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
import { createAssistantMessageEventStream, createFakeStreamFn } from "@mini-agent/ai";
import type { Message, StreamContext, StreamFn } from "@mini-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/agent-session.ts";
import type { AgentEvent } from "../src/agent-event.ts";
import { SessionJournal } from "../src/session-journal.ts";
import type { SessionEntryBase, SessionEntryData } from "../src/session-types.ts";
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

function pathTo(
	entries: readonly { id: string; parentId: string | null }[],
	leafId: string,
): string[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: string[] = [];
	let current: string | null = leafId;
	while (current !== null) {
		const entry = byId.get(current);
		if (!entry) throw new Error(`missing entry ${current}`);
		path.push(entry.id);
		current = entry.parentId;
	}
	return path.reverse();
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
	vi.restoreAllMocks();
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

describe("AgentSession", () => {
	it.each(["outcome failure", "historical branch"] as const)(
		"normalizes partial tool history before a new submission after %s",
		async (trigger) => {
			const contexts: StreamContext[] = [];
			let executes = 0;
			const definition: ToolDef = {
				name: "unsafe", description: "unsafe", replay: "unsafe",
				parameters: { type: "object" },
				execute: async (_args, _signal, onUpdate) => {
					executes++;
					onUpdate?.({ content: [{ type: "text", text: "committed partial" }] });
					return { content: [{ type: "text", text: "original result" }] };
				},
			};
			const inner = createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "unsafe", arguments: {} }],
				"old final", "new final",
			]);
			const session = await AgentSession.create({
				directory: await temporaryDirectory(), system: "base", tools: [definition],
				streamFn: (context, signal) => {
					contexts.push(structuredClone(context));
					return inner(context, signal);
				},
			});
			const append = SessionJournal.prototype.append;
			if (trigger === "outcome failure") {
				const failure = new Error("outcome fsync failed");
				const spy = vi.spyOn(SessionJournal.prototype, "append").mockImplementation(
					function <TData extends SessionEntryData>(
						this: SessionJournal, data: TData,
					): Promise<SessionEntryBase & TData> {
						if (data.type === "tool_outcome") return Promise.reject(failure);
						return (append<TData>).call(this, data);
					},
				);
				await expect(session.submit({ requestId: "old", prompt: "run unsafe" }))
					.rejects.toBe(failure);
				spy.mockRestore();
			} else {
				await session.submit({ requestId: "old", prompt: "run unsafe" });
				const partial = session.entries.find(({ type }) => type === "tool_update")!;
				const before = await readFile(session.filePath, "utf8");
				session.branch(partial.id);
				expect(await readFile(session.filePath, "utf8")).toBe(before);
			}
			const next = await session.submit({ requestId: "next", prompt: "continue" });
			expect(executes).toBe(1);
			const context = contexts.at(-1)!;
			expect(context.messages.map(({ role }) => role)).toEqual([
				"system", "user", "assistant", "toolResult", "user",
			]);
			expect(context.messages[3]).toMatchObject({
				role: "toolResult", toolCallId: "c1", isError: true,
				content: [
					{ type: "text", text: "committed partial" },
					{ type: "text", text: expect.stringMatching(/interrupted/i) },
				],
			});
			const activePath = pathTo(session.entries, session.leafId!);
			const nextIndex = activePath.indexOf(next.id);
			expect(session.entries.find(({ id }) => id === activePath[nextIndex - 1]))
				.toMatchObject({ type: "run_end", status: "interrupted" });
			const reopened = await AgentSession.open({
				path: session.filePath, system: "base", tools: [definition],
				streamFn: createFakeStreamFn(["unused"]),
			});
			expect(reopened.state.messages).toEqual(session.state.messages);
			expect(executes).toBe(1);
		},
	);

	it.each(["parallel", "sequential"] as const)(
		"propagates a failed second %s intent without sealing pending recovery",
		async (toolExecution) => {
			let executes = 0;
			const first: ToolDef = {
				...echoTool,
				execute: async () => {
					executes++;
					return { content: [{ type: "text", text: "safe result" }] };
				},
			};
			const second = { ...first, name: "second" };
			const directory = await temporaryDirectory();
			const session = await AgentSession.create({
				directory, system: "base", tools: [first, second], toolExecution,
				streamFn: createFakeStreamFn([[
					{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "one" } },
					{ type: "toolCall", id: "c2", name: "second", arguments: { text: "two" } },
				]]),
			});
			const failure = new Error("second intent fsync failed");
			const append = SessionJournal.prototype.append;
			const spy = vi.spyOn(SessionJournal.prototype, "append").mockImplementation(
				function <TData extends SessionEntryData>(
					this: SessionJournal, data: TData,
				): Promise<SessionEntryBase & TData> {
					if (data.type === "tool_intent" && data.sourceIndex === 1)
						return Promise.reject(failure);
					return (append<TData>).call(this, data);
				},
			);
			await expect(session.submit({ requestId: "failure", prompt: "go" }))
				.rejects.toBe(failure);
			expect(executes).toBe(toolExecution === "parallel" ? 0 : 1);
			expect(session.entries.some(({ type }) => type === "run_end")).toBe(false);
			spy.mockRestore();

			const reopened = await AgentSession.open({
				path: session.filePath, system: "base", tools: [first, second],
				streamFn: createFakeStreamFn(["unused"]),
			});
			expect(executes).toBe(1);
			expect(reopened.state.messages.filter(({ role }) => role === "toolResult"))
				.toMatchObject([
					{ toolCallId: "c1", content: [{ text: "safe result" }], isError: false },
					{ toolCallId: "c2", isError: true },
				]);
			expect(reopened.entries.at(-1)).toMatchObject({
				type: "run_end", status: "interrupted",
			});
		},
	);

	it.each(["submission", "sections", "tools"] as const)(
		"owns the session and stays non-idle while %s persistence is pending",
		async (operation) => {
			const session = await AgentSession.create({
				directory: await temporaryDirectory(),
				system: "base",
				tools: [echoTool],
				streamFn: createFakeStreamFn(["answer"]),
			});
			const gate = deferred();
			const reached = deferred();
			const append = SessionJournal.prototype.append;
			let gated = false;
			vi.spyOn(SessionJournal.prototype, "append").mockImplementation(
				async function <TData extends SessionEntryData>(
					this: SessionJournal, data: TData,
				): Promise<SessionEntryBase & TData> {
					if (!gated) {
						gated = true;
						reached.resolve();
						await gate.promise;
					}
					return (append<TData>).call(this, data);
				},
			);
			const pending = operation === "submission"
				? session.submit({ requestId: "owner", prompt: "go" })
				: operation === "sections"
					? session.appendSystemSections([{ text: "policy" }])
					: session.setTools([]);
			await reached.promise;
			let idle = false;
			const waiting = session.waitForIdle().then(() => { idle = true; });
			try {
				await Promise.resolve();
				expect(idle).toBe(false);
				const bytes = await readFile(session.filePath, "utf8");
				await expect(session.submit({ requestId: "other", prompt: "no" }))
					.rejects.toThrow(/active run|operation/i);
				await expect(session.appendSystemSections([{ text: "no" }]))
					.rejects.toThrow(/active run|operation/i);
				await expect(session.setTools([])).rejects.toThrow(/active run|operation/i);
				expect(() => session.branch(session.entries[0]!.id))
					.toThrow(/active run|operation/i);
				expect(await readFile(session.filePath, "utf8")).toBe(bytes);
			} finally {
				gate.resolve();
				await pending;
				await waiting;
			}
			expect(idle).toBe(true);
		},
	);

	it("rejects a different active request before writing without damaging the owner", async () => {
		let executes = 0;
		const session = await AgentSession.create({
			directory: await temporaryDirectory(),
			system: "base",
			tools: [{ ...echoTool, execute: async (args) => {
				executes++;
				return echoTool.execute(args);
			} }],
			streamFn: createFakeStreamFn([
				[{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "owner" } }],
				"done",
			]),
		});
		const gate = deferred();
		const reached = deferred();
		session.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				reached.resolve();
				await gate.promise;
			}
		});
		const owner = session.submit({ requestId: "owner", prompt: "go" });
		await reached.promise;
		try {
			await expect(session.submit({ requestId: "other", prompt: "no" }))
				.rejects.toThrow(/active run|operation/i);
			expect(session.entries.some((entry) =>
				entry.type === "submission" && entry.requestId === "other"
			)).toBe(false);
		} finally {
			gate.resolve();
			await owner;
		}
		expect(executes).toBe(1);
		expect(session.entries.at(-1)).toMatchObject({
			type: "run_end", status: "completed",
		});
	});

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

	it("reopens the leaf path and continues with full history", async () => {
		const directory = await temporaryDirectory();
		const session = await AgentSession.create({
			directory,
			system: "test",
			streamFn: createFakeStreamFn(["first", "second"]),
		});
		await session.submit({ requestId: "one", prompt: "one" });
		await session.submit({ requestId: "two", prompt: "two" });
		const messagesBefore = structuredClone(session.state.messages);
		const bytesBefore = await readFile(session.filePath, "utf8");
		const contexts: StreamContext[] = [];
		const inner = createFakeStreamFn(["third"]);
		const resumed = await AgentSession.open({
			path: session.filePath,
			directory,
			system: "ignored",
			streamFn: (context, signal) => {
				contexts.push(structuredClone(context));
				return inner(context, signal);
			},
		});

		expect(resumed.state.messages).toEqual(messagesBefore);
		await resumed.submit({ requestId: "three", prompt: "three" });
		expect(contexts).toHaveLength(1);
		expect(contexts[0]!.messages
			.filter((message) => message.role === "user")
			.map(text)).toEqual(["one", "two", "three"]);
		expect((await readFile(resumed.filePath, "utf8")).startsWith(bytesBefore))
			.toBe(true);

		const latest = await AgentSession.openLatest({
			directory,
			system: "ignored",
			streamFn: createFakeStreamFn(["unused"]),
		});
		expect(latest.filePath).toBe(session.filePath);
		const empty = await temporaryDirectory();
		await expect(AgentSession.openLatest({
			directory: empty,
			system: "test",
			streamFn: createFakeStreamFn(["unused"]),
		})).rejects.toThrow(/no session/i);
	});

	it("branches from an earlier entry without erasing old descendants", async () => {
		const directory = await temporaryDirectory();
		const session = await AgentSession.create({
			directory,
			system: "test",
			streamFn: createFakeStreamFn(["one", "old", "new"]),
		});
		await session.submit({ requestId: "one", prompt: "one" });
		const firstLeaf = session.leafId!;
		await session.submit({ requestId: "old", prompt: "old branch" });
		const oldLeaf = session.leafId!;
		const beforeBranch = await readFile(session.filePath, "utf8");

		session.branch(firstLeaf);

		expect(await readFile(session.filePath, "utf8")).toBe(beforeBranch);
		expect(session.state.messages
			.filter((message) => message.role === "user")
			.map(text)).toEqual(["one"]);
		const newSubmission = await session.submit({
			requestId: "new",
			prompt: "new branch",
		});
		const newLeaf = session.leafId!;
		expect(newSubmission.parentId).toBe(firstLeaf);
		expect(session.entries.some(({ id }) => id === oldLeaf)).toBe(true);
		expect(session.entries.some(({ id }) => id === newLeaf)).toBe(true);
		expect(session.state.messages
			.filter((message) => message.role === "user")
			.map(text)).toEqual(["one", "new branch"]);
		expect(pathTo(session.entries, oldLeaf).slice(0, -1))
			.not.toEqual(pathTo(session.entries, newLeaf).slice(0, -1));
		expect(pathTo(session.entries, oldLeaf)).toContain(firstLeaf);
		expect(pathTo(session.entries, newLeaf)).toContain(firstLeaf);

		const reopened = await AgentSession.open({
			path: session.filePath,
			system: "ignored",
			streamFn: createFakeStreamFn(["unused"]),
		});
		expect(reopened.state.messages
			.filter((message) => message.role === "user")
			.map(text)).toEqual(["one", "new branch"]);
	});

	it("guards branch changes and keeps request IDs global across branches", async () => {
		const directory = await temporaryDirectory();
		const inner = createFakeStreamFn(["one", "old", "new"]);
		const provider = vi.fn<StreamFn>((context, signal) =>
			inner(context, signal)
		);
		const session = await AgentSession.create({
			directory,
			system: "test",
			streamFn: provider,
		});
		await session.submit({ requestId: "one", prompt: "one" });
		const firstLeaf = session.leafId!;
		const old = await session.submit({
			requestId: "old",
			prompt: "old branch",
		});
		const bytes = await readFile(session.filePath, "utf8");
		const leaf = session.leafId;
		expect(() => session.branch("missing")).toThrow(/unknown/i);
		expect(session.leafId).toBe(leaf);
		expect(await readFile(session.filePath, "utf8")).toBe(bytes);

		const gate = deferred();
		const endReached = deferred();
		const unsubscribe = session.subscribe(async (event: AgentEvent) => {
			if (event.type === "agent_end") {
				endReached.resolve();
				await gate.promise;
			}
		});
		const running = session.submit({ requestId: "active", prompt: "active" });
		await endReached.promise;
		expect(() => session.branch(firstLeaf)).toThrow(/active run/i);
		gate.resolve();
		await running;
		unsubscribe();

		session.branch(firstLeaf);
		const callsBefore = provider.mock.calls.length;
		const duplicate = await session.submit({
			requestId: "old",
			prompt: "must not execute",
		});
		expect(duplicate.id).toBe(old.id);
		expect(provider).toHaveBeenCalledTimes(callsBefore);

		let starts = 0;
		const stop = session.subscribe((event) => {
			if (event.type === "agent_start") starts++;
		});
		await session.submit({ requestId: "new", prompt: "new" });
		expect(starts).toBe(1);
		stop();
		await session.submit({ requestId: "newer", prompt: "newer" });
		expect(starts).toBe(1);
	});
});

describe("AgentSession compaction", () => {
	// 摘要请求走同一个 streamFn，用 summarization system prompt 识别并返回脚本化摘要。
	async function createSessionWithTurns(
		turns: number,
		options: { summaries?: string[]; summaryError?: string } = {},
	) {
		const events: AgentEvent[] = [];
		const order: string[] = [];
		const summaryContexts: StreamContext[] = [];
		const inner = createFakeStreamFn(
			Array.from({ length: turns + 4 }, (_, i) => `answer ${i + 1}`),
		);
		const streamFn: StreamFn = (context, signal) => {
			if (context.system.sections.some((s) => s.text.startsWith("Summarize the earlier"))) {
				summaryContexts.push(structuredClone(context));
				order.push("summary");
				const stream = createAssistantMessageEventStream();
				if (options.summaryError) {
					stream.push({
						type: "error", reason: "error",
						error: {
							role: "assistant", content: [], stopReason: "error",
							errorMessage: options.summaryError,
						},
					});
				} else {
					const text = options.summaries?.[summaryContexts.length - 1] ??
						"checkpoint summary";
					stream.push({
						type: "done",
						message: {
							role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
						},
					});
				}
				stream.end();
				return stream;
			}
			return inner(context, signal);
		};
		const session = await AgentSession.create({
			directory: await temporaryDirectory(), system: "base", streamFn,
		});
		session.subscribe((event) => {
			events.push(event);
			if (event.type === "compaction_start") order.push("start");
			if (event.type === "compaction_end") order.push(`end:${event.status}`);
		});
		for (let i = 1; i <= turns; i++)
			await session.submit({ requestId: `r${i}`, prompt: `question ${i}` });
		return { session, events, order, summaryContexts };
	}

	function compactionEventsOf(events: AgentEvent[]): AgentEvent[] {
		return events.filter((event) => event.type.startsWith("compaction"));
	}

	it("manually compacts append-only and emits committed events", async () => {
		const { session, events, order, summaryContexts } =
			await createSessionWithTurns(5);
		const before = await readFile(session.filePath, "utf8");
		const entriesBefore = session.entries.length;

		const entry = await session.compact();

		// start 在摘要 provider 调用前，completed 在 journal append/fsync 后。
		expect(order).toEqual(["start", "summary", "end:completed"]);
		expect(entry).toBeDefined();
		expect(compactionEventsOf(events)).toEqual([
			{
				type: "compaction_start", reason: "manual",
				contextTokens: expect.any(Number),
			},
			{
				type: "compaction_end", reason: "manual", status: "completed",
				entryId: entry!.id, firstKeptEntryId: entry!.firstKeptEntryId,
				tokensBefore: expect.any(Number),
			},
		]);
		// 返回 entry 即 journal 最后一条；旧 bytes/entries 逐字节不变。
		expect(entry).toEqual(session.entries.at(-1));
		expect((await readFile(session.filePath, "utf8")).startsWith(before)).toBe(true);
		expect(session.entries.length).toBe(entriesBefore + 1);

		// state 重建为 summary + retained tail（keepRecentTurns=4：a2..a5 + u3..u5）。
		expect(session.state.messages.map((message) => message.role)).toEqual([
			"system", "user", "assistant", "user", "assistant",
			"user", "assistant", "user", "assistant",
		]);
		const summaryMessage = session.state.messages[1]!;
		expect(summaryMessage.role).toBe("user");
		expect(summaryMessage.role === "user" && text(summaryMessage))
			.toContain("checkpoint summary");
		expect(summaryMessage.role === "user" && text(summaryMessage))
			.toContain("<summary>");

		// reopen 得到相同 state。
		const reopened = await AgentSession.open({
			path: session.filePath, system: "base",
			streamFn: sessionStreamFnStub,
		});
		expect(reopened.state.messages).toEqual(session.state.messages);

		// 第二次压缩：摘要输入含第一份摘要与 a2，不含已丢弃的 raw prefix。
		await session.submit({ requestId: "r6", prompt: "question 6" });
		const second = await session.compact();
		expect(second).toBeDefined();
		expect(summaryContexts).toHaveLength(2);
		const secondRequest = summaryContexts[1]!.messages[0]!;
		const serialized = secondRequest.role === "user" ? text(secondRequest) : "";
		expect(serialized).toContain("checkpoint summary");
		expect(serialized).toContain("answer 2");
		expect(serialized).not.toContain("question 1");
		expect(serialized).not.toContain("answer 1");
	});

	it("does nothing when no eligible prefix exists", async () => {
		const { session, events, summaryContexts } = await createSessionWithTurns(2);
		const before = await readFile(session.filePath, "utf8");

		const result = await session.compact();

		expect(result).toBeUndefined();
		expect(compactionEventsOf(events)).toEqual([]);
		expect(summaryContexts).toEqual([]);
		expect(await readFile(session.filePath, "utf8")).toBe(before);
	});

	it("emits a paired error end and rethrows when the summary provider fails", async () => {
		const { session, events } = await createSessionWithTurns(5, {
			summaryError: "provider exploded",
		});
		const before = await readFile(session.filePath, "utf8");
		const messagesBefore = session.state.messages.slice();

		await expect(session.compact()).rejects.toThrow(/summary/i);

		expect(compactionEventsOf(events)).toEqual([
			{
				type: "compaction_start", reason: "manual",
				contextTokens: expect.any(Number),
			},
			{
				type: "compaction_end", reason: "manual", status: "error",
				errorMessage: expect.stringMatching(/provider exploded/),
			},
		]);
		expect(session.entries.every((entry) => entry.type !== "compaction")).toBe(true);
		expect(await readFile(session.filePath, "utf8")).toBe(before);
		expect(session.state.messages).toEqual(messagesBefore);
	});

	it("emits a paired error end and keeps raw state when the append fails", async () => {
		const { session, events } = await createSessionWithTurns(5);
		const append = SessionJournal.prototype.append;
		const failure = new Error("disk full");
		const spy = vi.spyOn(SessionJournal.prototype, "append").mockImplementation(
			function <TData extends SessionEntryData>(
				this: SessionJournal, data: TData,
			): Promise<SessionEntryBase & TData> {
				if (data.type === "compaction") return Promise.reject(failure);
				return (append<TData>).call(this, data);
			},
		);

		await expect(session.compact()).rejects.toBe(failure);
		spy.mockRestore();

		expect(compactionEventsOf(events)).toEqual([
			{
				type: "compaction_start", reason: "manual",
				contextTokens: expect.any(Number),
			},
			{
				type: "compaction_end", reason: "manual", status: "error",
				errorMessage: "disk full",
			},
		]);
		expect(session.entries.every((entry) => entry.type !== "compaction")).toBe(true);
		// state 不切换为摘要；旧历史仍可 reopen。
		expect(session.state.messages.some((message) =>
			message.role === "user" && text(message).includes("<summary>")
		)).toBe(false);
		const reopened = await AgentSession.open({
			path: session.filePath, system: "base", streamFn: sessionStreamFnStub,
		});
		expect(reopened.state.messages).toEqual(session.state.messages);
	});
});

// reopen 只需要合法 streamFn；这些测试不会在 reopen 后真正请求 provider。
const sessionStreamFnStub: StreamFn = () => {
	throw new Error("unexpected provider call");
};
