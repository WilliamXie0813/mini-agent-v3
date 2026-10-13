import type {
	ConnectionState,
	RunStatus,
} from "../state/types.ts";

export interface WorkspaceHeaderProps {
	connection: ConnectionState;
	runStatus?: RunStatus;
	onAbort(): void;
}

export function WorkspaceHeader({
	connection,
	runStatus,
	onAbort,
}: WorkspaceHeaderProps): React.JSX.Element {
	const running = runStatus === "running";
	return (
		<header className="workspace-header">
			<div className="brand">mini-agent</div>
			<div className="header-title">Run inspector</div>
			<div className="header-statuses">
				<span className={`status-pill status-${connection}`}>
					{connection}
				</span>
				{runStatus && (
					<span className={`status-pill status-${runStatus}`}>
						{runStatus}
					</span>
				)}
				{running && connection === "connected" && (
					<button className="danger-button" onClick={onAbort}>
						Stop run
					</button>
				)}
			</div>
		</header>
	);
}
