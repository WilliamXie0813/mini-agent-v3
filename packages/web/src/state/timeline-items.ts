import type { AgentEventEnvelope } from "@mini-agent/protocol";
import type {
	TimelineAssistantStreamItem,
	TimelineDiagnosticItem,
	TimelineLeafItem,
} from "./types.ts";

export function appendAssistantUpdate(
	items: TimelineLeafItem[],
	envelope: AgentEventEnvelope,
): void {
	const previous = items.at(-1);
	if (previous?.kind === "assistant-stream") {
		previous.envelopes.push(envelope);
		previous.count++;
		return;
	}
	const item: TimelineAssistantStreamItem = {
		kind: "assistant-stream",
		id: `${envelope.runId}:${envelope.sequence}:stream`,
		count: 1,
		envelopes: [envelope],
	};
	items.push(item);
}

export function eventItem(
	envelope: AgentEventEnvelope,
): TimelineLeafItem {
	return {
		kind: "event",
		id: `${envelope.runId}:${envelope.sequence}`,
		eventType: envelope.event.type,
		envelopes: [envelope],
	};
}

export function diagnostic(
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

export function ordered(
	envelopes: AgentEventEnvelope[],
): AgentEventEnvelope[] {
	return envelopes
		.map((envelope, index) => ({ envelope, index }))
		.sort((left, right) =>
			left.envelope.sequence - right.envelope.sequence ||
			left.index - right.index)
		.map(({ envelope }) => envelope);
}
