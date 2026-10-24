import type * as React from "react";

import { useAgentSession } from "./use-agent-session.ts";
import { Workspace } from "./workspace.tsx";

export function App(): React.JSX.Element {
	const { state, actions } = useAgentSession();
	return <Workspace state={state} {...actions} />;
}
