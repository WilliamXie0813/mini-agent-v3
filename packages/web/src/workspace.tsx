import { useEffect, useRef, useState } from "react";
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
import {
	MAX_TIMELINE_WIDTH,
	MIN_TIMELINE_WIDTH,
	useTimelineWidth,
} from "./use-timeline-width.ts";
import "./styles.css";

export interface WorkspaceProps {
	state: AppState;
	onPromptChange(prompt: string): void;
	onSubmit(): void;
	onAbort(): void;
	onCompact(): void;
	onSelectTimelineItem(itemId?: string): void;
	onRetryConnection(): void;
	onDismissError(): void;
}

function composerNote(
	connection: AppState["connection"],
	session: AppState["session"],
): string {
	if (connection === "connecting") {
		return "Connecting to the local agent. Your prompt will stay here while the connection opens.";
	}
	if (connection === "reconnecting") {
		return "Reconnecting automatically. Start the local agent server if it is not running.";
	}
	if (connection === "disconnected") {
		return "Connection closed. Retry from the connection panel.";
	}
	if (connection === "incompatible") {
		return "The server protocol does not match this workbench. Retry after updating both.";
	}
	if (!session) return "Connected. Waiting for the session snapshot.";
	if (session.status === "compacting") return "Compacting the active session context.";
	if (session.status === "running") {
		return "Agent is running. Use Stop to interrupt this run.";
	}
	return "Web and CLI share the same core; each process holds its own session.";
}

// Light 三栏工作台：Header + Session / Chat / Timeline。
// 组件只消费 Task 4 selector 输出，不 reinterpret raw entries/events。
export function Workspace(props: WorkspaceProps): React.JSX.Element {
	const { state } = props;
	const [timelineOpen, setTimelineOpen] = useState(false);
	const [linkedToolCallId, setLinkedToolCallId] = useState<string>();
	const {
		timelineWidth,
		timelinePointerDown,
		timelinePointerMove,
		timelinePointerEnd,
		timelineKeyDown,
	} = useTimelineWidth();
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
	const timelineToolCallIds = new Set(
		timeline.flatMap((item) => (item.toolCallId ? [item.toolCallId] : [])),
	);

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

	useEffect(() => {
		if (!timelineOpen) return;
		const previous = document.activeElement as HTMLElement | null;
		const close = document.querySelector<HTMLButtonElement>("[data-timeline-close]");
		close?.focus();
		const keyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setTimelineOpen(false);
		};
		window.addEventListener("keydown", keyDown);
		return () => {
			window.removeEventListener("keydown", keyDown);
			previous?.focus();
		};
	}, [timelineOpen]);

	useEffect(() => {
		if (!linkedToolCallId) return;
		const row = document.querySelector<HTMLElement>(
			`[data-timeline-tool-call-id="${CSS.escape(linkedToolCallId)}"]`,
		);
		row?.scrollIntoView?.({ block: "nearest" });
	}, [linkedToolCallId]);

	const blocked =
		state.connection !== "connected" || !session || session.status !== "idle";
	const closeModal = () => props.onSelectTimelineItem(undefined);
	const focusToolInTimeline = (toolCallId: string) => {
		setLinkedToolCallId(toolCallId);
		if (
			typeof window.matchMedia === "function" &&
			window.matchMedia("(max-width: 1099px)").matches
		) {
			setTimelineOpen(true);
		}
	};
	const selectTimelineItem = (itemId: string) => {
		props.onSelectTimelineItem(itemId);
		const item = timeline.find((candidate) => candidate.id === itemId);
		if (item?.toolCallId) setLinkedToolCallId(item.toolCallId);
	};

	return (
		<div className="workspace" data-theme="light">
			<div
				className="workspace-frame"
				{...(modalOpen ? { inert: true, "aria-hidden": true } : {})}
			>
				<WorkspaceHeader
					connection={state.connection}
					sessionStatus={session?.status}
					agentActive={session?.agentActive ?? false}
					usage={usage}
					protocolError={state.lastProtocolError}
					timelineOpen={timelineOpen}
					onToggleTimeline={() => setTimelineOpen((open) => !open)}
					onDismissError={props.onDismissError}
					onAbort={props.onAbort}
				/>
				<div
					className="workspace-body"
					style={
						{
							"--timeline-width": `${timelineWidth}px`,
						} as React.CSSProperties
					}
				>
					<SessionSidebar
						session={session}
						compactDisabled={blocked}
						onCompact={props.onCompact}
					/>
					<main aria-label="Chat" className="chat-panel">
						<ChatPanel
							items={chatItems}
							cards={toolCards}
							connection={state.connection}
							hasSession={session !== undefined}
							availableTimelineToolIds={timelineToolCallIds}
							linkedToolCallId={linkedToolCallId}
							onFocusTimeline={focusToolInTimeline}
							onRetryConnection={props.onRetryConnection}
						/>
						<PromptComposer
							prompt={state.prompt}
							disabled={blocked}
							note={composerNote(state.connection, session)}
							onPromptChange={props.onPromptChange}
							onSubmit={props.onSubmit}
						/>
					</main>
					<aside aria-label="Timeline resize" className="timeline-resizer-region">
						<div
							role="separator"
							aria-label="Resize Timeline"
							aria-orientation="vertical"
							aria-valuemin={MIN_TIMELINE_WIDTH}
							aria-valuemax={MAX_TIMELINE_WIDTH}
							aria-valuenow={timelineWidth}
							aria-valuetext={`${timelineWidth} pixels`}
							className="timeline-resizer"
							tabIndex={0}
							onPointerDown={timelinePointerDown}
							onPointerMove={timelinePointerMove}
							onPointerUp={timelinePointerEnd}
							onPointerCancel={timelinePointerEnd}
							onKeyDown={timelineKeyDown}
						/>
					</aside>
					{timelineOpen && (
						<button
							type="button"
							className="timeline-scrim"
							aria-label="Close Timeline"
							onClick={() => setTimelineOpen(false)}
						/>
					)}
					<TimelinePanel
						items={timeline}
						selectedId={state.selectedTimelineItemId}
						linkedToolCallId={linkedToolCallId}
						open={timelineOpen}
						onLinkTool={setLinkedToolCallId}
						onSelect={selectTimelineItem}
						onClose={() => setTimelineOpen(false)}
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
					onNavigate={selectTimelineItem}
				/>
			)}
		</div>
	);
}
