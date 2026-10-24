import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolClientOptions } from "../src/protocol-client.ts";
import type {
	AgentEvent,
	AgentEventEnvelope,
	SessionEntry,
} from "../src/state/types.ts";
import { useAgentSession } from "../src/use-agent-session.ts";

const protocolMock = vi.hoisted(() => ({
	capturedOptions: undefined as ProtocolClientOptions | undefined,
	connect: vi.fn(),
	send: vi.fn(),
	close: vi.fn(),
}));

vi.mock("../src/protocol-client.ts", () => ({
	resolveAgentSocketUrl: () => "ws://localhost/agent",
	createProtocolClient(options: ProtocolClientOptions) {
		protocolMock.capturedOptions = options;
		return {
			connect: protocolMock.connect,
			send: protocolMock.send,
			close: protocolMock.close,
		};
	},
}));

const UUID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const CREATED_AT = "2026-10-23T00:00:00.000Z";

const submission: SessionEntry = {
	id: "e1",
	parentId: null,
	createdAt: CREATED_AT,
	type: "submission",
	requestId: "r1",
	prompt: "hi",
};

function env(sequence: number, event: AgentEvent): AgentEventEnvelope {
	return { sessionId: "s1", sequence, elapsedMs: sequence * 10, event };
}

function snapshot(
	latestSequence: number,
	entries: SessionEntry[],
	transientEvents: AgentEventEnvelope[] = [],
) {
	return {
		type: "session.snapshot" as const,
		snapshot: {
			sessionId: "s1",
			leafId: "leaf-1",
			status: "idle" as const,
			entries,
			transientEvents,
			latestSequence,
		},
	};
}

beforeEach(() => {
	protocolMock.capturedOptions = undefined;
	protocolMock.connect.mockClear();
	protocolMock.send.mockClear();
	protocolMock.close.mockClear();
	vi.spyOn(crypto, "randomUUID").mockReturnValue(UUID);
});

afterEach(cleanup);

describe("useAgentSession", () => {
	it("creates a client, connects on mount, and closes on unmount", () => {
		const { result, unmount } = renderHook(() => useAgentSession());
		expect(protocolMock.capturedOptions?.url).toBe("ws://localhost/agent");
		expect(protocolMock.connect).toHaveBeenCalledTimes(1);
		expect(result.current.state.connection).toBe("connecting");
		act(() => protocolMock.capturedOptions?.onConnectionChange("connected"));
		expect(result.current.state.connection).toBe("connected");
		unmount();
		expect(protocolMock.close).toHaveBeenCalledTimes(1);
	});

	it("submits a non-empty prompt as prompt.submit with a fresh requestId", () => {
		const { result } = renderHook(() => useAgentSession());
		act(() => result.current.actions.onPromptChange("hello agent"));
		act(() => result.current.actions.onSubmit());
		expect(protocolMock.send).toHaveBeenCalledWith({
			type: "prompt.submit",
			requestId: UUID,
			prompt: "hello agent",
		});
	});

	it("rejects a blank prompt locally without sending anything", () => {
		const { result } = renderHook(() => useAgentSession());
		act(() => result.current.actions.onPromptChange("   "));
		act(() => result.current.actions.onSubmit());
		expect(protocolMock.send).not.toHaveBeenCalled();
		expect(result.current.state.lastProtocolError).toEqual({
			code: "EMPTY_PROMPT",
			message: "Prompt must not be empty",
		});
	});

	it("sends run.abort for stop and session.compact for compact", () => {
		const { result } = renderHook(() => useAgentSession());
		act(() => result.current.actions.onAbort());
		expect(protocolMock.send).toHaveBeenCalledWith({
			type: "run.abort",
			requestId: UUID,
		});
		act(() => result.current.actions.onCompact());
		expect(protocolMock.send).toHaveBeenCalledWith({
			type: "session.compact",
			requestId: UUID,
		});
	});

	it("tracks command.accepted/completed and protocol.error through the reducer", () => {
		const { result } = renderHook(() => useAgentSession());
		const options = protocolMock.capturedOptions;
		if (!options) throw new Error("client was not created");
		act(() =>
			options.onMessage({
				type: "command.accepted",
				requestId: "r1",
				command: "prompt.submit",
			}),
		);
		expect(result.current.state.pendingRequests).toEqual({ r1: "prompt.submit" });
		act(() =>
			options.onMessage({
				type: "command.completed",
				requestId: "r1",
				command: "prompt.submit",
				result: { submissionId: "sub1" },
			}),
		);
		expect(result.current.state.pendingRequests).toEqual({});
		act(() =>
			options.onMessage({
				type: "protocol.error",
				requestId: "r2",
				code: "RUN_ACTIVE",
				message: "run already active",
			}),
		);
		expect(result.current.state.pendingRequests).toEqual({});
		expect(result.current.state.lastProtocolError).toEqual({
			code: "RUN_ACTIVE",
			message: "run already active",
		});
	});

	it("atomically replaces stale local facts when a reconnect snapshot arrives", () => {
		const { result } = renderHook(() => useAgentSession());
		const options = protocolMock.capturedOptions;
		if (!options) throw new Error("client was not created");
		act(() => options.onMessage(snapshot(0, [submission])));
		act(() => options.onMessage({ type: "agent.event", envelope: env(0, { type: "agent_start" }) }));
		expect(result.current.state.session?.events).toHaveLength(1);
		expect(result.current.state.session?.latestSequence).toBe(0);
		const secondAssistant: SessionEntry = {
			id: "e2",
			parentId: "e1",
			createdAt: CREATED_AT,
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			},
		};
		act(() => options.onMessage(snapshot(1, [submission, secondAssistant])));
		expect(result.current.state.session?.events).toEqual([]);
		expect(result.current.state.session?.entries).toHaveLength(2);
		expect(result.current.state.session?.latestSequence).toBe(1);
	});

	it("dispatches timeline selection changes", () => {
		const { result } = renderHook(() => useAgentSession());
		act(() => result.current.actions.onSelectTimelineItem("entry:e1"));
		expect(result.current.state.selectedTimelineItemId).toBe("entry:e1");
		act(() => result.current.actions.onSelectTimelineItem(undefined));
		expect(result.current.state.selectedTimelineItemId).toBeUndefined();
	});
});
