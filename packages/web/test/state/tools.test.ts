import { describe, expect, it } from "vitest";

import { buildTimeline } from "../../src/state/timeline.ts";
import { buildToolCards } from "../../src/state/tools.ts";
import type {
	AgentEvent,
	AgentEventEnvelope,
	AssistantMessage,
	SessionEntry,
	SessionViewState,
	ToolResult,
} from "../../src/state/types.ts";

const CREATED_AT = "2026-10-23T00:00:00.000Z";

let entryCounter = 0;
function base(parentId: string | null) {
	entryCounter += 1;
	return { id: `e${entryCounter}`, parentId, createdAt: CREATED_AT };
}

function sessionView(
	entries: SessionEntry[],
	events: AgentEventEnvelope[] = [],
): SessionViewState {
	return {
		sessionId: "s1",
		leafId: entries.at(-1)?.id ?? null,
		status: events.length > 0 ? "running" : "idle",
		agentActive: events.length > 0,
		compactionActive: false,
		entries,
		events,
		latestSequence: events.at(-1)?.sequence ?? 0,
		diagnostics: [],
	};
}

function liveEnvelope(sequence: number, event: AgentEvent): AgentEventEnvelope {
	return { sessionId: "s1", sequence, elapsedMs: sequence, event };
}

function toolCall(id: string) {
	return {
		type: "toolCall" as const,
		id,
		name: "read",
		arguments: { path: `${id}.txt` },
	};
}

function toolAssistant(ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => toolCall(id)),
		stopReason: "toolUse",
	};
}

describe("buildToolCards source order vs timeline completion order", () => {
	it("keeps cards in assistant block order and tool-end in event order", () => {
		const assistant: SessionEntry = {
			...base(null),
			type: "message",
			message: toolAssistant(["c1", "c2", "c3"]),
		};
		const events = [
			liveEnvelope(0, {
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "read",
				args: { path: "c1.txt" },
			}),
			liveEnvelope(1, {
				type: "tool_execution_start",
				toolCallId: "c2",
				toolName: "read",
				args: { path: "c2.txt" },
			}),
			liveEnvelope(2, {
				type: "tool_execution_start",
				toolCallId: "c3",
				toolName: "read",
				args: { path: "c3.txt" },
			}),
			liveEnvelope(3, {
				type: "tool_execution_end",
				toolCallId: "c2",
				toolName: "read",
				result: { content: [{ type: "text", text: "two" }] },
				isError: false,
				durationMs: 8,
			}),
			liveEnvelope(4, {
				type: "tool_execution_end",
				toolCallId: "c3",
				toolName: "read",
				result: { content: [{ type: "text", text: "three" }] },
				isError: false,
				durationMs: 9,
			}),
			liveEnvelope(5, {
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "read",
				result: { content: [{ type: "text", text: "one" }] },
				isError: false,
				durationMs: 10,
			}),
		];
		const session = sessionView([assistant], events);

		expect(buildToolCards(session).map((card) => card.toolCallId)).toEqual([
			"c1",
			"c2",
			"c3",
		]);
		expect(
			buildTimeline(session)
				.filter((item) => item.kind === "tool-end")
				.map((item) => item.toolCallId),
		).toEqual(["c2", "c3", "c1"]);

		const c1 = buildToolCards(session)[0];
		expect(c1?.status).toBe("completed");
		expect(c1?.durationMs).toBe(10);
		expect(c1?.isError).toBe(false);
	});
});

describe("buildToolCards durable merge", () => {
	it("merges intent, update, outcome, and toolResult into one card", () => {
		const assistant: SessionEntry = {
			...base(null),
			type: "message",
			message: toolAssistant(["c1", "c2"]),
		};
		const intent1: SessionEntry = {
			...base(assistant.id),
			type: "tool_intent",
			submissionId: "sub-1",
			assistantEntryId: assistant.id,
			toolCallId: "c1",
			tool: { name: "read", description: "", parameters: {} },
			args: { path: "c1.txt" },
			replay: "unsafe",
			sourceIndex: 0,
		};
		const partial: ToolResult = {
			content: [{ type: "text", text: "loading" }],
		};
		const update1: SessionEntry = {
			...base(intent1.id),
			type: "tool_update",
			intentId: intent1.id,
			partialResult: partial,
		};
		const trickyText = "this output mentions error but succeeded";
		const outcome1: SessionEntry = {
			...base(update1.id),
			type: "tool_outcome",
			intentId: intent1.id,
			result: { content: [{ type: "text", text: trickyText }] },
			isError: false,
			durationMs: 42,
		};
		const toolResult1: SessionEntry = {
			...base(outcome1.id),
			type: "message",
			intentId: intent1.id,
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: trickyText }],
				isError: false,
			},
		};
		const intent2: SessionEntry = {
			...base(toolResult1.id),
			type: "tool_intent",
			submissionId: "sub-1",
			assistantEntryId: assistant.id,
			toolCallId: "c2",
			tool: { name: "read", description: "", parameters: {} },
			args: { path: "c2.txt" },
			replay: "unsafe",
			sourceIndex: 1,
		};
		const outcome2: SessionEntry = {
			...base(intent2.id),
			type: "tool_outcome",
			intentId: intent2.id,
			result: { content: [{ type: "text", text: "everything looks fine" }] },
			isError: true,
			durationMs: 7,
		};
		const session = sessionView([
			assistant,
			intent1,
			update1,
			outcome1,
			toolResult1,
			intent2,
			outcome2,
		]);

		const cards = buildToolCards(session);
		expect(cards.map((card) => card.toolCallId)).toEqual(["c1", "c2"]);
		const [first, second] = cards;
		expect(first).toMatchObject({
			toolCallId: "c1",
			toolName: "read",
			status: "completed",
			isError: false,
			durationMs: 42,
			partialResult: partial,
			args: { path: "c1.txt" },
		});
		// isError/duration 来自结构化字段，不从文本猜测。
		expect(second).toMatchObject({
			toolCallId: "c2",
			status: "error",
			isError: true,
			durationMs: 7,
		});
	});
});
