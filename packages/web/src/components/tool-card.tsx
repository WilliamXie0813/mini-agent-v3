import type { JSX } from "react";

import { formatDuration } from "../format.ts";
import type { ToolCardView } from "../state/types.ts";

// UI 层的防御性 JSON 格式化：result/partialResult 是 unknown，
// 可能是 ToolResult 对象或 content blocks；不可序列化时退化为 String。
export function formatJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

// 状态只有 pending | running | completed | error 四种；run aborted 时
// 不伪造每个工具的 aborted 状态。partialResult 在完成后可能仍挂在 card
// 上（Task 4 已知行为），因此只在未完结时渲染。
export interface ToolCardProps {
	card: ToolCardView;
	isLinked?: boolean;
	onFocusTimeline?(toolCallId: string): void;
}

export function ToolCard({
	card,
	isLinked = false,
	onFocusTimeline,
}: ToolCardProps): JSX.Element {
	const showPartial =
		card.partialResult !== undefined &&
		(card.status === "pending" || card.status === "running");
	return (
		<section
			className={`tool-card tool-card-${card.status}${isLinked ? " tool-card-linked" : ""}`}
			data-tool-call-id={card.toolCallId}
		>
			<header className="tool-card-header">
				<span className="tool-identity">
					<span className="tool-state-dot" aria-hidden="true" />
					<span className="tool-name">{card.toolName}</span>
				</span>
				<span className={`tool-status tool-status-${card.status}`}>
					{card.status}
				</span>
				{card.durationMs !== undefined && (
					<span className="tool-duration">{formatDuration(card.durationMs)}</span>
				)}
				{onFocusTimeline && (
					<button
						type="button"
						className="tool-timeline-link"
						onClick={() => onFocusTimeline(card.toolCallId)}
					>
						View Timeline
					</button>
				)}
			</header>
			<details className="tool-arguments">
				<summary>arguments</summary>
				<pre
					className="tool-json"
					aria-label="Tool arguments JSON"
					role="region"
					tabIndex={0}
				>
					{formatJson(card.args)}
				</pre>
			</details>
			{showPartial && (
				<div className="tool-field tool-partial">
					<span className="tool-field-label">partial result</span>
					<pre
						className="tool-json"
						aria-label="Partial result JSON"
						role="region"
						tabIndex={0}
					>
						{formatJson(card.partialResult)}
					</pre>
				</div>
			)}
			{card.result !== undefined && (
				<details className="tool-result">
					<summary>result{card.isError ? " (error)" : ""}</summary>
					<pre
						className="tool-json"
						aria-label="Tool result JSON"
						role="region"
						tabIndex={0}
					>
						{formatJson(card.result)}
					</pre>
				</details>
			)}
			{card.status === "error" && (
				<p className="tool-error">tool execution failed</p>
			)}
		</section>
	);
}
