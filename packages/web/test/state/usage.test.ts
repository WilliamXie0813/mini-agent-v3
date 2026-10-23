import { describe, expect, it } from "vitest";

import type {
	AgentEvent,
	AgentEventEnvelope,
	AssistantMessage,
	SessionEntry,
	SessionViewState,
} from "../../src/state/types.ts";
import { buildUsageTotals } from "../../src/state/usage.ts";

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
		entries,
		events,
		latestSequence: events.at(-1)?.sequence ?? 0,
		diagnostics: [],
	};
}

function liveEnvelope(sequence: number, event: AgentEvent): AgentEventEnvelope {
	return { sessionId: "s1", sequence, elapsedMs: sequence, event };
}

function assistantEntry(message: AssistantMessage): SessionEntry {
	return { ...base(null), type: "message", message };
}

function assistant(
	text: string,
	usage?: AssistantMessage["usage"],
): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
	if (usage) message.usage = usage;
	return message;
}

describe("buildUsageTotals", () => {
	it("sums input/output/cache counters separately", () => {
		const session = sessionView([
			assistantEntry(
				assistant("one", {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
				}),
			),
			assistantEntry(assistant("two", { inputTokens: 4, outputTokens: 3 })),
		]);
		expect(buildUsageTotals(session)).toEqual({
			inputTokens: 14,
			outputTokens: 8,
			cacheReadTokens: 2,
			cacheWriteTokens: 1,
		});
	});

	it("never invents a cost field for assistants without usage", () => {
		const session = sessionView([assistantEntry(assistant("no usage"))]);
		const totals = buildUsageTotals(session);
		expect(totals).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(Object.keys(totals).sort()).toEqual([
			"cacheReadTokens",
			"cacheWriteTokens",
			"inputTokens",
			"outputTokens",
		]);
	});

	it("counts the active-seam live assistant exactly once", () => {
		const durable = assistant("durable", { inputTokens: 10, outputTokens: 5 });
		const liveFinal = assistant("live", { inputTokens: 1, outputTokens: 1 });
		const livePartial: AssistantMessage = {
			...liveFinal,
			stopReason: "pending",
			usage: { inputTokens: 99, outputTokens: 99 },
		};
		const events = [
			liveEnvelope(0, {
				type: "message_update",
				message: livePartial,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "l",
					partial: livePartial,
				},
			}),
			liveEnvelope(1, { type: "message_end", message: liveFinal }),
			liveEnvelope(2, {
				type: "turn_end",
				message: liveFinal,
				toolResults: [],
			}),
			liveEnvelope(3, { type: "agent_end", messages: [liveFinal] }),
		];
		const session = sessionView([assistantEntry(durable)], events);
		expect(buildUsageTotals(session)).toEqual({
			inputTokens: 11,
			outputTokens: 6,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});
});
