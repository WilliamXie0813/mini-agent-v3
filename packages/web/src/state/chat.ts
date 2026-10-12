import type { AgentEventEnvelope } from "@mini-agent/protocol";
import type {
	ChatItem,
	ChatMessage,
	ChatMessageItem,
	ToolCardItem,
	ToolResultMessage,
} from "./types.ts";

export function buildChatView(
	envelopes: AgentEventEnvelope[],
): ChatItem[] {
	const items: ChatItem[] = [];
	const cards = new Map<string, ToolCardItem>();
	let openMessageIndex: number | undefined;

	for (const envelope of ordered(envelopes)) {
		const event = envelope.event;
		switch (event.type) {
			case "message_start":
				if (event.message.role === "system" || event.message.role === "toolResult")
					break;
				if (openMessageIndex !== undefined) break;
				openMessageIndex = pushMessage(
					items,
					envelope,
					event.message,
					event.message.role === "assistant" ? "streaming" : "complete",
				);
				break;
			case "message_update":
				if (openMessageIndex === undefined) break;
				openMessageIndex = updateAssistant(
					items,
					openMessageIndex,
					envelope,
					event.message as ChatMessage,
				);
				break;
			case "message_end":
				if (event.message.role === "toolResult") {
					applyToolResult(cards, event.message);
					break;
				}
				if (event.message.role === "system") break;
				if (openMessageIndex === undefined) break;
				openMessageIndex = finalizeMessage(
					items,
					cards,
					openMessageIndex,
					envelope,
					event.message,
				);
				break;
			case "tool_execution_start":
				updateCard(cards, event.toolCallId, (card) => {
					card.status = "running";
					card.args = event.args;
				});
				break;
			case "tool_execution_update":
				updateCard(cards, event.toolCallId, (card) => {
					card.partialResult = event.partialResult;
				});
				break;
			case "tool_execution_end":
				updateCard(cards, event.toolCallId, (card) => {
					card.status = event.isError ? "error" : "completed";
					card.durationMs = event.durationMs;
					card.executionResult = event.result;
				});
				break;
		}
	}
	return items;
}

function pushMessage(
	items: ChatItem[],
	envelope: AgentEventEnvelope,
	message: ChatMessage,
	status: ChatMessageItem["status"],
): number {
	items.push({
		kind: "message",
		id: `${envelope.runId}:message:${envelope.sequence}`,
		status,
		message,
	});
	return items.length - 1;
}

function updateAssistant(
	items: ChatItem[],
	index: number | undefined,
	envelope: AgentEventEnvelope,
	message: ChatMessage,
): number {
	const current = index === undefined ? undefined : items[index];
	if (
		index !== undefined &&
		current?.kind === "message" &&
		current.message.role === "assistant"
	) {
		items[index] = { ...current, status: "streaming", message };
		return index;
	}
	return index ?? -1;
}

function finalizeMessage(
	items: ChatItem[],
	cards: Map<string, ToolCardItem>,
	index: number | undefined,
	envelope: AgentEventEnvelope,
	message: ChatMessage,
): undefined {
	let messageIndex = index;
	const current = messageIndex === undefined ? undefined : items[messageIndex];
	if (
		messageIndex !== undefined &&
		current?.kind === "message" &&
		current.message.role === message.role
	) {
		items[messageIndex] = { ...current, status: "complete", message };
	} else {
		return undefined;
	}
	if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type !== "toolCall" || cards.has(block.id)) continue;
			const card: ToolCardItem = {
				kind: "tool",
				id: `${envelope.runId}:tool:${block.id}`,
				toolCallId: block.id,
				toolName: block.name,
				args: block.arguments,
				status: "pending",
			};
			cards.set(block.id, card);
			items.push(card);
		}
	}
	return undefined;
}

function updateCard(
	cards: Map<string, ToolCardItem>,
	toolCallId: string,
	update: (card: ToolCardItem) => void,
): void {
	const card = cards.get(toolCallId);
	if (card) update(card);
}

function applyToolResult(
	cards: Map<string, ToolCardItem>,
	message: ToolResultMessage,
): void {
	updateCard(cards, message.toolCallId, (card) => {
		card.resultMessage = message;
		card.resultText = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		if (message.isError) card.status = "error";
	});
}

function ordered(envelopes: AgentEventEnvelope[]): AgentEventEnvelope[] {
	return envelopes
		.map((envelope, index) => ({ envelope, index }))
		.sort((left, right) =>
			left.envelope.sequence - right.envelope.sequence ||
			left.index - right.index)
		.map(({ envelope }) => envelope);
}
