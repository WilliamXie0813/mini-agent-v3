import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app.tsx";
import type { ProtocolClientOptions } from "../src/protocol-client.ts";
import { createInitialAppState } from "../src/state/reducer.ts";
import type {
	AgentEvent,
	AgentEventEnvelope,
	AppState,
	ServerMessage,
	SessionEntry,
	SessionViewState,
} from "../src/state/types.ts";
import type { useAgentSession } from "../src/use-agent-session.ts";

const protocolMock = vi.hoisted(() => ({
	capturedOptions: undefined as ProtocolClientOptions | undefined,
	connect: vi.fn(),
	retry: vi.fn(),
	send: vi.fn(),
	close: vi.fn(),
}));

vi.mock("../src/protocol-client.ts", () => ({
	resolveAgentSocketUrl: () => "ws://localhost/agent",
	createProtocolClient(options: ProtocolClientOptions) {
		protocolMock.capturedOptions = options;
		return {
			connect: protocolMock.connect,
				retry: protocolMock.retry,
			send: protocolMock.send,
			close: protocolMock.close,
		};
	},
}));

const hookMock = vi.hoisted(() => ({
	state: undefined as AppState | undefined,
	actions: {
		onPromptChange: vi.fn(),
		onSubmit: vi.fn(),
		onAbort: vi.fn(),
		onCompact: vi.fn(),
		onSelectTimelineItem: vi.fn(),
			onRetryConnection: vi.fn(),
			onDismissError: vi.fn(),
	},
	useAgentSession: vi.fn(),
}));

vi.mock("../src/use-agent-session.ts", () => ({
	useAgentSession: hookMock.useAgentSession,
}));

const CREATED_AT = "2026-10-23T00:00:00.000Z";

const READY: ServerMessage = {
	type: "server.ready",
	protocolVersion: 1,
	capabilities: ["journal_replay"],
};

const submission: SessionEntry = {
	id: "e1",
	parentId: null,
	createdAt: CREATED_AT,
	type: "submission",
	requestId: "r1",
	prompt: "read the files",
};

const assistantEntry: SessionEntry = {
	id: "e2",
	parentId: "e1",
	createdAt: CREATED_AT,
	type: "message",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "I will read them now." }],
		stopReason: "stop",
	},
};

function snapshot(
	status: "idle" | "running" | "compacting",
	latestSequence: number,
	entries: SessionEntry[],
) {
	return {
		type: "session.snapshot" as const,
		snapshot: {
			sessionId: "s1",
			leafId: "leaf-1",
			status,
			entries,
			transientEvents: [],
			latestSequence,
		},
	};
}

function env(sequence: number, event: AgentEvent): AgentEventEnvelope {
	return { sessionId: "s1", sequence, elapsedMs: sequence * 10, event };
}

function sessionState(status: SessionViewState["status"]): AppState {
	const session: SessionViewState = {
		sessionId: "s1",
		leafId: "leaf-1",
		status,
		agentActive: status === "running",
		compactionActive: status === "compacting",
		entries: [submission],
		events: [],
		latestSequence: 0,
		diagnostics: [],
	};
	return { ...createInitialAppState(), connection: "connected", session };
}

// Mock 掉 hook 但保留受控输入的真实行为：prompt 存在本地 state，
// onPromptChange 同时记录 spy 调用并回写，这样 userEvent.type 才能累加文本。
function clientOptions(): ProtocolClientOptions {
	const options = protocolMock.capturedOptions;
	if (!options) throw new Error("protocol client was not created");
	return options;
}

let realUseAgentSession: typeof useAgentSession;

beforeAll(async () => {
	const actual = await vi.importActual<
		typeof import("../src/use-agent-session.ts")
	>("../src/use-agent-session.ts");
	realUseAgentSession = actual.useAgentSession;
});

beforeEach(() => {
	protocolMock.capturedOptions = undefined;
	protocolMock.connect.mockClear();
	protocolMock.retry.mockClear();
	protocolMock.send.mockClear();
	protocolMock.close.mockClear();
	hookMock.useAgentSession.mockReset();
	for (const spy of Object.values(hookMock.actions)) spy.mockClear();
});

afterEach(cleanup);

describe("App with a mocked session hook", () => {
	it("routes composer input and send through the workspace actions", async () => {
		hookMock.useAgentSession.mockImplementation(() => {
			const [prompt, setPrompt] = useState("");
			return {
				state: { ...sessionState("idle"), prompt },
				actions: {
					...hookMock.actions,
					onPromptChange: (value: string) => {
						hookMock.actions.onPromptChange(value);
						setPrompt(value);
					},
				},
			};
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(screen.getByLabelText("Prompt"), "hello agent");
		expect(hookMock.actions.onPromptChange).toHaveBeenLastCalledWith(
			"hello agent",
		);
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(hookMock.actions.onSubmit).toHaveBeenCalledTimes(1);
	});

	it("routes stop, compact, and timeline selection through the workspace actions", async () => {
		hookMock.useAgentSession.mockImplementation(() => ({
			state: sessionState("running"),
			actions: hookMock.actions,
		}));
		const user = userEvent.setup();
		const { rerender } = render(<App />);
		await user.click(screen.getByRole("button", { name: "Stop" }));
		expect(hookMock.actions.onAbort).toHaveBeenCalledTimes(1);
		hookMock.useAgentSession.mockImplementation(() => ({
			state: sessionState("idle"),
			actions: hookMock.actions,
		}));
		rerender(<App />);
			await user.click(screen.getByRole("button", { name: "Compact session" }));
			expect(hookMock.actions.onCompact).not.toHaveBeenCalled();
			await user.click(screen.getByRole("button", { name: "Compact session" }));
		expect(hookMock.actions.onCompact).toHaveBeenCalledTimes(1);
		const timeline = within(screen.getByLabelText("Timeline"));
		await user.click(timeline.getByRole("button", { name: /submission/ }));
		expect(hookMock.actions.onSelectTimelineItem).toHaveBeenCalledWith(
			"entry:e1",
		);
	});
});

describe("App against a fake protocol client", () => {
	beforeEach(() => {
		hookMock.useAgentSession.mockImplementation(() => realUseAgentSession());
	});

	it("renders durable chat from the server snapshot", () => {
		render(<App />);
		const options = clientOptions();
		act(() => options.onMessage(READY));
		act(() => options.onMessage(snapshot("idle", 0, [submission, assistantEntry])));
		expect(screen.getByText("read the files")).toBeInTheDocument();
		expect(screen.getByText("I will read them now.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
	});

	it("streams assistant text from message_update events", () => {
		render(<App />);
		const options = clientOptions();
		act(() => options.onMessage(READY));
		act(() => options.onMessage(snapshot("running", 0, [submission])));
		const partial = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "working on it" }],
			stopReason: "pending" as const,
		};
		act(() =>
			options.onMessage({
				type: "agent.event",
				envelope: env(0, {
					type: "message_update",
					message: partial,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "working on it",
						partial,
					},
				}),
			}),
		);
		expect(screen.getByText("working on it")).toBeInTheDocument();
		expect(screen.getByText("streaming")).toBeInTheDocument();
	});

	it("renders tool cards and live timeline rows from tool events", () => {
		render(<App />);
		const options = clientOptions();
		act(() => options.onMessage(READY));
		act(() => options.onMessage(snapshot("running", 0, [submission])));
		const assistantDraft = {
			role: "assistant" as const,
			content: [],
			stopReason: "pending" as const,
		};
		act(() =>
			options.onMessage({
				type: "agent.event",
				envelope: env(0, { type: "message_start", message: assistantDraft }),
			}),
		);
		act(() =>
			options.onMessage({
				type: "agent.event",
				envelope: env(1, {
					type: "tool_execution_start",
					toolCallId: "call-1",
					toolName: "read",
					args: { path: "a.txt" },
				}),
			}),
		);
		act(() =>
			options.onMessage({
				type: "agent.event",
				envelope: env(2, {
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "read",
					result: { content: "file body" },
					isError: false,
					durationMs: 12,
				}),
			}),
		);
		expect(screen.getByText("read", { selector: ".tool-name" })).toBeInTheDocument();
		expect(
			screen.getByText("completed", { selector: ".tool-status" }),
		).toBeInTheDocument();
		const timeline = within(screen.getByLabelText("Timeline"));
		expect(timeline.getByText("tool start: read")).toBeInTheDocument();
	});

	it("restores idle controls when a fresh idle snapshot follows agent_end", () => {
		render(<App />);
		const options = clientOptions();
		act(() => options.onMessage(READY));
		act(() => options.onMessage(snapshot("running", 0, [submission])));
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		act(() =>
			options.onMessage({
				type: "agent.event",
				envelope: env(0, { type: "agent_end", messages: [] }),
			}),
		);
		act(() =>
			options.onMessage(snapshot("idle", 1, [submission, assistantEntry])),
		);
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
	});

	it("shows the reconnecting banner and disables input while keeping the journal view", () => {
		render(<App />);
		const options = clientOptions();
		act(() => options.onMessage(READY));
		act(() => options.onMessage(snapshot("idle", 0, [submission])));
		act(() => options.onConnectionChange("reconnecting"));
			expect(screen.getByText("Agent connection lost")).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Retry connection" }),
			).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		expect(screen.getByText("read the files")).toBeInTheDocument();
	});
});
