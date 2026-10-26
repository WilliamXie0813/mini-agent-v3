import { getDefaultStreamFn } from "@mini-agent/ai";
import type { Message } from "@mini-agent/ai";
import type { AgentLoopOptions } from "./agent-options.ts";
import { runAgentTurn } from "./agent-turn.ts";
import type { AgentTurnOptions, AgentTurnState } from "./agent-turn.ts";

export type { AgentLoopOptions } from "./agent-options.ts";

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
	const state: AgentTurnState = {
		turn: 0,
		overflowRecovered: false,
		newMessages: [],
	};
	const turnOptions: AgentTurnOptions = {
		...options,
		streamFn,
		tools,
		emit,
		state,
	};

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: options.prompt }],
	};
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	options.messages.push(userMessage);
	state.newMessages.push(userMessage);
	await emit({ type: "message_start", message: userMessage });
	await emit({ type: "message_end", message: userMessage });

	// 内层 steering 循环：完整 turn 结束后、下一次 provider 请求前注入。
	// 外层 follow-up 循环只接续正常 stop；state.turn 与 overflowRecovered 跨段保留。
	let followUpMessages: Message[] = [];
	while (true) {
		let steeringMessages: Message[] = [];
		let normalStop = false;
		while (state.turn < maxTurns) {
			if (state.turn > 0) await emit({ type: "turn_start" });
			for (const message of followUpMessages) {
				options.messages.push(message);
				state.newMessages.push(message);
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
			}
			followUpMessages = [];
			for (const message of steeringMessages) {
				options.messages.push(message);
				state.newMessages.push(message);
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
			}
			steeringMessages = [];
			const result = await runAgentTurn(turnOptions);
			state.turn++;
			if (result === "terminal") {
				await emit({ type: "agent_end", messages: state.newMessages });
				return options.messages;
			}
			steeringMessages = options.steeringQueue?.drain() ?? [];
			if (result === "stop" && steeringMessages.length === 0) {
				normalStop = true;
				break;
			}
		}
		if (!normalStop) break;
		followUpMessages = options.followUpQueue?.drain() ?? [];
		if (followUpMessages.length === 0) {
			await emit({ type: "agent_end", messages: state.newMessages });
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
