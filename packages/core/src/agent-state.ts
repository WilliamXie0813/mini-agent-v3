import { createInitialSystemMessage, getCurrentTools, getToolStateChanges } from "@mini-agent/ai";
import type { Message, SystemSection } from "@mini-agent/ai";
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

// 只追加不改旧：prompt 更新是一条新的 system entry，sections 在调用时复制快照。
export function appendSystemSections(
	state: AgentState,
	sections: readonly SystemSection[],
): void {
	if (sections.length === 0) return;
	state.messages.push({
		role: "system",
		sections: sections.map((section) => ({ ...section })),
	});
}

// 先重放 transcript 里的旧声明，再算最小 delta；两边都空就不新增历史条目——
// 相同声明重复设置是 prompt cache 命中的前提。声明 delta 只记 model-visible 字段。
export function replaceAgentTools(
	state: AgentState,
	tools: ToolDef<any>[],
): void {
	const changes = getToolStateChanges(
		getCurrentTools(state.messages),
		toToolDeclarations(tools),
	);
	if (changes.toolsAdded.length > 0 || changes.toolsRemoved.length > 0) {
		state.messages.push({
			role: "system",
			sections: [],
			// 只写非空的一侧：纯新增不带 toolsRemoved: []，反之亦然。
			...(changes.toolsRemoved.length > 0
				? { toolsRemoved: changes.toolsRemoved }
				: {}),
			...(changes.toolsAdded.length > 0
				? { toolsAdded: changes.toolsAdded }
				: {}),
		});
	}
	state.tools = tools.slice();
}
