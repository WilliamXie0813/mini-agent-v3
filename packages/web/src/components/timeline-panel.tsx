import { useState } from "react";
import type { JSX } from "react";

import { formatDuration } from "../format.ts";
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

function matchesFilter(item: TimelineItem, filter: TimelineFilter): boolean {
	if (filter === "tools") return TOOL_KINDS.has(item.kind);
	if (filter === "errors") return item.hasError === true || item.warning !== undefined;
	return true;
}

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
	const visibleItems = items.filter((item) => matchesFilter(item, filter));
	const filterCounts: Record<TimelineFilter, number> = {
		all: items.length,
		tools: items.filter((item) => TOOL_KINDS.has(item.kind)).length,
		errors: items.filter(
			(item) => item.hasError === true || item.warning !== undefined,
		).length,
	};
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
			<header className="timeline-panel-header">
				<div className="timeline-heading">
					<div className="timeline-heading-copy">
						<span className="timeline-mark" aria-hidden="true">
							<svg viewBox="0 0 24 24" width="18" height="18">
								<path
									d="M3 12h4l2.2-5 3.4 10 2.3-5H21"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</span>
						<div>
							<h2 className="timeline-title">Timeline</h2>
							<p className="timeline-legend">
								<span className="timeline-legend-item">
									<span
										className="timeline-legend-dot timeline-legend-journal"
										aria-hidden="true"
									/>
									<span className="timeline-legend-label">Journal</span>
									<span>persisted</span>
								</span>
								<span className="timeline-legend-item">
									<span
										className="timeline-legend-dot timeline-legend-live"
										aria-hidden="true"
									/>
									<span className="timeline-legend-label">Live</span>
									<span>current run</span>
								</span>
							</p>
						</div>
					</div>
					<div className="timeline-heading-actions">
						<span className="timeline-count" aria-live="polite">
							<strong>{visibleItems.length}</strong>{" "}
							{visibleItems.length === 1 ? "event" : "events"}
						</span>
						<button
							type="button"
							className="timeline-close"
							data-timeline-close
							onClick={onClose}
						>
							Close
						</button>
					</div>
				</div>
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
							aria-label={label}
							aria-pressed={filter === value}
							onClick={() => setFilter(value)}
						>
							<span>{label}</span>
							<span className="timeline-filter-count" aria-hidden="true">
								{filterCounts[value]}
							</span>
						</button>
					))}
				</div>
			</header>
			{visibleItems.length === 0 ? (
				<section className="timeline-empty">
					<span className="timeline-empty-mark" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="22" height="22">
							<path
								d="M4 8h16M4 12h10M4 16h13"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							/>
						</svg>
					</span>
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
							item.elapsedMs !== undefined
								? `Elapsed ${formatDuration(item.elapsedMs)}`
								: "",
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
									data-source={item.source}
									data-event-kind={item.kind}
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
									<span className="timeline-row-content">
										<span className="timeline-label">{item.label}</span>
										<span className="timeline-row-meta">
											<span className={`source-badge source-${item.source}`}>
												{SOURCE_LABELS[item.source]}
											</span>
											{item.warning && (
												<span className="timeline-warning" title={item.warning}>
													warning
												</span>
											)}
										</span>
									</span>
									{item.elapsedMs !== undefined && (
										<span className="timeline-elapsed mono">
											+{formatDuration(item.elapsedMs)}
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
