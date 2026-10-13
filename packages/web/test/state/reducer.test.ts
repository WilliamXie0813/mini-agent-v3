import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@mini-agent/protocol";
import {
	createInitialAppState,
	reduceAppState,
} from "../../src/state/reducer.ts";
import { envelope } from "./fixtures.ts";

function reduce(messages: ServerMessage[]) {
	return messages.reduce(
		(state, message) =>
			reduceAppState(state, { type: "server.message", message }),
		createInitialAppState(),
	);
}

describe("reduceAppState", () => {
	it("stores ready metadata and selects the first scenario", () => {
		const state = reduce([{
			type: "server.ready",
			protocolVersion: 1,
			capabilities: ["demo_scenarios"],
			scenarios: [
				{ id: "stream", title: "Stream", description: "One response." },
				{ id: "tools", title: "Tools", description: "One tool." },
			],
		}]);

		expect(state.connection).toBe("connected");
		expect(state.scenarios).toHaveLength(2);
		expect(state.selectedScenarioId).toBe("stream");
	});

	it("starts a fresh run and clears previous transient state", () => {
		const prior = {
			...createInitialAppState(),
			prompt: "old prompt",
			selectedTimelineItemId: "old:item",
			run: {
				runId: "old-run",
				status: "completed" as const,
				envelopes: [envelope(0, { type: "agent_start" }, 0, "old-run")],
				diagnostics: [],
			},
		};

		const state = reduceAppState(prior, {
			type: "server.message",
			message: {
				type: "run.accepted",
				requestId: "request-1",
				runId: "run-1",
			},
		});

		expect(state.run).toEqual({
			runId: "run-1",
			status: "running",
			envelopes: [],
			diagnostics: [],
		});
		expect(state.selectedTimelineItemId).toBeUndefined();
		expect(state.lastProtocolError).toBeUndefined();
	});

	it("preserves duplicate raw events and records a diagnostic", () => {
		const accepted = reduce([{
			type: "run.accepted",
			requestId: "request-1",
			runId: "run-1",
		}]);
		const event = envelope(0, { type: "agent_start" });
		const once = reduceAppState(accepted, {
			type: "server.message",
			message: event,
		});
		const twice = reduceAppState(once, {
			type: "server.message",
			message: event,
		});

		expect(twice.run?.envelopes).toHaveLength(2);
		expect(twice.run?.diagnostics).toEqual([{
			code: "DUPLICATE_SEQUENCE",
			message: "Sequence 0 was received more than once.",
			sequence: 0,
		}]);
	});

	it.each(["completed", "aborted", "error", "failed"] as const)(
		"maps settled outcome %s to run status",
		(outcome) => {
			const state = reduce([
				{ type: "run.accepted", requestId: "r", runId: "run-1" },
				{ type: "run.settled", runId: "run-1", outcome },
			]);

			expect(state.run?.status).toBe(outcome);
		},
	);

	it("resets transient workspace state but keeps server metadata", () => {
		const state = reduce([
			{
				type: "server.ready",
				protocolVersion: 1,
				capabilities: ["demo_scenarios"],
				scenarios: [{
					id: "stream",
					title: "Stream",
					description: "One response.",
				}],
			},
			{ type: "run.accepted", requestId: "r", runId: "run-1" },
			{ type: "workspace.reset", requestId: "reset" },
		]);

		expect(state.scenarios).toHaveLength(1);
		expect(state.selectedScenarioId).toBe("stream");
		expect(state.run).toBeUndefined();
		expect(state.prompt).toBe("");
		expect(state.selectedTimelineItemId).toBeUndefined();
	});

	it("records a protocol error without completing the run", () => {
		const state = reduce([
			{ type: "run.accepted", requestId: "r", runId: "run-1" },
			{
				type: "protocol.error",
				requestId: "r",
				code: "RUN_ACTIVE",
				message: "A run is already active.",
			},
		]);

		expect(state.run?.status).toBe("running");
		expect(state.lastProtocolError).toEqual({
			code: "RUN_ACTIVE",
			message: "A run is already active.",
		});
	});
});
