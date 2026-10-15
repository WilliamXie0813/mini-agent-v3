import type { AgentEvent, SessionHooks, ToolDef } from "@mini-agent/core";
import type { StreamFn } from "@mini-agent/ai";
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

	// 决策 hook 在 Task 3–7 逐个接上；本任务未注册任何 handler 时返回空对象。
	sessionHooks(): SessionHooks {
		return {};
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
}
