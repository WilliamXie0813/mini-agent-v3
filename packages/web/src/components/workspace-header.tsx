import type { JSX } from "react";

import type { AppState, SessionViewState, UsageTotals } from "../state/types.ts";

export interface WorkspaceHeaderProps {
	connection: AppState["connection"];
	sessionStatus?: SessionViewState["status"];
	agentActive: boolean;
	usage?: UsageTotals;
	protocolError?: { code: string; message: string };
	timelineOpen: boolean;
	onToggleTimeline(): void;
	onDismissError(): void;
	onAbort(): void;
}

const CONNECTION_TEXT: Record<AppState["connection"], string> = {
	connecting: "connecting",
	connected: "connected",
	reconnecting: "reconnecting",
	disconnected: "disconnected",
	incompatible: "incompatible",
};

// Header 保持轻量：品牌、连接状态、run 状态、token usage 与 Stop。
// 只显示 token 计数，永不显示成本。Stop 仅发送 run.abort，不伪造结束。
export function WorkspaceHeader(props: WorkspaceHeaderProps): JSX.Element {
	const {
		connection,
		sessionStatus,
		agentActive,
		usage,
		protocolError,
		timelineOpen,
		onToggleTimeline,
		onDismissError,
		onAbort,
	} = props;
	const tokenMetrics = usage
		? [
				["input", usage.inputTokens],
				["output", usage.outputTokens],
				["cache read", usage.cacheReadTokens],
				["cache write", usage.cacheWriteTokens],
			] as const
		: [];
	return (
		<header className="workspace-header">
			<h1 className="visually-hidden">mini-agent Runtime Workbench</h1>
			<div className="brand">
				<span className="brand-name">mini-agent</span>
				<span className="brand-edition">Runtime workbench</span>
			</div>
			<div className="header-signals">
				<span
					role="status"
					aria-label="Connection"
					className={`connection connection-${connection}`}
				>
					<span className="status-dot" aria-hidden="true" />
					{CONNECTION_TEXT[connection]}
				</span>
				<span
					role="status"
					aria-label="Run status"
					className={`run-status run-status-${sessionStatus ?? "none"}`}
				>
					<span className="run-status-dot" aria-hidden="true" />
					{sessionStatus ?? "no session"}
				</span>
			</div>
			{usage && (
				<div className="usage" role="group" aria-label="Token usage">
					<span className="usage-title">tokens</span>
					{tokenMetrics.map(([label, value]) => (
						<span key={label} className="usage-metric">
							<span className="usage-label">{label}</span>{" "}
							<span className="usage-value">{value.toLocaleString("en-US")}</span>
						</span>
					))}
				</div>
			)}
			<div className="header-actions">
				<button
					type="button"
					className="timeline-toggle"
					aria-controls="timeline-panel"
					aria-expanded={timelineOpen}
					onClick={onToggleTimeline}
				>
					Timeline
				</button>
				{agentActive && (
					<button type="button" className="stop-button" onClick={onAbort}>
						Stop
					</button>
				)}
			</div>
			{protocolError && (
				<div role="alert" className="protocol-error">
					<span>
						<strong>Protocol error</strong> {protocolError.message}
						<span className="mono"> ({protocolError.code})</span>
					</span>
					<button type="button" onClick={onDismissError}>
						Dismiss
					</button>
				</div>
			)}
		</header>
	);
}
