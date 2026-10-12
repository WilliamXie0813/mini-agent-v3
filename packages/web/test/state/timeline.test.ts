import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@mini-agent/protocol";
import { buildTimeline } from "../../src/state/timeline.ts";
import { assistant, envelope } from "./fixtures.ts";

function lifecycle(): AgentEventEnvelope[] {
	return [
		envelope(0, { type: "agent_start" }),
		envelope(1, { type: "turn_start" }),
		envelope(2, {
			type: "message_start",
			message: assistant("", "pending"),
		}),
		envelope(3, {
			type: "message_update",
			message: assistant("a", "pending"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "a",
				partial: assistant("a", "pending"),
			},
		}),
		envelope(4, {
			type: "message_update",
			message: assistant("ab", "pending"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "b",
				partial: assistant("ab", "pending"),
			},
		}),
		envelope(5, {
			type: "tool_execution_end",
			toolCallId: "c2",
			toolName: "fast",
			result: {},
			isError: false,
		}),
		envelope(6, {
			type: "tool_execution_end",
			toolCallId: "c3",
			toolName: "medium",
			result: {},
			isError: false,
		}),
		envelope(7, {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "slow",
			result: {},
			isError: false,
		}),
		envelope(8, {
			type: "turn_end",
			message: assistant("ab"),
			toolResults: [],
		}),
		envelope(9, { type: "turn_start" }),
		envelope(10, {
			type: "message_start",
			message: assistant("", "pending"),
		}),
		envelope(11, {
			type: "message_end",
			message: assistant("final"),
		}),
		envelope(12, {
			type: "turn_end",
			message: assistant("final"),
			toolResults: [],
		}),
		envelope(13, { type: "agent_end", messages: [assistant("final")] }),
	];
}

describe("buildTimeline", () => {
	it("keeps agent events outside two turn groups", () => {
		const timeline = buildTimeline(lifecycle());

		expect(timeline.map(({ kind }) => kind)).toEqual([
			"event",
			"turn",
			"turn",
			"event",
		]);
		expect(timeline.filter((item) => item.kind === "turn")).toHaveLength(2);
	});

	it("aggregates consecutive assistant updates without losing envelopes", () => {
		const firstTurn = buildTimeline(lifecycle()).find(
			(item) => item.kind === "turn",
		);
		if (!firstTurn || firstTurn.kind !== "turn")
			throw new Error("expected first turn");
		const stream = firstTurn.items.find(
			(item) => item.kind === "assistant-stream",
		);

		expect(stream).toMatchObject({
			kind: "assistant-stream",
			count: 2,
			id: "run-1:3:stream",
		});
		expect(stream?.envelopes.map(({ sequence }) => sequence)).toEqual([3, 4]);
	});

	it("keeps a streaming aggregate id stable as new updates arrive", () => {
		const first = buildTimeline(lifecycle().slice(0, 4));
		const second = buildTimeline(lifecycle().slice(0, 5));
		const firstTurn = first.find((item) => item.kind === "turn");
		const secondTurn = second.find((item) => item.kind === "turn");
		if (firstTurn?.kind !== "turn" || secondTurn?.kind !== "turn")
			throw new Error("expected turn groups");
		const firstStream = firstTurn.items.find(
			(item) => item.kind === "assistant-stream",
		);
		const secondStream = secondTurn.items.find(
			(item) => item.kind === "assistant-stream",
		);

		expect(firstStream?.id).toBe(secondStream?.id);
	});

	it("preserves tool completion sequence", () => {
		const firstTurn = buildTimeline(lifecycle()).find(
			(item) => item.kind === "turn",
		);
		if (!firstTurn || firstTurn.kind !== "turn")
			throw new Error("expected first turn");

		expect(firstTurn.items
			.filter(
				(item) =>
					item.kind === "event" &&
					item.eventType === "tool_execution_end",
			)
			.map((item) =>
				item.kind === "event" &&
				item.envelopes[0].event.type === "tool_execution_end"
					? item.envelopes[0].event.toolCallId
					: "",
			)).toEqual(["c2", "c3", "c1"]);
	});

	it("keeps unknown and structurally misplaced events as diagnostics", () => {
		const unknown = envelope(
			1,
			{ type: "future_event" } as unknown as AgentEventEnvelope["event"],
		);
		const timeline = buildTimeline([
			envelope(0, { type: "agent_start" }),
			unknown,
			envelope(2, { type: "turn_start" }),
			envelope(3, {
				type: "message_start",
				message: assistant("", "pending"),
			}),
		]);

		expect(timeline.some(
			(item) =>
				item.kind === "diagnostic" &&
				item.envelopes[0] === unknown,
		)).toBe(true);
		expect(timeline.some(
			(item) =>
				item.kind === "diagnostic" &&
				item.code === "UNCLOSED_TURN",
		)).toBe(true);
	});

	it.each([
		{
			name: "message end without start",
			events: [
				envelope(2, {
					type: "message_end",
					message: assistant("ended first"),
				}),
			],
			code: "MESSAGE_END_WITHOUT_START",
		},
		{
			name: "message update without start",
			events: [
				envelope(2, {
					type: "message_update",
					message: assistant("orphan", "pending"),
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "orphan",
						partial: assistant("orphan", "pending"),
					},
				}),
			],
			code: "MESSAGE_UPDATE_WITHOUT_START",
		},
		{
			name: "overlapping message starts",
			events: [
				envelope(2, {
					type: "message_start",
					message: assistant("", "pending"),
				}),
				envelope(3, {
					type: "message_start",
					message: assistant("second", "pending"),
				}),
			],
			code: "OVERLAPPING_MESSAGE_START",
		},
	])("diagnoses $name", ({ events, code }) => {
		const timeline = buildTimeline([
			envelope(0, { type: "agent_start" }),
			envelope(1, { type: "turn_start" }),
			...events,
			envelope(8, {
				type: "turn_end",
				message: assistant("done"),
				toolResults: [],
			}),
			envelope(9, { type: "agent_end", messages: [] }),
		]);
		const turn = timeline.find((item) => item.kind === "turn");
		if (turn?.kind !== "turn") throw new Error("expected a turn");

		expect(turn.items.some(
			(item) => item.kind === "diagnostic" && item.code === code,
		)).toBe(true);
	});
});
