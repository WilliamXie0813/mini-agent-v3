import type { AssistantMessage, ContentBlock, JSONSchema, Message, Tool } from "@mini-agent/ai";

export type ToolCall = Extract<ContentBlock, { type: "toolCall" }>;
export type ToolExecutionMode = "sequential" | "parallel";

export interface CommitToolIntentContext {
	assistantMessage: AssistantMessage;
	toolCall: ToolCall;
	tool: ToolDef<any>;
	args: Record<string, unknown>;
	sourceIndex: number;
}

export type CommitToolIntent = (
	context: CommitToolIntentContext,
) => void | Promise<void>;

export interface BeforeToolCallResult {
	block?: boolean; reason?: string; terminate?: boolean;
}

export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage; toolCall: ToolCall;
	args: Record<string, unknown>; messages: readonly Message[];
}

export type BeforeToolCall = (context: BeforeToolCallContext, signal?: AbortSignal) =>
	| BeforeToolCallResult
	| void
	| Promise<BeforeToolCallResult | undefined>
	| Promise<void>;

export type ToolUpdateHandler = (partialResult: ToolResult) => void;

// 本阶段三个工具都不需要泛型参数，`any` 用在注册表位置是刻意的：
// 工具表是异构的（read 收 { path }，bash 收 { command }），除 any 外只能靠类型擦除容不下的技巧。
export interface ToolDef<P = Record<string, unknown>> extends Tool {
	/** 副作用安全性：进程崩溃后能否安全重跑。默认 "unsafe"。第 9 阶段启用。 */
	replay?: "safe" | "unsafe";
	executionMode?: ToolExecutionMode;
	execute: (params: P, signal?: AbortSignal, onUpdate?: ToolUpdateHandler) => Promise<ToolResult>;
}

export interface ToolResult {
	content: ContentBlock[];
	isError?: boolean;
	terminate?: boolean;
}

// provider 只该看到 name/description/parameters。把 ToolDef 直接交给 streamFn 会
// 让 provider 层拿到 execute 闭包——那是运行时对象，不是协议的一部分。
export function toToolDeclarations(tools: ToolDef<any>[]): Tool[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters as JSONSchema,
	}));
}
