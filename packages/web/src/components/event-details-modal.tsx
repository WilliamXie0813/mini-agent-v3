import { useEffect, useRef } from "react";
import type { JSX, KeyboardEvent } from "react";

import type { TimelineItem } from "../state/types.ts";
import { formatJson } from "./tool-card.tsx";

export interface EventDetailsModalProps {
	item: TimelineItem;
	previousId?: string;
	nextId?: string;
	onClose(): void;
	onNavigate(itemId: string): void;
}

// 按需检查的 modal：只消费选中的 TimelineItem 及其 raw payloads。
// Esc / Close 清除 selection；焦点管理（打开时聚焦 dialog、关闭后归还
// Timeline row）由 Workspace 与该组件协作完成。
export function EventDetailsModal(props: EventDetailsModalProps): JSX.Element {
	const { item, previousId, nextId, onClose, onNavigate } = props;
	const dialogRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		dialogRef.current?.focus();
	}, []);
	const payload = item.raw.length === 1 ? item.raw[0] : item.raw;
	const json = formatJson(payload);
	const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") onClose();
	};
	const copy = () => {
		void navigator.clipboard?.writeText(json).catch(() => {
			// clipboard 不可用（无权限或非安全上下文）时静默降级。
		});
	};
	return (
		<div className="modal-overlay">
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label="Event details"
				className="event-modal"
				tabIndex={-1}
				onKeyDown={keyDown}
			>
				<header className="event-modal-header">
					<div className="event-modal-heading">
						<h2>{item.label}</h2>
						<dl className="event-meta">
							<div>
								<dt>source</dt>
								<dd>{item.source}</dd>
							</div>
							<div>
								<dt>id</dt>
								<dd className="mono">{item.id}</dd>
							</div>
							{item.sequence !== undefined && (
								<div>
									<dt>sequence</dt>
									<dd className="mono">{item.sequence}</dd>
								</div>
							)}
							{item.elapsedMs !== undefined && (
								<div>
									<dt>elapsedMs</dt>
									<dd className="mono">{item.elapsedMs}</dd>
								</div>
							)}
						</dl>
					</div>
					<button
						type="button"
						className="modal-close"
						aria-label="Close"
						onClick={onClose}
					>
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
							<path
								d="M3 3l10 10M13 3L3 13"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
							/>
						</svg>
					</button>
				</header>
				<div className="event-modal-toolbar">
					{item.toolCallId && (
						<span className="mono event-tool">tool {item.toolCallId}</span>
					)}
					{item.warning && (
						<span className="event-warning">{item.warning}</span>
					)}
					<button type="button" className="copy-json" onClick={copy}>
						Copy JSON
					</button>
				</div>
				<pre className="event-json">
					<code>{json}</code>
				</pre>
				<footer className="event-modal-footer">
					<button
						type="button"
						disabled={previousId === undefined}
						onClick={() => previousId !== undefined && onNavigate(previousId)}
					>
						Previous event
					</button>
					<button
						type="button"
						disabled={nextId === undefined}
						onClick={() => nextId !== undefined && onNavigate(nextId)}
					>
						Next event
					</button>
				</footer>
			</div>
		</div>
	);
}
