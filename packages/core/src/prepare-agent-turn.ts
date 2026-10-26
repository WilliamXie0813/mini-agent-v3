import {
	getCurrentSystemMessage,
	getCurrentTools,
	toolDeclarationsEqual,
} from "@mini-agent/ai";
import type { StreamContext, SystemMessage } from "@mini-agent/ai";
import { AgentInfrastructureFailure } from "./agent-infrastructure-failure.ts";
import type { AgentTurnOptions } from "./agent-turn.ts";
import type { ToolDef } from "./tool.ts";

const runSignals = new WeakMap<AgentTurnOptions, AbortSignal>();

export function getAgentTurnSignal(options: AgentTurnOptions): AbortSignal {
	if (options.signal) return options.signal;
	let signal = runSignals.get(options);
	if (!signal) {
		signal = new AbortController().signal;
		runSignals.set(options, signal);
	}
	return signal;
}

export async function prepareAgentTurn(
	options: AgentTurnOptions,
): Promise<{ request: StreamContext; activeTools: ToolDef<any>[] }> {
	const { messages, state } = options;
	const signal = getAgentTurnSignal(options);
	// 阶段 11：prepareNextTurnWithContext 在 turn_start 之后、replay 之前被咨询——
	// turn_start 已发出，本轮的 system 变更因此归属下一轮（与 pi 的顺序一致）。
	// 三个字段合并进一条真 SystemMessage 追加进 transcript：getCurrentSystemMessage /
	// getCurrentTools 的权威是历史本身，旁路改 context 会在下一轮 replay 时被抹掉、
	// 也进不了 journal。三者全空时是 no-op：不发事件、不写历史。
	if (state.turn > 0 && options.prepareNextTurnWithContext) {
		const result = await options.prepareNextTurnWithContext({
			messages,
			turn: state.turn,
			signal,
		});
		if (
			result &&
			(result.sections?.length ||
				result.toolsAdded?.length ||
				result.toolsRemoved?.length)
		) {
			const message: SystemMessage = {
				role: "system",
				sections: result.sections?.map((section) => ({ ...section })) ?? [],
				...(result.toolsRemoved?.length
					? { toolsRemoved: [...result.toolsRemoved] }
					: {}),
				...(result.toolsAdded?.length
					? { toolsAdded: [...result.toolsAdded] }
					: {}),
			};
			messages.push(message);
			state.newMessages.push(message);
			await options.emit({ type: "message_start", message });
			await options.emit({ type: "message_end", message });
		}
	}
	// 每轮都从 transcript 重新重放：system 与工具声明的唯一权威是历史本身。
	// replay 结果只活在本次请求 context 里，不写回 transcript。
	const context: StreamContext = {
		system: getCurrentSystemMessage(messages),
		messages: [...messages], // 快照：provider 拿到的是本次请求那一刻的历史
		tools: getCurrentTools(messages),
	};

	// 调用模型前的最后替换缝（阶段 10）：hook 之后本轮可执行工具
	// 以 prepared context 的声明为准——被 hook 移除的工具即使有闭包也不执行。
	const prepared = options.prepareRequest
		? await options.prepareRequest({ context, signal })
		: context;
	const activeTools = options.tools.filter((tool) =>
		prepared.tools.some((declaration) => toolDeclarationsEqual(tool, declaration)),
	);

	// 阶段 11：transformContext 是发给 provider 前的最后一个决策 hook，只重写 messages
	// （过滤/重排），不改工具声明——改声明是 prepareNextTurnWithContext 的职责。
	// 契约：返回数组非空，且每个元素必须与 prepared.messages 中某一元素引用相同；
	// 伪造新对象是调用方 bug，按基础设施失败中止本次 run（agent.ts 解包后原样冒泡）。
	let request: StreamContext = prepared;
	if (options.transformContext) {
		const transformed = await options.transformContext(prepared.messages, signal);
		if (transformed.length === 0) {
			throw new AgentInfrastructureFailure(
				new TypeError("transformContext must return a non-empty message array"),
			);
		}
		const known = new Set(prepared.messages);
		for (const message of transformed) {
			if (!known.has(message)) {
				throw new AgentInfrastructureFailure(
					new TypeError(
						"transformContext must only filter or reorder the messages it received",
					),
				);
			}
		}
		request = { ...prepared, messages: transformed };
	}
	return { request, activeTools };
}
