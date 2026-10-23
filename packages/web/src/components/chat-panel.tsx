import type { JSX } from "react";

import type { ChatItem, ToolCardView } from "../state/types.ts";
import { ToolCard } from "./tool-card.tsx";

export interface ChatPanelProps {
	items: ChatItem[];
	cards: ToolCardView[];
}

// 只消费 selector 输出：messages 按序渲染，tool card 挂在携带对应
// toolCallId 的 assistant 消息之后；没有任何消息认领的 card 追加在末尾。
export function ChatPanel({ items, cards }: ChatPanelProps): JSX.Element {
	const claimed = new Set<string>();
	const rows: JSX.Element[] = [];
	for (const item of items) {
		rows.push(<ChatMessage key={item.id} item={item} />);
		for (const toolCallId of item.toolCallIds) {
			const card = cards.find((candidate) => candidate.toolCallId === toolCallId);
			if (!card || claimed.has(toolCallId)) continue;
			claimed.add(toolCallId);
			rows.push(<ToolCard key={card.id} card={card} />);
		}
	}
	for (const card of cards) {
		if (!claimed.has(card.toolCallId)) {
			rows.push(<ToolCard key={card.id} card={card} />);
		}
	}
	return (
		<div className="chat-scroll">
			<div className="chat-messages">
				{rows.length === 0 ? <p className="chat-empty">No messages yet.</p> : rows}
			</div>
		</div>
	);
}

const ROLE_LABELS: Record<ChatItem["role"], string> = {
	user: "user",
	assistant: "assistant",
	toolResult: "tool result",
};

function ChatMessage({ item }: { item: ChatItem }): JSX.Element {
	const terminal =
		item.stopReason === "aborted" || item.stopReason === "error"
			? item.stopReason
			: undefined;
	return (
		<article
			className={`chat-message chat-message-${item.role}`}
			data-message-id={item.id}
		>
			<header className="chat-message-header">
				<span className="chat-role">{ROLE_LABELS[item.role]}</span>
				{item.streaming && <span className="chat-streaming">streaming</span>}
				{terminal && (
					<span className={`chat-terminal chat-terminal-${terminal}`}>
						{terminal}
					</span>
				)}
			</header>
			{item.text !== "" && <p className="chat-text">{item.text}</p>}
		</article>
	);
}
