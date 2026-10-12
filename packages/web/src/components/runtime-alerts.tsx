import type {
	RunDiagnostic,
} from "../state/types.ts";

export interface RuntimeAlertsProps {
	protocolError?: { code: string; message: string };
	diagnostics: RunDiagnostic[];
	onSelectDiagnostic(sequence: number): void;
}

export function RuntimeAlerts({
	protocolError,
	diagnostics,
	onSelectDiagnostic,
}: RuntimeAlertsProps): React.JSX.Element | null {
	if (!protocolError && diagnostics.length === 0) return null;
	return (
		<section className="runtime-alerts" aria-label="Runtime diagnostics">
			{protocolError && (
				<div className="runtime-alert" role="alert">
					{protocolError.code}: {protocolError.message}
				</div>
			)}
			{diagnostics.map((diagnostic, index) =>
				diagnostic.sequence === undefined
					? (
						<div className="runtime-alert" key={`${diagnostic.code}:${index}`}>
							{diagnostic.code}: {diagnostic.message}
						</div>
					)
					: (
						<button
							className="runtime-alert"
							key={`${diagnostic.code}:${diagnostic.sequence}:${index}`}
							onClick={() => onSelectDiagnostic(diagnostic.sequence!)}
						>
							{diagnostic.code}: {diagnostic.message}
						</button>
					))}
		</section>
	);
}
