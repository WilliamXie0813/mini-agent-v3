import { createFakeStreamFn } from "@mini-agent/ai";
import { Agent } from "@mini-agent/core";
import type { AgentOptions, ToolDef } from "@mini-agent/core";
import type { DemoScenarioSummary } from "@mini-agent/protocol";
import {
	createDelayTool,
	createLookupTool,
} from "./demo-tools.ts";

export interface DemoScenarioRegistry {
	list(): DemoScenarioSummary[];
	createAgent(scenarioId: string): Agent | undefined;
}

interface DemoScenarioDefinition {
	summary: DemoScenarioSummary;
	createOptions(): AgentOptions;
}

type FakeScript = Parameters<typeof createFakeStreamFn>[0];

const system = "You are a deterministic teaching agent.";

function options(
	script: FakeScript,
	tools: ToolDef<any>[] = [],
	streamOptions: { chunkSize?: number; delayMs?: number } = {},
): AgentOptions {
	return {
		system,
		streamFn: createFakeStreamFn(script, streamOptions),
		tools,
	};
}

function text(textValue: string): { type: "text"; text: string } {
	return { type: "text", text: textValue };
}

const definitions: DemoScenarioDefinition[] = [
	{
		summary: {
			id: "streaming-text",
			title: "Streaming text",
			description: "Observe start, text deltas, and one authoritative done message.",
		},
		createOptions: () => options(
			["This deterministic response arrives in visible chunks."],
			[],
			{ chunkSize: 3, delayMs: 2 },
		),
	},
	{
		summary: {
			id: "tool-loop",
			title: "Tool loop",
			description: "Observe a tool call, its result, and the next model turn.",
		},
		createOptions: () => options([
			[
				text("I will look up the agent event model."),
				{
					type: "toolCall",
					id: "lookup-1",
					name: "lookup",
					arguments: { topic: "agent events" },
				},
			],
			"The lookup result returned in a second turn.",
		], [createLookupTool()]),
	},
	{
		summary: {
			id: "parallel-tools",
			title: "Parallel tools",
			description: "Compare completion-ordered events with source-ordered results.",
		},
		createOptions: () => options([
			[
				text("I will run three independent tools."),
				{ type: "toolCall", id: "c1", name: "slow", arguments: {} },
				{ type: "toolCall", id: "c2", name: "fast", arguments: {} },
				{ type: "toolCall", id: "c3", name: "medium", arguments: {} },
			],
			"Fast and medium completed first; results stayed in source order.",
		], [
			createDelayTool("slow", 100, "slow result"),
			createDelayTool("fast", 20, "fast result"),
			createDelayTool("medium", 30, "medium result"),
		]),
	},
	{
		summary: {
			id: "recoverable-error",
			title: "Recoverable error",
			description: "Feed invalid tool arguments back, then recover next turn.",
		},
		createOptions: () => options([
			[{
				type: "toolCall",
				id: "lookup-invalid",
				name: "lookup",
				arguments: { topic: 42 },
			}],
			"The validation error was visible, so I recovered without crashing.",
		], [createLookupTool()]),
	},
	{
		summary: {
			id: "abort-lifecycle",
			title: "Abort lifecycle",
			description: "Stop a delayed stream and observe the terminal aborted lifecycle.",
		},
		createOptions: () => options(
			["This deliberately slow response gives the Stop button time to interrupt it."],
			[],
			{ chunkSize: 1, delayMs: 15 },
		),
	},
];

export function createDemoScenarioRegistry(): DemoScenarioRegistry {
	return {
		list: () => definitions.map(({ summary }) => ({ ...summary })),
		createAgent: (scenarioId) => {
			const definition = definitions.find(
				({ summary }) => summary.id === scenarioId,
			);
			return definition ? new Agent(definition.createOptions()) : undefined;
		},
	};
}
