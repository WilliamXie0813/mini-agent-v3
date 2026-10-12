import type { AgentEventEnvelope } from "@mini-agent/protocol";
import type {
	TimelineAssistantStreamItem,
	TimelineDiagnosticItem,
	TimelineItem,
	TimelineLeafItem,
	TimelineTurnItem,
} from "./types.ts";

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
	let turnNumber = 0;

	for (const envelope of ordered(envelopes)) {
		const type = envelope.event.type;
		if (type === "turn_start") {
			if (current) {
				current.items.push(diagnostic(
					"NESTED_TURN",
					"A new turn started before the previous turn ended.",
					envelope,
				));
				output.push(current);
			}
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
		if (type === "message_update") {
			appendAssistantUpdate(current.items, envelope);
		} else {
			current.items.push(eventItem(envelope));
		}
	}

	if (current) {
		output.push(current);
		output.push(diagnostic(
			"UNCLOSED_TURN",
			"Timeline ended before turn_end.",
			current.start,
		));
	}
	return output;
}

function appendAssistantUpdate(
	items: TimelineLeafItem[],
	envelope: AgentEventEnvelope,
): void {
	const previous = items.at(-1);
	if (previous?.kind === "assistant-stream") {
		previous.envelopes.push(envelope);
		previous.count++;
		previous.id = aggregateId(previous.envelopes);
		return;
	}
	const item: TimelineAssistantStreamItem = {
		kind: "assistant-stream",
		id: `${envelope.runId}:${envelope.sequence}-${envelope.sequence}`,
		count: 1,
		envelopes: [envelope],
	};
	items.push(item);
}

function eventItem(envelope: AgentEventEnvelope): TimelineLeafItem {
	return {
		kind: "event",
		id: `${envelope.runId}:${envelope.sequence}`,
		eventType: envelope.event.type,
		envelopes: [envelope],
	};
}

function diagnostic(
	code: string,
	message: string,
	envelope: AgentEventEnvelope,
): TimelineDiagnosticItem {
	return {
		kind: "diagnostic",
		id: `${envelope.runId}:${envelope.sequence}:diagnostic:${code}`,
		code,
		message,
		envelopes: [envelope],
	};
}

function aggregateId(envelopes: AgentEventEnvelope[]): string {
	return `${envelopes[0].runId}:${envelopes[0].sequence}-${envelopes.at(-1)!.sequence}`;
}

function ordered(envelopes: AgentEventEnvelope[]): AgentEventEnvelope[] {
	return envelopes
		.map((envelope, index) => ({ envelope, index }))
		.sort((left, right) =>
			left.envelope.sequence - right.envelope.sequence ||
			left.index - right.index)
		.map(({ envelope }) => envelope);
}
