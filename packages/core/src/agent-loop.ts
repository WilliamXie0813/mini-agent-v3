import { getDefaultStreamFn } from "@mini-agent/ai";
import type {
	Message,
	StreamContext,
	StreamDeltaHandler,
	StreamFn,
	ToolResultMessage,
} from "@mini-agent/ai";
import type { AgentEventSink } from "./agent-event.ts";
import {
	executeToolCalls,
	failTruncatedToolCalls,
} from "./execute-tool-calls.ts";
import { streamAssistantMessage } from "./stream-assistant.ts";
import { toToolDeclarations } from "./tool.ts";
import type { ToolDef } from "./tool.ts";

export interface AgentLoopOptions {
	prompt: string;
	messages: Message[]; // 已有历史，函数会就地追加
	system: string; // 本阶段是纯字符串；阶段 8 改为 SystemMessage
	streamFn?: StreamFn; // 缺省 fallback 到 getDefaultStreamFn()
	signal?: AbortSignal;
	onDelta?: StreamDeltaHandler; // 流式增量只给 UI 看；入历史的永远是 done 携带的那条消息
	emit?: AgentEventSink;
	tools?: ToolDef<any>[]; // 缺省 []：无工具的调用走一轮就收敛，与阶段 1 行为一致
	maxTurns?: number; // 缺省 10：模型反复要工具时的熔断，防止无限烧 token
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
	const newMessages: Message[] = [];

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
		const context: StreamContext = {
			system: { role: "system", content: options.system },
			messages: [...options.messages], // 快照：provider 拿到的是本次请求那一刻的历史
			tools: toToolDeclarations(tools),
		};

		// 只有 done 携带的完整消息才进历史：delta 是传输层的碎块，
		// 一次响应的 40 个 delta 共同描述的是 1 条 assistant 消息（spec §5 阶段 3）。
		const message = await streamAssistantMessage(
			streamFn(context, options.signal),
			async (event) => {
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					options.onDelta?.(event.assistantMessageEvent.delta);
				}
				await emit(event);
			},
		);
		options.messages.push(message);
		newMessages.push(message);

		// length 保护：参数 JSON 被 token 上限截断，半截参数「解析成功但不完整」，
		// 执行它可能删错文件。整批判失败回喂，模型可重发。
		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) {
			await emit({ type: "turn_end", message, toolResults: [] });
			await emit({ type: "agent_end", messages: newMessages });
			return options.messages;
		}
		let toolResults: ToolResultMessage[];
		if (message.stopReason === "length") {
			toolResults = (await failTruncatedToolCalls(toolCalls, emit)).messages;
		} else {
			const batch = await executeToolCalls(
				toolCalls,
				tools,
				options.signal,
				emit,
			);
			toolResults = batch.messages;
		}
		options.messages.push(...toolResults);
		newMessages.push(...toolResults);
		await emit({ type: "turn_end", message, toolResults });
		if (options.signal?.aborted) {
			await emit({ type: "turn_start" });
			throw new Error("agent loop aborted");
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
