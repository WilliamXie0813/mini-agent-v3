import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@mini-agent/protocol";
import type {
	ProtocolClient,
	ProtocolClientOptions,
} from "../src/protocol-client.ts";
import { useAgentSession } from "../src/use-agent-session.ts";

function sessionHarness() {
	let options: ProtocolClientOptions | undefined;
	const client: ProtocolClient = {
		connect: vi.fn(),
		send: vi.fn(),
		close: vi.fn(),
	};
	const ids = ["request-1", "request-2", "request-3", "request-4"];
	const hook = renderHook(() => useAgentSession({
		url: "ws://localhost/agent",
		createClient: (value) => {
			options = value;
			return client;
		},
		createRequestId: () => ids.shift() ?? "request-fallback",
	}));
	if (!options) throw new Error("protocol client was not created");
	return {
		...hook,
		client,
		serverMessage(message: ServerMessage) {
			act(() => options?.onMessage(message));
		},
		connection(state: Parameters<ProtocolClientOptions["onConnectionChange"]>[0]) {
			act(() => options?.onConnectionChange(state));
		},
	};
}

const ready: ServerMessage = {
	type: "server.ready",
	protocolVersion: 1,
	capabilities: ["demo_scenarios"],
	scenarios: [{
		id: "streaming-text",
		title: "Streaming text",
		description: "One streamed message.",
	}],
};

describe("useAgentSession", () => {
	it("connects once and closes on unmount", () => {
		const session = sessionHarness();

		expect(session.client.connect).toHaveBeenCalledTimes(1);
		session.unmount();
		expect(session.client.close).toHaveBeenCalledTimes(1);
	});

	it("sends run, abort, and reset commands with request ids", () => {
		const session = sessionHarness();
		session.serverMessage(ready);
		act(() => {
			session.result.current.actions.onPromptChange("Run this demo.");
		});

		act(() => session.result.current.actions.onRun());
		act(() => session.result.current.actions.onAbort());
		act(() => session.result.current.actions.onReset());

		expect(session.client.send).toHaveBeenNthCalledWith(1, {
			type: "run.start",
			requestId: "request-1",
			scenarioId: "streaming-text",
			prompt: "Run this demo.",
		});
		expect(session.client.send).toHaveBeenNthCalledWith(2, {
			type: "run.abort",
			requestId: "request-2",
		});
		expect(session.client.send).toHaveBeenNthCalledWith(3, {
			type: "workspace.reset",
			requestId: "request-3",
		});
	});

	it("does not send a run for a blank prompt", () => {
		const session = sessionHarness();
		session.serverMessage(ready);
		act(() => session.result.current.actions.onPromptChange("   "));

		act(() => session.result.current.actions.onRun());

		expect(session.client.send).not.toHaveBeenCalled();
	});

	it("replaces old run data on accepted and maps settlement", () => {
		const session = sessionHarness();
		session.serverMessage(ready);
		session.serverMessage({
			type: "run.accepted",
			requestId: "request-1",
			runId: "run-old",
		});
		session.serverMessage({
			type: "agent.event",
			runId: "run-old",
			sequence: 0,
			elapsedMs: 0,
			event: { type: "agent_start" },
		});
		session.serverMessage({
			type: "run.accepted",
			requestId: "request-2",
			runId: "run-new",
		});

		expect(session.result.current.state.run).toMatchObject({
			runId: "run-new",
			status: "running",
			envelopes: [],
		});

		session.serverMessage({
			type: "run.settled",
			runId: "run-new",
			outcome: "completed",
		});
		expect(session.result.current.state.run?.status).toBe("completed");
	});

	it("blocks through reducer state after connection loss", () => {
		const session = sessionHarness();
		session.connection("connected");
		expect(session.result.current.state.connection).toBe("connected");

		session.connection("disconnected");

		expect(session.result.current.state.connection).toBe("disconnected");
	});
});
