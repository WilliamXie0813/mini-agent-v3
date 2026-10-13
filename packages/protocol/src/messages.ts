import type { AgentEvent } from "@mini-agent/core";

export const PROTOCOL_VERSION = 1;

export type Capability =
	| "demo_scenarios"
	| "streaming_messages"
	| "abort_run"
	| "turn_timeline"
	| "raw_event_details";

export const V1_CAPABILITIES: readonly Capability[] = [
	"demo_scenarios",
	"streaming_messages",
	"abort_run",
	"turn_timeline",
	"raw_event_details",
];

export interface DemoScenarioSummary {
	id: string;
	title: string;
	description: string;
}

export type ClientCommand =
	| {
			type: "run.start";
			requestId: string;
			scenarioId: string;
			prompt: string;
	  }
	| { type: "run.abort"; requestId: string }
	| { type: "workspace.reset"; requestId: string };

export interface ServerReadyMessage {
	type: "server.ready";
	protocolVersion: typeof PROTOCOL_VERSION;
	capabilities: Capability[];
	scenarios: DemoScenarioSummary[];
}

export interface RunAcceptedMessage {
	type: "run.accepted";
	requestId: string;
	runId: string;
}

export interface AgentEventMessage {
	type: "agent.event";
	runId: string;
	sequence: number;
	elapsedMs: number;
	event: AgentEvent;
}

export type RunOutcome = "completed" | "aborted" | "error" | "failed";

export interface RunSettledMessage {
	type: "run.settled";
	runId: string;
	outcome: RunOutcome;
}

export interface WorkspaceResetMessage {
	type: "workspace.reset";
	requestId: string;
}

export interface ProtocolErrorMessage {
	type: "protocol.error";
	requestId?: string;
	code: string;
	message: string;
}

export type ServerMessage =
	| ServerReadyMessage
	| RunAcceptedMessage
	| AgentEventMessage
	| RunSettledMessage
	| WorkspaceResetMessage
	| ProtocolErrorMessage;

export type AgentEventEnvelope = AgentEventMessage;

export type DecodeErrorCode =
	| "INVALID_JSON"
	| "INVALID_MESSAGE"
	| "UNSUPPORTED_PROTOCOL";

export type DecodeResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: { code: DecodeErrorCode; message: string };
	  };
