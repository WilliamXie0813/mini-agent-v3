import type { AgentEvent, SessionEntry } from "@mini-agent/core";

export const PROTOCOL_VERSION = 1;

export type Capability =
	| "journal_replay"
	| "streaming_messages"
	| "tool_timeline"
	| "abort_run"
	| "manual_compaction"
	| "token_usage";

export interface AgentEventEnvelope {
	sessionId: string;
	sequence: number;
	elapsedMs: number;
	event: AgentEvent;
}

export interface SessionSnapshot {
	sessionId: string;
	leafId: string | null;
	status: "idle" | "running" | "compacting";
	entries: SessionEntry[]; // active path only
	transientEvents: AgentEventEnvelope[]; // current operation only
	latestSequence: number;
}

export type ClientCommand =
	| { type: "prompt.submit"; requestId: string; prompt: string }
	| { type: "run.abort"; requestId: string }
	| { type: "session.compact"; requestId: string };

export type CommandCompletion =
	| {
			command: "prompt.submit";
			result: { submissionId: string };
	  }
	| {
			command: "run.abort";
			result: Record<string, never>;
	  }
	| {
			command: "session.compact";
			result: {
				compacted: boolean;
				entryId?: string;
				tokensBefore?: number;
			};
	  };

export type ProtocolErrorCode =
	| "INVALID_JSON"
	| "INVALID_MESSAGE"
	| "RUN_ACTIVE"
	| "NO_ACTIVE_RUN"
	| "COMMAND_FAILED"
	| "UNSUPPORTED_PROTOCOL";

export type ServerMessage =
	| {
			type: "server.ready";
			protocolVersion: 1;
			capabilities: Capability[];
	  }
	| { type: "session.snapshot"; snapshot: SessionSnapshot }
	| {
			type: "command.accepted";
			requestId: string;
			command: ClientCommand["type"];
	  }
	| ({
			type: "command.completed";
			requestId: string;
	  } & CommandCompletion)
	| {
			type: "agent.event";
			envelope: AgentEventEnvelope;
	  }
	| {
			type: "protocol.error";
			requestId?: string;
			code: ProtocolErrorCode;
			message: string;
	  };

export type DecodeResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: {
				code:
					| "INVALID_JSON"
					| "INVALID_MESSAGE"
					| "UNSUPPORTED_PROTOCOL";
				message: string;
			};
	  };
