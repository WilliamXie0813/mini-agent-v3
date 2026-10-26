import { describe, expect, it, vi } from "vitest";
import {
	createAssistantMessageEventStream,
	createFakeStreamFn,
} from "@mini-agent/ai";
import type {
	AssistantMessage,
	ContentBlock,
	Message,
	StreamContext,
	StreamFn,
} from "@mini-agent/ai";
import { Agent } from "../src/agent.ts";
import type { AgentEvent } from "../src/agent-event.ts";
import type { ToolDef } from "../src/tool.ts";
import { createSubagentTool } from "../src/subagent-tool.ts";

const echoTool: ToolDef<{ text: string }> = {
	name: "echo",
	description: "echo back",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	execute: async ({ text }) => ({
		content: [{ type: "text", text }],
	}),
};

function captureContexts(script: Parameters<typeof createFakeStreamFn>[0]) {
	const contexts: StreamContext[] = [];
	const inner = createFakeStreamFn(script);
	const streamFn: StreamFn = (context, signal) => {
		contexts.push(structuredClone(context));
		return inner(context, signal);
	};
	return { contexts, streamFn };
}

function textOf(content: ContentBlock[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function parentToolResultText(messages: Message[]): string {
	const result = messages.find((message) =>
		message.role === "toolResult" && message.toolName === "delegate"
	);
	if (result?.role !== "toolResult") throw new Error("missing delegate result");
	return textOf(result.content);
}

function streamMessage(message: AssistantMessage): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "done", message });
			stream.end(message);
		});
		return stream;
	};
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("createSubagentTool", () => {
	it("runs an isolated multi-turn child and exposes only its final text", async () => {
		const parentStream = createFakeStreamFn([
			[{
				type: "toolCall",
				id: "parent-call",
				name: "delegate",
				arguments: { task: " investigate " },
			}],
			"parent done",
		]);
		const child = captureContexts([
			[{
				type: "text",
				text: "child draft",
			}, {
				type: "toolCall",
				id: "child-call",
				name: "echo",
				arguments: { text: "child echo" },
			}],
			"child final",
		]);
		const delegate = createSubagentTool({
			system: "child system",
			streamFn: child.streamFn,
			tools: [echoTool],
		});
		const parent = new Agent({
			system: "parent system",
			streamFn: parentStream,
			tools: [delegate],
		});
		const parentEvents: AgentEvent[] = [];
		parent.subscribe((event) => {
			parentEvents.push(event);
		});

		await parent.prompt("parent prompt");

		expect(parent.state.messages.map((message) => message.role)).toEqual([
			"system", "user", "assistant", "toolResult", "assistant",
		]);
		expect(parentToolResultText(parent.state.messages)).toBe("child final");
		expect(parent.state.messages.some((message) =>
			message.role === "toolResult" && message.toolName === "echo"
		)).toBe(false);
		expect(parentEvents.filter((event) => event.type === "tool_execution_start")
			.map((event) => event.toolName)).toEqual(["delegate"]);
		expect(child.contexts).toHaveLength(2);
		expect(child.contexts[0]!.messages.map((message) => message.role)).toEqual([
			"system", "user",
		]);
		expect(child.contexts[0]!.messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: " investigate " }],
		});
		expect(JSON.stringify(child.contexts[0])).not.toContain("parent prompt");
		expect(child.contexts[0]!.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(child.contexts[1]!.messages.map((message) => message.role)).toEqual([
			"system", "user", "assistant", "toolResult",
		]);
		expect(delegate.name).toBe("delegate");
		expect(delegate.replay).toBe("unsafe");
	});

	it("creates a fresh child transcript for every execution", async () => {
		const child = captureContexts(["first final", "second final"]);
		const delegate = createSubagentTool({
			system: "child system",
			streamFn: child.streamFn,
		});

		const first = await delegate.execute({ task: "first task" });
		const second = await delegate.execute({ task: "second task" });

		expect(textOf(first.content)).toBe("first final");
		expect(textOf(second.content)).toBe("second final");
		expect(child.contexts).toHaveLength(2);
		expect(child.contexts[1]!.messages.map((message) => message.role)).toEqual([
			"system", "user",
		]);
		expect(JSON.stringify(child.contexts[1])).not.toContain("first final");
		expect(JSON.stringify(child.contexts[1])).not.toContain("first task");
	});

	it("maps assistant errors to error results and prefers their text", async () => {
		const delegate = createSubagentTool({
			system: "child system",
			streamFn: streamMessage({
				role: "assistant",
				content: [{ type: "text", text: "partial failure" }],
				stopReason: "error",
				errorMessage: "provider failed",
			}),
		});

		const result = await delegate.execute({ task: "go" });

		expect(result.isError).toBe(true);
		expect(textOf(result.content)).toBe("partial failure");
	});

	it("uses an error message fallback and marks length as an error", async () => {
		const errorDelegate = createSubagentTool({
			system: "child system",
			streamFn: streamMessage({
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "provider failed",
			}),
		});
		const lengthDelegate = createSubagentTool({
			system: "child system",
			streamFn: streamMessage({
				role: "assistant",
				content: [{ type: "text", text: "truncated" }],
				stopReason: "length",
			}),
		});

		const error = await errorDelegate.execute({ task: "go" });
		const length = await lengthDelegate.execute({ task: "go" });

		expect(error.isError).toBe(true);
		expect(textOf(error.content)).toBe("provider failed");
		expect(length.isError).toBe(true);
		expect(textOf(length.content)).toBe("truncated");
	});

	it("rejects a blank task without calling the child provider", async () => {
		const streamFn = vi.fn<StreamFn>();
		const delegate = createSubagentTool({ system: "child system", streamFn });

		const result = await delegate.execute({ task: " \n\t " });

		expect(result.isError).toBe(true);
		expect(textOf(result.content)).not.toBe("");
		expect(streamFn).not.toHaveBeenCalled();
	});

	it("aborts the child and removes the parent abort listener", async () => {
		const started = deferred();
		const inner = createFakeStreamFn(["too late"], { delayMs: 20 });
		let childSignal: AbortSignal | undefined;
		const streamFn: StreamFn = (context, signal) => {
			childSignal = signal;
			started.resolve();
			return inner(context, signal);
		};
		const delegate = createSubagentTool({ system: "child system", streamFn });
		const controller = new AbortController();
		const addListener = vi.spyOn(controller.signal, "addEventListener");
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");

		const running = delegate.execute({ task: "wait" }, controller.signal);
		await started.promise;
		controller.abort();
		const result = await running;

		expect(childSignal?.aborted).toBe(true);
		expect(result.isError).toBe(true);
		expect(textOf(result.content)).toBe("Operation aborted");
		const abortListener = addListener.mock.calls.find(([type]) =>
			type === "abort"
		)?.[1];
		expect(abortListener).toBeDefined();
		expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
	});
});
