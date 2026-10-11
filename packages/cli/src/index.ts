import * as readline from "node:readline/promises";
import { Agent, createDefaultTools } from "@mini-agent/core";
import { createFakeStreamFn, setDefaultStreamFn } from "@mini-agent/ai";
import type { ContentBlock } from "@mini-agent/ai";

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
const agent = new Agent({
	system,
	tools: createDefaultTools(),
});

let running = false;
let streamed = false;
let aborted = false;

agent.subscribe((event) => {
	switch (event.type) {
		case "agent_start":
			running = true;
			streamed = false;
			aborted = false;
			break;
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				streamed = true;
				process.stdout.write(event.assistantMessageEvent.delta);
			}
			break;
		case "tool_execution_start":
			console.log(
				`${streamed ? "\n" : ""}→ ${event.toolName} ${JSON.stringify(event.args)}`,
			);
			break;
		case "message_end":
			if (event.message.role === "toolResult" && event.message.isError) {
				console.log(
					`✗ ${event.message.toolName}: ${textOf(event.message.content)}`,
				);
			}
			if (
				event.message.role === "assistant" &&
				event.message.stopReason === "error"
			) {
				console.log(
					`${streamed ? "\n" : ""}✗ ${textOf(event.message.content)}`,
				);
			}
			if (
				event.message.role === "assistant" &&
				event.message.stopReason === "aborted"
			) {
				aborted = true;
			}
			break;
		case "agent_end":
			running = false;
			break;
	}
});

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});
rl.on("SIGINT", () => {
	if (running) agent.abort();
	else rl.close();
});
console.log("mini-agent (stage 4) — type /exit to quit");

try {
	process.stdout.write("> ");
	for await (const line of rl) {
		if (line.trim() === "/exit") break;
		await agent.prompt(line);
		if (aborted) console.log(`${streamed ? "\n" : ""}^C`);
		else if (streamed) console.log();
		process.stdout.write("> ");
	}
} finally {
	rl.close();
}
