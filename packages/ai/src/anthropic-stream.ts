import type { AssistantMessageEventStream } from "./event-stream.ts";
import type { AssistantMessage, StopReason } from "./types.ts";
import type { SseFrame } from "./sse.ts";

function check(value: unknown, detail: string): asserts value {
	if (!value) throw new Error(`Anthropic protocol: ${detail}`);
}
function object(value: unknown): Record<string, unknown> {
	check(value !== null && typeof value === "object" && !Array.isArray(value), "expected object");
	return value as Record<string, unknown>;
}
function string(value: unknown, nonempty = false): string {
	check(typeof value === "string" && (!nonempty || value.trim().length > 0), "expected string");
	return value;
}
function count(value: unknown): number {
	check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "invalid token count/index");
	return value;
}

export function createAnthropicStreamState(stream: AssistantMessageEventStream) {
	const partial: AssistantMessage = { role: "assistant", content: [], stopReason: "pending" };
	const blocks: { open: boolean; json: string; input: Record<string, unknown> }[] = [];
	let started = false, completed = false;
	let stopReason: StopReason = "pending";
	stream.push({ type: "start", partial });
	const fail = (reason: "error" | "aborted", message: string) => {
		if (completed) return;
		completed = true;
		stream.push({ type: "error", reason, error: {
			role: "assistant", content: [], stopReason: reason,
			errorMessage: message, usage: partial.usage,
		} });
	};
	return {
		get completed() { return completed; },
		fail,
		accept(frame: SseFrame): void {
			if (completed) return;
			const event = object(JSON.parse(frame.data));
			const type = string(event.type, true);
			check(frame.event === "message" || frame.event === type, "event/type mismatch");
			if (type === "error") {
				const error = object(event.error);
				fail("error", `${string(error.type, true)}: ${string(error.message)}`);
				return;
			}
			if (type === "message_start") {
				check(!started, "duplicate message_start");
				const message = object(event.message), usage = object(message.usage);
				check(message.role === "assistant", "expected assistant role");
				const read = count(usage.cache_read_input_tokens ?? 0);
				const write = count(usage.cache_creation_input_tokens ?? 0);
				partial.usage = {
					inputTokens: count(usage.input_tokens) + read + write,
					outputTokens: count(usage.output_tokens), cacheReadTokens: read, cacheWriteTokens: write,
				};
				count(partial.usage.inputTokens);
				started = true;
				return;
			}
			if (!["content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].includes(type)) return;
			check(started, `${type} before message_start`);
			if (type === "message_delta") {
				const reason = object(event.delta).stop_reason;
				if (reason !== null) {
					check(reason === "end_turn" || reason === "stop_sequence" ||
						reason === "tool_use" || reason === "max_tokens", "unknown stop_reason");
					stopReason = reason === "tool_use" ? "toolUse" : reason === "max_tokens" ? "length" : "stop";
				}
				partial.usage!.outputTokens = count(object(event.usage).output_tokens);
				return;
			}
			if (type === "message_stop") {
				check(stopReason !== "pending", "message_stop without stop_reason");
				check(stopReason === "length" || blocks.every((block) => !block.open), "unclosed content block");
				const tools = partial.content.filter((block) => block.type === "toolCall");
				check(stopReason !== "toolUse" || tools.length > 0, "tool_use without tool blocks");
				check(stopReason !== "stop" || tools.length === 0, "tool blocks without tool_use");
				for (let index = 0; index < partial.content.length; index++) {
					const block = partial.content[index], state = blocks[index];
					if (block.type !== "toolCall") continue;
					try { block.arguments = state.json === "" ? state.input : object(JSON.parse(state.json)); }
					catch {
						check(stopReason === "length", `invalid tool JSON at block ${index}`);
						block.arguments = {};
						partial.errorMessage = `Tool arguments truncated at block ${index}; batch must not execute`;
					}
				}
				completed = true;
				stream.push({ type: "done", message: { ...partial, stopReason } });
				return;
			}
			const index = count(event.index);
			if (type === "content_block_start") {
				check(index === blocks.length, `duplicate or out-of-order block ${index}`);
				const block = object(event.content_block);
				let input: Record<string, unknown> = {};
				if (block.type === "text") {
					partial.content.push({ type: "text", text: string(block.text) });
				} else {
					check(block.type === "tool_use", `unsupported content block ${index}`);
					const id = string(block.id, true), name = string(block.name, true);
					check(!partial.content.some((c) => c.type === "toolCall" && c.id === id), "duplicate tool id");
					input = object(block.input);
					partial.content.push({ type: "toolCall", id, name, arguments: {} });
				}
				blocks.push({ open: true, json: "", input });
				stream.push({ type: block.type === "text" ? "text_start" : "toolcall_start", contentIndex: index, partial });
				return;
			}
			const block = partial.content[index], state = blocks[index];
			check(state?.open, `missing or closed block ${index}`);
			if (type === "content_block_stop") {
				state.open = false;
				stream.push({ type: block.type === "text" ? "text_end" : "toolcall_end", contentIndex: index, partial });
			} else {
				const delta = object(event.delta);
				check(delta.type === (block.type === "text" ? "text_delta" : "input_json_delta"), `invalid delta at block ${index}`);
				const value = string(block.type === "text" ? delta.text : delta.partial_json);
				if (block.type === "text") block.text += value;
				else state.json += value;
				stream.push({ type: block.type === "text" ? "text_delta" : "toolcall_delta",
					contentIndex: index, delta: value, partial });
			}
		},
	};
}
