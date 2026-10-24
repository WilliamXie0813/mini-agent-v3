import type {
	AgentEventEnvelope,
	ServerMessage,
	SessionSnapshot,
} from "@mini-agent/protocol";

import { liveStatusTransition } from "./live-status.ts";
import type { AppAction, AppState, SessionViewState } from "./types.ts";

export function createInitialAppState(): AppState {
	return { connection: "connecting", prompt: "", pendingRequests: {} };
}

export function reduceAppState(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "connection.changed":
			return { ...state, connection: action.connection };
		case "prompt.changed":
			return { ...state, prompt: action.prompt };
		case "timeline.selected":
			return { ...state, selectedTimelineItemId: action.itemId };
		case "local.error":
			return {
				...state,
				lastProtocolError: { code: action.code, message: action.message },
			};
		case "server.message":
			return reduceServerMessage(state, action.message);
	}
}

function reduceServerMessage(state: AppState, message: ServerMessage): AppState {
	switch (message.type) {
		case "server.ready":
			return { ...state, connection: "connected" };
		case "session.snapshot":
			return applySnapshot(state, message.snapshot);
		case "agent.event":
			return applyAgentEvent(state, message.envelope);
		case "command.accepted":
			return {
				...state,
				pendingRequests: {
					...state.pendingRequests,
					[message.requestId]: message.command,
				},
			};
		case "command.completed":
			return removePending(state, message.requestId);
		case "protocol.error": {
			const next = message.requestId
				? removePending(state, message.requestId)
				: state;
			return {
				...next,
				lastProtocolError: { code: message.code, message: message.message },
			};
		}
	}
}

function removePending(state: AppState, requestId: string): AppState {
	if (!(requestId in state.pendingRequests)) return state;
	const pendingRequests = { ...state.pendingRequests };
	delete pendingRequests[requestId];
	return { ...state, pendingRequests };
}

// snapshot 是唯一事实源：原子替换 session 内全部字段，旧 diagnostics 随之失效。
function applySnapshot(
	state: AppState,
	snapshot: SessionSnapshot,
): AppState {
	const session: SessionViewState = {
		sessionId: snapshot.sessionId,
		leafId: snapshot.leafId,
		status: snapshot.status,
		agentActive: snapshot.status === "running",
		compactionActive: snapshot.status === "compacting",
		entries: snapshot.entries,
		events: [...snapshot.transientEvents],
		latestSequence: snapshot.latestSequence,
		diagnostics: [],
	};
	const selected = state.selectedTimelineItemId;
	return {
		...state,
		session,
		selectedTimelineItemId:
			selected && isSelectionValid(selected, session) ? selected : undefined,
	};
}

function isSelectionValid(itemId: string, session: SessionViewState): boolean {
	if (itemId.startsWith("entry:")) {
		return session.entries.some((entry) => `entry:${entry.id}` === itemId);
	}
	if (itemId.startsWith("event:")) {
		return session.events.some(
			(envelope) =>
				`event:${envelope.sessionId}:${envelope.sequence}` === itemId,
		);
	}
	return false;
}

// agent/compaction 事件各自成对（core 保证失败路径也补齐配对），live status
// 的推进规则在 live-status.ts；此处只负责 sequence 校验与事件追加。
function applyAgentEvent(
	state: AppState,
	envelope: AgentEventEnvelope,
): AppState {
	const session = state.session;
	if (!session) return state;
	if (envelope.sessionId !== session.sessionId) {
		return withDiagnostic(
			state,
			session,
			`ignored event for session ${envelope.sessionId}`,
		);
	}
	const expected = nextExpectedSequence(session);
	if (envelope.sequence < expected) {
		return withDiagnostic(
			state,
			session,
			`duplicate agent event sequence ${envelope.sequence} dropped`,
		);
	}
	let next: AppState = {
		...state,
		session: {
			...session,
			events: [...session.events, envelope],
			latestSequence: envelope.sequence,
			...liveStatusTransition(session, envelope.event),
		},
	};
	if (envelope.sequence > expected) {
		next = withDiagnostic(
			next,
			next.session ?? session,
			`sequence gap: expected ${expected}, received ${envelope.sequence}`,
		);
	}
	return next;
}

// 新 snapshot 没有 transient events 且 latestSequence === 0 时表示尚未见过任何
// event，第一条 sequence 0 必须接受；否则只接受严格递增的 sequence。
function nextExpectedSequence(session: SessionViewState): number {
	const last = session.events.at(-1);
	if (last) return last.sequence + 1;
	return session.latestSequence === 0 ? 0 : session.latestSequence + 1;
}

function withDiagnostic(
	state: AppState,
	session: SessionViewState,
	message: string,
): AppState {
	const suffixes = session.diagnostics
		.map((diagnostic) => Number(diagnostic.id.split(":").at(-1)))
		.filter((suffix) => Number.isInteger(suffix));
	const next = suffixes.length > 0 ? Math.max(...suffixes) + 1 : 1;
	return {
		...state,
		session: {
			...session,
			diagnostics: [
				...session.diagnostics,
				{ id: `diag:${session.sessionId}:${next}`, message },
			],
		},
	};
}
