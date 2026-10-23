import type { AgentEventEnvelope, SessionViewState, TimelineItem } from "./types.ts";

// Timeline 是纯投影：journal rows 在前（entry 顺序），live rows 在后
// （envelope sequence 顺序），session diagnostics 垫底。
// 未知或乱序 event 保留 raw JSON 并加 warning，绝不 throw 或静默丢弃。
export function buildTimeline(session: SessionViewState): TimelineItem[] {
	const items: TimelineItem[] = [];
	appendJournal(session, items);
	appendLive(session, items);
	for (const diagnostic of session.diagnostics) {
		items.push({ id: diagnostic.id, source: "diagnostic", kind: "diagnostic", label: diagnostic.message, raw: [] });
	}
	return items;
}

type JournalRow = Pick<TimelineItem, "kind" | "label"> &
	Partial<Pick<TimelineItem, "toolCallId">>;

function appendJournal(session: SessionViewState, items: TimelineItem[]): void {
	const intentToCall = new Map<string, string>();
	for (const entry of session.entries) {
		const row = journalRow(entry, intentToCall);
		if (!row) continue;
		items.push({ id: `entry:${entry.id}`, source: "journal", raw: [entry], ...row });
	}
}

function journalRow(
	entry: SessionViewState["entries"][number],
	intentToCall: Map<string, string>,
): JournalRow | undefined {
	switch (entry.type) {
		case "submission":
			return { kind: "submission", label: "submission" };
		case "message":
			return {
				kind: "message",
				label: `message: ${entry.message.role}`,
				...(entry.message.role === "toolResult"
					? { toolCallId: entry.message.toolCallId }
					: {}),
			};
		case "tool_intent":
			intentToCall.set(entry.id, entry.toolCallId);
			return {
				kind: "tool-intent",
				toolCallId: entry.toolCallId,
				label: `tool intent: ${entry.tool.name}`,
			};
		case "tool_update":
			return { kind: "tool-update", label: "tool update", ...toolCallOf(intentToCall, entry.intentId) };
		case "tool_outcome":
			return {
				kind: "tool-outcome",
				label: entry.isError ? "tool outcome: error" : "tool outcome",
				...toolCallOf(intentToCall, entry.intentId),
			};
		case "run_end":
			return { kind: "run-end", label: `run end: ${entry.status}` };
		case "compaction":
			return {
				kind: "compaction",
				label: `compaction: ${entry.reason}, ${entry.tokensBefore} tokens before`,
			};
	}
}

function toolCallOf(
	intentToCall: Map<string, string>,
	intentId: string,
): { toolCallId: string } | Record<string, never> {
	const toolCallId = intentToCall.get(intentId);
	return toolCallId ? { toolCallId } : {};
}

interface LiveContext {
	sessionId: string;
	turnOpen: boolean;
	assistantOpen: boolean;
	stream: AgentEventEnvelope[];
	streamWarning?: string;
}

type LiveRow = Pick<TimelineItem, "kind" | "label"> &
	Partial<Pick<TimelineItem, "toolCallId" | "warning">>;

function appendLive(session: SessionViewState, items: TimelineItem[]): void {
	const context: LiveContext = {
		sessionId: session.sessionId, turnOpen: false, assistantOpen: false, stream: [],
	};
	for (const envelope of session.events) appendLiveEnvelope(context, items, envelope);
	flushStream(context, items);
}

function emit(
	context: LiveContext,
	items: TimelineItem[],
	envelope: AgentEventEnvelope,
	row: LiveRow,
): void {
	flushStream(context, items);
	items.push({
		id: `event:${context.sessionId}:${envelope.sequence}`,
		source: "live", raw: [envelope],
		sequence: envelope.sequence, elapsedMs: envelope.elapsedMs,
		...row,
	});
}

function flushStream(context: LiveContext, items: TimelineItem[]): void {
	const first = context.stream[0];
	if (!first) return;
	items.push({
		id: `event:${context.sessionId}:${first.sequence}`,
		source: "live", raw: [...context.stream],
		sequence: first.sequence, elapsedMs: first.elapsedMs,
		kind: "assistant-stream", label: `assistant stream ×${context.stream.length}`,
		...(context.streamWarning ? { warning: context.streamWarning } : {}),
	});
	context.stream = [];
	context.streamWarning = undefined;
}

function appendLiveEnvelope(
	context: LiveContext,
	items: TimelineItem[],
	envelope: AgentEventEnvelope,
): void {
	const event = envelope.event;
	switch (event.type) {
		case "agent_start":
			return emit(context, items, envelope, { kind: "agent", label: "agent start" });
		case "agent_end":
			return emit(context, items, envelope, { kind: "agent", label: "agent end" });
		case "turn_start":
			context.turnOpen = true;
			return emit(context, items, envelope, { kind: "turn", label: "turn start" });
		case "turn_end": {
			const warning = context.turnOpen ? undefined : "turn_end without turn_start";
			context.turnOpen = false;
			return emit(context, items, envelope, { kind: "turn", label: "turn end", warning });
		}
		case "message_start":
			if (event.message.role === "assistant") context.assistantOpen = true;
			return emit(context, items, envelope, {
				kind: "message-lifecycle",
				label: `message start: ${event.message.role}`,
			});
		case "message_update":
			if (context.stream.length === 0 && !context.assistantOpen) {
				context.streamWarning = "message_update without assistant message_start";
			}
			context.stream.push(envelope);
			return;
		case "message_end":
			if (event.message.role === "assistant") context.assistantOpen = false;
			return emit(context, items, envelope, {
				kind: "message-lifecycle",
				label: `message end: ${event.message.role}`,
			});
		case "tool_execution_start":
			return emit(context, items, envelope, {
				kind: "tool-start",
				label: `tool start: ${event.toolName}`,
				toolCallId: event.toolCallId,
			});
		case "tool_execution_update":
			return emit(context, items, envelope, {
				kind: "tool-update-live",
				label: `tool update: ${event.toolName}`,
				toolCallId: event.toolCallId,
			});
		case "tool_execution_end":
			return emit(context, items, envelope, {
				kind: "tool-end",
				label: `tool end: ${event.toolName}`,
				toolCallId: event.toolCallId,
			});
		case "compaction_start":
			return emit(context, items, envelope, {
				kind: "compaction",
				label: `compaction in progress: ${event.reason}`,
			});
		case "compaction_end":
			return emit(context, items, envelope, {
				kind: "compaction",
				label: event.status === "completed"
					? `compaction completed: ${event.reason}, ${event.tokensBefore} tokens before`
					: `compaction failed: ${event.reason} (${event.errorMessage})`,
			});
		default:
			return emit(context, items, envelope, {
				kind: "diagnostic",
				label: "unknown event",
				warning: `unknown event type: ${(event as { type: string }).type}`,
			});
	}
}
