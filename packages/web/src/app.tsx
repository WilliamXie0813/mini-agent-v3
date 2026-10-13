import { Workspace } from "./components/workspace.tsx";
import { useAgentSession } from "./use-agent-session.ts";

export function App(): React.JSX.Element {
	const session = useAgentSession();
	return <Workspace state={session.state} {...session.actions} />;
}
