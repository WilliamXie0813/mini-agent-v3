import { describe, expect, it } from "vitest";

import { buildChatView } from "../../src/state/chat.ts";
import type {
	AgentEvent,
	AgentEventEnvelope,
	AssistantMessage,
	AssistantMessageEvent,
	SessionEntry,
	SessionViewState,
	UserMessage,
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

function partialAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "pending",
	};
}

function textDelta(partial: AssistantMessage): AssistantMessageEvent {
	return { type: "text_delta", contentIndex: 0, delta: "x", partial };
}

function durableSession(): SessionViewState {
	const system: SessionEntry = {
		...base(null),
		type: "message",
		message: { role: "system", sections: [{ text: "system prompt" }] },
	};
	const submission: SessionEntry = {
		...base(system.id),
		type: "submission",
		requestId: "r1",
		prompt: "read the file",
	};
	const toolAssistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "let me read" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "b.txt" } },
		],
		stopReason: "toolUse",
		usage: { inputTokens: 10, outputTokens: 4 },
	};
	const assistant: SessionEntry = {
		...base(submission.id),
		type: "message",
		message: toolAssistant,
	};
	const intent1: SessionEntry = {
		...base(assistant.id),
		type: "tool_intent",
		submissionId: submission.id,
		assistantEntryId: assistant.id,
		toolCallId: "c1",
		tool: { name: "read", description: "", parameters: {} },
		args: { path: "a.txt" },
		replay: "unsafe",
		sourceIndex: 0,
	};
	const outcome1: SessionEntry = {
		...base(intent1.id),
		type: "tool_outcome",
		intentId: intent1.id,
		result: { content: [{ type: "text", text: "file a" }] },
		isError: false,
		durationMs: 3,
	};
	const toolResult1: SessionEntry = {
		...base(outcome1.id),
		type: "message",
		intentId: intent1.id,
		message: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "file a" }],
			isError: false,
		},
	};
	const toolResult2: SessionEntry = {
		...base(toolResult1.id),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "c2",
			toolName: "read",
			content: [{ type: "text", text: "file b" }],
			isError: false,
		},
	};
	const finalAssistant: SessionEntry = {
		...base(toolResult2.id),
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "both files read" }],
			stopReason: "stop",
		},
	};
	const runEnd: SessionEntry = {
		...base(finalAssistant.id),
		type: "run_end",
		submissionId: submission.id,
		status: "completed",
	};
	return sessionView([
		system,
		submission,
		assistant,
		intent1,
		outcome1,
		toolResult1,
		toolResult2,
		finalAssistant,
		runEnd,
	]);
}

describe("buildChatView durable journal", () => {
	it("renders each durable message exactly once", () => {
		const items = buildChatView(durableSession());
		expect(items.filter((item) => item.role === "user")).toHaveLength(1);
		expect(items.filter((item) => item.role === "assistant")).toHaveLength(2);
		expect(items.filter((item) => item.role === "toolResult")).toHaveLength(2);
		expect(items).toHaveLength(5);
		expect(items.some((item) => item.text.includes("system prompt"))).toBe(false);
		expect(items[0]).toMatchObject({ role: "user", text: "read the file" });
		const toolCaller = items.find(
			(item) => item.role === "assistant" && item.toolCallIds.length > 0,
		);
		expect(toolCaller?.toolCallIds).toEqual(["c1", "c2"]);
		expect(items.every((item) => item.id.startsWith("entry:"))).toBe(true);
		expect(items.every((item) => !item.streaming)).toBe(true);
	});
});

describe("buildChatView live streaming", () => {
	const user: UserMessage = {
		role: "user",
		content: [{ type: "text", text: "hi" }],
	};
	const finalAssistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "complete text" }],
		stopReason: "stop",
		usage: { inputTokens: 3, outputTokens: 2 },
	};

	function streamingEvents(includeEnd: boolean): AgentEventEnvelope[] {
		const updates = Array.from({ length: 40 }, (_, i) => {
			const partial = partialAssistant(`part-${i}`);
			return liveEnvelope(4 + i, {
				type: "message_update",
				message: partial,
				assistantMessageEvent: textDelta(partial),
			});
		});
		const events: AgentEventEnvelope[] = [
			liveEnvelope(0, { type: "agent_start" }),
			liveEnvelope(1, { type: "message_start", message: user }),
			liveEnvelope(2, { type: "message_end", message: user }),
			liveEnvelope(3, { type: "message_start", message: partialAssistant("") }),
			...updates,
		];
		if (includeEnd) {
			events.push(
				liveEnvelope(44, { type: "message_end", message: finalAssistant }),
			);
		}
		return events;
	}

	it("aggregates 40 updates into one finished assistant message", () => {
		const session = sessionView([], streamingEvents(true));
		const items = buildChatView(session);
		const assistants = items.filter(
			(item) => item.kind === "message" && item.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.text).toBe("complete text");
		expect(assistants[0]?.streaming).toBe(false);
		expect(assistants[0]?.stopReason).toBe("stop");
		const users = items.filter((item) => item.role === "user");
		expect(users).toHaveLength(1);
		expect(users[0]?.text).toBe("hi");
	});

	it("uses the last update text while message_end is missing", () => {
		const session = sessionView([], streamingEvents(false));
		const assistants = buildChatView(session).filter(
			(item) => item.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.text).toBe("part-39");
		expect(assistants[0]?.streaming).toBe(true);
	});
});
