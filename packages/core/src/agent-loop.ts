import { consumeAssistantMessage, getDefaultStreamFn } from "@mini-agent/ai";
import type {
	ContentBlock,
	Message,
	StreamContext,
	StreamDeltaHandler,
	StreamFn,
	ToolResultMessage,
} from "@mini-agent/ai";
import { executeToolCalls } from "./execute-tool-calls.ts";
import { toToolDeclarations } from "./tool.ts";
import type { ToolDef } from "./tool.ts";

export interface AgentLoopOptions {
	prompt: string;
	messages: Message[]; // 已有历史，函数会就地追加
	system: string; // 本阶段是纯字符串；阶段 8 改为 SystemMessage
	streamFn?: StreamFn; // 缺省 fallback 到 getDefaultStreamFn()
	signal?: AbortSignal;
	onDelta?: StreamDeltaHandler; // 流式增量只给 UI 看；入历史的永远是 done 携带的那条消息
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

	options.messages.push({
		role: "user",
		content: [{ type: "text", text: options.prompt }],
	});

	// 单层循环（双层 follow-up 是阶段 13）：每轮 = 一次 streamFn 往返 + 一批工具执行。
	// 收敛条件只有一个——模型返回的消息里没有 toolCall。
	for (let turn = 0; turn < maxTurns; turn++) {
		// 中止只检查事件边界：进入新一轮前不再问模型（length 保护的 continue 可能带着已中止的 signal 回到这里）。
		if (options.signal?.aborted) return options.messages;
		const context: StreamContext = {
			system: { role: "system", content: options.system },
			messages: [...options.messages], // 快照：provider 拿到的是本次请求那一刻的历史
			tools: toToolDeclarations(tools),
		};

		// 只有 done 携带的完整消息才进历史：delta 是传输层的碎块，
		// 一次响应的 40 个 delta 共同描述的是 1 条 assistant 消息（spec §5 阶段 3）。
		const message = await consumeAssistantMessage(streamFn(context, options.signal), options.onDelta);
		options.messages.push(message);

		// length 保护：参数 JSON 被 token 上限截断，半截参数「解析成功但不完整」，
		// 执行它可能删错文件。整批判失败回喂，模型可重发。
		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) return options.messages;
		if (message.stopReason === "length") {
			options.messages.push(...truncatedBatchFailures(toolCalls, tools));
			continue;
		}

		const batch = await executeToolCalls(toolCalls, tools, options.signal);
		options.messages.push(...batch.messages);
		// 工具执行后的 abort 检查放在结果之后：中止不能让已经执行的工具结果丢失。
		if (options.signal?.aborted) return options.messages;
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

// 不导出：只服务 length 保护这一个分支；文案是给模型看的，必须包含「怎么办」。
// 收 ContentBlock[] 而非收窄后的 toolCall 块：调用方虽然已过滤，但这里不假设——
// 与 executeToolCalls 不收窄签名是同一个理由。
function truncatedBatchFailures(
	toolCalls: ContentBlock[],
	tools: ToolDef<any>[],
): ToolResultMessage[] {
	return toolCalls.map((block) => {
		const name = block.type === "toolCall" ? block.name : "unknown";
		return {
			role: "toolResult",
			toolCallId: block.type === "toolCall" ? block.id : "unknown",
			toolName: name,
			content: [
				{
					type: "text",
					text: `Tool "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
				},
			],
			isError: true,
		};
	});
}
