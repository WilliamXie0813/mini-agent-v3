import { getDefaultStreamFn, setDefaultStreamFn } from "@mini-agent/ai";
import type { AgentEvent, SessionHooks, ToolDef } from "@mini-agent/core";
import { createSecondStreamFn } from "./second-stream-fn.ts";
import { assertUniqueToolNames } from "./tool-names.ts";
import { ExtensionRunner } from "./runner.ts";
import type { ExtensionLogger } from "./runner.ts";
import type { Extension } from "./types.ts";

export interface BootstrapExtensionsOptions {
	extensions: Extension[];
	log?: ExtensionLogger;
}

export interface BootstrappedExtensions {
	runner: ExtensionRunner;
	hooks: SessionHooks;
	tools(base: ToolDef<any>[]): ToolDef<any>[];
	notify(event: AgentEvent): Promise<void>;
	installStreamFn(): void;
}

// CLI 的唯一接入面：装配根调一次，拿回 runner / hooks / tools / notify / installStreamFn。
export async function bootstrapExtensions(
	options: BootstrapExtensionsOptions,
): Promise<BootstrappedExtensions> {
	const runner = new ExtensionRunner(options.log ? { log: options.log } : {});
	for (const extension of options.extensions) await runner.use(extension);
	return {
		runner,
		hooks: runner.sessionHooks(),
		// 内置工具在前（它们有 journal 重放语义），扩展工具在后；
		// 同名抛错而不是静默覆盖（阶段 5 起的约定）。
		tools: (base) => {
			const combined = [...base, ...runner.tools];
			assertUniqueToolNames(combined);
			return combined;
		},
		notify: (event) => runner.notify(event),
		// 读当前的默认实现再包一层：组装根启动时已设过一次默认实现，
		// 这里只做「在其之上包一层」，demo 与真实 provider 走同一条路径。
		installStreamFn: () =>
			setDefaultStreamFn(createSecondStreamFn(getDefaultStreamFn())),
	};
}
