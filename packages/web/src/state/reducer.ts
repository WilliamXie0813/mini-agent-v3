import type {
	AgentEventEnvelope,
	ServerMessage,
} from "@mini-agent/protocol";
import type {
	AppAction,
	AppState,
	RunViewState,
} from "./types.ts";

export function createInitialAppState(): AppState {
	return {
		connection: "connecting",
		scenarios: [],
		prompt: "",
	};
}

export function reduceAppState(
	state: AppState,
	action: AppAction,
): AppState {
	switch (action.type) {
		case "connection.changed":
			return { ...state, connection: action.connection };
		case "scenario.selected":
			return { ...state, selectedScenarioId: action.scenarioId };
		case "prompt.changed":
			return { ...state, prompt: action.prompt };
		case "timeline.selected":
			return { ...state, selectedTimelineItemId: action.itemId };
		case "workspace.cleared":
			return clearWorkspace(state);
		case "server.message":
			return reduceServerMessage(state, action.message);
	}
}

function reduceServerMessage(
	state: AppState,
	message: ServerMessage,
): AppState {
	switch (message.type) {
		case "server.ready":
			return {
				...state,
				connection: "connected",
				scenarios: message.scenarios,
				selectedScenarioId:
					state.selectedScenarioId &&
					message.scenarios.some(({ id }) => id === state.selectedScenarioId)
						? state.selectedScenarioId
						: message.scenarios[0]?.id,
			};
		case "run.accepted":
			return {
				...state,
				run: freshRun(message.runId),
				selectedTimelineItemId: undefined,
				lastProtocolError: undefined,
			};
		case "agent.event":
			return appendEnvelope(state, message);
		case "run.settled":
			return settleRun(state, message.runId, message.outcome);
		case "workspace.reset":
			return clearWorkspace(state);
		case "protocol.error":
			return {
				...state,
				lastProtocolError: {
					code: message.code,
					message: message.message,
				},
			};
	}
}

function freshRun(runId: string): RunViewState {
	return {
		runId,
		status: "running",
		envelopes: [],
		diagnostics: [],
	};
}

function appendEnvelope(
	state: AppState,
	envelope: AgentEventEnvelope,
): AppState {
	const run = state.run?.runId === envelope.runId
		? state.run
		: {
				...freshRun(envelope.runId),
				diagnostics: [{
					code: "EVENT_WITHOUT_ACCEPTED_RUN",
					message: `Received event for unaccepted run ${envelope.runId}.`,
					sequence: envelope.sequence,
				}],
			};
	const duplicate = run.envelopes.some(
		({ sequence }) => sequence === envelope.sequence,
	);
	return {
		...state,
		run: {
			...run,
			envelopes: [...run.envelopes, envelope],
			diagnostics: duplicate
				? [
						...run.diagnostics,
						{
							code: "DUPLICATE_SEQUENCE",
							message: `Sequence ${envelope.sequence} was received more than once.`,
							sequence: envelope.sequence,
						},
					]
				: run.diagnostics,
		},
	};
}

function settleRun(
	state: AppState,
	runId: string,
	outcome: RunViewState["status"],
): AppState {
	if (!state.run || state.run.runId !== runId) {
		return {
			...state,
			lastProtocolError: {
				code: "UNEXPECTED_SETTLED_RUN",
				message: `Received settlement for unknown run ${runId}.`,
			},
		};
	}
	return { ...state, run: { ...state.run, status: outcome } };
}

function clearWorkspace(state: AppState): AppState {
	return {
		...state,
		prompt: "",
		run: undefined,
		selectedTimelineItemId: undefined,
		lastProtocolError: undefined,
	};
}
