import type { AgentEvent, SessionViewState } from "./types.ts";

export type LiveStatusFacts = Pick<
	SessionViewState,
	"status" | "agentActive" | "compactionActive"
>;

// agent/compaction 事件各自成对（core 保证失败路径也补齐配对）。status 只由这四类
// 事件推进：mid-run threshold compaction 期间 agent 仍 active，compaction_end 后
// 回到 running 而不是 idle；Stop 按钮与 composer 禁用全靠这里的 live status。
export function liveStatusTransition(
	session: LiveStatusFacts,
	event: AgentEvent,
): LiveStatusFacts {
	switch (event.type) {
		case "agent_start":
			return {
				status: "running",
				agentActive: true,
				compactionActive: session.compactionActive,
			};
		case "agent_end":
			return {
				status: session.compactionActive ? "compacting" : "idle",
				agentActive: false,
				compactionActive: session.compactionActive,
			};
		case "compaction_start":
			return {
				status: "compacting",
				agentActive: session.agentActive,
				compactionActive: true,
			};
		case "compaction_end":
			return {
				status: session.agentActive ? "running" : "idle",
				agentActive: session.agentActive,
				compactionActive: false,
			};
		default:
			return {
				status: session.status,
				agentActive: session.agentActive,
				compactionActive: session.compactionActive,
			};
	}
}
