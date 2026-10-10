import * as readline from "node:readline/promises";
import { agentLoop, createDefaultTools } from "@mini-agent/core";
import { createFakeStreamFn, setDefaultStreamFn } from "@mini-agent/ai";
import type { ContentBlock, Message } from "@mini-agent/ai";

// 组装根：cli 是唯一知道用哪个 provider 的地方（spec §3.2a）。
// 必须发生在任何循环之前。问候文案刻意一眼能认出是假模型——
// 阶段 7 接真实模型时，从输出就能判断切换是否成功。
// 默认 chunkSize 1 + delayMs 25：肉眼能看到逐字出现（验收 #1）。
// 测试里同样的 provider 用 chunkSize 3、delayMs 0。
setDefaultStreamFn(
	createFakeStreamFn(["Hello from the deterministic fake model."], { delayMs: 25 }),
);

// content 是块数组；错误分支需要可读文本，只提 text 块拼起来（渲染 text 走 block.text，不经这里）。
function textOf(content: ContentBlock[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

const system = "You are a minimal teaching agent.";
const messages: Message[] = []; // 跨轮累积，肉眼可见历史增长；阶段 9 持久化的雏形

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});
console.log("mini-agent (stage 3) — type /exit to quit");

try {
	process.stdout.write("> ");
	for await (const line of rl) {
		if (line.trim() === "/exit") break;
		// 渲染范围是本轮新增的消息：toolCall 由 assistant 消息携带，toolResult 是独立消息，
		// 只看「最后一条是 assistant」会漏掉工具场景。
		const before = messages.length;
		let streamed = false;
		await agentLoop({
			prompt: line,
			messages,
			system,
			tools: createDefaultTools(),
			onDelta: (delta) => {
				streamed = true;
				process.stdout.write(delta);
			},
		});
		for (const message of messages.slice(before)) {
			if (message.role === "assistant") {
				// text 块已经在 onDelta 里逐字打过了，这里只补非文本块——
				// 事后重印一遍会让每句话出现两次。
				for (const block of message.content) {
					if (block.type === "toolCall")
						console.log(`\n→ ${block.name} ${JSON.stringify(block.arguments)}`);
				}
			}
			if (message.role === "toolResult" && message.isError) {
				console.log(`✗ ${message.toolName}: ${textOf(message.content)}`);
			}
		}
		// 只在真的流式输出过之后换行：无工具的空响应不该多出一个空行
		//（空白 prompt 由 agentLoop 提前返回，走不到这里）。
		if (streamed) console.log();
		// 空白行由 agentLoop 提前返回，slice(before) 为空数组，不重印上一轮回复——天然满足。
		process.stdout.write("> ");
	}
} finally {
	rl.close();
}
