import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { AgentSession, createDefaultTools } from "@mini-agent/core";
import { createAnthropicStreamFn, setDefaultStreamFn } from "@mini-agent/ai";
import { bootstrapExtensions, createDemoExtension } from "@mini-agent/extensions";
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

// 阶段 11：扩展系统挂在默认 StreamFn 之上——不碰上面的密钥处理，
// 只把当前默认实现包进第二个 StreamFn（装饰/观测链路）。
const bootstrapped = await bootstrapExtensions({
	extensions: [createDemoExtension()],
});
bootstrapped.installStreamFn();

// content 是块数组；错误分支需要可读文本，只提 text 块拼起来（渲染 text 走 block.text，不经这里）。
function textOf(content: ContentBlock[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

const system = "You are a minimal teaching agent.";
// 阶段 10：context window 可用 ANTHROPIC_CONTEXT_WINDOW 覆盖，缺省走 core 的 128_000。
// 非法值在创建 session 前明确失败，不能让一次手滑把所有请求打到错误窗口。
function parseContextWindow(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw new Error(
			`ANTHROPIC_CONTEXT_WINDOW must be a positive integer, got ${JSON.stringify(value)}`,
		);
	return parsed;
}
const sessionOptions = {
	system,
	tools: bootstrapped.tools(createDefaultTools()),
	hooks: bootstrapped.hooks,
	contextWindow: parseContextWindow(process.env.ANTHROPIC_CONTEXT_WINDOW),
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

// 扩展的观察类 hook 复用同一条事件流。用 void 显式忽略 promise：
// 观察者失败永远不会冒泡到 CLI 的事件循环（runner 内部已隔离 + 记录）。
session.subscribe((event) => {
	void bootstrapped.notify(event);
});

// 扩展命令的上下文：日志打到终端；StreamFn 槽在组装根已全局安装，这里不留引用。
const extensionContext = {
	log: (message: string) => console.log(message),
	getStreamFn: () => undefined,
	setStreamFn: () => {},
};

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});
rl.on("SIGINT", () => {
	if (running) session.abort();
	else rl.close();
});
console.log("mini-agent (stage 11) — type /exit to quit, /compact to compact, /ext to list extensions");
console.log(`session: ${session.filePath} (${continueSession ? "resumed" : "created"})`);

try {
	process.stdout.write("> ");
	for await (const line of rl) {
		if (line.trim() === "/exit") break;
		// /compact 是命令不是 submission：不生成 requestId、不请求 provider。
		// 摘要正文可能含敏感上下文，只打印结果，不把摘要重复写到终端。
		// 摘要失败（provider 抖动等）打印诊断并回到提示符，不能让 REPL 崩掉。
		if (line.trim() === "/compact") {
			try {
				const entry = await session.compact();
				console.log(entry
					? `compacted ${entry.tokensBefore} tokens (reason: manual)`
					: "nothing to compact");
			} catch (error) {
				console.log(
					`✗ compaction failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			process.stdout.write("> ");
			continue;
		}
		// /ext 列出扩展注册的工具与命令。
		if (line.trim() === "/ext") {
			const tools = bootstrapped.runner.tools.map((tool) => tool.name);
			const commands = bootstrapped.runner.commands.map((command) => command.name);
			console.log(`extension tools: ${tools.join(", ") || "(none)"}`);
			console.log(`extension commands: ${commands.join(", ") || "(none)"}`);
			process.stdout.write("> ");
			continue;
		}
		// 扩展注册的斜杠命令（如 /demo）：匹配名字后把剩余文本作为 args 传入。
		const slash = /^\/(\S+)\s*(.*)$/.exec(line.trim());
		if (slash) {
			const command = bootstrapped.runner.commands.find(
				(candidate) => candidate.name === slash[1],
			);
			if (command) {
				await command.run({ args: slash[2] ?? "", context: extensionContext });
				process.stdout.write("> ");
				continue;
			}
		}
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
