import type { ServerMessage, SessionSnapshot } from "@mini-agent/protocol";
import { describe, expect, it } from "vitest";

import {
	createInitialAppState,
	reduceAppState,
} from "../../src/state/reducer.ts";
import type {
	AgentEvent,
	AgentEventEnvelope,
	AppState,
	SessionEntry,
} from "../../src/state/types.ts";

function envelope(
	sequence: number,
	event: AgentEvent,
	sessionId = "s1",
): AgentEventEnvelope {
	return { sessionId, sequence, elapsedMs: sequence * 5, event };
}

function runEndEntry(id: string): SessionEntry {
	return {
		type: "run_end",
		id,
		parentId: null,
		createdAt: "2026-10-23T00:00:00.000Z",
		submissionId: "sub-1",
		status: "completed",
	};
}

function snapshot(overrides?: Partial<SessionSnapshot>): SessionSnapshot {
	return {
		sessionId: "s1",
		leafId: null,
		status: "idle",
		entries: [],
		transientEvents: [],
		latestSequence: 0,
		...overrides,
	};
}

function dispatch(state: AppState, message: ServerMessage): AppState {
	return reduceAppState(state, { type: "server.message", message });
}

function withSnapshot(snap: SessionSnapshot): AppState {
	return dispatch(createInitialAppState(), {
		type: "session.snapshot",
		snapshot: snap,
	});
}

describe("reduceAppState", () => {
	it("sets connection to connected on server.ready", () => {
		const state = dispatch(createInitialAppState(), {
			type: "server.ready",
			protocolVersion: 1,
			capabilities: ["journal_replay"],
		});
		expect(state.connection).toBe("connected");
	});

	it("replaces session facts atomically on session.snapshot", () => {
		let state = withSnapshot(
			snapshot({
				status: "running",
				entries: [runEndEntry("e1")],
				transientEvents: [envelope(0, { type: "agent_start" })],
				latestSequence: 0,
			}),
		);
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(1, { type: "turn_start" }),
		});
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(1, { type: "turn_start" }),
		});
		expect(state.session?.diagnostics).toHaveLength(1);

		state = dispatch(state, {
			type: "session.snapshot",
			snapshot: snapshot({ entries: [runEndEntry("e9")], latestSequence: 5 }),
		});
		expect(state.session?.entries.map((entry) => entry.id)).toEqual(["e9"]);
		expect(state.session?.events).toEqual([]);
		expect(state.session?.status).toBe("idle");
		expect(state.session?.latestSequence).toBe(5);
		expect(state.session?.diagnostics).toEqual([]);
	});

	it("accepts sequence 0 on a fresh snapshot with no transient events", () => {
		let state = withSnapshot(snapshot());
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(0, { type: "agent_start" }),
		});
		expect(state.session?.events).toHaveLength(1);
		expect(state.session?.latestSequence).toBe(0);
		expect(state.session?.diagnostics).toEqual([]);
	});

	it("accepts the next sequence after existing events", () => {
		let state = withSnapshot(
			snapshot({
				status: "running",
				transientEvents: [envelope(0, { type: "agent_start" })],
				latestSequence: 0,
			}),
		);
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(1, { type: "turn_start" }),
		});
		expect(state.session?.events.map((item) => item.sequence)).toEqual([0, 1]);
		expect(state.session?.diagnostics).toEqual([]);
	});

	it("ignores live events from a different session", () => {
		let state = withSnapshot(snapshot());
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(0, { type: "agent_start" }, "other-session"),
		});
		expect(state.session?.events).toEqual([]);
	});

	it("drops duplicate sequences and records a diagnostic", () => {
		let state = withSnapshot(snapshot());
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(0, { type: "agent_start" }),
		});
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(0, { type: "agent_start" }),
		});
		expect(state.session?.events).toHaveLength(1);
		expect(state.session?.diagnostics).toHaveLength(1);
		expect(state.session?.diagnostics[0]?.message).toContain("duplicate");
	});

	it("keeps events across a sequence gap and records a diagnostic", () => {
		let state = withSnapshot(snapshot());
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(0, { type: "agent_start" }),
		});
		state = dispatch(state, {
			type: "agent.event",
			envelope: envelope(3, { type: "agent_end", messages: [] }),
		});
		expect(state.session?.events.map((item) => item.sequence)).toEqual([0, 3]);
		expect(state.session?.latestSequence).toBe(3);
		expect(state.session?.diagnostics).toHaveLength(1);
		expect(state.session?.diagnostics[0]?.message).toContain("gap");
	});

	it("tracks pendingRequests through command.accepted and command.completed", () => {
		let state = createInitialAppState();
		state = dispatch(state, {
			type: "command.accepted",
			requestId: "r1",
			command: "prompt.submit",
		});
		expect(state.pendingRequests).toEqual({ r1: "prompt.submit" });
		state = dispatch(state, {
			type: "command.completed",
			requestId: "r1",
			command: "prompt.submit",
			result: { submissionId: "sub-1" },
		});
		expect(state.pendingRequests).toEqual({});
	});

	it("stores protocol.error without faking a run end", () => {
		let state = withSnapshot(snapshot({ status: "running" }));
		state = dispatch(state, {
			type: "command.accepted",
			requestId: "r1",
			command: "prompt.submit",
		});
		const sessionBefore = state.session;
		state = dispatch(state, {
			type: "protocol.error",
			requestId: "r1",
			code: "RUN_ACTIVE",
			message: "a run is already active",
		});
		expect(state.lastProtocolError).toEqual({
			code: "RUN_ACTIVE",
			message: "a run is already active",
		});
		expect(state.pendingRequests).toEqual({});
		expect(state.session).toBe(sessionBefore);
	});

	it("clears diagnostics and invalid selection on reconnect snapshot", () => {
		let state = withSnapshot(snapshot({ entries: [runEndEntry("e1")] }));
		state = reduceAppState(state, {
			type: "timeline.selected",
			itemId: "entry:e1",
		});
		state = dispatch(state, {
			type: "session.snapshot",
			snapshot: snapshot({ entries: [runEndEntry("e2")] }),
		});
		expect(state.selectedTimelineItemId).toBeUndefined();

		let kept = withSnapshot(snapshot({ entries: [runEndEntry("e1")] }));
		kept = reduceAppState(kept, {
			type: "timeline.selected",
			itemId: "entry:e1",
		});
		kept = dispatch(kept, {
			type: "session.snapshot",
			snapshot: snapshot({ entries: [runEndEntry("e1")] }),
		});
		expect(kept.selectedTimelineItemId).toBe("entry:e1");

		let live = withSnapshot(
			snapshot({
				status: "running",
				transientEvents: [envelope(0, { type: "agent_start" })],
			}),
		);
		live = reduceAppState(live, {
			type: "timeline.selected",
			itemId: "event:s1:0",
		});
		live = dispatch(live, {
			type: "session.snapshot",
			snapshot: snapshot({
				status: "running",
				transientEvents: [envelope(0, { type: "agent_start" })],
			}),
		});
		expect(live.selectedTimelineItemId).toBe("event:s1:0");
	});

	it("records local errors as lastProtocolError", () => {
		const state = reduceAppState(createInitialAppState(), {
			type: "local.error",
			code: "EMPTY_PROMPT",
			message: "prompt is blank",
		});
		expect(state.lastProtocolError).toEqual({
			code: "EMPTY_PROMPT",
			message: "prompt is blank",
		});
	});
});
