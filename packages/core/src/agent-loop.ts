import { getDefaultStreamFn, getCurrentSystemMessage, getCurrentTools, toolDeclarationsEqual } from "@mini-agent/ai";
import type {
	Message,
	StreamContext,
	StreamFn,
	SystemMessage,
	ToolResultMessage,
} from "@mini-agent/ai";
import { AgentInfrastructureFailure } from "./agent-infrastructure-failure.ts";
import type { AgentEventSink } from "./agent-event.ts";
import type { AfterToolCall, FinishTurn, PrepareNextTurn, PrepareRequest, RecoverContextOverflow, TransformContext } from "./agent-options.ts";
import {
	executeToolCalls,
	failTruncatedToolCalls,
} from "./execute-tool-calls.ts";
import { streamAssistantMessage } from "./stream-assistant.ts";
import type {
	BeforeToolCall,
	CommitToolIntent,
	ToolDef,
	ToolExecutionMode,
} from "./tool.ts";

export interface AgentLoopOptions {
	prompt: string;
	messages: Message[]; // 完整 transcript（含 system entries），函数会就地追加
	streamFn?: StreamFn; // 缺省 fallback 到 getDefaultStreamFn()
	signal?: AbortSignal;
	emit?: AgentEventSink;
	tools?: ToolDef<any>[]; // 执行注册表；缺省 []：无工具的调用走一轮就收敛，与阶段 1 行为一致
	maxTurns?: number; // 缺省 10：模型反复要工具时的熔断，防止无限烧 token
	beforeToolCall?: BeforeToolCall;
	afterToolCall?: AfterToolCall;
	toolExecution?: ToolExecutionMode;
	commitToolIntent?: CommitToolIntent;
	prepareRequest?: PrepareRequest;
	transformContext?: TransformContext;
	recoverContextOverflow?: RecoverContextOverflow;
	finishTurn?: FinishTurn;
	prepareNextTurnWithContext?: PrepareNextTurn;
}

// 提前返回都在构造 user 消息之前（阶段 1 的约定，不要动）：已中止的 signal 不产生半条消息；
// 空白 prompt 不污染历史。
export async function agentLoop(options: AgentLoopOptions): Promise<Message[]> {
	if (options.signal?.aborted) return options.messages;
	if (options.prompt.trim() === "") return options.messages;

	// 不用 try/catch：未安装时让 getDefaultStreamFn 的具名错误直接冒泡给调用方。
	const streamFn = options.streamFn ?? getDefaultStreamFn();
	const tools = options.tools ?? [];
	const maxTurns = options.maxTurns ?? 10;
	const emit = options.emit ?? (() => {});
	// PrepareRequestContext.signal 是必需字段；调用方没给 signal 时用永不可中止的占位。
	const runSignal = new AbortController().signal;
	const newMessages: Message[] = [];
	// 一次 run 最多 compact-and-retry 一次：第二次 overflow 正常结束为 error，
	// 不得递归重试（否则超窗 + 压缩失败会烧成无限循环）。
	let overflowRecovered = false;

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: options.prompt }],
	};
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	options.messages.push(userMessage);
	newMessages.push(userMessage);
	await emit({ type: "message_start", message: userMessage });
	await emit({ type: "message_end", message: userMessage });

	// 单层循环（双层 follow-up 是阶段 13）：每轮 = 一次 streamFn 往返 + 一批工具执行。
	// 收敛条件只有一个——模型返回的消息里没有 toolCall。
	for (let turn = 0; turn < maxTurns; turn++) {
		if (turn > 0) await emit({ type: "turn_start" });
		if (options.signal?.aborted) throw new Error("agent loop aborted");
		// 阶段 11：prepareNextTurnWithContext 在 turn_start 之后、replay 之前被咨询——
		// turn_start 已发出，本轮的 system 变更因此归属下一轮（与 pi 的顺序一致）。
		// 三个字段合并进一条真 SystemMessage 追加进 transcript：getCurrentSystemMessage /
		// getCurrentTools 的权威是历史本身，旁路改 context 会在下一轮 replay 时被抹掉、
		// 也进不了 journal。三者全空时是 no-op：不发事件、不写历史。
		if (turn > 0 && options.prepareNextTurnWithContext) {
			const result = await options.prepareNextTurnWithContext({
				messages: options.messages,
				turn,
				signal: options.signal ?? runSignal,
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
				options.messages.push(message);
				newMessages.push(message);
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
			}
		}
		// 每轮都从 transcript 重新重放：system 与工具声明的唯一权威是历史本身。
		// replay 结果只活在本次请求 context 里，不写回 transcript。
		const currentSystem = getCurrentSystemMessage(options.messages);
		const currentTools = getCurrentTools(options.messages);
		const context: StreamContext = {
			system: currentSystem,
			messages: [...options.messages], // 快照：provider 拿到的是本次请求那一刻的历史
			tools: currentTools,
		};

		// 调用模型前的最后替换缝（阶段 10）：hook 之后本轮可执行工具
		// 以 prepared context 的声明为准——被 hook 移除的工具即使有闭包也不执行。
		const prepared = options.prepareRequest
			? await options.prepareRequest({ context, signal: options.signal ?? runSignal })
			: context;
		const activeTools = tools.filter((tool) =>
			prepared.tools.some((declaration) => toolDeclarationsEqual(tool, declaration)),
		);

		// 阶段 11：transformContext 是发给 provider 前的最后一个决策 hook，只重写 messages
		// （过滤/重排），不改工具声明——改声明是 prepareNextTurnWithContext 的职责。
		// 契约：返回数组非空，且每个元素必须与 prepared.messages 中某一元素引用相同；
		// 伪造新对象是调用方 bug，按基础设施失败中止本次 run（agent.ts 解包后原样冒泡）。
		let request: StreamContext = prepared;
		if (options.transformContext) {
			const messages = await options.transformContext(
				prepared.messages,
				options.signal ?? runSignal,
			);
			if (messages.length === 0) {
				throw new AgentInfrastructureFailure(
					new TypeError("transformContext must return a non-empty message array"),
				);
			}
			const known = new Set(prepared.messages);
			for (const message of messages) {
				if (!known.has(message)) {
					throw new AgentInfrastructureFailure(
						new TypeError(
							"transformContext must only filter or reorder the messages it received",
						),
					);
				}
			}
			request = { ...prepared, messages };
		}

		// 只有 done 携带的完整消息才进历史：delta 是传输层的碎块，
		// 一次响应的 40 个 delta 共同描述的是 1 条 assistant 消息（spec §5 阶段 3）。
		const message = await streamAssistantMessage(
			streamFn(request, options.signal),
			emit,
		);
		options.messages.push(message);
		newMessages.push(message);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			await emit({ type: "turn_end", message, toolResults: [] });
			// 结构化超窗（provider 已分类，core 不匹配错误字符串）：先 append 诊断、
			// 走完当前 turn_end，再交给编排层压缩一次并重试。stopReason "length"
			// 是输出上限，不是超窗，不走这条路。
			if (
				message.errorKind === "context_overflow" &&
				!overflowRecovered &&
				options.recoverContextOverflow
			) {
				const recovered = await options.recoverContextOverflow({
					context: {
						system: getCurrentSystemMessage(options.messages),
						messages: [...options.messages],
						tools: getCurrentTools(options.messages),
					},
					message,
					signal: options.signal ?? runSignal,
				});
				if (recovered) {
					overflowRecovered = true;
					continue; // loop 顶部会为下一轮 emit turn_start
				}
			}
			await emit({ type: "agent_end", messages: newMessages });
			return options.messages;
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
						{ message, toolResults: [], messages: options.messages, turn },
						options.signal,
					)
				: undefined;
			if (decision?.action === "continue") continue;
			await emit({ type: "agent_end", messages: newMessages });
			return options.messages;
		}
		let toolResults: ToolResultMessage[];
		let terminate = false;
		if (message.stopReason === "length") {
			toolResults = (
				await failTruncatedToolCalls(toolCalls, options.signal, emit)
			).messages;
		} else {
			const batch = await executeToolCalls(
				toolCalls,
				{
					assistantMessage: message,
					messages: options.messages,
					tools: activeTools,
					signal: options.signal,
					emit,
					beforeToolCall: options.beforeToolCall,
					afterToolCall: options.afterToolCall,
					toolExecution: options.toolExecution,
					commitToolIntent: options.commitToolIntent,
				},
			);
			toolResults = batch.messages;
			terminate = batch.terminate;
		}
		options.messages.push(...toolResults);
		newMessages.push(...toolResults);
		await emit({ type: "turn_end", message, toolResults });
		if (options.signal?.aborted) {
			await emit({ type: "turn_start" });
			throw new Error("agent loop aborted");
		}
		if (terminate) {
			await emit({ type: "agent_end", messages: newMessages });
			return options.messages;
		}
		// 工具结果之后的第二条收敛分支：terminate 硬停已在上面优先返回，
		// 扩展不得复活；finishTurn 在 turn_end 之后被咨询（订阅者先看到轮次关闭）。
		// 这里 loop 的默认走向是继续下一轮，所以只有显式 "end" 提前收敛；
		// "continue" 与 void 都维持原行为（void 不改变模型驱动的收敛）。
		const decision = options.finishTurn
			? await options.finishTurn(
					{ message, toolResults, messages: options.messages, turn },
					options.signal,
				)
			: undefined;
		if (decision?.action === "end") {
			await emit({ type: "agent_end", messages: newMessages });
			return options.messages;
		}
	}

	// 错误信息带最后一轮的工具名：否则使用者看到 hit maxTurns 还得自己去翻历史
	// 才知道模型在反复调什么。不合成 assistant 消息——熔断本身就是异常路径。
	// 注意不能直接看 at(-1)：每轮的最后一条是 toolResult，工具名在往前一条的 assistant 里。
	const lastCaller = options.messages.findLast(
		(m) =>
			m.role === "assistant" && m.content.some((c) => c.type === "toolCall"),
	);
	const called =
		lastCaller?.role === "assistant"
			? lastCaller.content
					.filter((c) => c.type === "toolCall")
					.map((c) => c.name)
					.join(", ")
			: "unknown";
	throw new Error(
		`agent loop hit maxTurns (${maxTurns}) without the model stopping; last tool calls: ${called}`,
	);
}
