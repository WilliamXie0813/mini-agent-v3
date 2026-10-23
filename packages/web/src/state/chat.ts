import type {
	AssistantMessage,
	ChatItem,
	ChatMessageView,
	Message,
	SessionViewState,
	ToolResultMessage,
	UserMessage,
} from "./types.ts";

// Chat 是 selector 层的纯投影：durable entries 在前，live events 在后。
// snapshot seam 保证两者不重叠，因此这里不做跨层去重。
export function buildChatView(session: SessionViewState): ChatItem[] {
	const items: ChatMessageView[] = [];
	appendDurable(session, items);
	appendLive(session, items);
	return items;
}

function appendDurable(
	session: SessionViewState,
	items: ChatMessageView[],
): void {
	for (const entry of session.entries) {
		if (entry.type === "submission") {
			items.push({
				kind: "message",
				id: `entry:${entry.id}`,
				role: "user",
				text: entry.prompt,
				streaming: false,
				toolCallIds: [],
			});
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message.role === "system") continue;
		items.push(chatFromMessage(`entry:${entry.id}`, entry.message));
	}
}

function appendLive(session: SessionViewState, items: ChatMessageView[]): void {
	let draftIndex = -1;
	for (const envelope of session.events) {
		const event = envelope.event;
		const id = `event:${envelope.sessionId}:${envelope.sequence}`;
		if (event.type === "message_start") {
			if (event.message.role === "assistant") {
				draftIndex = items.length;
				items.push(assistantView(id, event.message, true));
			}
			continue;
		}
		if (event.type === "message_update") {
			if (event.message.role !== "assistant") continue;
			if (draftIndex < 0) {
				draftIndex = items.length;
				items.push(assistantView(id, event.message, true));
			} else {
				items[draftIndex] = assistantView(
					items[draftIndex]?.id ?? id,
					event.message,
					true,
				);
			}
			continue;
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant") {
				const view = assistantView(
					draftIndex >= 0 ? (items[draftIndex]?.id ?? id) : id,
					event.message,
					false,
				);
				if (draftIndex >= 0) items[draftIndex] = view;
				else items.push(view);
				draftIndex = -1;
			} else if (
				event.message.role === "user" ||
				event.message.role === "toolResult"
			) {
				items.push(chatFromMessage(id, event.message));
			}
		}
	}
}

function chatFromMessage(id: string, message: Message): ChatMessageView {
	if (message.role === "assistant") return assistantView(id, message, false);
	if (message.role === "toolResult") return toolResultView(id, message);
	if (message.role === "user") return userView(id, message);
	throw new Error("system messages are not part of the chat view");
}

function userView(id: string, message: UserMessage): ChatMessageView {
	return {
		kind: "message",
		id,
		role: "user",
		text: textOf(message.content),
		streaming: false,
		toolCallIds: [],
	};
}

function assistantView(
	id: string,
	message: AssistantMessage,
	streaming: boolean,
): ChatMessageView {
	return {
		kind: "message",
		id,
		role: "assistant",
		text: textOf(message.content),
		streaming,
		stopReason: message.stopReason,
		toolCallIds: message.content
			.filter((block) => block.type === "toolCall")
			.map((block) => block.id),
	};
}

function toolResultView(
	id: string,
	message: ToolResultMessage,
): ChatMessageView {
	return {
		kind: "message",
		id,
		role: "toolResult",
		text: textOf(message.content),
		streaming: false,
		toolCallId: message.toolCallId,
		toolCallIds: [],
	};
}

function textOf(content: AssistantMessage["content"]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}
