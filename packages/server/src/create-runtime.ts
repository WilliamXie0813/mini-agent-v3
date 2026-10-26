import { createAnthropicStreamFn, setDefaultStreamFn } from "@mini-agent/ai";
import type { StreamFn } from "@mini-agent/ai";
import { AgentSession, createDefaultTools } from "@mini-agent/core";
import { bootstrapExtensions, createDemoExtension } from "@mini-agent/extensions";
import type { Extension } from "@mini-agent/extensions";
import { SessionHost } from "./session-host.ts";

export interface CreateRuntimeOptions {
	continueSession?: boolean;
	directory?: string;
	env?: NodeJS.ProcessEnv;
	streamFn?: StreamFn;
	extensions?: Extension[];
}

// 与 CLI 相同的校验：非法值在创建 session 前明确失败，
// 不能让一次手滑把所有请求打到错误的上下文窗口。
function parseContextWindow(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw new Error(
			`ANTHROPIC_CONTEXT_WINDOW must be a positive integer, got ${JSON.stringify(value)}`,
		);
	return parsed;
}

// server 的组装根：与 CLI 同一条 provider → extensions → session 装配链（spec §3.2a），
// 差别只在最外层——CLI 把 session 交给 readline，这里交给长生命周期的 SessionHost。
export async function createRuntime(
	options: CreateRuntimeOptions = {},
): Promise<SessionHost> {
	const env = options.env ?? process.env;
	setDefaultStreamFn(options.streamFn ?? createAnthropicStreamFn({
		apiKey: env.ANTHROPIC_API_KEY ?? "",
		baseUrl: env.ANTHROPIC_BASE_URL,
		model: env.ANTHROPIC_MODEL,
	}));
	const bootstrapped = await bootstrapExtensions({
		// demo extension 仍提供示例工具/命令，但其教学用的 bash guard
		// 不能泄漏到真实工作台，否则每次 shell 调用都会 fail-closed。
		extensions: options.extensions ?? [createDemoExtension({ blockBash: false })],
	});
	bootstrapped.installStreamFn();
	const contextWindow = parseContextWindow(env.ANTHROPIC_CONTEXT_WINDOW);
	const sessionOptions = {
		system: "You are a minimal teaching agent.",
		tools: bootstrapped.tools(createDefaultTools()),
		hooks: bootstrapped.hooks,
		directory: options.directory,
		contextWindow,
	};
	const session = options.continueSession === true
		? await AgentSession.openLatest(sessionOptions)
		: await AgentSession.create(sessionOptions);
	return new SessionHost(session, {
		// 观察类 hook 复用同一条事件流。notify 内部已逐 handler 隔离并记录，
		// void 显式忽略 promise：observer 失败永不冒泡进 transport，也不杀 run。
		onEvent: (event) => {
			void bootstrapped.notify(event);
		},
	});
}
