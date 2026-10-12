import type {
	TimelineItem,
	TimelineLeafItem,
} from "../state/types.ts";

export interface TimelinePanelProps {
	items: TimelineItem[];
	selectedItemId?: string;
	onSelect(itemId?: string): void;
}

export function TimelinePanel({
	items,
	selectedItemId,
	onSelect,
}: TimelinePanelProps): React.JSX.Element {
	return (
		<aside className="timeline-panel" aria-label="Run timeline">
			<div className="timeline-heading">
				<strong>Run timeline</strong>
			</div>
			<div className="timeline-scroll">
				{items.map((item) =>
					item.kind === "turn"
						? (
							<section className="turn-group" key={item.id}>
								<h2>Turn {item.turnNumber}</h2>
								{item.items.map((leaf) => (
									<TimelineLeaf
										key={leaf.id}
										item={leaf}
										selected={leaf.id === selectedItemId}
										onSelect={onSelect}
									/>
								))}
							</section>
						)
						: (
							<TimelineLeaf
								key={item.id}
								item={item}
								selected={item.id === selectedItemId}
								onSelect={onSelect}
							/>
						))}
			</div>
		</aside>
	);
}

function TimelineLeaf({
	item,
	selected,
	onSelect,
}: {
	item: TimelineLeafItem;
	selected: boolean;
	onSelect(itemId?: string): void;
}): React.JSX.Element {
	if (item.kind === "diagnostic") {
		return (
			<button
				className={`timeline-row diagnostic ${selected ? "selected" : ""}`}
				onClick={() => onSelect(item.id)}
			>
				Warning: {item.message}
			</button>
		);
	}
	if (item.kind === "assistant-stream") {
		return (
			<button
				className={`timeline-row ${selected ? "selected" : ""}`}
				onClick={() => onSelect(item.id)}
			>
				Assistant stream × {item.count}
			</button>
		);
	}
	const event = item.envelopes[0].event;
	const toolCallId =
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
			? event.toolCallId
			: undefined;
	return (
		<button
			className={`timeline-row ${selected ? "selected" : ""}`}
			aria-label={`${item.eventType}${toolCallId ? ` ${toolCallId}` : ""}`}
			data-testid={
				item.eventType === "tool_execution_end"
					? "timeline-tool-end"
					: undefined
			}
			data-tool-call-id={toolCallId}
			onClick={() => onSelect(item.id)}
		>
			<span>{item.eventType}</span>
			{toolCallId && <span>{toolCallId}</span>}
			<span>{item.envelopes[0].elapsedMs}ms</span>
		</button>
	);
}
