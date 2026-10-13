import {
	useEffect,
	useReducer,
	useRef,
} from "react";
import type { ClientCommand } from "@mini-agent/protocol";
import {
	browserWebSocketUrl,
	createProtocolClient,
} from "./protocol-client.ts";
import type {
	ProtocolClient,
	ProtocolClientOptions,
} from "./protocol-client.ts";
import {
	createInitialAppState,
	reduceAppState,
} from "./state/reducer.ts";
import type { AppState } from "./state/types.ts";
import type { WorkspaceProps } from "./components/workspace.tsx";

export interface UseAgentSessionOptions {
	url?: string;
	createClient?: (options: ProtocolClientOptions) => ProtocolClient;
	createRequestId?: () => string;
}

export type AgentSessionActions = Omit<WorkspaceProps, "state">;

export function useAgentSession(
	options: UseAgentSessionOptions = {},
): { state: AppState; actions: AgentSessionActions } {
	const [state, dispatch] = useReducer(
		reduceAppState,
		undefined,
		createInitialAppState,
	);
	const clientRef = useRef<ProtocolClient | undefined>(undefined);
	const requestId = options.createRequestId ?? (() => crypto.randomUUID());

	useEffect(() => {
		const client = (options.createClient ?? createProtocolClient)({
			url: options.url ?? browserWebSocketUrl(),
			onMessage: (message) => {
				dispatch({ type: "server.message", message });
			},
			onConnectionChange: (connection) => {
				dispatch({ type: "connection.changed", connection });
			},
		});
		clientRef.current = client;
		try {
			client.connect();
		} catch (error) {
			reportClientError(dispatch, error);
		}
		return () => {
			client.close();
			clientRef.current = undefined;
		};
	}, []);

	const send = (command: ClientCommand) => {
		try {
			clientRef.current?.send(command);
		} catch (error) {
			reportClientError(dispatch, error);
		}
	};

	return {
		state,
		actions: {
			onSelectScenario: (scenarioId) => {
				dispatch({ type: "scenario.selected", scenarioId });
			},
			onPromptChange: (prompt) => {
				dispatch({ type: "prompt.changed", prompt });
			},
			onRun: () => {
				if (
					state.connection !== "connected" ||
					!state.selectedScenarioId ||
					state.prompt.trim() === ""
				) return;
				send({
					type: "run.start",
					requestId: requestId(),
					scenarioId: state.selectedScenarioId,
					prompt: state.prompt,
				});
			},
			onAbort: () => {
				send({ type: "run.abort", requestId: requestId() });
			},
			onReset: () => {
				send({ type: "workspace.reset", requestId: requestId() });
			},
			onSelectTimelineItem: (itemId) => {
				dispatch({ type: "timeline.selected", itemId });
			},
		},
	};
}

function reportClientError(
	dispatch: React.Dispatch<Parameters<typeof reduceAppState>[1]>,
	error: unknown,
): void {
	dispatch({
		type: "server.message",
		message: {
			type: "protocol.error",
			code: "CLIENT_ERROR",
			message: error instanceof Error ? error.message : String(error),
		},
	});
}
