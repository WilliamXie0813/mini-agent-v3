import type { AgentEvent } from "@mini-agent/core";
export { decodeClientCommand } from "./client-guards.ts";
import {
	failure,
	invalid,
	isObject,
	nonEmptyString,
	parseObject,
	success,
} from "./guard-utils.ts";
import {
	PROTOCOL_VERSION,
	V1_CAPABILITIES,
} from "./messages.ts";
import type {
	Capability,
	DecodeResult,
	DemoScenarioSummary,
	RunOutcome,
	ServerMessage,
} from "./messages.ts";

import type { JsonObject } from "./guard-utils.ts";

const outcomes: readonly RunOutcome[] = [
	"completed",
	"aborted",
	"error",
	"failed",
];

export function decodeServerMessage(raw: string): DecodeResult<ServerMessage> {
	const parsed = parseObject(raw);
	if (!parsed.ok) return parsed;
	const message = parsed.value;
	const type = message["type"];
	if (typeof type !== "string")
		return invalid("type must be a non-empty string");

	switch (type) {
		case "server.ready":
			return decodeReady(message);
		case "run.accepted":
			return decodeRunAccepted(message);
		case "agent.event":
			return decodeAgentEvent(message);
		case "run.settled":
			return decodeRunSettled(message);
		case "workspace.reset":
			return decodeWorkspaceReset(message);
		case "protocol.error":
			return decodeProtocolError(message);
		default:
			return invalid(`unknown server message "${type}"`);
	}
}

function decodeReady(message: JsonObject): DecodeResult<ServerMessage> {
	const version = message["protocolVersion"];
	if (version !== PROTOCOL_VERSION) {
		if (typeof version === "number")
			return failure(
				"UNSUPPORTED_PROTOCOL",
				`unsupported protocol version ${version}; expected ${PROTOCOL_VERSION}`,
			);
		return invalid("protocolVersion must be 1");
	}
	const capabilities = message["capabilities"];
	if (!Array.isArray(capabilities) || !capabilities.every(isCapability))
		return invalid("capabilities must contain supported capability strings");
	const scenarios = message["scenarios"];
	if (!Array.isArray(scenarios))
		return invalid("scenarios must be an array");
	const decoded: DemoScenarioSummary[] = [];
	for (const scenario of scenarios) {
		if (!isObject(scenario))
			return invalid("each scenario must be an object");
		const id = nonEmptyString(scenario, "id");
		const title = nonEmptyString(scenario, "title");
		const description = nonEmptyString(scenario, "description");
		if (!id.ok) return id;
		if (!title.ok) return title;
		if (!description.ok) return description;
		decoded.push({ id: id.value, title: title.value, description: description.value });
	}
	return success({
		type: "server.ready",
		protocolVersion: PROTOCOL_VERSION,
		capabilities: capabilities as Capability[],
		scenarios: decoded,
	});
}

function decodeRunAccepted(message: JsonObject): DecodeResult<ServerMessage> {
	const requestId = nonEmptyString(message, "requestId");
	const runId = nonEmptyString(message, "runId");
	if (!requestId.ok) return requestId;
	if (!runId.ok) return runId;
	return success({ type: "run.accepted", requestId: requestId.value, runId: runId.value });
}

function decodeAgentEvent(message: JsonObject): DecodeResult<ServerMessage> {
	const runId = nonEmptyString(message, "runId");
	if (!runId.ok) return runId;
	const sequence = message["sequence"];
	if (!Number.isInteger(sequence) || (sequence as number) < 0)
		return invalid("sequence must be a non-negative integer");
	const elapsedMs = message["elapsedMs"];
	if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0)
		return invalid("elapsedMs must be a non-negative number");
	const event = message["event"];
	if (!isObject(event) || typeof event["type"] !== "string" || event["type"].length === 0)
		return invalid("event.type must be a non-empty string");
	return success({
		type: "agent.event",
		runId: runId.value,
		sequence: sequence as number,
		elapsedMs,
		event: event as AgentEvent,
	});
}

function decodeRunSettled(message: JsonObject): DecodeResult<ServerMessage> {
	const runId = nonEmptyString(message, "runId");
	if (!runId.ok) return runId;
	const outcome = message["outcome"];
	if (typeof outcome !== "string" || !outcomes.includes(outcome as RunOutcome))
		return invalid("outcome must be completed, aborted, error, or failed");
	return success({ type: "run.settled", runId: runId.value, outcome: outcome as RunOutcome });
}

function decodeWorkspaceReset(message: JsonObject): DecodeResult<ServerMessage> {
	const requestId = nonEmptyString(message, "requestId");
	if (!requestId.ok) return requestId;
	return success({ type: "workspace.reset", requestId: requestId.value });
}

function decodeProtocolError(message: JsonObject): DecodeResult<ServerMessage> {
	const requestId = message["requestId"];
	if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0))
		return invalid("requestId must be a non-empty string when provided");
	const code = nonEmptyString(message, "code");
	const errorMessage = nonEmptyString(message, "message");
	if (!code.ok) return code;
	if (!errorMessage.ok) return errorMessage;
	return success({
		type: "protocol.error",
		...(typeof requestId === "string" ? { requestId } : {}),
		code: code.value,
		message: errorMessage.value,
	});
}

function isCapability(value: unknown): value is Capability {
	return typeof value === "string" &&
		(V1_CAPABILITIES as readonly string[]).includes(value);
}
