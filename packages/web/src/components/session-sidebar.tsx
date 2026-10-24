import { useEffect, useState } from "react";
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
	const [confirmingCompact, setConfirmingCompact] = useState(false);
	useEffect(() => {
		if (compactDisabled) setConfirmingCompact(false);
	}, [compactDisabled]);
	return (
		<aside aria-label="Session" className="session-sidebar">
			<h2 className="panel-title">Session</h2>
			{session ? (
				<>
					<dl className="session-meta">
						<div>
								<dt>Session ID</dt>
							<dd className="mono">{session.sessionId}</dd>
						</div>
						<div>
								<dt>Leaf entry</dt>
							<dd className="mono">{session.leafId ?? "—"}</dd>
						</div>
					</dl>
					<div className="session-badges">
							<span className="badge" title="Stored in the durable journal">
								persisted
							</span>
							<span className="badge" title="Entries restored from the journal">
								journal replay
							</span>
					</div>
						{confirmingCompact ? (
							<div
								id="compact-confirmation"
								className="compact-confirmation"
								role="group"
								aria-label="Confirm session compaction"
							>
								<p>
									Compaction summarizes the active context. Existing journal entries
									remain.
								</p>
								<div className="compact-actions">
									<button
										type="button"
										className="compact-button compact-confirm"
										onClick={() => {
											setConfirmingCompact(false);
											onCompact();
										}}
									>
										Compact session
									</button>
									<button
										type="button"
										className="compact-cancel"
										onClick={() => setConfirmingCompact(false)}
									>
										Cancel
									</button>
								</div>
							</div>
						) : (
							<button
								type="button"
								className="compact-button"
								disabled={compactDisabled}
								aria-controls="compact-confirmation"
								aria-expanded={false}
								onClick={() => setConfirmingCompact(true)}
							>
								Compact session
							</button>
						)}
				</>
			) : (
				<p className="session-pending">waiting for session snapshot…</p>
			)}
		</aside>
	);
}
