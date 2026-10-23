import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, decodeClientCommand, decodeServerMessage } from "../src/index.ts";

const encode = (value: unknown): string => JSON.stringify(value);

describe("decodeClientCommand", () => {
	it("accepts a well-formed prompt.submit", () => {
		expect(
			decodeClientCommand(
				encode({ type: "prompt.submit", requestId: "r1", prompt: "hello" }),
			),
		).toEqual({
			ok: true,
			value: { type: "prompt.submit", requestId: "r1", prompt: "hello" },
		});
	});

	it("accepts run.abort and session.compact", () => {
		expect(
			decodeClientCommand(encode({ type: "run.abort", requestId: "r2" })),
		).toEqual({ ok: true, value: { type: "run.abort", requestId: "r2" } });
		expect(
			decodeClientCommand(encode({ type: "session.compact", requestId: "r3" })),
		).toEqual({ ok: true, value: { type: "session.compact", requestId: "r3" } });
	});

	it("rejects malformed JSON with INVALID_JSON", () => {
		expect(decodeClientCommand("{")).toMatchObject({
			ok: false,
			error: { code: "INVALID_JSON" },
		});
	});

	it("rejects non-string raw input with INVALID_JSON", () => {
		for (const raw of [null, undefined, 42, ["prompt.submit"]]) {
			expect(
				decodeClientCommand(raw as unknown as string),
			).toMatchObject({ ok: false, error: { code: "INVALID_JSON" } });
		}
	});

	it("rejects a blank prompt with INVALID_MESSAGE", () => {
		expect(
			decodeClientCommand(
				encode({ type: "prompt.submit", requestId: "r1", prompt: "   " }),
			),
		).toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
	});

	it("rejects an empty requestId", () => {
		for (const type of ["prompt.submit", "run.abort", "session.compact"]) {
			const command =
				type === "prompt.submit"
					? { type, requestId: "", prompt: "hi" }
					: { type, requestId: "" };
			expect(decodeClientCommand(encode(command))).toMatchObject({
				ok: false,
				error: { code: "INVALID_MESSAGE" },
			});
		}
	});

	it("rejects an unknown command type", () => {
		expect(
			decodeClientCommand(encode({ type: "prompt.preview", requestId: "r1" })),
		).toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
	});

	it("rejects array, null, and non-string fields", () => {
		expect(decodeClientCommand(encode([]))).toMatchObject({
			ok: false,
			error: { code: "INVALID_MESSAGE" },
		});
		expect(decodeClientCommand(encode(null))).toMatchObject({
			ok: false,
			error: { code: "INVALID_MESSAGE" },
		});
		expect(
			decodeClientCommand(
				encode({ type: "prompt.submit", requestId: 7, prompt: "hi" }),
			),
		).toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
		expect(
			decodeClientCommand(
				encode({ type: "prompt.submit", requestId: "r1", prompt: 42 }),
			),
		).toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
		expect(decodeClientCommand(encode({ type: 9, requestId: "r1" }))).toMatchObject({
			ok: false,
			error: { code: "INVALID_MESSAGE" },
		});
	});
});

describe("decodeServerMessage", () => {
	it("accepts server.ready with the current protocol version", () => {
		const result = decodeServerMessage(
			encode({
				type: "server.ready",
				protocolVersion: PROTOCOL_VERSION,
				capabilities: ["journal_replay", "abort_run"],
			}),
		);
		expect(result).toEqual({
			ok: true,
			value: {
				type: "server.ready",
				protocolVersion: 1,
				capabilities: ["journal_replay", "abort_run"],
			},
		});
	});

	it("rejects an unsupported protocol version", () => {
		expect(
			decodeServerMessage(
				encode({ type: "server.ready", protocolVersion: 2, capabilities: [] }),
			),
		).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PROTOCOL" } });
	});

	const validEntry = {
		type: "submission",
		id: "e1",
		parentId: null,
		createdAt: "2026-10-16T00:00:00.000Z",
	};

	const validSnapshot = {
		sessionId: "s1",
		leafId: "e1",
		status: "idle",
		entries: [validEntry],
		transientEvents: [],
		latestSequence: 0,
	};

	it("accepts a session.snapshot with valid top-level fields", () => {
		expect(
			decodeServerMessage(encode({ type: "session.snapshot", snapshot: validSnapshot })),
		).toEqual({
			ok: true,
			value: { type: "session.snapshot", snapshot: validSnapshot },
		});
	});

	it("rejects a snapshot with missing sessionId / leafId / status / latestSequence", () => {
		const invalidSnapshots = [
			{ ...validSnapshot, sessionId: "" },
			{ ...validSnapshot, leafId: 1 },
			{ ...validSnapshot, status: "paused" },
			{ ...validSnapshot, latestSequence: -1 },
			{ ...validSnapshot, latestSequence: 0.5 },
		];
		for (const snapshot of invalidSnapshots) {
			expect(
				decodeServerMessage(encode({ type: "session.snapshot", snapshot })),
			).toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
		}
	});

	it("requires each entry to have type / id / parentId / createdAt", () => {
		for (const entry of [
			{ ...validEntry, type: undefined },
			{ ...validEntry, id: "" },
			{ ...validEntry, parentId: undefined },
			{ ...validEntry, createdAt: 5 },
		]) {
			const snapshot = { ...validSnapshot, entries: [entry] };
			expect(
				decodeServerMessage(encode({ type: "session.snapshot", snapshot })),
			).toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
		}
	});

	const validEnvelope = {
		sessionId: "s1",
		sequence: 3,
		elapsedMs: 12,
		event: { type: "turn_start" },
	};

	it("accepts a transient agent.event envelope", () => {
		expect(
			decodeServerMessage(encode({ type: "agent.event", envelope: validEnvelope })),
		).toEqual({ ok: true, value: { type: "agent.event", envelope: validEnvelope } });
	});

	it("requires a non-negative integer sequence and non-negative elapsedMs", () => {
		for (const envelope of [
			{ ...validEnvelope, sequence: -1 },
			{ ...validEnvelope, sequence: 1.5 },
			{ ...validEnvelope, elapsedMs: -0.5 },
			{ ...validEnvelope, event: { type: 9 } },
		]) {
			expect(
				decodeServerMessage(encode({ type: "agent.event", envelope })),
			).toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
		}
	});

	it("rejects snapshot transientEvents with invalid envelopes", () => {
		const snapshot = { ...validSnapshot, transientEvents: [{ ...validEnvelope, sequence: -1 }] };
		expect(
			decodeServerMessage(encode({ type: "session.snapshot", snapshot })),
		).toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
	});

	it("rejects an unknown server message type", () => {
		expect(decodeServerMessage(encode({ type: "server.ping" }))).toMatchObject({
			ok: false,
			error: { code: "INVALID_MESSAGE" },
		});
	});

	it("rejects malformed JSON with INVALID_JSON", () => {
		expect(decodeServerMessage("{")).toMatchObject({
			ok: false,
			error: { code: "INVALID_JSON" },
		});
	});
});
