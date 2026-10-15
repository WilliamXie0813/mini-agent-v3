import type { AfterToolCallResult, AgentEvent, BeforeToolCallResult, FinishTurnResult, PrepareNextTurnResult, SessionHooks, ToolCall, ToolDef, ToolExecutionMode, ToolResult } from "@mini-agent/core";
import type { Message, StreamContext, StreamFn, ToolResultMessage } from "@mini-agent/ai";

// 观察类：来自既有 AgentEvent 流 + CLI 合成的 session_start。
export type ObserverEvent =
	| { type: "session_start"; sessionId: string; filePath: string }
	| Extract<AgentEvent, { type: "message_end" }>
	| Extract<AgentEvent, { type: "tool_execution_start" }>
	| Extract<AgentEvent, { type: "tool_execution_update" }>
	| Extract<AgentEvent, { type: "tool_execution_end" }>;

// ObserverEvent 按 type 字段建立的映射类型；Extract 让它在 AgentEvent 增删变体时自动跟随。
export type ObserverEventMap = { [E in ObserverEvent as E["type"]]: E };

// 决策类：与六个 core hook 一一对应，一个 hook 一个事件。
// 负载形状与 core hook 参数刻意不同——多一层转换是刻意的：
// 事件名是稳定契约，hook 签名可以演进。
export interface ToolCallEvent {
	toolCall: ToolCall;
	args: Record<string, unknown>;
	messages: readonly Message[];
}

export interface ToolResultEvent {
	toolCall: ToolCall;
	tool?: ToolDef<any>;
	args: Record<string, unknown>;
	result: ToolResult;
	isError: boolean;
	durationMs: number; // 只读：monotonic
	messages: readonly Message[];
}

export type ContextEvent = readonly Message[];

export interface BeforeProviderRequestEvent {
	context: StreamContext;
	signal: AbortSignal;
}

export interface FinishTurnEvent {
	message: Message;
	toolResults: ToolResultMessage[];
	messages: readonly Message[];
	turn: number;
}

export interface NextTurnEvent {
	messages: readonly Message[];
	turn: number;
	signal: AbortSignal;
}

export interface DecisionEventHandlers {
	tool_call: (event: ToolCallEvent) => BeforeToolCallResult | void | Promise<BeforeToolCallResult | void>;
	tool_result: (event: ToolResultEvent) => AfterToolCallResult | void | Promise<AfterToolCallResult | void>;
	context: (event: ContextEvent) => Message[] | void | Promise<Message[] | void>;
	before_provider_request: (event: BeforeProviderRequestEvent) => StreamContext | void | Promise<StreamContext | void>;
	turn_end: (event: FinishTurnEvent) => FinishTurnResult | void | Promise<FinishTurnResult | void>;
	next_turn: (event: NextTurnEvent) => PrepareNextTurnResult | void | Promise<PrepareNextTurnResult | void>;
}

export interface ExtensionCommand {
	name: string;
	description: string;
	run: (input: { args: string; context: ExtensionContext }) => void | Promise<void>;
}

export interface ExtensionAPI {
	on<K extends keyof ObserverEventMap>(event: K, handler: (event: ObserverEventMap[K]) => void | Promise<void>): void;
	on<K extends keyof DecisionEventHandlers>(event: K, handler: DecisionEventHandlers[K]): void;
	registerTool<P extends Record<string, unknown>>(tool: ToolDef<P>): void;
	registerCommand(command: ExtensionCommand): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface Extension {
	name: string;
	factory: ExtensionFactory;
	hidden?: boolean;
}

export interface ExtensionContext {
	readonly log: (message: string) => void;
	getStreamFn(): StreamFn | undefined;
	setStreamFn(fn: StreamFn | undefined): void;
}
