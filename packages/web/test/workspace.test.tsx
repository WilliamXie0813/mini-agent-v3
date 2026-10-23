import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEvent,
	AgentEventEnvelope,
	AppState,
	AssistantMessage,
	SessionEntry,
	SessionViewState,
} from "../src/state/types.ts";
import { Workspace, type WorkspaceProps } from "../src/workspace.tsx";

afterEach(cleanup);

const CREATED_AT = "2026-10-23T00:00:00.000Z";

function base(id: string, parentId: string | null) {
	return { id, parentId, createdAt: CREATED_AT };
}

function env(sequence: number, event: AgentEvent): AgentEventEnvelope {
	return { sessionId: "s1", sequence, elapsedMs: sequence * 5, event };
}

function partialAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "pending",
	};
}

function finalAssistant(
	text: string,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
	};
}

// durable fixture：一次完成的 run——两次工具调用（一成一败）、一次压缩、run_end。
function durableEntries(): SessionEntry[] {
	const toolAssistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "let me read" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
			{ type: "toolCall", id: "c2", name: "write", arguments: { path: "b.txt" } },
		],
		stopReason: "toolUse",
		usage: {
			inputTokens: 10,
			outputTokens: 4,
			cacheReadTokens: 6,
			cacheWriteTokens: 2,
		},
	};
	return [
		{
			...base("sys", null),
			type: "message",
			message: { role: "system", sections: [{ text: "system prompt" }] },
		},
		{
			...base("sub1", "sys"),
			type: "submission",
			requestId: "r1",
			prompt: "read the files",
		},
		{ ...base("asst1", "sub1"), type: "message", message: toolAssistant },
		{
			...base("int1", "asst1"),
			type: "tool_intent",
			submissionId: "sub1",
			assistantEntryId: "asst1",
			toolCallId: "c1",
			tool: { name: "read", description: "", parameters: {} },
			args: { path: "a.txt" },
			replay: "unsafe",
			sourceIndex: 0,
		},
		{
			...base("int2", "int1"),
			type: "tool_intent",
			submissionId: "sub1",
			assistantEntryId: "asst1",
			toolCallId: "c2",
			tool: { name: "write", description: "", parameters: {} },
			args: { path: "b.txt" },
			replay: "unsafe",
			sourceIndex: 1,
		},
		{
			...base("upd1", "int2"),
			type: "tool_update",
			intentId: "int1",
			partialResult: { content: [{ type: "text", text: "partial chunk" }] },
		},
		{
			...base("out1", "upd1"),
			type: "tool_outcome",
			intentId: "int1",
			result: { content: [{ type: "text", text: "file a" }] },
			isError: false,
			durationMs: 12,
		},
		{
			...base("out2", "out1"),
			type: "tool_outcome",
			intentId: "int2",
			result: { content: [{ type: "text", text: "disk full" }] },
			isError: true,
			durationMs: 7,
		},
		{
			...base("tr1", "out2"),
			type: "message",
			intentId: "int1",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "file a" }],
				isError: false,
			},
		},
		{
			...base("tr2", "tr1"),
			type: "message",
			intentId: "int2",
			message: {
				role: "toolResult",
				toolCallId: "c2",
				toolName: "write",
				content: [{ type: "text", text: "disk full" }],
				isError: true,
			},
		},
		{
			...base("cmp1", "tr2"),
			type: "compaction",
			reason: "manual",
			summary: "compacted summary",
			firstKeptEntryId: "tr2",
			tokensBefore: 4321,
		},
		{
			...base("re1", "cmp1"),
			type: "run_end",
			submissionId: "sub1",
			status: "completed",
		},
	];
}

// live fixture：一次完整 agent run 的 envelope 流，两条 message_update 聚合成一行。
function liveEvents(): AgentEventEnvelope[] {
	const final: AssistantMessage = {
		...finalAssistant("draft xy", "stop"),
		usage: { inputTokens: 4, outputTokens: 2 },
	};
	return [
		env(0, { type: "agent_start" }),
		env(1, { type: "turn_start" }),
		env(2, { type: "message_start", message: partialAssistant("draft") }),
		env(3, {
			type: "message_update",
			message: partialAssistant("draft x"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: " x",
				partial: partialAssistant("draft x"),
			},
		}),
		env(4, {
			type: "message_update",
			message: partialAssistant("draft xy"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "y",
				partial: partialAssistant("draft xy"),
			},
		}),
		env(5, { type: "message_end", message: final }),
		env(6, { type: "turn_end", message: final, toolResults: [] }),
		env(7, { type: "agent_end", messages: [final] }),
	];
}

function sessionView(
	entries: SessionEntry[],
	events: AgentEventEnvelope[],
	status: SessionViewState["status"],
): SessionViewState {
	return {
		sessionId: "s1",
		leafId: entries.at(-1)?.id ?? null,
		status,
		entries,
		events,
		latestSequence: events.at(-1)?.sequence ?? 0,
		diagnostics: [],
	};
}

function appState(overrides: Partial<AppState> = {}): AppState {
	return { connection: "connected", prompt: "", pendingRequests: {}, ...overrides };
}

function idleState(): AppState {
	return appState({ session: sessionView(durableEntries(), [], "idle") });
}

function fullState(): AppState {
	return appState({ session: sessionView(durableEntries(), liveEvents(), "idle") });
}

function renderWorkspace(state: AppState, overrides: Partial<WorkspaceProps> = {}) {
	const props: WorkspaceProps = {
		state,
		onPromptChange: vi.fn(),
		onSubmit: vi.fn(),
		onAbort: vi.fn(),
		onCompact: vi.fn(),
		onSelectTimelineItem: vi.fn(),
		...overrides,
	};
	return { ...render(<Workspace {...props} />), props };
}

// 受控 wrapper：modal 交互（Esc、Prev/Next、焦点归还）需要真实状态流转。
function Harness({ initial }: { initial: AppState }) {
	const [state, setState] = useState(initial);
	return (
		<Workspace
			state={state}
			onPromptChange={(prompt) => setState((s) => ({ ...s, prompt }))}
			onSubmit={() => {}}
			onAbort={() => {}}
			onCompact={() => {}}
			onSelectTimelineItem={(itemId) =>
				setState((s) => ({ ...s, selectedTimelineItemId: itemId }))
			}
		/>
	);
}

describe("workspace layout and connection", () => {
	it("renders Session, Chat and Timeline landmarks on a light theme", () => {
		const { container } = renderWorkspace(fullState());
		expect(
			screen.getByRole("complementary", { name: "Session" }),
		).toBeInTheDocument();
		expect(screen.getByRole("main", { name: "Chat" })).toBeInTheDocument();
		expect(
			screen.getByRole("complementary", { name: "Timeline" }),
		).toBeInTheDocument();
		expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
		expect(container.querySelector('[data-theme="dark"]')).toBeNull();
		expect(screen.queryByRole("button", { name: /dark/i })).toBeNull();
		expect(screen.queryByRole("switch", { name: /theme/i })).toBeNull();
	});

	it.each([
		["connecting", /^connecting/i],
		["reconnecting", /^reconnecting/i],
		["disconnected", /^disconnected/i],
		["incompatible", /^incompatible/i],
	] as const)("blocks input while %s", (connection, pattern) => {
		renderWorkspace(appState({ connection, session: sessionView([], [], "idle") }));
		expect(screen.getByRole("alert").textContent).toMatch(pattern);
		expect(screen.getByRole("textbox", { name: "Prompt" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("enables prompt controls and hides Stop when connected and idle", () => {
		renderWorkspace(idleState());
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("textbox", { name: "Prompt" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Compact" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
	});

	it("disables prompt controls and shows Stop while running", () => {
		renderWorkspace(
			appState({ session: sessionView(durableEntries(), liveEvents(), "running") }),
		);
		expect(screen.getByRole("textbox", { name: "Prompt" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Compact" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
	});

	it("disables controls while compacting without showing running", () => {
		renderWorkspace(
			appState({ session: sessionView(durableEntries(), [], "compacting") }),
		);
		expect(screen.getByRole("status", { name: "Run status" })).toHaveTextContent(
			"compacting",
		);
		expect(
			screen.getByRole("status", { name: "Run status" }),
		).not.toHaveTextContent("running");
		expect(screen.getByRole("textbox", { name: "Prompt" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Compact" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
	});
});

describe("chat panel and tool cards", () => {
	it("renders user, assistant and tool result text", () => {
		renderWorkspace(fullState());
		const chat = screen.getByRole("main", { name: "Chat" });
		expect(within(chat).getByText("read the files")).toBeInTheDocument();
		expect(within(chat).getByText("let me read")).toBeInTheDocument();
		expect(within(chat).getAllByText("file a").length).toBeGreaterThan(0);
		expect(within(chat).getByText("draft xy")).toBeInTheDocument();
	});

	it("shows a streaming indicator for the in-flight assistant draft", () => {
		const session = sessionView(
			[],
			[
				env(0, { type: "message_start", message: partialAssistant("drafting") }),
				env(1, {
					type: "message_update",
					message: partialAssistant("drafting more"),
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: " more",
						partial: partialAssistant("drafting more"),
					},
				}),
			],
			"running",
		);
		renderWorkspace(appState({ session }));
		const chat = screen.getByRole("main", { name: "Chat" });
		expect(within(chat).getByText("drafting more")).toBeInTheDocument();
		expect(within(chat).getByText(/streaming/i)).toBeInTheDocument();
	});

	it("renders tool cards in source order with args, duration and error", () => {
		renderWorkspace(fullState());
		const readName = screen.getByText("read", { selector: ".tool-name" });
		const writeName = screen.getByText("write", { selector: ".tool-name" });
		expect(
			readName.compareDocumentPosition(writeName) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		const readCard = readName.closest("[data-tool-call-id]");
		const writeCard = writeName.closest("[data-tool-call-id]");
		expect(readCard).not.toBeNull();
		expect(writeCard).not.toBeNull();
		expect(within(readCard as HTMLElement).getByText(/a\.txt/)).toBeInTheDocument();
		expect(within(readCard as HTMLElement).getByText("12 ms")).toBeInTheDocument();
		expect(within(readCard as HTMLElement).getByText("completed")).toBeInTheDocument();
		expect(within(writeCard as HTMLElement).getByText("error")).toBeInTheDocument();
		expect(
			within(writeCard as HTMLElement).getByText(/failed/i),
		).toBeInTheDocument();
		expect(within(writeCard as HTMLElement).getByText("7 ms")).toBeInTheDocument();
	});

	it("keeps tool results collapsed by default", () => {
		renderWorkspace(fullState());
		const readCard = screen
			.getByText("read", { selector: ".tool-name" })
			.closest("[data-tool-call-id]") as HTMLElement;
		const details = within(readCard)
			.getByText(/file a/)
			.closest("details");
		expect(details).not.toBeNull();
		expect(details).not.toHaveAttribute("open");
	});

	it("shows partial results only while the tool is running", () => {
		// running：live tool_execution_update 的 partial 可见。
		const runningSession = sessionView(
			[],
			[
				env(0, {
					type: "message_start",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "c9",
								name: "bash",
								arguments: { command: "ls" },
							},
						],
						stopReason: "pending",
					},
				}),
				env(1, {
					type: "tool_execution_start",
					toolCallId: "c9",
					toolName: "bash",
					args: { command: "ls" },
				}),
				env(2, {
					type: "tool_execution_update",
					toolCallId: "c9",
					toolName: "bash",
					args: { command: "ls" },
					partialResult: "half done",
				}),
			],
			"running",
		);
		renderWorkspace(appState({ session: runningSession }));
		const bashCard = screen
			.getByText("bash", { selector: ".tool-name" })
			.closest("[data-tool-call-id]") as HTMLElement;
		expect(within(bashCard).getByText("running")).toBeInTheDocument();
		expect(within(bashCard).getByText(/half done/)).toBeInTheDocument();
	});

	it("does not show stale partial results after completion", () => {
		// Task 4 已知行为：partialResult 在完成后仍可能挂在 card 上，UI 不渲染它。
		renderWorkspace(fullState());
		expect(screen.queryByText(/partial chunk/)).toBeNull();
	});

	it("shows the terminal stop reason for aborted assistants", () => {
		const session = sessionView(
			[],
			[env(0, { type: "message_end", message: finalAssistant("stopped midway", "aborted") })],
			"idle",
		);
		renderWorkspace(appState({ session }));
		const chat = screen.getByRole("main", { name: "Chat" });
		expect(within(chat).getByText("aborted")).toBeInTheDocument();
	});

	it("shows the terminal stop reason for error assistants", () => {
		const session = sessionView(
			[],
			[env(0, { type: "message_end", message: finalAssistant("blew up", "error") })],
			"idle",
		);
		renderWorkspace(appState({ session }));
		const message = screen
			.getByText("blew up")
			.closest("[data-message-id]") as HTMLElement;
		expect(within(message).getByText("error")).toBeInTheDocument();
	});
});

describe("usage, compaction and timeline rows", () => {
	it("shows token totals in the header without any cost text", () => {
		renderWorkspace(fullState());
		expect(screen.getByText(/input 14/)).toBeInTheDocument();
		expect(screen.getByText(/output 6/)).toBeInTheDocument();
		expect(screen.getByText(/cache read 6/)).toBeInTheDocument();
		expect(screen.getByText(/cache write 2/)).toBeInTheDocument();
		expect(screen.queryByText(/\$|cost/i)).toBeNull();
	});

	it("shows compaction reason and tokensBefore in the timeline", () => {
		renderWorkspace(fullState());
		const timeline = screen.getByRole("complementary", { name: "Timeline" });
		expect(
			within(timeline).getByText("compaction: manual, 4321 tokens before"),
		).toBeInTheDocument();
	});

	it("aggregates consecutive live message updates into one counted row", () => {
		renderWorkspace(fullState());
		expect(screen.getByText("assistant stream ×2")).toBeInTheDocument();
	});

	it("distinguishes journal and live rows with source badges", () => {
		renderWorkspace(fullState());
		const timeline = screen.getByRole("complementary", { name: "Timeline" });
		expect(within(timeline).getAllByText("Journal").length).toBeGreaterThan(0);
		expect(within(timeline).getAllByText("Live").length).toBeGreaterThan(0);
	});

	it("reports timeline item ids when journal and live rows are clicked", async () => {
		const user = userEvent.setup();
		const { props } = renderWorkspace(fullState());
		await user.click(screen.getByRole("button", { name: /submission/ }));
		expect(props.onSelectTimelineItem).toHaveBeenCalledWith("entry:sub1");
		await user.click(screen.getByRole("button", { name: /agent start/ }));
		expect(props.onSelectTimelineItem).toHaveBeenCalledWith("event:s1:0");
	});
});

describe("event details modal", () => {
	it("opens an accessible dialog with source, id, sequence, elapsed and JSON", async () => {
		const user = userEvent.setup();
		render(<Harness initial={fullState()} />);
		await user.click(screen.getByRole("button", { name: /turn start/ }));
		const dialog = screen.getByRole("dialog", { name: "Event details" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(dialog.textContent).toContain("live");
		expect(dialog.textContent).toContain("event:s1:1");
		expect(dialog.textContent).toContain("sequence");
		expect(dialog.textContent).toContain("elapsedMs");
		expect(dialog.textContent).toContain('"type": "turn_start"');
	});

	it("closes on Escape and returns focus to the original timeline row", async () => {
		const user = userEvent.setup();
		render(<Harness initial={fullState()} />);
		const row = screen.getByRole("button", { name: /run end: completed/ });
		await user.click(row);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(row).toHaveFocus();
	});

	it("closes via the close button and clears the selection", async () => {
		const user = userEvent.setup();
		render(<Harness initial={fullState()} />);
		await user.click(screen.getByRole("button", { name: /turn start/ }));
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("navigates to the previous and next visible timeline items", async () => {
		const user = userEvent.setup();
		render(<Harness initial={fullState()} />);
		await user.click(screen.getByRole("button", { name: /run end: completed/ }));
		let dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("entry:re1");

		await user.click(screen.getByRole("button", { name: "Next event" }));
		dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("event:s1:0");
		expect(dialog.textContent).toContain('"type": "agent_start"');

		await user.click(screen.getByRole("button", { name: "Previous event" }));
		dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("entry:re1");

		await user.click(screen.getByRole("button", { name: "Previous event" }));
		dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("entry:cmp1");
		expect(dialog.textContent).toContain('"tokensBefore": 4321');
	});

	it("disables Next on the last visible item", async () => {
		const user = userEvent.setup();
		render(<Harness initial={fullState()} />);
		await user.click(screen.getByRole("button", { name: /agent end/ }));
		expect(screen.getByRole("button", { name: "Next event" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Previous event" })).toBeEnabled();
	});

	it("keeps the timeline rendered but inert while the modal is open", async () => {
		const user = userEvent.setup();
		const { container } = render(<Harness initial={fullState()} />);
		await user.click(screen.getByRole("button", { name: /turn start/ }));
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		const frame = container.querySelector(".workspace-frame");
		expect(frame).toHaveAttribute("aria-hidden", "true");
		expect(frame).toHaveAttribute("inert");
		// Timeline 仍在 DOM 中，只是被 inert 屏蔽。
		expect(
			screen.getByRole("complementary", { name: "Timeline", hidden: true }),
		).toBeInTheDocument();
	});
});
