import { useState } from "react";
import type { JSX } from "react";

import type { TimelineItem } from "../state/types.ts";

export interface TimelinePanelProps {
	items: TimelineItem[];
	selectedId?: string;
	linkedToolCallId?: string;
	open: boolean;
	onLinkTool(toolCallId: string): void;
	onSelect(itemId: string): void;
	onClose(): void;
}

const SOURCE_LABELS: Record<TimelineItem["source"], string> = {
	journal: "Journal",
	live: "Live",
	diagnostic: "Diagnostic",
};

type TimelineFilter = "all" | "tools" | "errors";

const TOOL_KINDS = new Set<TimelineItem["kind"]>([
	"tool-intent",
	"tool-update",
	"tool-outcome",
	"tool-start",
	"tool-update-live",
	"tool-end",
]);

// 连续事件轨道：journal 与 live row 用 source badge 区分，
// 不把 replay 记录冒充实时事件。点击 row 打开 Event Details modal。
export function TimelinePanel(props: TimelinePanelProps): JSX.Element {
	const {
		items,
		selectedId,
		linkedToolCallId,
		open,
		onLinkTool,
		onSelect,
		onClose,
	} = props;
	const [filter, setFilter] = useState<TimelineFilter>("all");
	const visibleItems = items.filter((item) => {
		if (filter === "tools") return TOOL_KINDS.has(item.kind);
		if (filter === "errors") return item.hasError === true || item.warning !== undefined;
		return true;
	});
	const emptyMessage =
		filter === "tools"
			? "No tool events yet."
			: filter === "errors"
				? "No error events."
				: "No events yet.";
	return (
		<aside
			id="timeline-panel"
			aria-label="Timeline"
			className={`timeline-panel${open ? " timeline-panel-open" : ""}`}
		>
			<div className="timeline-heading">
				<h2 className="panel-title">Timeline</h2>
				<button
					type="button"
					className="timeline-close"
					data-timeline-close
					onClick={onClose}
				>
					Close
				</button>
			</div>
			<p className="timeline-legend">
				<span>Journal</span> persisted <span>Live</span> current run
			</p>
			<div className="timeline-filters" role="group" aria-label="Filter timeline">
				{(
					[
						["all", "All"],
						["tools", "Tools"],
						["errors", "Errors"],
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						type="button"
						aria-pressed={filter === value}
						onClick={() => setFilter(value)}
					>
						{label}
					</button>
				))}
			</div>
			{visibleItems.length === 0 ? (
				<section className="timeline-empty">
					<h3>{emptyMessage}</h3>
					<p>
						{filter === "all"
							? "Session journal and live events appear here once the run produces facts."
							: "Choose All to return to the complete event track."}
					</p>
				</section>
			) : (
				<ol className="timeline-track">
					{visibleItems.map((item) => {
						const classes = [
							"timeline-row",
							item.kind === "turn" ? "timeline-row-turn" : "",
							item.toolCallId && item.toolCallId === linkedToolCallId
								? "timeline-row-linked"
								: "",
						]
							.filter(Boolean)
							.join(" ");
						const accessibleLabel = [
							SOURCE_LABELS[item.source],
							item.label,
							item.warning ? `Warning: ${item.warning}` : "",
						]
							.filter(Boolean)
							.join(", ");
						return (
							<li key={item.id}>
								<button
									type="button"
									className={classes}
									data-timeline-item={item.id}
									{...(item.toolCallId
										? { "data-timeline-tool-call-id": item.toolCallId }
										: {})}
									aria-label={accessibleLabel}
									aria-current={item.id === selectedId}
									onClick={() => {
										onSelect(item.id);
										if (item.toolCallId) onLinkTool(item.toolCallId);
									}}
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
						);
					})}
				</ol>
			)}
		</aside>
	);
}
