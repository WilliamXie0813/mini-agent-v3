import type { AgentEventEnvelope } from "@mini-agent/protocol";

type WireEvent = AgentEventEnvelope["event"];
type WireMessage = Extract<WireEvent, { type: "message_end" }>["message"];
export type WireAssistant = Extract<WireMessage, { role: "assistant" }>;

export function envelope(
	sequence: number,
	event: WireEvent,
	elapsedMs = sequence * 10,
	runId = "run-1",
): AgentEventEnvelope {
	return {
		type: "agent.event",
		runId,
		sequence,
		elapsedMs,
		event,
	};
}

export function assistant(
	text: string,
	stopReason: WireAssistant["stopReason"] = "stop",
): WireAssistant {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
	};
}
