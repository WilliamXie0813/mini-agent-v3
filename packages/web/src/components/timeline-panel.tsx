import type { JSX } from "react";

import type { TimelineItem } from "../state/types.ts";

export interface TimelinePanelProps {
	items: TimelineItem[];
	selectedId?: string;
	onSelect(itemId: string): void;
}

const SOURCE_LABELS: Record<TimelineItem["source"], string> = {
	journal: "Journal",
	live: "Live",
	diagnostic: "Diag",
};

// 连续事件轨道：journal 与 live row 用 source badge 区分，
// 不把 replay 记录冒充实时事件。点击 row 打开 Event Details modal。
export function TimelinePanel(props: TimelinePanelProps): JSX.Element {
	const { items, selectedId, onSelect } = props;
	return (
		<aside aria-label="Timeline" className="timeline-panel">
			<h2 className="panel-title">Timeline</h2>
			{items.length === 0 ? (
				<p className="timeline-empty">No events yet.</p>
			) : (
				<ol className="timeline-track">
					{items.map((item) => (
						<li key={item.id}>
							<button
								type="button"
								className={
									item.kind === "turn"
										? "timeline-row timeline-row-turn"
										: "timeline-row"
								}
								data-timeline-item={item.id}
								aria-current={item.id === selectedId}
								onClick={() => onSelect(item.id)}
							>
								<span className="timeline-seq mono">
									{item.sequence ?? "—"}
								</span>
								<span className={`source-badge source-${item.source}`}>
									{SOURCE_LABELS[item.source]}
								</span>
								<span className="timeline-label">{item.label}</span>
								{item.elapsedMs !== undefined && (
									<span className="timeline-elapsed mono">
										+{item.elapsedMs} ms
									</span>
								)}
								{item.warning && (
									<span className="timeline-warning" title={item.warning}>
										warning
									</span>
								)}
							</button>
						</li>
					))}
				</ol>
			)}
		</aside>
	);
}
