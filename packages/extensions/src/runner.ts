import type { AgentEvent, AfterToolCallResult, SessionHooks, ToolDef } from "@mini-agent/core";
import type { StreamFn, SystemSection, Tool } from "@mini-agent/ai";
import type {
	DecisionEventHandlers,
	Extension,
	ExtensionAPI,
	ExtensionCommand,
	ExtensionContext,
	ObserverEventMap,
} from "./types.ts";
import { assertUniqueToolNames } from "./tool-names.ts";

export type ExtensionLogger = (message: string) => void;

export interface ExtensionRunnerOptions {
	log?: ExtensionLogger;
}

// notify() 只分发的五种观察事件；其余 AgentEvent 变体静默丢弃。
// session_start 是 CLI 合成事件，不属于 AgentEvent，但 handler 表按同名键注册。
const OBSERVER_EVENTS = new Set([
	"session_start",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ExtensionRunner implements ExtensionAPI {
	// 观察 + 决策 handler 同表，键是事件名；owner 记录注册时的扩展名，供错误消息使用。
	private handlers = new Map<string, Function[]>();
	private handlerOwners = new Map<Function, string>();
	private toolList: ToolDef<any>[] = [];
	private commandList: ExtensionCommand[] = [];
	private readonly log: ExtensionLogger;
	private streamFnSlot: StreamFn | undefined;
	private readonly context: ExtensionContext;
	private activeExtensionName: string | undefined;

	constructor(options?: ExtensionRunnerOptions) {
		this.log = options?.log ?? console.error;
		this.context = {
			log: (message: string) => this.log(message),
			getStreamFn: () => this.streamFnSlot,
			setStreamFn: (fn: StreamFn | undefined) => { this.streamFnSlot = fn; },
		};
	}

	get tools(): ToolDef<any>[] {
		return this.toolList;
	}

	get commands(): ExtensionCommand[] {
		return this.commandList;
	}

	async use(extension: Extension): Promise<void> {
		const previous = this.activeExtensionName;
		this.activeExtensionName = extension.name;
		try {
			await extension.factory(this.bindingView());
		} catch (error) {
			throw new Error(`extension "${extension.name}" failed to initialize: ${errorMessage(error)}`);
		} finally {
			this.activeExtensionName = previous;
		}
	}

	on<K extends keyof ObserverEventMap>(
		event: K,
		handler: (event: ObserverEventMap[K]) => void | Promise<void>,
	): void;
	on<K extends keyof DecisionEventHandlers>(event: K, handler: DecisionEventHandlers[K]): void;
	on(event: string, handler: Function): void {
		this.addHandler(event, handler);
	}

	registerTool<P extends Record<string, unknown>>(tool: ToolDef<P>): void {
		assertUniqueToolNames([...this.toolList, tool as ToolDef<any>]);
		this.toolList.push(tool as ToolDef<any>);
	}

	registerCommand(command: ExtensionCommand): void {
		if (this.commandList.some((existing) => existing.name === command.name))
			throw new Error(`duplicate command name: "${command.name}"`);
		this.commandList.push(command);
	}

	async notify(event: AgentEvent): Promise<void> {
		const type: string = event.type;
		if (!OBSERVER_EVENTS.has(type)) return;
		const handlers = this.handlers.get(type);
		if (!handlers) return;
		for (const handler of handlers) {
			try {
				await handler(event);
			} catch (error) {
				const owner = this.handlerOwners.get(handler) ?? "unknown";
				this.log(`extension "${owner}" handler for "${type}" failed: ${errorMessage(error)}`);
			}
		}
	}

	// 决策 hook 逐个接上；未注册任何 handler 时返回空对象。
	// tool_call 是短路语义：首个非 undefined 返回值生效，后续 handler 不再运行。
	// tool_result 是 fold 语义：逐个传递，字段级最后一个生效，void 不动已累积字段。
	// turn_end 是短路语义：首个非 undefined 返回值生效（与 tool_call 同构）。
	// handler 抛错只记录后重抛——tool_call 由 prepareToolCall 转成 error result（fail-closed），
	// tool_result / turn_end 则由 agent.ts 包装为 AgentInfrastructureFailure 冒泡。
	sessionHooks(): SessionHooks {
		const toolCallHandlers = this.handlersFor("tool_call");
		const toolResultHandlers = this.handlersFor("tool_result");
		const contextHandlers = this.handlersFor("context");
		const turnEndHandlers = this.handlersFor("turn_end");
		const nextTurnHandlers = this.handlersFor("next_turn");
		const hooks: SessionHooks = {};
		if (toolCallHandlers.length > 0) {
			hooks.beforeToolCall = async (context) => {
				for (const { name, handler } of toolCallHandlers) {
					try {
						const result = await handler(context);
						if (result !== undefined) return result;
					} catch (error) {
						this.log(`extension "${name}" handler for "tool_call" failed: ${errorMessage(error)}`);
						throw error;
					}
				}
				return undefined;
			};
		}
		if (toolResultHandlers.length > 0) {
			hooks.afterToolCall = async (context) => {
				let accumulated: AfterToolCallResult = {};
				for (const { name, handler } of toolResultHandlers) {
					try {
						const partial = await handler(context);
						if (partial) accumulated = { ...accumulated, ...partial };
					} catch (error) {
						this.log(`extension "${name}" handler for "tool_result" failed: ${errorMessage(error)}`);
						throw error;
					}
				}
				return accumulated;
			};
		}
		if (contextHandlers.length > 0) {
			hooks.transformContext = async (messages, signal) => {
				let current = [...messages];
				for (const { name, handler } of contextHandlers) {
					try {
						const next = await handler(current);
						if (next !== undefined) current = next;
					} catch (error) {
						this.log(`extension "${name}" handler for "context" failed: ${errorMessage(error)}`);
						throw error;
					}
				}
				return current;
			};
		}
		if (turnEndHandlers.length > 0) {
			hooks.finishTurn = async (context) => {
				for (const { name, handler } of turnEndHandlers) {
					try {
						const result = await handler(context);
						if (result !== undefined) return result;
					} catch (error) {
						this.log(`extension "${name}" handler for "turn_end" failed: ${errorMessage(error)}`);
						throw error;
					}
				}
				return undefined;
			};
		}
		if (nextTurnHandlers.length > 0) {
			// merge 语义：跨扩展拼接，全部 handler 都运行。sections 与 toolsAdded 按注册序
			// 拼接（各扩展加的东西互不相干，覆盖会让注册顺序决定谁生效）；
			// toolsRemoved 去重保留首次出现位置，便于读日志时对应到具体扩展。
			// 三个字段都为空时返回的对象仍是真值——agent-loop 的空检查会把它当 no-op，
			// 与 void 表现一致。
			hooks.prepareNextTurnWithContext = async (context) => {
				const sections: SystemSection[] = [];
				const toolsAdded: Tool[] = [];
				const toolsRemoved: string[] = [];
				for (const { name, handler } of nextTurnHandlers) {
					try {
						const partial = await handler(context);
						if (!partial) continue;
						if (partial.sections) sections.push(...partial.sections);
						if (partial.toolsAdded) toolsAdded.push(...partial.toolsAdded);
						if (partial.toolsRemoved)
							for (const toolName of partial.toolsRemoved)
								if (!toolsRemoved.includes(toolName)) toolsRemoved.push(toolName);
					} catch (error) {
						this.log(`extension "${name}" handler for "next_turn" failed: ${errorMessage(error)}`);
						throw error;
					}
				}
				return { sections, toolsAdded, toolsRemoved };
			};
		}
		return hooks;
	}

	// 传给 factory 的绑定视图：私有对象字面量，方法体只做箭头函数转发。
	private bindingView(): ExtensionAPI {
		return {
			on: (event: string, handler: Function) => this.addHandler(event, handler),
			registerTool: (tool) => this.registerTool(tool),
			registerCommand: (command) => this.registerCommand(command),
		};
	}

	private addHandler(event: string, handler: Function): void {
		const owner = this.activeExtensionName ?? "";
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		this.handlerOwners.set(handler, owner);
	}

	// handler 表按 Function 存储，组合决策 hook 时按注册序还原 owner 名，供错误消息使用。
	private handlersFor<K extends keyof DecisionEventHandlers>(
		event: K,
	): { name: string; handler: DecisionEventHandlers[K] }[] {
		const list = this.handlers.get(event) ?? [];
		return list.map((handler) => ({
			name: this.handlerOwners.get(handler) ?? "unknown",
			handler: handler as DecisionEventHandlers[K],
		}));
	}
}
