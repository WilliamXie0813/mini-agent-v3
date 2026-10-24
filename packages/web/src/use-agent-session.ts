import { useEffect, useMemo, useReducer, useRef } from "react";

import type { ClientCommand } from "@mini-agent/protocol";

import { createProtocolClient, resolveAgentSocketUrl } from "./protocol-client.ts";
import type { ProtocolClient } from "./protocol-client.ts";
import { createInitialAppState, reduceAppState } from "./state/reducer.ts";
import type { AppState } from "./state/types.ts";
import type { WorkspaceProps } from "./workspace.tsx";

export interface AgentSession {
	state: AppState;
	actions: Omit<WorkspaceProps, "state">;
}

// Hook 只负责 client 生命周期、reducer dispatch、requestId 生成，
// 以及把 Send/Stop/Compact 翻译成 typed command；
// tool card、usage、timeline 的解释全部留在 selector 层。
export function useAgentSession(): AgentSession {
	const [state, dispatch] = useReducer(
		reduceAppState,
		undefined,
		createInitialAppState,
	);
	const clientRef = useRef<ProtocolClient | null>(null);

	useEffect(() => {
		const client = createProtocolClient({
			url: resolveAgentSocketUrl(window.location),
			onMessage: (message) => dispatch({ type: "server.message", message }),
			onConnectionChange: (connection) =>
				dispatch({ type: "connection.changed", connection }),
		});
		clientRef.current = client;
		client.connect();
		return () => {
			clientRef.current = null;
			client.close();
		};
	}, []);

	const actions = useMemo<Omit<WorkspaceProps, "state">>(() => {
		const send = (command: ClientCommand): void => {
			const client = clientRef.current;
			if (!client) return;
			try {
				client.send(command);
			} catch (error) {
				dispatch({
					type: "local.error",
					code: "NOT_CONNECTED",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		};
		return {
			onPromptChange: (prompt) => dispatch({ type: "prompt.changed", prompt }),
			onSubmit: () => {
				const prompt = state.prompt;
				if (prompt.trim().length === 0) {
					dispatch({
						type: "local.error",
						code: "EMPTY_PROMPT",
						message: "Prompt must not be empty",
					});
					return;
				}
				send({ type: "prompt.submit", requestId: crypto.randomUUID(), prompt });
			},
			onAbort: () => send({ type: "run.abort", requestId: crypto.randomUUID() }),
			onCompact: () =>
				send({ type: "session.compact", requestId: crypto.randomUUID() }),
			onSelectTimelineItem: (itemId) =>
				dispatch({ type: "timeline.selected", itemId }),
		};
	}, [state.prompt]);

	return { state, actions };
}
