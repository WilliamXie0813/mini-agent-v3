import { getCurrentSystemMessage, getCurrentTools } from "@mini-agent/ai";
import type { Message, StreamFn, ToolResultMessage } from "@mini-agent/ai";
import type { AgentEventSink } from "./agent-event.ts";
import type { AgentLoopOptions } from "./agent-options.ts";
import {
	executeToolCalls,
	failTruncatedToolCalls,
} from "./execute-tool-calls.ts";
import { getAgentTurnSignal, prepareAgentTurn } from "./prepare-agent-turn.ts";
import { streamAssistantMessage } from "./stream-assistant.ts";
import type { ToolDef } from "./tool.ts";

export interface AgentTurnState {
	turn: number;
	overflowRecovered: boolean;
	newMessages: Message[];
}

export type AgentTurnResult = "continue" | "stop" | "terminal";

export type AgentTurnOptions = Omit<
	AgentLoopOptions,
	| "prompt"
	| "maxTurns"
	| "streamFn"
	| "tools"
	| "emit"
	| "steeringQueue"
	| "followUpQueue"
> & {
	streamFn: StreamFn;
	tools: ToolDef<any>[];
	emit: AgentEventSink;
	state: AgentTurnState;
};

export async function runAgentTurn(
	options: AgentTurnOptions,
): Promise<AgentTurnResult> {
	if (options.signal?.aborted) throw new Error("agent loop aborted");
	const { messages, state, emit } = options;
	const { request, activeTools } = await prepareAgentTurn(options);

	// 只有 done 携带的完整消息才进历史：delta 是传输层的碎块，
	// 一次响应的 40 个 delta 共同描述的是 1 条 assistant 消息（spec §5 阶段 3）。
	const message = await streamAssistantMessage(
		options.streamFn(request, options.signal),
		emit,
	);
	messages.push(message);
	state.newMessages.push(message);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		await emit({ type: "turn_end", message, toolResults: [] });
		// 结构化超窗（provider 已分类，core 不匹配错误字符串）：先 append 诊断、
		// 走完当前 turn_end，再交给编排层压缩一次并重试。stopReason "length"
		// 是输出上限，不是超窗，不走这条路。
		if (
			message.errorKind === "context_overflow" &&
			!state.overflowRecovered &&
			options.recoverContextOverflow
		) {
			const recovered = await options.recoverContextOverflow({
				context: {
					system: getCurrentSystemMessage(messages),
					messages: [...messages],
					tools: getCurrentTools(messages),
				},
				message,
				signal: getAgentTurnSignal(options),
			});
			if (recovered) {
				state.overflowRecovered = true;
				return "continue";
			}
		}
		return "terminal";
	}

	// length 保护：参数 JSON 被 token 上限截断，半截参数「解析成功但不完整」，
	// 执行它可能删错文件。整批判失败回喂，模型可重发。
	const toolCalls = message.content.filter((c) => c.type === "toolCall");
	if (toolCalls.length === 0) {
		await emit({ type: "turn_end", message, toolResults: [] });
		// finishTurn 只在模型正常收敛时被咨询（stopReason error/aborted 的轮次
		// 在上面已返回，到不了这里）。continue 从同一个 maxTurns 预算再要一轮，
		// 预算耗尽照旧抛 hit maxTurns——不为 continue 单开计数器。
		const decision = options.finishTurn
			? await options.finishTurn(
					{ message, toolResults: [], messages, turn: state.turn },
					options.signal,
				)
			: undefined;
		return decision?.action === "continue" ? "continue" : "stop";
	}
	let toolResults: ToolResultMessage[];
	let terminate = false;
	if (message.stopReason === "length") {
		toolResults = (
			await failTruncatedToolCalls(toolCalls, options.signal, emit)
		).messages;
	} else {
		const batch = await executeToolCalls(toolCalls, {
			assistantMessage: message,
			messages,
			tools: activeTools,
			signal: options.signal,
			emit,
			beforeToolCall: options.beforeToolCall,
			afterToolCall: options.afterToolCall,
			toolExecution: options.toolExecution,
			commitToolIntent: options.commitToolIntent,
		});
		toolResults = batch.messages;
		terminate = batch.terminate;
	}
	messages.push(...toolResults);
	state.newMessages.push(...toolResults);
	await emit({ type: "turn_end", message, toolResults });
	if (options.signal?.aborted) {
		await emit({ type: "turn_start" });
		throw new Error("agent loop aborted");
	}
	if (terminate) return "terminal";
	// 工具结果之后的第二条收敛分支：terminate 硬停已在上面优先返回，
	// 扩展不得复活；finishTurn 在 turn_end 之后被咨询（订阅者先看到轮次关闭）。
	// 这里 loop 的默认走向是继续下一轮，所以只有显式 "end" 提前收敛；
	// "continue" 与 void 都维持原行为（void 不改变模型驱动的收敛）。
	const decision = options.finishTurn
		? await options.finishTurn(
				{ message, toolResults, messages, turn: state.turn },
				options.signal,
			)
		: undefined;
	return decision?.action === "end" ? "stop" : "continue";
}
