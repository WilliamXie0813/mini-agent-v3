import type { DemoScenarioSummary } from "@mini-agent/protocol";

export interface ScenarioSidebarProps {
	scenarios: DemoScenarioSummary[];
	selectedScenarioId?: string;
	disabled: boolean;
	onSelect(scenarioId: string): void;
	onReset(): void;
}

export function ScenarioSidebar({
	scenarios,
	selectedScenarioId,
	disabled,
	onSelect,
	onReset,
}: ScenarioSidebarProps): React.JSX.Element {
	return (
		<aside className="scenario-sidebar" aria-label="Demo scenarios">
			<div className="section-label">Demo scenarios</div>
			<div className="scenario-list">
				{scenarios.map((scenario) => (
					<button
						key={scenario.id}
						className={
							scenario.id === selectedScenarioId
								? "scenario-card selected"
								: "scenario-card"
						}
						aria-label={scenario.title}
						disabled={disabled}
						onClick={() => onSelect(scenario.id)}
					>
						<strong>{scenario.title}</strong>
						<span>{scenario.description}</span>
					</button>
				))}
			</div>
			<div className="scenario-meta">
				<div><strong>Provider</strong> deterministic fake</div>
				<div><strong>Session</strong> ephemeral</div>
				<div><strong>Protocol</strong> v1</div>
				<button
					className="secondary-button"
					disabled={disabled}
					onClick={onReset}
				>
					Reset workspace
				</button>
			</div>
		</aside>
	);
}
