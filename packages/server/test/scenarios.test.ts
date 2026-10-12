import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@mini-agent/ai";
import type { AgentEvent } from "@mini-agent/core";
import { createDemoScenarioRegistry } from "../src/scenarios.ts";

async function runScenario(
	scenarioId: string,
	onEvent?: (event: AgentEvent) => void,
): Promise<{ events: AgentEvent[]; assistant: AssistantMessage[] }> {
	const agent = createDemoScenarioRegistry().createAgent(scenarioId);
	if (!agent) throw new Error(`missing scenario ${scenarioId}`);
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
		onEvent?.(event);
	});
	await agent.prompt("Explain this deterministic run.");
	return {
		events,
		assistant: agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		),
	};
}

describe("createDemoScenarioRegistry", () => {
	it("lists the five stage 1-6 demos in display order", () => {
		expect(createDemoScenarioRegistry().list().map(({ id }) => id)).toEqual([
			"streaming-text",
			"tool-loop",
			"parallel-tools",
			"recoverable-error",
			"abort-lifecycle",
		]);
	});

	it("returns undefined for an unknown scenario", () => {
		expect(createDemoScenarioRegistry().createAgent("missing")).toBeUndefined();
	});

	it("creates a fresh fake stream for every agent", async () => {
		const registry = createDemoScenarioRegistry();
		const first = registry.createAgent("tool-loop");
		const second = registry.createAgent("tool-loop");
		if (!first || !second) throw new Error("tool-loop scenario must exist");

		await first.prompt("first");
		await second.prompt("second");

		expect(first.state.messages.filter((message) => message.role === "assistant"))
			.toHaveLength(2);
		expect(second.state.messages.filter((message) => message.role === "assistant"))
			.toHaveLength(2);
		expect(first.state.messages.at(1)).toEqual(second.state.messages.at(1));
	});
});

describe("demo scenario lifecycles", () => {
	it("streams one authoritative assistant message", async () => {
		const { events, assistant } = await runScenario("streaming-text");

		expect(events.some((event) => event.type === "message_update")).toBe(true);
		expect(
			events.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant",
			),
		).toHaveLength(1);
		expect(assistant).toHaveLength(1);
		expect(assistant[0].stopReason).toBe("stop");
	});

	it("runs a tool result through two turns", async () => {
		const { events } = await runScenario("tool-loop");
		const types = events.map(({ type }) => type);
		const toolEnd = types.indexOf("tool_execution_end");
		const resultMessage = events.findIndex(
			(event) =>
				event.type === "message_start" &&
				event.message.role === "toolResult",
		);

		expect(types.filter((type) => type === "turn_start")).toHaveLength(2);
		expect(toolEnd).toBeGreaterThan(-1);
		expect(resultMessage).toBeGreaterThan(toolEnd);
	});

	it("shows completion order while preserving source-ordered results", async () => {
		const { events } = await runScenario("parallel-tools");
		const completed = events
			.filter((event) => event.type === "tool_execution_end")
			.map(({ toolCallId }) => toolCallId);
		const results = events
			.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "toolResult",
			)
			.map((event) =>
				event.type === "message_end" &&
				event.message.role === "toolResult"
					? event.message.toolCallId
					: "",
			);

		expect(completed).toEqual(["c2", "c3", "c1"]);
		expect(results).toEqual(["c1", "c2", "c3"]);
	});

	it("feeds invalid arguments back and lets the model recover", async () => {
		const { events } = await runScenario("recoverable-error");
		const toolResults = events.filter(
			(event) =>
				event.type === "message_end" &&
				event.message.role === "toolResult",
		);

		expect(toolResults).toHaveLength(1);
		const result = toolResults[0];
		if (result.type !== "message_end" || result.message.role !== "toolResult")
			throw new Error("expected a tool result message");
		expect(result.message.isError).toBe(true);
		expect(result.message.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("failed validation"),
		});
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
	});

	it("closes an interrupted stream with one aborted assistant message", async () => {
		let aborted = false;
		const registry = createDemoScenarioRegistry();
		const agent = registry.createAgent("abort-lifecycle");
		if (!agent) throw new Error("abort-lifecycle scenario must exist");
		const events: AgentEvent[] = [];
		agent.subscribe((event) => {
			events.push(event);
			if (!aborted && event.type === "message_update") {
				aborted = true;
				agent.abort();
			}
		});

		await agent.prompt("Stop this response.");

		const assistant = agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(aborted).toBe(true);
		expect(assistant).toHaveLength(1);
		expect(assistant[0]).toMatchObject({
			stopReason: "aborted",
			content: [{ type: "text", text: "" }],
		});
		expect(events.at(-1)?.type).toBe("agent_end");
	});
});
