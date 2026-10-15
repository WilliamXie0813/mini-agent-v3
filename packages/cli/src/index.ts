import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { AgentSession, createDefaultTools } from "@mini-agent/core";
import { createAnthropicStreamFn, setDefaultStreamFn } from "@mini-agent/ai";
import type { ContentBlock } from "@mini-agent/ai";

// 本地开发的默认配置来自 cwd 的 .env（pnpm dev 时即 packages/cli/.env）。
// loadEnvFile 不覆盖已有变量——shell 显式设置的 env 优先；没有 .env 不算错误。
try {
	process.loadEnvFile();
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--continue")) {
	throw new Error("Unknown CLI arguments; the only supported option is --continue");
}
const continueSession = args[0] === "--continue";

// 组装根：cli 是唯一知道用哪个 provider 的地方（spec §3.2a）。
setDefaultStreamFn(
	createAnthropicStreamFn({
		apiKey: process.env.ANTHROPIC_API_KEY ?? "",
		baseUrl: process.env.ANTHROPIC_BASE_URL,
		model: process.env.ANTHROPIC_MODEL,
	}),
);

// content 是块数组；错误分支需要可读文本，只提 text 块拼起来（渲染 text 走 block.text，不经这里）。
function textOf(content: ContentBlock[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

const system = "You are a minimal teaching agent.";
const sessionOptions = {
	system,
	tools: createDefaultTools(),
};
const session = continueSession
	? await AgentSession.openLatest(sessionOptions)
	: await AgentSession.create(sessionOptions);

let running = false;
let streamed = false;
let aborted = false;

session.subscribe((event) => {
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
				(event.message.stopReason === "error" || event.message.stopReason === "length")
			) {
				const diagnostic = event.message.errorMessage ??
					(event.message.stopReason === "length" ? "Response hit the output token limit"
						: textOf(event.message.content));
				console.log(
					`${streamed ? "\n" : ""}✗ ${diagnostic}`,
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
	if (running) session.abort();
	else rl.close();
});
console.log("mini-agent (stage 9) — type /exit to quit");
console.log(`session: ${session.filePath} (${continueSession ? "resumed" : "created"})`);

try {
	process.stdout.write("> ");
	for await (const line of rl) {
		if (line.trim() === "/exit") break;
		if (line.trim() === "") {
			process.stdout.write("> ");
			continue;
		}
		await session.submit({
			requestId: randomUUID(),
			prompt: line,
		});
		if (aborted) console.log(`${streamed ? "\n" : ""}^C`);
		else if (streamed) console.log();
		process.stdout.write("> ");
	}
} finally {
	rl.close();
}
