import { describe, expect, it } from "vitest";
import { toAnthropicRequest } from "../src/anthropic-messages.ts";
import type { StreamContext } from "../src/types.ts";

const settings = { model: "test-model", maxTokens: 42 };
const text = (value: string) => ({ type: "text" as const, text: value });
function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value)) freeze(child);
	}
}

describe("Anthropic request conversion", () => {
	it("converts mixed history and groups source-ordered results", () => {
		const context: StreamContext = {
			system: { role: "system", content: "current system" },
			messages: [
				{ role: "user", content: [text("go")] },
				{ role: "assistant", stopReason: "toolUse", content: [
					text("reading"),
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
					{ type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } },
				] },
				{ role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: [text("A")] },
				{ role: "toolResult", toolCallId: "c2", toolName: "read", isError: true, content: [text("B")] },
				{ role: "user", content: [text("next")] },
			],
			tools: [{ name: "read", description: "read file", parameters: { type: "object" } }],
		};
		const before = structuredClone(context);
		freeze(context);
		expect(toAnthropicRequest(context, settings)).toEqual({
			model: "test-model", max_tokens: 42, stream: true, system: "current system",
			tools: [{ name: "read", description: "read file", input_schema: { type: "object" } }],
			messages: [
				{ role: "user", content: [text("go")] },
				{ role: "assistant", content: [
					text("reading"),
					{ type: "tool_use", id: "c1", name: "read", input: { path: "a" } },
					{ type: "tool_use", id: "c2", name: "read", input: { path: "b" } },
				] },
				{ role: "user", content: [
					{ type: "tool_result", tool_use_id: "c1", is_error: false, content: [text("A")] },
					{ type: "tool_result", tool_use_id: "c2", is_error: true, content: [text("B")] },
					text("next"),
				] },
			],
		});
		expect(context).toEqual(before);
	});

	it("skips system history and terminal diagnostics on the next prompt", () => {
		const context: StreamContext = {
			system: { role: "system", content: "current" }, tools: [],
			messages: [
				{ role: "system", content: "old" },
				{ role: "user", content: [text("one")] },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 500" },
				{ role: "system", content: "also old" },
				{ role: "assistant", content: [text("half")], stopReason: "aborted" },
				{ role: "user", content: [text("two")] },
			],
		};
		const request = toAnthropicRequest(context, settings);
		expect(request.system).toBe("current");
		expect(request.messages).toEqual([{ role: "user", content: [text("one"), text("two")] }]);
		expect(request).not.toHaveProperty("thinking");
		expect(toAnthropicRequest(context, settings)).toEqual(request);
	});

	it("rejects non-text tool results instead of inventing a tool_use", () => {
		expect(() => toAnthropicRequest({
			system: { role: "system", content: "" }, tools: [],
			messages: [{
				role: "toolResult", toolCallId: "c1", toolName: "read", isError: false,
				content: [{ type: "toolCall", id: "c2", name: "bad", arguments: {} }],
			}],
		}, settings)).toThrow(/tool result.*text/i);
	});

	it.each([undefined, "c1", "c2"])("pairs interrupted calls while preserving the recorded result %s", (completed) => {
		const context: StreamContext = {
			system: { role: "system", content: "" }, tools: [],
			messages: [
				{ role: "user", content: [text("go")] },
				{ role: "assistant", stopReason: "toolUse", content: [
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
					{ type: "toolCall", id: "c2", name: "read", arguments: { path: "b" } },
				] },
				...(completed ? [{
					role: "toolResult" as const, toolCallId: completed, toolName: "read",
					isError: false, content: [text("recorded")],
				}] : []),
				{ role: "assistant", stopReason: "aborted", content: [] },
				{ role: "user", content: [text("next")] },
			],
		};
		const before = structuredClone(context);
		freeze(context);
		const request = toAnthropicRequest(context, settings);
		expect(request.messages).toHaveLength(3);
		expect(request.messages[2]?.content).toMatchObject([
			{ type: "tool_result", tool_use_id: "c1", is_error: completed !== "c1" },
			{ type: "tool_result", tool_use_id: "c2", is_error: completed !== "c2" },
			text("next"),
		]);
		for (const value of request.messages[2]!.content) {
			if (value.type !== "tool_result") continue;
			if (value.tool_use_id === completed) expect(value.content).toEqual([text("recorded")]);
			else expect(value.content[0]?.text).toMatch(/interrupted.*not.*succeeded/i);
		}
		expect(context).toEqual(before);
	});
});
