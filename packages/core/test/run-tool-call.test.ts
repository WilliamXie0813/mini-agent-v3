import { describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	Message,
	UserMessage,
} from "@mini-agent/ai";
import { runToolCall } from "../src/run-tool-call.ts";
import type { RunToolCallOptions } from "../src/run-tool-call.ts";
import type { ToolCall, ToolDef, ToolUpdateHandler } from "../src/tool.ts";

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [],
	stopReason: "toolUse",
};

const userMessage: UserMessage = {
	role: "user",
	content: [{ type: "text", text: "hi" }],
};

const call: ToolCall = {
	type: "toolCall",
	id: "c1",
	name: "write",
	arguments: { path: "a.txt" },
};

function makeTool(
	execute: ToolDef<any>["execute"] = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "done" }],
	})),
): ToolDef<any> {
	return {
		name: "write",
		description: "write a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
		execute,
	};
}

function makeOptions(overrides: Partial<RunToolCallOptions> = {}): RunToolCallOptions {
	return {
		assistantMessage,
		messages: [userMessage],
		tools: [makeTool()],
		...overrides,
	};
}

function resultText(outcome: { result: { content: Array<{ type: string; text?: string }> } }): string {
	return outcome.result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

describe("runToolCall", () => {
	it("executes a prepared tool without emitting events or touching history", async () => {
		const execute = vi.fn(async (_args: unknown, _signal: unknown, onUpdate?: ToolUpdateHandler) => {
			onUpdate?.({ content: [{ type: "text", text: "partial" }] });
			return { content: [{ type: "text" as const, text: "done" }] };
		});
		const messages: Message[] = [userMessage];
		const options: RunToolCallOptions = {
			...makeOptions({ tools: [makeTool(execute)], messages }),
		};
		const emit = vi.fn();
		const before = structuredClone(messages);
		const optionsWithEmit = { ...options, emit };

		const outcome = await runToolCall(call, optionsWithEmit);

		expect(emit).not.toHaveBeenCalled();
		expect(messages).toEqual(before);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(outcome.result).toMatchObject({ isError: false });
		expect(outcome.message).toMatchObject({ role: "toolResult", toolCallId: "c1" });
		expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("returns an error without executing for an unknown tool", async () => {
		const execute = vi.fn(async () => ({ content: [] }));
		const options = makeOptions({ tools: [makeTool(execute)] });

		const outcome = await runToolCall({ ...call, name: "missing" }, options);

		expect(execute).not.toHaveBeenCalled();
		expect(outcome.result.isError).toBe(true);
		expect(resultText(outcome)).toContain("not found");
	});

	it("returns an error without executing for invalid arguments", async () => {
		const execute = vi.fn(async () => ({ content: [] }));
		const options = makeOptions({ tools: [makeTool(execute)] });

		const outcome = await runToolCall({ ...call, arguments: {} }, options);

		expect(execute).not.toHaveBeenCalled();
		expect(outcome.result.isError).toBe(true);
		expect(resultText(outcome)).toContain("failed validation");
	});

	it("returns an error without executing when beforeToolCall blocks", async () => {
		const execute = vi.fn(async () => ({ content: [] }));
		const options = makeOptions({
			tools: [makeTool(execute)],
			beforeToolCall: () => ({ block: true, reason: "nope" }),
		});

		const outcome = await runToolCall(call, options);

		expect(execute).not.toHaveBeenCalled();
		expect(outcome.result.isError).toBe(true);
		expect(resultText(outcome)).toContain("nope");
	});

	it("turns a throwing tool into an error result", async () => {
		const options = makeOptions({
			tools: [
				makeTool(async () => {
					throw new Error("disk full");
				}),
			],
		});

		const outcome = await runToolCall(call, options);

		expect(outcome.result.isError).toBe(true);
		expect(outcome.message.isError).toBe(true);
		expect(resultText(outcome)).toContain("disk full");
	});

	it("applies afterToolCall overrides to both result and message", async () => {
		const options = makeOptions({
			afterToolCall: () => ({
				content: [{ type: "text", text: "redacted" }],
				isError: true,
			}),
		});

		const outcome = await runToolCall(call, options);

		expect(outcome.result.content).toEqual([{ type: "text", text: "redacted" }]);
		expect(outcome.result.isError).toBe(true);
		expect(outcome.message.content).toEqual([{ type: "text", text: "redacted" }]);
		expect(outcome.message.isError).toBe(true);
	});

	it("does not execute a call whose signal is already aborted", async () => {
		const execute = vi.fn(async () => ({ content: [] }));
		const controller = new AbortController();
		controller.abort();
		const options = makeOptions({
			tools: [makeTool(execute)],
			signal: controller.signal,
		});

		const outcome = await runToolCall(call, options);

		expect(execute).not.toHaveBeenCalled();
		expect(outcome.result.isError).toBe(true);
		expect(resultText(outcome)).toBe("Operation aborted");
	});
});
