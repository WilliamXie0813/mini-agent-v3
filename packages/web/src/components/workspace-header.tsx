import type { JSX } from "react";

import type { AppState, SessionViewState, UsageTotals } from "../state/types.ts";

export interface WorkspaceHeaderProps {
	connection: AppState["connection"];
	sessionStatus?: SessionViewState["status"];
	agentActive: boolean;
	usage?: UsageTotals;
	protocolError?: { code: string; message: string };
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
	const { connection, sessionStatus, agentActive, usage, protocolError, onAbort } =
		props;
	return (
		<header className="workspace-header">
			<div className="brand">
				<span className="brand-name">mini-agent</span>
				<span className="brand-edition">Runtime workbench</span>
			</div>
			<span
				role="status"
				aria-label="Connection"
				className={`connection connection-${connection}`}
			>
				<span className="status-dot" aria-hidden="true" />
				{CONNECTION_TEXT[connection]}
			</span>
			<span role="status" aria-label="Run status" className="run-status">
				{sessionStatus ?? "no session"}
			</span>
			{usage && (
				<span className="usage" aria-label="Token usage">
					<span>input {usage.inputTokens}</span>
					<span>output {usage.outputTokens}</span>
					<span>cache read {usage.cacheReadTokens}</span>
					<span>cache write {usage.cacheWriteTokens}</span>
				</span>
			)}
			{agentActive && (
				<button type="button" className="stop-button" onClick={onAbort}>
					Stop
				</button>
			)}
			{protocolError && (
				<p role="alert" className="protocol-error">
					{protocolError.code}: {protocolError.message}
				</p>
			)}
		</header>
	);
}
