import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@mini-agent/protocol";
import { buildChatView } from "../../src/state/chat.ts";
import { assistant, envelope } from "./fixtures.ts";

function textOf(item: ReturnType<typeof buildChatView>[number]): string {
	if (item.kind !== "message") return "";
	return item.message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("buildChatView", () => {
	it("updates one assistant draft and finalizes it authoritatively", () => {
		const events: AgentEventEnvelope[] = [
			envelope(0, {
				type: "message_start",
				message: assistant("", "pending"),
			}),
			envelope(1, {
				type: "message_update",
				message: assistant("a", "pending"),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "a",
					partial: assistant("a", "pending"),
				},
			}),
			envelope(2, {
				type: "message_update",
				message: assistant("ab", "pending"),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "b",
					partial: assistant("ab", "pending"),
				},
			}),
		];
		const streaming = buildChatView(events);

		expect(streaming).toHaveLength(1);
		expect(streaming[0]).toMatchObject({
			kind: "message",
			status: "streaming",
		});
		expect(textOf(streaming[0])).toBe("ab");

		const complete = buildChatView([
			...events,
			envelope(3, {
				type: "message_end",
				message: assistant("authoritative final"),
			}),
		]);
		expect(complete).toHaveLength(1);
		expect(complete[0]).toMatchObject({
			kind: "message",
			status: "complete",
		});
		expect(textOf(complete[0])).toBe("authoritative final");
	});

	it("keeps forty updates as one semantic message", () => {
		const updates = Array.from({ length: 40 }, (_value, index) =>
			envelope(index + 1, {
				type: "message_update",
				message: assistant("x".repeat(index + 1), "pending"),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "x",
					partial: assistant("x".repeat(index + 1), "pending"),
				},
			}),
		);
		const chat = buildChatView([
			envelope(0, {
				type: "message_start",
				message: assistant("", "pending"),
			}),
			...updates,
			envelope(41, {
				type: "message_end",
				message: assistant("x".repeat(40)),
			}),
		]);

		expect(chat).toHaveLength(1);
		expect(textOf(chat[0])).toBe("x".repeat(40));
	});

	it("keeps source-ordered cards while applying completion-ordered events", () => {
		const toolAssistant = {
			role: "assistant" as const,
			content: [
				{ type: "toolCall" as const, id: "c1", name: "slow", arguments: {} },
				{ type: "toolCall" as const, id: "c2", name: "fast", arguments: {} },
				{ type: "toolCall" as const, id: "c3", name: "medium", arguments: {} },
			],
			stopReason: "toolUse" as const,
		};
		const events: AgentEventEnvelope[] = [
			envelope(0, { type: "message_start", message: toolAssistant }),
			envelope(1, { type: "message_end", message: toolAssistant }),
			envelope(2, {
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "slow",
				args: {},
			}),
			envelope(3, {
				type: "tool_execution_start",
				toolCallId: "c2",
				toolName: "fast",
				args: {},
			}),
			envelope(4, {
				type: "tool_execution_start",
				toolCallId: "c3",
				toolName: "medium",
				args: {},
			}),
			envelope(5, {
				type: "tool_execution_end",
				toolCallId: "c2",
				toolName: "fast",
				result: { content: [] },
				isError: false,
				durationMs: 20,
			}),
			envelope(6, {
				type: "tool_execution_end",
				toolCallId: "c3",
				toolName: "medium",
				result: { content: [] },
				isError: false,
				durationMs: 30,
			}),
			envelope(7, {
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "slow",
				result: { content: [] },
				isError: true,
				durationMs: 100,
			}),
			...["c1", "c2", "c3"].map((toolCallId, index) =>
				envelope(8 + index, {
					type: "message_end",
					message: {
						role: "toolResult",
						toolCallId,
						toolName: toolCallId,
						content: [{ type: "text", text: `${toolCallId} result` }],
						isError: toolCallId === "c1",
					},
				}),
			),
		];

		const cards = buildChatView(events).filter(
			(item) => item.kind === "tool",
		);
		expect(cards.map(({ toolCallId }) => toolCallId)).toEqual([
			"c1",
			"c2",
			"c3",
		]);
		expect(cards.map(({ durationMs }) => durationMs)).toEqual([100, 20, 30]);
		expect(cards.map(({ status }) => status)).toEqual([
			"error",
			"completed",
			"completed",
		]);
		expect(cards[0]).toMatchObject({
			resultText: "c1 result",
			status: "error",
		});
	});
});
