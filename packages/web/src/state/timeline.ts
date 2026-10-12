import type { AgentEventEnvelope } from "@mini-agent/protocol";
import type {
	TimelineItem,
	TimelineTurnItem,
} from "./types.ts";
import {
	appendAssistantUpdate,
	diagnostic,
	eventItem,
	ordered,
} from "./timeline-items.ts";

const knownEvents = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

export function buildTimeline(
	envelopes: AgentEventEnvelope[],
): TimelineItem[] {
	const output: TimelineItem[] = [];
	let current: TimelineTurnItem | undefined;
	let openMessage:
		| { role: string; envelope: AgentEventEnvelope }
		| undefined;
	let turnNumber = 0;

	for (const envelope of ordered(envelopes)) {
		const type = envelope.event.type;
		if (type === "turn_start") {
			if (current) {
				if (openMessage) {
					current.items.push(diagnostic(
						"UNCLOSED_MESSAGE",
						"A message remained open when the next turn started.",
						openMessage.envelope,
					));
				}
				current.items.push(diagnostic(
					"NESTED_TURN",
					"A new turn started before the previous turn ended.",
					envelope,
				));
				output.push(current);
			}
			openMessage = undefined;
			current = {
				kind: "turn",
				id: `${envelope.runId}:turn:${++turnNumber}:${envelope.sequence}`,
				turnNumber,
				start: envelope,
				items: [],
			};
			continue;
		}
		if (type === "turn_end") {
			if (!current) {
				output.push(diagnostic(
					"TURN_END_WITHOUT_START",
					"A turn ended without a matching turn_start.",
					envelope,
				));
				continue;
			}
			if (openMessage) {
				current.items.push(diagnostic(
					"UNCLOSED_MESSAGE",
					"A message remained open when the turn ended.",
					openMessage.envelope,
				));
				openMessage = undefined;
			}
			current.end = envelope;
			output.push(current);
			current = undefined;
			continue;
		}
		if (type === "agent_start" || type === "agent_end") {
			if (current) {
				current.items.push(diagnostic(
					"AGENT_EVENT_INSIDE_TURN",
					`${type} appeared before the current turn closed.`,
					envelope,
				));
			} else {
				output.push(eventItem(envelope));
			}
			continue;
		}

		const target = current?.items ?? output;
		if (!knownEvents.has(type)) {
			target.push(diagnostic(
				"UNKNOWN_EVENT",
				`Unknown agent event "${type}".`,
				envelope,
			));
			continue;
		}
		if (!current) {
			output.push(diagnostic(
				"EVENT_OUTSIDE_TURN",
				`${type} appeared outside a turn.`,
				envelope,
			));
			continue;
		}
		if (type === "message_start") {
			if (openMessage) {
				current.items.push(diagnostic(
					"OVERLAPPING_MESSAGE_START",
					"A message started before the previous message ended.",
					envelope,
				));
			} else {
				openMessage = {
					role: envelope.event.type === "message_start"
						? envelope.event.message.role
						: "",
					envelope,
				};
				current.items.push(eventItem(envelope));
			}
			continue;
		}
		if (type === "message_update") {
			if (!openMessage) {
				current.items.push(diagnostic(
					"MESSAGE_UPDATE_WITHOUT_START",
					"A message update arrived without message_start.",
					envelope,
				));
			} else if (openMessage.role !== "assistant") {
				current.items.push(diagnostic(
					"MESSAGE_UPDATE_FOR_NON_ASSISTANT",
					"A message update targeted a non-assistant message.",
					envelope,
				));
			} else {
				appendAssistantUpdate(current.items, envelope);
			}
			continue;
		}
		if (type === "message_end") {
			if (!openMessage) {
				current.items.push(diagnostic(
					"MESSAGE_END_WITHOUT_START",
					"A message ended without message_start.",
					envelope,
				));
			} else {
				current.items.push(eventItem(envelope));
				openMessage = undefined;
			}
			continue;
		}
		current.items.push(eventItem(envelope));
	}

	if (current) {
		if (openMessage) {
			current.items.push(diagnostic(
				"UNCLOSED_MESSAGE",
				"Timeline ended before message_end.",
				openMessage.envelope,
			));
		}
		output.push(current);
		output.push(diagnostic(
			"UNCLOSED_TURN",
			"Timeline ended before turn_end.",
			current.start,
		));
	}
	return output;
}
