import * as readline from "node:readline/promises";
import { agentLoop } from "@mini-agent/core";
import { createFakeStreamFn, setDefaultStreamFn } from "@mini-agent/ai";
import type { Message } from "@mini-agent/ai";

// 组装根：cli 是唯一知道用哪个 provider 的地方（spec §3.2a）。
// 必须发生在任何循环之前。问候文案刻意一眼能认出是假模型——
// 阶段 7 接真实模型时，从输出就能判断切换是否成功。
setDefaultStreamFn(createFakeStreamFn(["Hello from the deterministic fake model."]));

const system = "You are a minimal teaching agent.";
const messages: Message[] = []; // 跨轮累积，肉眼可见历史增长；阶段 9 持久化的雏形

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("mini-agent (stage 1) — type /exit to quit");

try {
	while (true) {
		const line = await rl.question("> ");
		if (line.trim() === "/exit") break;
		// 空白行由 agentLoop 提前返回，CLI 不重复判空（两处规则会分叉）。
		// 但「没追加新消息就别打印」必须由 CLI 自己保证——否则空行会重印上一轮的回复。
		const before = messages.length;
		await agentLoop({ prompt: line, messages, system });
		const last = messages.at(-1);
		if (messages.length > before && last?.role === "assistant") {
			const text = last.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			console.log(text);
		}
	}
} finally {
	rl.close();
}
