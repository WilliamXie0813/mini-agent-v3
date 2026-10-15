import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionJournal } from "../src/session-journal.ts";
import { recoverInterruptedTools } from "../src/session-recovery.ts";
import { toToolDeclarations } from "../src/tool.ts";
import type { ToolCall, ToolDef } from "../src/tool.ts";

const directories: string[] = [];

async function journal(): Promise<SessionJournal> {
	const directory = await mkdtemp(join(tmpdir(), "mini-agent-recovery-"));
	directories.push(directory);
	return SessionJournal.create(directory);
}

function toolCall(
	id: string,
	name: string,
	arguments_: Record<string, unknown> = {},
): ToolCall {
	return { type: "toolCall", id, name, arguments: arguments_ };
}

function tool(
	name: string,
	replay: "safe" | "unsafe",
	execute: ToolDef["execute"],
): ToolDef {
	return {
		name,
		description: `${name} tool`,
		replay,
		parameters: { type: "object" },
		execute,
	};
}

async function appendSubmissionAndAssistant(
	store: SessionJournal,
	calls: ToolCall[],
) {
	const submission = await store.append({
		type: "submission",
		requestId: "request-1",
		prompt: "go",
	});
	const assistant = await store.append({
		type: "message",
		message: {
			role: "assistant",
			content: calls,
			stopReason: "toolUse",
		},
	});
	return { submission, assistant };
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true })
		),
	);
});

describe("recoverInterruptedTools", () => {
	it("bounds an unfinished run before a later submission's terminal assistant", async () => {
		const store = await journal();
		const call = toolCall("c1", "edit");
		const { submission, assistant } =
			await appendSubmissionAndAssistant(store, [call]);
		let executes = 0;
		const edit = tool("edit", "unsafe", async () => {
			executes++;
			return { content: [] };
		});
		const intent = await store.append({
			type: "tool_intent", submissionId: submission.id,
			assistantEntryId: assistant.id, sourceIndex: 0, toolCallId: call.id,
			tool: toToolDeclarations([edit])[0]!, args: {}, replay: "unsafe",
		});
		await store.append({
			type: "tool_update", intentId: intent.id,
			partialResult: { content: [{ type: "text", text: "old partial" }] },
		});
		const later = await store.append({
			type: "submission", requestId: "later", prompt: "later",
		});
		await store.append({
			type: "message",
			message: { role: "assistant", content: [], stopReason: "stop" },
		});
		await store.append({
			type: "run_end", submissionId: later.id, status: "completed",
		});

		await recoverInterruptedTools(store, [edit]);

		expect(executes).toBe(0);
		expect(store.entries.find((entry) =>
			entry.type === "message" && entry.intentId === intent.id
		)).toMatchObject({
			message: {
				role: "toolResult", isError: true,
				content: [
					{ type: "text", text: "old partial" },
					{ type: "text", text: expect.stringMatching(/interrupted/i) },
				],
			},
		});
		expect(store.entries.at(-1)).toMatchObject({
			type: "run_end", submissionId: submission.id, status: "interrupted",
		});
	});

	it("replays a safe intent and preserves committed updates", async () => {
		const store = await journal();
		const call = toolCall("c1", "read", { path: "a.txt" });
		const { submission, assistant } =
			await appendSubmissionAndAssistant(store, [call]);
		const execute = vi.fn(async (
			_args: Record<string, unknown>,
			_signal?: AbortSignal,
			onUpdate?: Parameters<ToolDef["execute"]>[2],
		) => {
			onUpdate?.({ content: [{ type: "text" as const, text: "replayed partial" }] });
			return { content: [{ type: "text" as const, text: "file contents" }] };
		});
		const read = tool("read", "safe", execute);
		const intent = await store.append({
			type: "tool_intent",
			submissionId: submission.id,
			assistantEntryId: assistant.id,
			toolCallId: call.id,
			tool: toToolDeclarations([read])[0]!,
			args: call.arguments,
			replay: "safe",
			sourceIndex: 0,
		});
		await store.append({
			type: "tool_update",
			intentId: intent.id,
			partialResult: {
				content: [{ type: "text", text: "committed partial" }],
			},
		});

		await recoverInterruptedTools(store, [read]);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]?.[0]).toEqual({ path: "a.txt" });
		const updates = store.entries.filter((entry) =>
			entry.type === "tool_update" && entry.intentId === intent.id
		);
		expect(updates).toHaveLength(2);
		expect(store.entries.at(-3)?.type).toBe("tool_outcome");
		expect(store.entries.at(-2)).toMatchObject({
			type: "message",
			intentId: intent.id,
			message: {
				role: "toolResult",
				toolCallId: "c1",
				isError: false,
				content: [{ type: "text", text: "file contents" }],
			},
		});
		expect(store.entries.at(-1)).toMatchObject({
			type: "run_end",
			submissionId: submission.id,
			status: "interrupted",
		});

		await recoverInterruptedTools(store, [read]);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("turns an unsafe pending intent into an interrupted result with partial output", async () => {
		const store = await journal();
		const call = toolCall("c1", "edit", { path: "a.txt" });
		const { submission, assistant } =
			await appendSubmissionAndAssistant(store, [call]);
		const execute = vi.fn(async () => ({ content: [] }));
		const edit = tool("edit", "unsafe", execute);
		const intent = await store.append({
			type: "tool_intent",
			submissionId: submission.id,
			assistantEntryId: assistant.id,
			toolCallId: call.id,
			tool: toToolDeclarations([edit])[0]!,
			args: call.arguments,
			replay: "unsafe",
			sourceIndex: 0,
		});
		for (const value of ["before", "still running"]) {
			await store.append({
				type: "tool_update",
				intentId: intent.id,
				partialResult: {
					content: [{ type: "text", text: value }],
				},
			});
		}

		await recoverInterruptedTools(store, [edit]);

		expect(execute).not.toHaveBeenCalled();
		expect(store.entries.findLast((entry) =>
			entry.type === "message" && entry.intentId === intent.id
		)).toMatchObject({
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "edit",
				isError: true,
				content: [
					{ type: "text", text: "before" },
					{ type: "text", text: "still running" },
					{ type: "text", text: expect.stringMatching(/interrupted.*unsafe/i) },
				],
			},
		});
	});

	it.each([
		["missing tool", []],
		[
			"changed declaration",
			[tool("read", "safe", async () => ({ content: [] }))],
		],
		[
			"no longer safe",
			[tool("read", "unsafe", async () => ({ content: [] }))],
		],
	] as const)("does not replay when the safe contract is %s", async (
		_kind,
		currentTools,
	) => {
		const store = await journal();
		const call = toolCall("c1", "read");
		const { submission, assistant } =
			await appendSubmissionAndAssistant(store, [call]);
		const original = {
			...tool("read", "safe", async () => ({ content: [] })),
			description: "original declaration",
		};
		await store.append({
			type: "tool_intent",
			submissionId: submission.id,
			assistantEntryId: assistant.id,
			toolCallId: call.id,
			tool: toToolDeclarations([original])[0]!,
			args: {},
			replay: "safe",
			sourceIndex: 0,
		});

		await recoverInterruptedTools(store, [...currentTools]);

		expect(store.entries.findLast((entry) => entry.type === "message"))
			.toMatchObject({
				message: {
					role: "toolResult",
					isError: true,
					content: [{
						type: "text",
						text: expect.stringMatching(/interrupted/i),
					}],
				},
			});
	});

	it("does not reexecute committed outcomes and restores message source order", async () => {
		const store = await journal();
		const calls = [toolCall("c1", "first"), toolCall("c2", "second")];
		const { submission, assistant } =
			await appendSubmissionAndAssistant(store, calls);
		const execute = vi.fn(async () => ({ content: [] }));
		const tools = [
			tool("first", "safe", execute),
			tool("second", "safe", execute),
		];
		const intents = [];
		for (const [sourceIndex, definition] of tools.entries()) {
			intents.push(await store.append({
				type: "tool_intent",
				submissionId: submission.id,
				assistantEntryId: assistant.id,
				toolCallId: calls[sourceIndex]!.id,
				tool: toToolDeclarations([definition])[0]!,
				args: {},
				replay: "safe",
				sourceIndex,
			}));
		}
		for (const sourceIndex of [1, 0]) {
			await store.append({
				type: "tool_outcome",
				intentId: intents[sourceIndex]!.id,
				result: {
					content: [{
						type: "text",
						text: `result-${sourceIndex + 1}`,
					}],
				},
				isError: false,
				durationMs: 1,
			});
		}

		await recoverInterruptedTools(store, tools);

		expect(execute).not.toHaveBeenCalled();
		expect(store.entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? [entry.message.toolCallId]
				: []
		)).toEqual(["c1", "c2"]);
	});

	it.each([
		["stop", "completed"],
		["error", "error"],
		["aborted", "aborted"],
	] as const)("only restores a missing %s run_end", async (
		stopReason,
		status,
	) => {
		const store = await journal();
		const submission = await store.append({
			type: "submission",
			requestId: "request-1",
			prompt: "go",
		});
		await store.append({
			type: "message",
			message: {
				role: "assistant",
				content: [],
				stopReason,
			},
		});
		const count = store.entries.length;

		await recoverInterruptedTools(store, []);

		expect(store.entries).toHaveLength(count + 1);
		expect(store.entries.at(-1)).toMatchObject({
			type: "run_end",
			submissionId: submission.id,
			status,
		});
	});

	it("closes calls that never reached the durable execute boundary", async () => {
		const store = await journal();
		const call = toolCall("c1", "read");
		const { submission } = await appendSubmissionAndAssistant(store, [call]);
		const execute = vi.fn(async () => ({ content: [] }));
		const read = tool("read", "safe", execute);

		await recoverInterruptedTools(store, [read]);

		expect(execute).not.toHaveBeenCalled();
		expect(store.entries.findLast((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
		)).toMatchObject({
			message: {
				toolCallId: "c1",
				isError: true,
				content: [{
					text: expect.stringMatching(/durable execute boundary/i),
				}],
			},
		});
		expect(store.entries.at(-1)).toMatchObject({
			type: "run_end",
			submissionId: submission.id,
			status: "interrupted",
		});
	});

	it("does not let an earlier turn with the same toolCallId mask the latest turn", async () => {
		const store = await journal();
		const submission = await store.append({
			type: "submission",
			requestId: "request-1",
			prompt: "go",
		});
		const repeated = toolCall("c1", "read");
		await store.append({
			type: "message",
			message: {
				role: "assistant",
				content: [repeated],
				stopReason: "toolUse",
			},
		});
		await store.append({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "first turn" }],
				isError: false,
			},
		});
		await store.append({
			type: "message",
			message: {
				role: "assistant",
				content: [repeated],
				stopReason: "toolUse",
			},
		});

		await recoverInterruptedTools(store, []);

		expect(store.entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? [entry.message]
				: []
		)).toHaveLength(2);
		expect(store.entries.at(-1)).toMatchObject({
			type: "run_end",
			submissionId: submission.id,
		});
	});
});
