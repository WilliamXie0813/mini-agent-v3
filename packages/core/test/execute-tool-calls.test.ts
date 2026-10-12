import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	Message,
} from "@mini-agent/ai";
import {
	executeToolCalls,
	failTruncatedToolCalls,
	shouldExecuteSequential,
} from "../src/execute-tool-calls.ts";
import type {
	ExecuteToolCallsOptions,
} from "../src/execute-tool-calls.ts";
import type { AgentEvent } from "../src/agent-event.ts";
import type {
	BeforeToolCall,
	ToolCall,
	ToolDef,
	ToolResult,
} from "../src/tool.ts";

function call(
	id: string,
	name: string,
	arguments_: Record<string, unknown> = {},
): ToolCall {
	return { type: "toolCall", id, name, arguments: arguments_ };
}

function assistant(toolCalls: ToolCall[]): AssistantMessage {
	return {
		role: "assistant",
		content: toolCalls,
		stopReason: "toolUse",
	};
}

function makeTool(
	name: string,
	execute: ToolDef<any>["execute"],
	parameters: Record<string, unknown> = { type: "object" },
): ToolDef<any> {
	return {
		name,
		description: name,
		parameters,
		execute,
	};
}

function options(
	toolCalls: ToolCall[],
	tools: ToolDef<any>[],
	overrides: Partial<ExecuteToolCallsOptions> = {},
): ExecuteToolCallsOptions {
	const assistantMessage = assistant(toolCalls);
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "go" }] },
		assistantMessage,
	];
	return {
		assistantMessage,
		messages,
		tools,
		...overrides,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

describe("executeToolCalls", () => {
	it("executes serially and returns messages in assistant source order", async () => {
		const log: string[] = [];
		const calls = [
			call("c1", "echo", { text: "first" }),
			call("c2", "echo", { text: "second" }),
		];
		const echo = makeTool(
			"echo",
			async ({ text }: { text: string }) => {
				log.push(text);
				return { content: [{ type: "text", text }] };
			},
			{
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
		);

		const batch = await executeToolCalls(calls, options(calls, [echo], {
			toolExecution: "sequential",
		}));

		expect(log).toEqual(["first", "second"]);
		expect(batch.messages.map((message) => message.toolCallId))
			.toEqual(["c1", "c2"]);
		expect(batch.terminate).toBe(false);
	});

	it("emits start, updates, end, then the result message", async () => {
		const calls = [call("c1", "stream")];
		const events: AgentEvent[] = [];
		const stream = makeTool(
			"stream",
			async (_params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "one" }] });
				onUpdate?.({ content: [{ type: "text", text: "two" }] });
				return { content: [{ type: "text", text: "done" }] };
			},
		);

		await executeToolCalls(calls, options(calls, [stream], {
			emit: (event) => {
				events.push(event);
			},
		}));

		expect(events.map((event) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_update",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		expect(events[1]).toMatchObject({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "stream",
			args: {},
			partialResult: {
				content: [{ type: "text", text: "one" }],
			},
		});
	});

	describe("shouldExecuteSequential", () => {
		const noop = async () => ({ content: [] });
		const calls = [call("c1", "first"), call("c2", "second")];
		const parallel = makeTool("first", noop);
		const sequential = {
			...makeTool("second", noop),
			executionMode: "sequential" as const,
		};

		it("uses sequential mode when requested globally", () => {
			expect(shouldExecuteSequential(calls, [parallel, sequential], "sequential"))
				.toBe(true);
		});

		it("downgrades the whole batch when one registered tool is sequential", () => {
			expect(shouldExecuteSequential(calls, [parallel, sequential], "parallel"))
				.toBe(true);
		});

		it("keeps a batch parallel when all registered tools allow it", () => {
			expect(shouldExecuteSequential(calls, [parallel], "parallel"))
				.toBe(false);
		});

		it("does not treat an unknown tool as sequential", () => {
			expect(shouldExecuteSequential(
				[call("c3", "missing")],
				[sequential],
				"parallel",
			)).toBe(false);
		});

		it("keeps an empty parallel batch parallel", () => {
			expect(shouldExecuteSequential([], [sequential], "parallel")).toBe(false);
		});
	});

	it("balances blocked, invalid, and unknown call lifecycles without executing", async () => {
		const execute = vi.fn(async () => ({ content: [] }));
		const calls = [
			call("c1", "blocked", { value: "ok" }),
			call("c2", "invalid", { value: 7 }),
			call("c3", "missing"),
		];
		const events: AgentEvent[] = [];
		const schema = {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		};
		const tools = [
			makeTool("blocked", execute, schema),
			makeTool("invalid", execute, schema),
		];
		const beforeToolCall: BeforeToolCall = ({ toolCall }) =>
			toolCall.name === "blocked"
				? { block: true, reason: "Denied" }
				: undefined;

		const batch = await executeToolCalls(calls, options(calls, tools, {
			toolExecution: "sequential",
			beforeToolCall,
			emit: (event) => {
				events.push(event);
			},
		}));

		expect(execute).not.toHaveBeenCalled();
		expect(batch.messages.map((message) => message.isError))
			.toEqual([true, true, true]);
		expect(events.map((event) => event.type)).toEqual([
			"tool_execution_start", "tool_execution_end",
			"message_start", "message_end",
			"tool_execution_start", "tool_execution_end",
			"message_start", "message_end",
			"tool_execution_start", "tool_execution_end",
			"message_start", "message_end",
		]);
	});

	it("waits for asynchronous update listeners before emitting end", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = () => {};
		const updateReached = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const calls = [call("c1", "stream")];
		const events: string[] = [];
		const stream = makeTool(
			"stream",
			async (_params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "partial" }] });
				return { content: [{ type: "text", text: "done" }] };
			},
		);

		const executing = executeToolCalls(calls, options(calls, [stream], {
			emit: async (event) => {
				events.push(event.type);
				if (event.type === "tool_execution_update") {
					reached();
					await gate;
				}
			},
		}));

		await updateReached;
		expect(events).not.toContain("tool_execution_end");
		release();
		await executing;
		expect(events.indexOf("tool_execution_update"))
			.toBeLessThan(events.indexOf("tool_execution_end"));
	});

	it("propagates update listener failures instead of converting them to tool errors", async () => {
		const calls = [call("c1", "stream")];
		const stream = makeTool(
			"stream",
			async (_params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "partial" }] });
				return { content: [{ type: "text", text: "done" }] };
			},
		);

		await expect(executeToolCalls(calls, options(calls, [stream], {
			emit: (event) => {
				if (event.type === "tool_execution_update")
					throw new Error("listener failed");
			},
		}))).rejects.toThrow("listener failed");
	});

	it("does not skip later calls when an earlier result terminates", async () => {
		const log: string[] = [];
		const calls = [call("c1", "first"), call("c2", "second")];
		const tools = [
			makeTool("first", async () => {
				log.push("first");
				return { content: [], terminate: true };
			}),
			makeTool("second", async () => {
				log.push("second");
				return { content: [], terminate: true };
			}),
		];

		const batch = await executeToolCalls(calls, options(calls, tools));

		expect(log).toEqual(["first", "second"]);
		expect(batch.terminate).toBe(true);
	});

	it("requires every finalized result to terminate the batch", async () => {
		const calls = [call("c1", "first"), call("c2", "second")];
		const tools = [
			makeTool("first", async () => ({
				content: [],
				terminate: true,
			})),
			makeTool("second", async () => ({
				content: [],
				terminate: false,
			})),
		];

		const batch = await executeToolCalls(calls, options(calls, tools));

		expect(batch.terminate).toBe(false);
	});

	it("does not emit events for calls that never start after abort", async () => {
		const controller = new AbortController();
		const calls = [call("c1", "first"), call("c2", "second")];
		const events: AgentEvent[] = [];
		const tools = [
			makeTool("first", async () => {
				controller.abort();
				return { content: [] };
			}),
			makeTool("second", async () => ({ content: [] })),
		];

		const batch = await executeToolCalls(calls, options(calls, tools, {
			signal: controller.signal,
			toolExecution: "sequential",
			emit: (event) => {
				events.push(event);
			},
		}));

		expect(batch.messages.map((message) => message.toolCallId))
			.toEqual(["c1"]);
		expect(
			events
				.filter((event) => "toolCallId" in event)
				.map((event) => event.toolCallId),
		).toEqual(["c1", "c1"]);
	});

	it("stops synthesizing truncated calls that have not started after abort", async () => {
		const controller = new AbortController();
		const calls = [call("c1", "first"), call("c2", "second")];
		const events: AgentEvent[] = [];

		const batch = await failTruncatedToolCalls(
			calls,
			controller.signal,
			(event) => {
				events.push(event);
				if (
					event.type === "tool_execution_start" &&
					event.toolCallId === "c1"
				) {
					controller.abort();
				}
			},
		);

		expect(batch.messages.map((message) => message.toolCallId))
			.toEqual(["c1"]);
		expect(
			events
				.filter((event) => "toolCallId" in event)
				.map((event) => event.toolCallId),
		).toEqual(["c1", "c1"]);
	});

	it("keeps thrown and explicit tool errors model-visible", async () => {
		const calls = [call("c1", "throw"), call("c2", "fail")];
		const tools = [
			makeTool("throw", async () => {
				throw new Error("kaboom");
			}),
			makeTool("fail", async () => ({
				content: [{ type: "text", text: "bad input" }],
				isError: true,
			})),
		];

		const batch = await executeToolCalls(calls, options(calls, tools));

		expect(batch.messages.map((message) => message.isError))
			.toEqual([true, true]);
		expect(textOf(batch.messages[0])).toBe("kaboom");
		expect(textOf(batch.messages[1])).toBe("bad input");
	});

	it("runs prepared tools in parallel while preserving two different orders", async () => {
		const calls = [
			call("c1", "slow"),
			call("c2", "fast"),
			call("c3", "medium"),
		];
		const tools = [
			makeTool("slow", async () => {
				await sleep(100);
				return { content: [{ type: "text", text: "slow" }] };
			}),
			makeTool("fast", async () => {
				await sleep(20);
				return { content: [{ type: "text", text: "fast" }] };
			}),
			makeTool("medium", async () => {
				await sleep(30);
				return { content: [{ type: "text", text: "medium" }] };
			}),
		];
		const events: AgentEvent[] = [];
		const startedAt = performance.now();

		const batch = await executeToolCalls(calls, options(calls, tools, {
			toolExecution: "parallel",
			emit: (event) => {
				events.push(event);
			},
		}));
		const elapsed = performance.now() - startedAt;

		expect(elapsed).toBeLessThan(150);
		expect(
			events
				.filter((event) => event.type === "tool_execution_start")
				.map((event) => event.toolCallId),
		).toEqual(["c1", "c2", "c3"]);
		expect(
			events
				.filter((event) => event.type === "tool_execution_end")
				.map((event) => event.toolCallId),
		).toEqual(["c2", "c3", "c1"]);
		expect(
			events
				.filter(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "toolResult",
				)
				.map((event) =>
					event.type === "message_end" &&
					event.message.role === "toolResult"
						? event.message.toolCallId
						: "never",
				),
		).toEqual(["c1", "c2", "c3"]);
		expect(batch.messages.map((message) => message.toolCallId))
			.toEqual(["c1", "c2", "c3"]);
	});

	it("finishes every prepare before starting any execute", async () => {
		const calls = [
			call("c1", "one"),
			call("c2", "two"),
			call("c3", "three"),
		];
		const hookOrder: string[] = [];
		const executeSnapshots: number[] = [];
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let firstReached = () => {};
		const reached = new Promise<void>((resolve) => {
			firstReached = resolve;
		});
		const tools = calls.map((toolCall) =>
			makeTool(toolCall.name, async () => {
				executeSnapshots.push(hookOrder.length);
				return { content: [] };
			}),
		);

		const executing = executeToolCalls(calls, options(calls, tools, {
			toolExecution: "parallel",
			beforeToolCall: async ({ toolCall }) => {
				hookOrder.push(toolCall.id);
				if (toolCall.id === "c1") {
					firstReached();
					await gate;
				}
			},
		}));

		await reached;
		expect(hookOrder).toEqual(["c1"]);
		expect(executeSnapshots).toEqual([]);
		release();
		await executing;
		expect(hookOrder).toEqual(["c1", "c2", "c3"]);
		expect(executeSnapshots).toEqual([3, 3, 3]);
	});

	it("keeps source-ordered messages when immediate and executed outcomes mix", async () => {
		const calls = [
			call("c1", "slow"),
			call("c2", "invalid", { value: 7 }),
			call("c3", "fast"),
		];
		const tools = [
			makeTool("slow", async () => {
				await sleep(60);
				return { content: [] };
			}),
			makeTool(
				"invalid",
				async () => ({ content: [] }),
				{
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
				},
			),
			makeTool("fast", async () => {
				await sleep(10);
				return { content: [] };
			}),
		];
		const events: AgentEvent[] = [];

		const batch = await executeToolCalls(calls, options(calls, tools, {
			toolExecution: "parallel",
			emit: (event) => {
				events.push(event);
			},
		}));

		expect(
			events
				.filter((event) => event.type === "tool_execution_end")
				.map((event) => event.toolCallId),
		).toEqual(["c2", "c3", "c1"]);
		expect(batch.messages.map((message) => message.toolCallId))
			.toEqual(["c1", "c2", "c3"]);
	});

	it("propagates a parallel end listener failure", async () => {
		const calls = [call("c1", "one"), call("c2", "two")];
		const tools = calls.map((toolCall) =>
			makeTool(toolCall.name, async () => ({ content: [] })),
		);

		await expect(executeToolCalls(calls, options(calls, tools, {
			toolExecution: "parallel",
			emit: (event) => {
				if (
					event.type === "tool_execution_end" &&
					event.toolCallId === "c2"
				) {
					throw new Error("end listener failed");
				}
			},
		}))).rejects.toThrow("end listener failed");
	});

	it("drains started siblings before propagating a parallel listener failure", async () => {
		const calls = [call("c1", "fast"), call("c2", "slow")];
		const tools = [
			makeTool("fast", async () => {
				await sleep(10);
				return { content: [] };
			}),
			makeTool("slow", async () => {
				await sleep(80);
				return { content: [] };
			}),
		];
		const ended: string[] = [];
		const startedAt = performance.now();

		await expect(executeToolCalls(calls, options(calls, tools, {
			toolExecution: "parallel",
			emit: (event) => {
				if (event.type !== "tool_execution_end") return;
				ended.push(event.toolCallId);
				if (event.toolCallId === "c1")
					throw new Error("end listener failed");
			},
		}))).rejects.toThrow("end listener failed");

		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(70);
		expect(ended).toEqual(["c1", "c2"]);
	});

	it("creates source-ordered abort outcomes when prepare aborts before phase two", async () => {
		const controller = new AbortController();
		const calls = [
			call("c1", "one"),
			call("c2", "two"),
			call("c3", "three"),
		];
		const executes = calls.map(() => vi.fn(async () => ({ content: [] })));
		const tools = calls.map((toolCall, index) =>
			makeTool(toolCall.name, executes[index]),
		);
		const hookOrder: string[] = [];

		const batch = await executeToolCalls(calls, options(calls, tools, {
			toolExecution: "parallel",
			signal: controller.signal,
			beforeToolCall: ({ toolCall }) => {
				hookOrder.push(toolCall.id);
				if (toolCall.id === "c2") controller.abort();
			},
		}));

		expect(hookOrder).toEqual(["c1", "c2"]);
		expect(executes.every((execute) => execute.mock.calls.length === 0))
			.toBe(true);
		expect(batch.messages.map((message) => message.toolCallId))
			.toEqual(["c1", "c2", "c3"]);
		expect(batch.messages.map((message) => textOf(message)))
			.toEqual(["Operation aborted", "Operation aborted", "Operation aborted"]);
	});
});
