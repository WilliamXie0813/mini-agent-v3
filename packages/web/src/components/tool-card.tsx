import type { ToolCardItem } from "../state/types.ts";

const statusLabels: Record<ToolCardItem["status"], string> = {
	pending: "Pending",
	running: "Running",
	completed: "Completed",
	error: "Error",
};

export function ToolCard({
	card,
}: {
	card: ToolCardItem;
}): React.JSX.Element {
	return (
		<article
			className={`tool-card tool-${card.status}`}
			data-testid="tool-card"
			data-tool-call-id={card.toolCallId}
		>
			<div className="tool-card-header">
				<strong>{card.toolName}</strong>
				<span>{statusLabels[card.status]}</span>
				{card.durationMs !== undefined && <span>{card.durationMs}ms</span>}
			</div>
			<code>{JSON.stringify(card.args)}</code>
			{card.resultText && (
				<details>
					<summary>Result</summary>
					<pre>{card.resultText}</pre>
				</details>
			)}
		</article>
	);
}
