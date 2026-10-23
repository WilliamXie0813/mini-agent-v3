import type { JSX } from "react";

import type { SessionViewState } from "../state/types.ts";

export interface SessionSidebarProps {
	session?: SessionViewState;
	compactDisabled: boolean;
	onCompact(): void;
}

// Session 侧栏只呈现当前 session 的持久化事实：id、leaf、持久化与
// journal replay 标签，以及手动 Compact。不做 New session 或历史切换。
export function SessionSidebar(props: SessionSidebarProps): JSX.Element {
	const { session, compactDisabled, onCompact } = props;
	return (
		<aside aria-label="Session" className="session-sidebar">
			<h2 className="panel-title">Session</h2>
			{session ? (
				<>
					<dl className="session-meta">
						<div>
							<dt>session</dt>
							<dd className="mono">{session.sessionId}</dd>
						</div>
						<div>
							<dt>leaf</dt>
							<dd className="mono">{session.leafId ?? "—"}</dd>
						</div>
					</dl>
					<div className="session-badges">
						<span className="badge">persistent</span>
						<span className="badge">journal replay</span>
					</div>
					<button
						type="button"
						className="compact-button"
						disabled={compactDisabled}
						onClick={onCompact}
					>
						Compact
					</button>
				</>
			) : (
				<p className="session-pending">waiting for session snapshot…</p>
			)}
		</aside>
	);
}
