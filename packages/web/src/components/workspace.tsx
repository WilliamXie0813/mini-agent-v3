import type { AppState, TimelineItem } from "../state/types.ts";
import { buildChatView } from "../state/chat.ts";
import { buildTimeline } from "../state/timeline.ts";
import { ChatPanel } from "./chat-panel.tsx";
import { EventDetails } from "./event-details.tsx";
import { PromptComposer } from "./prompt-composer.tsx";
import { RuntimeAlerts } from "./runtime-alerts.tsx";
import { ScenarioSidebar } from "./scenario-sidebar.tsx";
import { TimelinePanel } from "./timeline-panel.tsx";
import { WorkspaceHeader } from "./workspace-header.tsx";

export interface WorkspaceProps {
	state: AppState;
	onSelectScenario(scenarioId: string): void;
	onPromptChange(prompt: string): void;
	onRun(): void;
	onAbort(): void;
	onReset(): void;
	onSelectTimelineItem(itemId?: string): void;
}

export function Workspace({
	state,
	onSelectScenario,
	onPromptChange,
	onRun,
	onAbort,
	onReset,
	onSelectTimelineItem,
}: WorkspaceProps): React.JSX.Element {
	const blocked = state.connection !== "connected";
	const running = state.run?.status === "running";
	const disabled = blocked || running;
	const scenario = state.scenarios.find(
		({ id }) => id === state.selectedScenarioId,
	);
	const timeline = buildTimeline(state.run?.envelopes ?? []);
	const selected = findTimelineItem(timeline, state.selectedTimelineItemId);

	return (
		<div className="workspace" data-theme="light">
			<WorkspaceHeader
				connection={state.connection}
				runStatus={state.run?.status}
				onAbort={onAbort}
			/>
			{blocked && (
				<div className="connection-blocker" role="alert">
					Connection {state.connection}. Refresh after the local server is ready.
				</div>
			)}
			<div className="workspace-grid">
				<ScenarioSidebar
					scenarios={state.scenarios}
					selectedScenarioId={state.selectedScenarioId}
					disabled={disabled}
					onSelect={onSelectScenario}
					onReset={onReset}
				/>
				<div className="conversation-column">
					<ChatPanel
						items={buildChatView(state.run?.envelopes ?? [])}
						runStatus={state.run?.status}
					/>
					<PromptComposer
						prompt={state.prompt}
						scenarioTitle={scenario?.title}
						disabled={disabled}
						onPromptChange={onPromptChange}
						onRun={onRun}
					/>
				</div>
				<div className="inspector-column">
					<RuntimeAlerts
						protocolError={state.lastProtocolError}
						diagnostics={state.run?.diagnostics ?? []}
						onSelectDiagnostic={(sequence) => {
							onSelectTimelineItem(
								findTimelineItemForSequence(timeline, sequence)?.id,
							);
						}}
					/>
					<TimelinePanel
						items={timeline}
						selectedItemId={state.selectedTimelineItemId}
						onSelect={onSelectTimelineItem}
					/>
					<EventDetails item={selected} />
				</div>
			</div>
		</div>
	);
}

function findTimelineItem(
	items: TimelineItem[],
	id: string | undefined,
): TimelineItem | undefined {
	if (!id) return undefined;
	for (const item of items) {
		if (item.id === id) return item;
		if (item.kind === "turn") {
			const child = item.items.find((candidate) => candidate.id === id);
			if (child) return child;
		}
	}
	return undefined;
}

function findTimelineItemForSequence(
	items: TimelineItem[],
	sequence: number,
): TimelineItem | undefined {
	for (const item of items) {
		if (item.kind === "turn") {
			if (item.start.sequence === sequence || item.end?.sequence === sequence)
				return item;
			const child = item.items.find((candidate) =>
				candidate.envelopes.some((envelope) => envelope.sequence === sequence));
			if (child) return child;
		} else if (item.envelopes.some(
			(envelope) => envelope.sequence === sequence,
		)) {
			return item;
		}
	}
	return undefined;
}
