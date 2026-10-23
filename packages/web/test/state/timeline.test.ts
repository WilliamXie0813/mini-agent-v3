import { describe, expect, it } from "vitest";

import { buildTimeline } from "../../src/state/timeline.ts";
import type {
	AgentEvent,
	AgentEventEnvelope,
	AssistantMessage,
	SessionEntry,
	SessionViewState,
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
	diagnostics: SessionViewState["diagnostics"] = [],
): SessionViewState {
	return {
		sessionId: "s1",
		leafId: entries.at(-1)?.id ?? null,
		status: events.length > 0 ? "running" : "idle",
		entries,
		events,
		latestSequence: events.at(-1)?.sequence ?? 0,
		diagnostics,
	};
}

function liveEnvelope(sequence: number, event: AgentEvent): AgentEventEnvelope {
	return { sessionId: "s1", sequence, elapsedMs: sequence, event };
}

function assistantEntry(): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		stopReason: "stop",
	};
	return { ...base(null), type: "message", message };
}

describe("buildTimeline journal rows", () => {
	it("maps entries to journal items with entry ids and raw payloads", () => {
		const submission: SessionEntry = {
			...base(null),
			type: "submission",
			requestId: "r1",
			prompt: "hello",
		};
		const assistant = assistantEntry();
		const runEnd: SessionEntry = {
			...base(assistant.id),
			type: "run_end",
			submissionId: submission.id,
			status: "completed",
		};
		const items = buildTimeline(sessionView([submission, assistant, runEnd]));
		expect(items.map((item) => item.kind)).toEqual([
			"submission",
			"message",
			"run-end",
		]);
		expect(items.map((item) => item.id)).toEqual([
			`entry:${submission.id}`,
			`entry:${assistant.id}`,
			`entry:${runEnd.id}`,
		]);
		expect(items.every((item) => item.source === "journal")).toBe(true);
		expect(items[0]?.raw).toEqual([submission]);
	});

	it("renders a journal compaction marker with reason and tokensBefore", () => {
		const compaction: SessionEntry = {
			...base(null),
			type: "compaction",
			reason: "manual",
			summary: "summary",
			firstKeptEntryId: "e1",
			tokensBefore: 1234,
		};
		const items = buildTimeline(sessionView([compaction]));
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			source: "journal",
			kind: "compaction",
			id: `entry:${compaction.id}`,
		});
		expect(items[0]?.label).toContain("manual");
		expect(items[0]?.label).toContain("1234");
	});
});

describe("buildTimeline live rows", () => {
	it("layers agent/turn/message/tool events in sequence order", () => {
		const events = [
			liveEnvelope(0, { type: "agent_start" }),
			liveEnvelope(1, { type: "turn_start" }),
			liveEnvelope(2, {
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "read",
				args: {},
			}),
			liveEnvelope(3, {
				type: "tool_execution_update",
				toolCallId: "c1",
				toolName: "read",
				args: {},
				partialResult: { content: [{ type: "text", text: "…" }] },
			}),
			liveEnvelope(4, {
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "read",
				result: { content: [{ type: "text", text: "done" }] },
				isError: false,
			}),
			liveEnvelope(5, { type: "turn_end", message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			}, toolResults: [] }),
			liveEnvelope(6, { type: "agent_end", messages: [] }),
		];
		const items = buildTimeline(sessionView([], events));
		expect(items.map((item) => item.kind)).toEqual([
			"agent",
			"turn",
			"tool-start",
			"tool-update-live",
			"tool-end",
			"turn",
			"agent",
		]);
		expect(items.every((item) => item.source === "live")).toBe(true);
		expect(items[0]?.id).toBe("event:s1:0");
		expect(items[2]?.raw).toEqual([events[2]]);
	});

	it("aggregates consecutive message_update events into one stream item", () => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			stopReason: "pending",
		};
		const events = [0, 1, 2].map((i) =>
			liveEnvelope(i, {
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "x",
					partial,
				},
			}),
		);
		const items = buildTimeline(sessionView([], events));
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("assistant-stream");
		expect(items[0]?.label).toContain("3");
		expect(items[0]?.raw).toHaveLength(3);
		expect(items[0]?.warning).toContain("message_update");
	});

	it("marks live compaction start/end as in-progress, completed, or failed", () => {
		const events = [
			liveEnvelope(0, {
				type: "compaction_start",
				reason: "manual",
				contextTokens: 100,
			}),
			liveEnvelope(1, {
				type: "compaction_end",
				reason: "manual",
				status: "completed",
				entryId: "e9",
				firstKeptEntryId: "e3",
				tokensBefore: 1234,
			}),
		];
		const items = buildTimeline(sessionView([], events));
		expect(items.map((item) => item.kind)).toEqual([
			"compaction",
			"compaction",
		]);
		expect(items.every((item) => item.source === "live")).toBe(true);
		expect(items[0]?.label).toContain("progress");
		expect(items[1]?.label).toContain("completed");
		expect(items[1]?.label).toContain("1234");

		const failed = buildTimeline(
			sessionView([], [
				liveEnvelope(0, {
					type: "compaction_end",
					reason: "threshold",
					status: "error",
					errorMessage: "boom",
				}),
			]),
		);
		expect(failed[0]?.label).toContain("failed");
	});
});

describe("buildTimeline unknown and out-of-order events", () => {
	it("keeps raw JSON and warns on an unknown event type", () => {
		const mystery = JSON.parse(
			JSON.stringify({ type: "mystery_event", extra: 1 }),
		) as AgentEvent;
		const items = buildTimeline(sessionView([], [liveEnvelope(0, mystery)]));
		expect(items).toHaveLength(1);
		expect(items[0]?.warning).toContain("mystery_event");
		expect(items[0]?.raw).toHaveLength(1);
		expect(items[0]?.source).toBe("live");
	});

	it("warns on turn_end without turn_start but keeps the event", () => {
		const event = liveEnvelope(0, {
			type: "turn_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				stopReason: "stop",
			},
			toolResults: [],
		});
		const items = buildTimeline(sessionView([], [event]));
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("turn");
		expect(items[0]?.warning).toContain("turn_start");
		expect(items[0]?.raw).toEqual([event]);
	});

	it("surfaces session diagnostics as timeline items", () => {
		const items = buildTimeline(
			sessionView([], [], [{ id: "diag:s1:1", message: "sequence gap" }]),
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: "diag:s1:1",
			source: "diagnostic",
			kind: "diagnostic",
			label: "sequence gap",
		});
	});
});
