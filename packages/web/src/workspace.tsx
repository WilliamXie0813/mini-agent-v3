import { useEffect, useRef } from "react";
import type * as React from "react";

import { ChatPanel } from "./components/chat-panel.tsx";
import { EventDetailsModal } from "./components/event-details-modal.tsx";
import { PromptComposer } from "./components/prompt-composer.tsx";
import { SessionSidebar } from "./components/session-sidebar.tsx";
import { TimelinePanel } from "./components/timeline-panel.tsx";
import { WorkspaceHeader } from "./components/workspace-header.tsx";
import { buildChatView } from "./state/chat.ts";
import { buildTimeline } from "./state/timeline.ts";
import { buildToolCards } from "./state/tools.ts";
import type { AppState } from "./state/types.ts";
import { buildUsageTotals } from "./state/usage.ts";
import "./styles.css";

export interface WorkspaceProps {
	state: AppState;
	onPromptChange(prompt: string): void;
	onSubmit(): void;
	onAbort(): void;
	onCompact(): void;
	onSelectTimelineItem(itemId?: string): void;
}

const CONNECTION_BANNER: Partial<Record<AppState["connection"], string>> = {
	connecting: "Connecting to the agent…",
	reconnecting: "Reconnecting to the agent…",
	disconnected: "Disconnected from the agent. Editing is blocked.",
	incompatible: "Incompatible protocol version. Reload the workbench.",
};

// Light 三栏工作台：Header + Session / Chat / Timeline。
// 组件只消费 Task 4 selector 输出，不 reinterpret raw entries/events。
export function Workspace(props: WorkspaceProps): React.JSX.Element {
	const { state } = props;
	const session = state.session;
	const chatItems = session ? buildChatView(session) : [];
	const toolCards = session ? buildToolCards(session) : [];
	const usage = session ? buildUsageTotals(session) : undefined;
	const timeline = session ? buildTimeline(session) : [];
	const selectedIndex = timeline.findIndex(
		(item) => item.id === state.selectedTimelineItemId,
	);
	const selected = selectedIndex >= 0 ? timeline[selectedIndex] : undefined;
	const modalOpen = selected !== undefined;

	// modal 关闭后把焦点还给原 Timeline row。
	const lastSelectedRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (state.selectedTimelineItemId) {
			lastSelectedRef.current = state.selectedTimelineItemId;
			return;
		}
		const previous = lastSelectedRef.current;
		if (!previous) return;
		lastSelectedRef.current = undefined;
		const row = document.querySelector<HTMLElement>(
			`[data-timeline-item="${CSS.escape(previous)}"]`,
		);
		row?.focus();
	}, [state.selectedTimelineItemId]);

	const blocked =
		state.connection !== "connected" || !session || session.status !== "idle";
	const banner = CONNECTION_BANNER[state.connection];
	const closeModal = () => props.onSelectTimelineItem(undefined);

	return (
		<div className="workspace" data-theme="light">
			<div
				className="workspace-frame"
				{...(modalOpen ? { inert: true, "aria-hidden": true } : {})}
			>
				<WorkspaceHeader
					connection={state.connection}
					sessionStatus={session?.status}
					usage={usage}
					protocolError={state.lastProtocolError}
					onAbort={props.onAbort}
				/>
				{banner && (
					<p role="alert" className="connection-banner">
						{banner}
					</p>
				)}
				<div className="workspace-body">
					<SessionSidebar
						session={session}
						compactDisabled={blocked}
						onCompact={props.onCompact}
					/>
					<main aria-label="Chat" className="chat-panel">
						<ChatPanel items={chatItems} cards={toolCards} />
						<PromptComposer
							prompt={state.prompt}
							disabled={blocked}
							onPromptChange={props.onPromptChange}
							onSubmit={props.onSubmit}
						/>
					</main>
					<TimelinePanel
						items={timeline}
						selectedId={state.selectedTimelineItemId}
						onSelect={props.onSelectTimelineItem}
					/>
				</div>
			</div>
			{selected && (
				<EventDetailsModal
					item={selected}
					previousId={
						selectedIndex > 0 ? timeline[selectedIndex - 1]?.id : undefined
					}
					nextId={
						selectedIndex < timeline.length - 1
							? timeline[selectedIndex + 1]?.id
							: undefined
					}
					onClose={closeModal}
					onNavigate={props.onSelectTimelineItem}
				/>
			)}
		</div>
	);
}
