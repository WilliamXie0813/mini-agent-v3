import { describe, expect, it } from "vitest";
import {
	decodeClientCommand,
	decodeServerMessage,
	PROTOCOL_VERSION,
} from "../src/index.ts";

describe("decodeClientCommand", () => {
	it.each([
		{
			type: "run.start",
			requestId: "request-1",
			scenarioId: "streaming-text",
			prompt: "show me the run",
		},
		{ type: "run.abort", requestId: "request-2" },
		{ type: "workspace.reset", requestId: "request-3" },
	])("decodes $type", (command) => {
		expect(decodeClientCommand(JSON.stringify(command))).toEqual({
			ok: true,
			value: command,
		});
	});

	it("reports malformed JSON", () => {
		expect(decodeClientCommand("{")).toEqual({
			ok: false,
			error: {
				code: "INVALID_JSON",
				message: "message must be valid JSON",
			},
		});
	});

	it.each([
		[
			"missing requestId",
			{ type: "run.abort" },
			"requestId must be a non-empty string",
		],
		[
			"empty scenarioId",
			{
				type: "run.start",
				requestId: "request-1",
				scenarioId: "",
				prompt: "hello",
			},
			"scenarioId must be a non-empty string",
		],
		[
			"non-string prompt",
			{
				type: "run.start",
				requestId: "request-1",
				scenarioId: "streaming-text",
				prompt: 42,
			},
			"prompt must be a string",
		],
		[
			"unknown command",
			{ type: "run.pause", requestId: "request-1" },
			'unknown client command "run.pause"',
		],
	])("rejects %s", (_name, message, expectedMessage) => {
		expect(decodeClientCommand(JSON.stringify(message))).toEqual({
			ok: false,
			error: {
				code: "INVALID_MESSAGE",
				message: expectedMessage,
			},
		});
	});
});

describe("decodeServerMessage", () => {
	it("accepts the supported ready protocol", () => {
		const message = {
			type: "server.ready",
			protocolVersion: PROTOCOL_VERSION,
			capabilities: ["demo_scenarios"],
			scenarios: [{
				id: "streaming-text",
				title: "Streaming text",
				description: "Show text deltas.",
			}],
		};

		expect(decodeServerMessage(JSON.stringify(message))).toEqual({
			ok: true,
			value: message,
		});
	});

	it("rejects an unsupported ready protocol", () => {
		const result = decodeServerMessage(JSON.stringify({
			type: "server.ready",
			protocolVersion: 2,
			capabilities: [],
			scenarios: [],
		}));

		expect(result).toEqual({
			ok: false,
			error: {
				code: "UNSUPPORTED_PROTOCOL",
				message: "unsupported protocol version 2; expected 1",
			},
		});
	});

	it("accepts an agent event envelope", () => {
		const message = {
			type: "agent.event",
			runId: "run-1",
			sequence: 0,
			elapsedMs: 1.25,
			event: { type: "agent_start" },
		};

		expect(decodeServerMessage(JSON.stringify(message))).toEqual({
			ok: true,
			value: message,
		});
	});

	it.each([
		{
			type: "run.accepted",
			requestId: "request-1",
			runId: "run-1",
		},
		{
			type: "run.settled",
			runId: "run-1",
			outcome: "completed",
		},
		{
			type: "workspace.reset",
			requestId: "request-2",
		},
		{
			type: "protocol.error",
			requestId: "request-3",
			code: "RUN_ACTIVE",
			message: "A run is already active.",
		},
		{
			type: "protocol.error",
			code: "INVALID_MESSAGE",
			message: "The message is invalid.",
		},
	])("decodes $type", (message) => {
		expect(decodeServerMessage(JSON.stringify(message))).toEqual({
			ok: true,
			value: message,
		});
	});

	it.each([
		[
			"empty runId",
			{
				type: "agent.event",
				runId: "",
				sequence: 0,
				elapsedMs: 0,
				event: { type: "agent_start" },
			},
			"runId must be a non-empty string",
		],
		[
			"negative sequence",
			{
				type: "agent.event",
				runId: "run-1",
				sequence: -1,
				elapsedMs: 0,
				event: { type: "agent_start" },
			},
			"sequence must be a non-negative integer",
		],
		[
			"fractional sequence",
			{
				type: "agent.event",
				runId: "run-1",
				sequence: 1.5,
				elapsedMs: 0,
				event: { type: "agent_start" },
			},
			"sequence must be a non-negative integer",
		],
		[
			"negative elapsedMs",
			{
				type: "agent.event",
				runId: "run-1",
				sequence: 0,
				elapsedMs: -1,
				event: { type: "agent_start" },
			},
			"elapsedMs must be a non-negative number",
		],
		[
			"missing event type",
			{
				type: "agent.event",
				runId: "run-1",
				sequence: 0,
				elapsedMs: 0,
				event: {},
			},
			"event.type must be a non-empty string",
		],
	])("rejects %s", (_name, message, expectedMessage) => {
		expect(decodeServerMessage(JSON.stringify(message))).toEqual({
			ok: false,
			error: {
				code: "INVALID_MESSAGE",
				message: expectedMessage,
			},
		});
	});

	it("rejects an unknown server message", () => {
		expect(decodeServerMessage(JSON.stringify({
			type: "server.pong",
		}))).toEqual({
			ok: false,
			error: {
				code: "INVALID_MESSAGE",
				message: 'unknown server message "server.pong"',
			},
		});
	});

	it("rejects an unknown run outcome", () => {
		expect(decodeServerMessage(JSON.stringify({
			type: "run.settled",
			runId: "run-1",
			outcome: "cancelled",
		}))).toEqual({
			ok: false,
			error: {
				code: "INVALID_MESSAGE",
				message: "outcome must be completed, aborted, error, or failed",
			},
		});
	});
});
