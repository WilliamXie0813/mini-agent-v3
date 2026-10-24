import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";

import type { TimelineItem } from "../state/types.ts";
import { formatJson } from "./tool-card.tsx";

// 轻量 JSON 语法着色：只分 key / string / number / literal 四类 token，
// 交替匹配保证字符串内的数字与引号不会被误标。key 靠“字符串后紧跟冒号”识别。
const JSON_TOKEN =
	/("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

const TOKEN_CLASSES = ["json-key", "json-string", "json-number", "json-literal"];

export function highlightJson(json: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	let lastIndex = 0;
	for (const match of json.matchAll(JSON_TOKEN)) {
		if (match.index > lastIndex) nodes.push(json.slice(lastIndex, match.index));
		const group = match.findIndex((part, index) => index > 0 && part !== undefined);
		nodes.push(
			<span key={match.index} className={TOKEN_CLASSES[group - 1]}>
				{match[group]}
			</span>,
		);
		lastIndex = match.index + match[0].length;
	}
	if (lastIndex < json.length) nodes.push(json.slice(lastIndex));
	return nodes;
}

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
	const closeRef = useRef<HTMLButtonElement>(null);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
	useEffect(() => {
		setCopyStatus("idle");
		closeRef.current?.focus();
	}, [item.id]);
	const payload = item.raw.length === 1 ? item.raw[0] : item.raw;
	const json = formatJson(payload);
	const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") onClose();
		if (event.key !== "Tab") return;
		const focusable = [
			...Array.from(
				dialogRef.current?.querySelectorAll<HTMLElement>(
					'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
				) ?? [],
			),
		];
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};
	const copy = async () => {
		try {
			if (!navigator.clipboard) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(json);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("error");
		}
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
						<h1>{item.label}</h1>
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
							ref={closeRef}
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
					<button type="button" className="copy-json" onClick={() => void copy()}>
						{copyStatus === "copied" ? "Copied" : "Copy JSON"}
					</button>
					<span className="copy-status" role="status" aria-live="polite">
						{copyStatus === "copied"
							? "JSON copied."
							: copyStatus === "error"
								? "Copy failed. Select the JSON directly."
								: ""}
					</span>
				</div>
				<pre className="event-json">
					<code>{highlightJson(json)}</code>
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
