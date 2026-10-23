import type { AgentEvent, SessionEntry } from "@mini-agent/core";

import { PROTOCOL_VERSION } from "./messages.ts";
import type {
	AgentEventEnvelope,
	Capability,
	ClientCommand,
	DecodeResult,
	ProtocolErrorCode,
	ServerMessage,
	SessionSnapshot,
} from "./messages.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function invalid<T>(message: string): DecodeResult<T> {
	return { ok: false, error: { code: "INVALID_MESSAGE", message } };
}

function invalidJson(message: string): DecodeResult<never> {
	return { ok: false, error: { code: "INVALID_JSON", message } };
}

function parseJson(raw: unknown): { ok: true; value: unknown } | { ok: false } {
	if (typeof raw !== "string") return { ok: false };
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { ok: false };
	}
}

// trusted local core event：只校验顶层 event.type，不复制 AgentEvent 联合校验。
function parseEnvelope(value: unknown): AgentEventEnvelope | undefined {
	if (!isRecord(value)) return undefined;
	const { sessionId, sequence, elapsedMs, event } = value;
	if (!isNonEmptyString(sessionId)) return undefined;
	if (!isNonNegativeInteger(sequence)) return undefined;
	if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
	if (!isRecord(event) || typeof event.type !== "string") return undefined;
	return { sessionId, sequence, elapsedMs, event: event as AgentEvent };
}

// snapshot entry 只校验基础字段（type/id/parentId/createdAt），完整联合校验属于 core。
function isSessionEntry(value: unknown): value is SessionEntry {
	if (!isRecord(value)) return false;
	if (typeof value.type !== "string" || !isNonEmptyString(value.id)) return false;
	if (value.parentId !== null && typeof value.parentId !== "string") return false;
	return typeof value.createdAt === "string";
}

function parseSnapshot(value: unknown): SessionSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const { sessionId, leafId, status, entries, transientEvents, latestSequence } = value;
	if (!isNonEmptyString(sessionId)) return undefined;
	if (leafId !== null && typeof leafId !== "string") return undefined;
	if (status !== "idle" && status !== "running" && status !== "compacting") return undefined;
	if (!Array.isArray(entries) || !entries.every(isSessionEntry)) return undefined;
	if (!Array.isArray(transientEvents)) return undefined;
	const envelopes: AgentEventEnvelope[] = [];
	for (const item of transientEvents) {
		const envelope = parseEnvelope(item);
		if (envelope === undefined) return undefined;
		envelopes.push(envelope);
	}
	if (!isNonNegativeInteger(latestSequence)) return undefined;
	return {
		sessionId,
		leafId,
		status,
		entries: entries as SessionEntry[],
		transientEvents: envelopes,
		latestSequence,
	};
}

const COMMAND_TYPES = ["prompt.submit", "run.abort", "session.compact"] as const;

export function decodeClientCommand(raw: unknown): DecodeResult<ClientCommand> {
	const parsed = parseJson(raw);
	if (!parsed.ok) return invalidJson("command is not valid JSON");
	const value = parsed.value;
	if (!isRecord(value)) return invalid("command must be an object");
	if (value.type === "prompt.submit") {
		const { requestId, prompt } = value;
		if (!isNonEmptyString(requestId)) return invalid("requestId must be a non-empty string");
		if (typeof prompt !== "string" || prompt.trim().length === 0) return invalid("prompt must be a non-empty string");
		return { ok: true, value: { type: "prompt.submit", requestId, prompt } };
	}
	if (value.type === "run.abort" || value.type === "session.compact") {
		if (!isNonEmptyString(value.requestId)) return invalid("requestId must be a non-empty string");
		return { ok: true, value: { type: value.type, requestId: value.requestId } };
	}
	return invalid(`unknown command type: ${JSON.stringify(value.type)}`);
}

export function decodeServerMessage(raw: unknown): DecodeResult<ServerMessage> {
	const parsed = parseJson(raw);
	if (!parsed.ok) return invalidJson("message is not valid JSON");
	const value = parsed.value;
	if (!isRecord(value)) return invalid("message must be an object");
	if (value.type === "server.ready") {
		const { protocolVersion, capabilities } = value;
		if (typeof protocolVersion !== "number") return invalid("protocolVersion must be a number");
		if (protocolVersion !== PROTOCOL_VERSION) {
			const error = {
				code: "UNSUPPORTED_PROTOCOL" as const,
				message: `unsupported protocol version: ${protocolVersion}`,
			};
			return { ok: false, error };
		}
		if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === "string")) {
			return invalid("capabilities must be an array of strings");
		}
		const ready: ServerMessage = {
			type: "server.ready",
			protocolVersion,
			capabilities: capabilities as Capability[],
		};
		return { ok: true, value: ready };
	}
	if (value.type === "session.snapshot") {
		const snapshot = parseSnapshot(value.snapshot);
		if (snapshot === undefined) return invalid("invalid session snapshot");
		return { ok: true, value: { type: "session.snapshot", snapshot } };
	}
	if (value.type === "command.accepted") {
		const { requestId, command } = value;
		if (!isNonEmptyString(requestId)) return invalid("requestId must be a non-empty string");
		if (!COMMAND_TYPES.includes(command as (typeof COMMAND_TYPES)[number])) {
			return invalid("unknown command type");
		}
		return { ok: true, value: { type: "command.accepted", requestId, command: command as ClientCommand["type"] } };
	}
	if (value.type === "command.completed") return decodeCommandCompleted(value);
	if (value.type === "agent.event") {
		const envelope = parseEnvelope(value.envelope);
		if (envelope === undefined) return invalid("invalid agent event envelope");
		return { ok: true, value: { type: "agent.event", envelope } };
	}
	if (value.type === "protocol.error") {
		const { requestId, code, message } = value;
		if (requestId !== undefined && typeof requestId !== "string") {
			return invalid("requestId must be a string when present");
		}
		if (typeof code !== "string") return invalid("code must be a string");
		if (typeof message !== "string") return invalid("message must be a string");
		return { ok: true, value: { type: "protocol.error", requestId, code: code as ProtocolErrorCode, message } };
	}
	return invalid(`unknown server message type: ${JSON.stringify(value.type)}`);
}

function decodeCommandCompleted(value: Record<string, unknown>): DecodeResult<ServerMessage> {
	const { requestId, command, result } = value;
	if (!isNonEmptyString(requestId)) return invalid("requestId must be a non-empty string");
	if (command === "prompt.submit") {
		if (!isRecord(result) || !isNonEmptyString(result.submissionId)) {
			return invalid("prompt.submit result requires a submissionId");
		}
		const completion = { submissionId: result.submissionId };
		return { ok: true, value: { type: "command.completed", requestId, command, result: completion } };
	}
	if (command === "run.abort") {
		if (!isRecord(result)) return invalid("run.abort result must be an object");
		return { ok: true, value: { type: "command.completed", requestId, command, result: {} } };
	}
	if (command === "session.compact") {
		const compactResult = parseCompactResult(result);
		if (compactResult === undefined) return invalid("invalid session.compact result");
		return { ok: true, value: { type: "command.completed", requestId, command, result: compactResult } };
	}
	return invalid("unknown command type");
}

function parseCompactResult(value: unknown):
	| { compacted: boolean; entryId?: string; tokensBefore?: number }
	| undefined {
	if (!isRecord(value) || typeof value.compacted !== "boolean") return undefined;
	if (value.entryId !== undefined && typeof value.entryId !== "string") return undefined;
	if (value.tokensBefore !== undefined && typeof value.tokensBefore !== "number") return undefined;
	const result: { compacted: boolean; entryId?: string; tokensBefore?: number } = { compacted: value.compacted };
	if (typeof value.entryId === "string") result.entryId = value.entryId;
	if (typeof value.tokensBefore === "number") result.tokensBefore = value.tokensBefore;
	return result;
}
