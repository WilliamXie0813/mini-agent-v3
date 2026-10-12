import { describe, expect, it, vi } from "vitest";
import {
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import type { AgentEventEnvelope } from "@mini-agent/protocol";
import { Workspace } from "../src/components/workspace.tsx";
import type {
	AppState,
	RunStatus,
} from "../src/state/types.ts";
import { assistant, envelope } from "./state/fixtures.ts";

const callbacks = {
	onSelectScenario: vi.fn(),
	onPromptChange: vi.fn(),
	onRun: vi.fn(),
	onAbort: vi.fn(),
	onReset: vi.fn(),
	onSelectTimelineItem: vi.fn(),
};

function state(
	overrides: Partial<AppState> = {},
): AppState {
	return {
		connection: "connected",
		scenarios: [{
			id: "parallel-tools",
			title: "Parallel tools",
			description: "Compare two ordering rules.",
		}],
		selectedScenarioId: "parallel-tools",
		prompt: "Run the demo.",
		...overrides,
	};
}

function running(
	envelopes: AgentEventEnvelope[],
	status: RunStatus = "running",
): AppState {
	return state({
		run: {
			runId: "run-1",
			status,
			envelopes,
			diagnostics: [],
		},
	});
}

function userMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
	};
}

function toolLifecycle(): AgentEventEnvelope[] {
	const toolAssistant = {
		role: "assistant" as const,
		content: [
			{ type: "toolCall" as const, id: "c1", name: "slow", arguments: {} },
			{ type: "toolCall" as const, id: "c2", name: "fast", arguments: {} },
			{ type: "toolCall" as const, id: "c3", name: "medium", arguments: {} },
		],
		stopReason: "toolUse" as const,
	};
	return [
		envelope(0, { type: "agent_start" }),
		envelope(1, { type: "turn_start" }),
		envelope(2, { type: "message_start", message: userMessage("Run tools.") }),
		envelope(3, { type: "message_end", message: userMessage("Run tools.") }),
		envelope(4, { type: "message_start", message: toolAssistant }),
		envelope(5, { type: "message_end", message: toolAssistant }),
		...["c1", "c2", "c3"].map((toolCallId, index) =>
			envelope(6 + index, {
				type: "tool_execution_start",
				toolCallId,
				toolName: toolCallId,
				args: {},
			}),
		),
		envelope(9, {
			type: "tool_execution_end",
			toolCallId: "c2",
			toolName: "fast",
			result: {},
			isError: false,
			durationMs: 20,
		}),
		envelope(10, {
			type: "tool_execution_end",
			toolCallId: "c3",
			toolName: "medium",
			result: {},
			isError: false,
			durationMs: 30,
		}),
		envelope(11, {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "slow",
			result: {},
			isError: true,
			durationMs: 100,
		}),
		...["c1", "c2", "c3"].map((toolCallId, index) =>
			envelope(12 + index, {
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId,
					toolName: toolCallId,
					content: [{ type: "text", text: `${toolCallId} result` }],
					isError: toolCallId === "c1",
				},
			}),
		),
		envelope(15, {
			type: "turn_end",
			message: toolAssistant,
			toolResults: [],
		}),
		envelope(16, { type: "turn_start" }),
		envelope(17, {
			type: "message_start",
			message: assistant("", "pending"),
		}),
		envelope(18, {
			type: "message_update",
			message: assistant("Final", "pending"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Final",
				partial: assistant("Final", "pending"),
			},
		}),
		envelope(19, { type: "message_end", message: assistant("Final answer") }),
		envelope(20, {
			type: "turn_end",
			message: assistant("Final answer"),
			toolResults: [],
		}),
		envelope(21, { type: "agent_end", messages: [assistant("Final answer")] }),
		envelope(
			22,
			{ type: "future_event" } as unknown as AgentEventEnvelope["event"],
		),
	];
}

describe("Workspace layout and controls", () => {
	it("renders the approved light three-column landmarks", () => {
		const { container } = render(
			<Workspace state={state()} {...callbacks} />,
		);

		expect(screen.getByRole("complementary", { name: "Demo scenarios" }))
			.toBeInTheDocument();
		expect(screen.getByRole("main", { name: "Chat" })).toBeInTheDocument();
		expect(screen.getByRole("complementary", { name: "Run timeline" }))
			.toBeInTheDocument();
		expect(container.firstElementChild).toHaveAttribute("data-theme", "light");
		expect(screen.queryByRole("button", { name: /dark/i })).not.toBeInTheDocument();
	});

	it("enables idle controls and switches to Stop during a run", () => {
		const { rerender } = render(
			<Workspace state={state()} {...callbacks} />,
		);
		expect(screen.getByRole("textbox", { name: "Prompt" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Stop run" }))
			.not.toBeInTheDocument();

		rerender(<Workspace state={running([])} {...callbacks} />);

		expect(screen.getByRole("textbox", { name: "Prompt" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Parallel tools" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
		expect(callbacks.onAbort).toHaveBeenCalled();
	});

	it.each(["disconnected", "incompatible"] as const)(
		"blocks the workspace when connection is %s",
		(connection) => {
			render(<Workspace state={state({ connection })} {...callbacks} />);

			expect(screen.getByRole("alert")).toHaveTextContent(connection);
			expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
		},
	);
});

describe("Workspace chat", () => {
	it("renders messages, streaming state, and source-ordered tool cards", () => {
		render(<Workspace state={running(toolLifecycle())} {...callbacks} />);

		expect(screen.getByText("Run tools.")).toBeInTheDocument();
		expect(screen.getByText("Final answer")).toBeInTheDocument();
		const cards = screen.getAllByTestId("tool-card");
		expect(cards.map((card) => card.getAttribute("data-tool-call-id"))).toEqual([
			"c1",
			"c2",
			"c3",
		]);
		expect(within(cards[0]).getByText("100ms")).toBeInTheDocument();
		expect(within(cards[0]).getByText("Error")).toBeInTheDocument();
		expect(within(cards[1]).getByText("Completed")).toBeInTheDocument();
	});

	it("marks an unfinished assistant message as streaming", () => {
		render(<Workspace state={running([
			envelope(0, {
				type: "message_start",
				message: assistant("", "pending"),
			}),
			envelope(1, {
				type: "message_update",
				message: assistant("partial", "pending"),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "partial",
					partial: assistant("partial", "pending"),
				},
			}),
		])} {...callbacks} />);

		expect(screen.getByText("Streaming")).toBeInTheDocument();
		expect(screen.getByText("partial")).toBeInTheDocument();
	});

	it("shows aborted at run level without relabeling error tools", () => {
		render(
			<Workspace state={running(toolLifecycle(), "aborted")} {...callbacks} />,
		);

		expect(screen.getByText("Run aborted")).toBeInTheDocument();
		const errorCard = screen.getAllByTestId("tool-card")[0];
		expect(within(errorCard).getByText("Error")).toBeInTheDocument();
		expect(within(errorCard).queryByText("Aborted")).not.toBeInTheDocument();
	});
});

describe("Workspace timeline", () => {
	it("renders turn groups, aggregated updates, and completion order", () => {
		render(<Workspace state={running(toolLifecycle())} {...callbacks} />);

		expect(screen.getByText("Turn 1")).toBeInTheDocument();
		expect(screen.getByText("Turn 2")).toBeInTheDocument();
		expect(screen.getByText("Assistant stream × 1")).toBeInTheDocument();
		expect(screen.getAllByTestId("timeline-tool-end").map(
			(item) => item.getAttribute("data-tool-call-id"),
		)).toEqual(["c2", "c3", "c1"]);
		expect(screen.getByText(/Warning: Unknown agent event/)).toBeInTheDocument();
	});

	it("selects a row and displays the raw event envelope", () => {
		const stateWithSelection = running(toolLifecycle());
		stateWithSelection.selectedTimelineItemId = "run-1:9";
		render(<Workspace state={stateWithSelection} {...callbacks} />);

		fireEvent.click(screen.getByRole("button", { name: /tool_execution_end.*c2/i }));
		expect(callbacks.onSelectTimelineItem).toHaveBeenCalledWith("run-1:9");
		expect(screen.getByText("Run run-1")).toBeInTheDocument();
		expect(screen.getByText("Sequence 9")).toBeInTheDocument();
		expect(screen.getByText("Elapsed 90ms")).toBeInTheDocument();
		expect(screen.getByText(/"toolCallId": "c2"/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
	});
});
