import { createInitialSystemMessage } from "@mini-agent/ai";
import type { Message } from "@mini-agent/ai";
import type { AgentEvent } from "./agent-event.ts";
import { toToolDeclarations } from "./tool.ts";
import type { ToolDef } from "./tool.ts";

export interface AgentState {
	messages: Message[];
	tools: ToolDef<any>[];
	isStreaming: boolean;
}

// 阶段 8：transcript 是 system 状态的唯一权威。已有任何 system entry 的历史
// 原样保留（resume 场景，阶段 9 直接复用这条规则），不再 prepend 初始消息。
export function createAgentState(
	messages: Message[],
	tools: ToolDef<any>[],
	system: string,
): AgentState {
	const history = messages.slice();
	if (!history.some((message) => message.role === "system")) {
		const initial = createInitialSystemMessage(system, toToolDeclarations(tools));
		if (initial) history.unshift(initial);
	}
	return {
		messages: history,
		tools: tools.slice(),
		isStreaming: false,
	};
}

export function reduceAgentState(
	state: AgentState,
	event: AgentEvent,
): void {
	if (event.type === "message_end") state.messages.push(event.message);
}
