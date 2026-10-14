import { isDeepStrictEqual } from "node:util";
import type { Message, SystemMessage, Tool } from "./types.ts";

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: string[];
}

// 声明复制只保留 model-visible 三字段：execute/replay/executionMode 是运行时属性，
// 属于执行注册表，不属于历史；parameters 深拷贝，历史里的声明之后不被调用方改到。
function copyDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: structuredClone(tool.parameters),
	};
}

// 新会话的组装层简写：AgentOptions.system + 初始工具 → 一条 leading system message。
// 两者都空时返回 undefined——没有内容就不制造历史条目。
export function createInitialSystemMessage(
	systemPrompt: string,
	tools?: readonly Tool[],
): SystemMessage | undefined {
	const declarations = tools ?? [];
	if (systemPrompt === "" && declarations.length === 0) return undefined;
	return {
		role: "system",
		sections: systemPrompt === "" ? [] : [{ text: systemPrompt }],
		...(declarations.length > 0
			? { toolsAdded: declarations.map(copyDeclaration) }
			: {}),
	};
}

// 重放整条 transcript 得到当前 system 快照。旧 entries 是 append-only 输入，只读不改。
// snapshot 只含累计 sections 与当前 toolsAdded——已消费的 toolsRemoved 不回带。
export function getCurrentSystemMessage(
	messages: readonly Message[],
): SystemMessage {
	const sections: SystemMessage["sections"] = [];
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		sections.push(...message.sections.map((section) => ({ ...section })));
		// 同一条消息先 remove 再 add：同名工具的定义变化就能表示为 remove + add。
		for (const name of message.toolsRemoved ?? []) tools.delete(name);
		for (const tool of message.toolsAdded ?? []) {
			// 先 delete 再 set：重新加入的工具排到末尾，保持插入顺序语义。
			tools.delete(tool.name);
			tools.set(tool.name, copyDeclaration(tool));
		}
	}
	return {
		role: "system",
		sections,
		...(tools.size > 0 ? { toolsAdded: [...tools.values()] } : {}),
	};
}

// wire system 文本：只拼接非空 section text，tag 不自动渲染，section 自身空白不 trim。
export function getCurrentSystemPrompt(messages: readonly Message[]): string {
	return getCurrentSystemMessage(messages)
		.sections.map((section) => section.text)
		.filter((text) => text !== "")
		.join("\n\n");
}

export function getCurrentTools(messages: readonly Message[]): Tool[] {
	return getCurrentSystemMessage(messages).toolsAdded ?? [];
}

// 只比较 model-visible 声明：同名同描述同 schema 的两个对象没有 delta——
// 换 execute 闭包不该产生新历史条目，换 description/schema 必须产生。
export function toolDeclarationsEqual(left: Tool, right: Tool): boolean {
	return left.name === right.name &&
		left.description === right.description &&
		isDeepStrictEqual(left.parameters, right.parameters);
}

export function getToolStateChanges(
	previous: readonly Tool[],
	current: readonly Tool[],
): ToolStateChanges {
	const toolsRemoved = previous
		.filter((tool) => {
			const next = current.find((candidate) => candidate.name === tool.name);
			return !next || !toolDeclarationsEqual(tool, next);
		})
		.map((tool) => tool.name);
	const toolsAdded = current
		.filter((tool) => {
			const prior = previous.find((candidate) => candidate.name === tool.name);
			return !prior || !toolDeclarationsEqual(prior, tool);
		})
		.map(copyDeclaration);
	return { toolsAdded, toolsRemoved };
}
