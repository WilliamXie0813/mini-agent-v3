import type {
	ChatItem,
	RunStatus,
} from "../state/types.ts";
import { ToolCard } from "./tool-card.tsx";

export interface ChatPanelProps {
	items: ChatItem[];
	runStatus?: RunStatus;
}

export function ChatPanel({
	items,
	runStatus,
}: ChatPanelProps): React.JSX.Element {
	return (
		<main className="chat-panel" aria-label="Chat">
			{runStatus === "aborted" && (
				<div className="run-banner danger">Run aborted</div>
			)}
			{runStatus === "error" && (
				<div className="run-banner danger">Run ended with an Agent error</div>
			)}
			{runStatus === "failed" && (
				<div className="run-banner danger">Run delivery failed</div>
			)}
			<div className="chat-scroll">
				{items.length === 0 && (
					<div className="empty-state">
						Choose a Demo, enter a Prompt, and inspect one complete run.
					</div>
				)}
				{items.map((item) =>
					item.kind === "tool"
						? <ToolCard key={item.id} card={item} />
						: <Message key={item.id} item={item} />)}
			</div>
		</main>
	);
}

function Message({
	item,
}: {
	item: Extract<ChatItem, { kind: "message" }>;
}): React.JSX.Element {
	const text = item.message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	return (
		<article className={`chat-message role-${item.message.role}`}>
			<div className="message-meta">
				<strong>{item.message.role === "user" ? "You" : "Agent"}</strong>
				{item.status === "streaming" && <span>Streaming</span>}
			</div>
			<div className="message-text">{text}</div>
		</article>
	);
}
