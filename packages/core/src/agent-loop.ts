import { getDefaultStreamFn } from "@mini-agent/ai";
import type { AssistantMessage, Message, StreamFn } from "@mini-agent/ai";

export interface AgentLoopOptions {
	prompt: string;
	messages: Message[]; // 已有历史，函数会就地追加
	system: string; // 本阶段是纯字符串；阶段 8 改为 SystemMessage
	streamFn?: StreamFn; // 缺省 fallback 到 getDefaultStreamFn()
	signal?: AbortSignal;
}

// 阶段 1：只处理无工具的单轮。不写 while 循环、不读 toolCall——那是阶段 2。
export async function agentLoop(options: AgentLoopOptions): Promise<Message[]> {
	// 提前返回都在构造 user 消息之前：已中止的 signal 不产生半条消息；
	// 空白 prompt 不污染历史（否则后续轮次会带上 content 为空的 user 消息）。
	if (options.signal?.aborted) return options.messages;
	if (options.prompt.trim() === "") return options.messages;

	// 不用 try/catch：未安装时让 getDefaultStreamFn 的具名错误直接冒泡给调用方。
	const streamFn = options.streamFn ?? getDefaultStreamFn();

	options.messages.push({ role: "user", content: [{ type: "text", text: options.prompt }] });

	const context = {
		system: { role: "system" as const, content: options.system },
		messages: [...options.messages],
		tools: [], // 本阶段恒为空但必须传——阶段 2 会往里填
	};

	// 只有 done 携带的完整消息才进历史（v1 约定，阶段 3 起 done 才是权威）。
	let doneMessage: AssistantMessage | undefined;
	for await (const event of streamFn(context, options.signal)) {
		if (event.type === "done") doneMessage = event.message;
	}
	options.messages.push(doneMessage!);

	return options.messages;
}
