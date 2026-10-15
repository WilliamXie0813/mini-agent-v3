import {
	toolDeclarationsEqual,
} from "@mini-agent/ai";
import type {
	AssistantMessage,
	ContentBlock,
	ToolResultMessage,
} from "@mini-agent/ai";
import { finalizeToolCall } from "./finalize-tool-call.ts";
import { SessionJournal } from "./session-journal.ts";
import type {
	SessionEntry,
	SessionEntryOf,
} from "./session-types.ts";
import { executePreparedToolCall } from "./tool-call.ts";
import type {
	ToolCall,
	ToolDef,
	ToolResult,
} from "./tool.ts";

function lastUnfinishedSubmission(
	path: readonly SessionEntry[],
): SessionEntryOf<"submission"> | undefined {
	const ended = new Set(path.flatMap((entry) =>
		entry.type === "run_end" ? [entry.submissionId] : []
	));
	return path.findLast((entry): entry is SessionEntryOf<"submission"> =>
		entry.type === "submission" && !ended.has(entry.id)
	);
}

function statusFor(message: AssistantMessage): "completed" | "error" | "aborted" {
	if (message.stopReason === "error") return "error";
	if (message.stopReason === "aborted") return "aborted";
	return "completed";
}

function resultMessage(
	call: ToolCall,
	result: ToolResult,
	isError: boolean,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: result.content ?? [],
		isError,
	};
}

function interruptedResult(
	content: ContentBlock[],
	text: string,
): ToolResult {
	return {
		content: [...content, { type: "text", text }],
		isError: true,
	};
}

async function appendOutcomeAndMessage(
	journal: SessionJournal,
	call: ToolCall,
	intent: SessionEntryOf<"tool_intent">,
	result: ToolResult,
	isError: boolean,
	durationMs?: number,
): Promise<void> {
	await journal.append({
		type: "tool_outcome",
		intentId: intent.id,
		result,
		isError,
		...(durationMs === undefined ? {} : { durationMs }),
	});
	await journal.append({
		type: "message",
		intentId: intent.id,
		message: resultMessage(call, result, isError),
	});
}

export async function recoverInterruptedTools(
	journal: SessionJournal,
	tools: readonly ToolDef<any>[],
): Promise<void> {
	const path = journal.pathTo();
	const submission = lastUnfinishedSubmission(path);
	if (!submission) return;
	const submissionIndex = path.indexOf(submission);
	const runEntries = path.slice(submissionIndex + 1);
	const assistantEntry = runEntries.findLast(
		(entry): entry is SessionEntryOf<"message"> =>
			entry.type === "message" && entry.message.role === "assistant",
	);
	if (!assistantEntry || assistantEntry.message.role !== "assistant") return;
	const assistantIndex = runEntries.indexOf(assistantEntry);
	const toolEntries = runEntries.slice(assistantIndex + 1);
	const calls = assistantEntry.message.content.filter(
		(block): block is ToolCall => block.type === "toolCall",
	);
	if (calls.length === 0) {
		await journal.append({
			type: "run_end",
			submissionId: submission.id,
			status: statusFor(assistantEntry.message),
		});
		return;
	}

	const intents = new Map<number, SessionEntryOf<"tool_intent">>();
	for (const entry of toolEntries) {
		if (
			entry.type === "tool_intent" &&
			entry.assistantEntryId === assistantEntry.id
		) intents.set(entry.sourceIndex, entry);
	}
	const outcomes = new Map<string, SessionEntryOf<"tool_outcome">>();
	const updates = new Map<string, SessionEntryOf<"tool_update">[]>();
	const messages = new Set<string>();
	const resultCallIds = new Set<string>();
	for (const entry of toolEntries) {
		if (entry.type === "tool_outcome") outcomes.set(entry.intentId, entry);
		if (entry.type === "tool_update") {
			const values = updates.get(entry.intentId) ?? [];
			values.push(entry);
			updates.set(entry.intentId, values);
		}
		if (entry.type === "message" && entry.message.role === "toolResult") {
			if (entry.intentId) messages.add(entry.intentId);
			resultCallIds.add(entry.message.toolCallId);
		}
	}

	for (const [sourceIndex, call] of calls.entries()) {
		const intent = intents.get(sourceIndex);
		if (
			resultCallIds.has(call.id) ||
			(intent && messages.has(intent.id))
		) continue;
		if (!intent) {
			await journal.append({
				type: "message",
				message: resultMessage(
					call,
					interruptedResult([], `Tool "${call.name}" was interrupted before reaching the durable execute boundary and was not executed.`),
					true,
				),
			});
			continue;
		}
		const outcome = outcomes.get(intent.id);
		if (outcome) {
			await journal.append({
				type: "message",
				intentId: intent.id,
				message: resultMessage(
					call,
					outcome.result,
					outcome.isError,
				),
			});
			continue;
		}
		const tool = tools.find(({ name }) => name === intent.tool.name);
		const canReplay = intent.replay === "safe" &&
			tool?.replay === "safe" &&
			toolDeclarationsEqual(tool, intent.tool);
		if (canReplay && tool) {
			const executed = await executePreparedToolCall({
				kind: "prepared",
				toolCall: call,
				tool,
				args: intent.args,
				startedAt: performance.now(),
			}, undefined, async (partialResult) => {
				await journal.append({
					type: "tool_update",
					intentId: intent.id,
					partialResult,
				});
			});
			const finalized = finalizeToolCall(executed);
			await appendOutcomeAndMessage(
				journal,
				call,
				intent,
				finalized.result,
				finalized.isError,
				finalized.durationMs,
			);
			continue;
		}
		const partialContent = (updates.get(intent.id) ?? []).flatMap(
			(entry) => entry.partialResult.content ?? [],
		);
		const result = interruptedResult(
			partialContent,
			`Tool "${call.name}" was interrupted before a durable result and was not replayed because replay is unsafe or its declaration changed.`,
		);
		await appendOutcomeAndMessage(journal, call, intent, result, true);
	}
	await journal.append({
		type: "run_end",
		submissionId: submission.id,
		status: "interrupted",
	});
}
