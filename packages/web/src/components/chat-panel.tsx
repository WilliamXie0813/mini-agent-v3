import type { JSX } from "react";

import type { AppState, ChatItem, ToolCardView } from "../state/types.ts";
import { ToolCard } from "./tool-card.tsx";

export interface ChatPanelProps {
	items: ChatItem[];
	cards: ToolCardView[];
	connection: AppState["connection"];
	hasSession: boolean;
	availableTimelineToolIds: ReadonlySet<string>;
	linkedToolCallId?: string;
	onFocusTimeline(toolCallId: string): void;
	onRetryConnection(): void;
}

const CONNECTION_COPY: Record<
	Exclude<AppState["connection"], "connected">,
	{ title: string; body: string; retryable: boolean }
> = {
	connecting: {
		title: "Connecting to the local agent",
		body: "Opening the WebSocket connection at /agent.",
		retryable: false,
	},
	reconnecting: {
		title: "Agent connection lost",
		body: "Reconnecting automatically. If this persists, start the local agent server and inspect its terminal for startup errors.",
		retryable: true,
	},
	disconnected: {
		title: "Agent disconnected",
		body: "Start the local agent server, then retry the connection. Your current prompt is preserved.",
		retryable: true,
	},
	incompatible: {
		title: "Incompatible agent protocol",
		body: "The server and workbench do not speak the same protocol version. Update both processes, then retry.",
		retryable: true,
	},
};

// 只消费 selector 输出：messages 按序渲染，tool card 挂在携带对应
// toolCallId 的 assistant 消息之后；没有任何消息认领的 card 追加在末尾。
export function ChatPanel(props: ChatPanelProps): JSX.Element {
	const {
		items,
		cards,
		connection,
		hasSession,
		availableTimelineToolIds,
		linkedToolCallId,
		onFocusTimeline,
		onRetryConnection,
	} = props;
	const claimed = new Set<string>();
	const rows: JSX.Element[] = [];
	for (const item of items) {
		rows.push(<ChatMessage key={item.id} item={item} />);
		for (const toolCallId of item.toolCallIds) {
			const card = cards.find((candidate) => candidate.toolCallId === toolCallId);
			if (!card || claimed.has(toolCallId)) continue;
			claimed.add(toolCallId);
				rows.push(
					<ToolCard
						key={card.id}
						card={card}
						isLinked={card.toolCallId === linkedToolCallId}
						onFocusTimeline={
							availableTimelineToolIds.has(card.toolCallId)
								? onFocusTimeline
								: undefined
						}
					/>,
				);
		}
	}
	for (const card of cards) {
		if (!claimed.has(card.toolCallId)) {
				rows.push(
					<ToolCard
						key={card.id}
						card={card}
						isLinked={card.toolCallId === linkedToolCallId}
						onFocusTimeline={
							availableTimelineToolIds.has(card.toolCallId)
								? onFocusTimeline
								: undefined
						}
					/>,
				);
		}
	}
	const connectionState =
		connection === "connected" ? undefined : (
			<ConnectionState
				connection={connection}
				onRetryConnection={onRetryConnection}
			/>
		);
	return (
		<div className="chat-scroll">
			<div className="chat-messages">
				{connectionState}
				{!hasSession &&
					connection === "connected" &&
					(
						<ConnectionState
							connection="connected"
							onRetryConnection={onRetryConnection}
						/>
					)}
				{hasSession && rows.length === 0 && (
					<section className="chat-empty">
						<h2>No messages yet</h2>
						<p>Send a prompt to start a run. Tool calls appear in source order.</p>
					</section>
				)}
				{hasSession && rows}
			</div>
		</div>
	);
}

function ConnectionState({
	connection,
	onRetryConnection,
}: {
	connection: AppState["connection"];
	onRetryConnection(): void;
}): JSX.Element {
	if (connection === "connected") {
		return (
			<section className="connection-state connection-state-connected" role="status">
				<h2>Waiting for the session snapshot</h2>
				<p>The connection is open. Chat and Timeline will populate from the server snapshot.</p>
			</section>
		);
	}
	const copy = CONNECTION_COPY[connection];
	return (
		<section
			className={`connection-state connection-state-${connection}`}
			role={connection === "connecting" || connection === "reconnecting" ? "status" : "alert"}
			aria-live="polite"
		>
			<h2>{copy.title}</h2>
			<p>{copy.body}</p>
			{copy.retryable && (
				<button type="button" onClick={onRetryConnection}>
					Retry connection
				</button>
			)}
		</section>
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
