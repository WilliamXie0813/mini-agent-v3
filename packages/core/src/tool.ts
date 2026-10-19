import type { AssistantMessage, ContentBlock, JSONSchema, Message, Tool } from "@mini-agent/ai";

// 从协议层的 ContentBlock 联合类型里抠出 toolCall 这一支，后续都用这个窄类型。
export type ToolCall = Extract<ContentBlock, { type: "toolCall" }>;
// 一批工具调用是顺序执行还是并行执行；默认 parallel（见 Agent.toolExecution），
// 单个工具也能在 ToolDef.executionMode 上强制自己走 sequential（见 shouldExecuteSequential）。
export type ToolExecutionMode = "sequential" | "parallel";

// beforeToolCall 校验通过、真正 execute() 之前的"提交点"上下文——
// 即将执行哪个工具、用什么参数、在这批调用里的第几个。
export interface CommitToolIntentContext {
	assistantMessage: AssistantMessage;
	toolCall: ToolCall;
	tool: ToolDef<any>;
	args: Record<string, unknown>;
	sourceIndex: number;
}

// 阶段 9 的 replay-safety 挂载点：在真正调用 execute() 之前先持久化"打算执行这个工具"的意图，
// 进程崩溃重启后就能依据这条记录判断该重放还是跳过，而不必重新问模型一遍。
export type CommitToolIntent = (
	context: CommitToolIntentContext,
) => void | Promise<void>;

// block：拦下这次调用，不跑 execute()，直接合成一个结果塞回给模型（可带 reason 说明原因）。
// terminate：标记这次调用处理完后，整个 agent loop 应该结束（不再进入下一轮）。
export interface BeforeToolCallResult {
	block?: boolean; reason?: string; terminate?: boolean;
}

// 执行工具前能看到的全部上下文：模型刚发出的那条消息、这次 toolCall 本身、
// 解析好的参数，以及到目前为止的完整历史（用于做基于历史的拦截判断）。
export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage; toolCall: ToolCall;
	args: Record<string, unknown>; messages: readonly Message[];
}

// 执行每个工具调用前都会咨询的拦截 hook；不返回值（void/undefined）等价于放行。
export type BeforeToolCall = (context: BeforeToolCallContext, signal?: AbortSignal) =>
	| BeforeToolCallResult
	| void
	| Promise<BeforeToolCallResult | undefined>
	| Promise<void>;

// 工具执行期间汇报"中间结果"的回调（比如长时间命令的流式输出），
// 对应 tool_execution_update 事件，不是最终的 ToolResult。
export type ToolUpdateHandler = (partialResult: ToolResult) => void;

// 本阶段三个工具都不需要泛型参数，`any` 用在注册表位置是刻意的：
// 工具表是异构的（read 收 { path }，bash 收 { command }），除 any 外只能靠类型擦除容不下的技巧。
export interface ToolDef<P = Record<string, unknown>> extends Tool {
	/** 副作用安全性：进程崩溃后能否安全重跑。默认 "unsafe"。第 9 阶段启用。 */
	replay?: "safe" | "unsafe";
	// 不设时跟随整批的 ToolExecutionMode；设了就强制这个工具单独走该模式
	// （例如一个有副作用的写操作，即使整批在并行跑也要顺序执行）。
	executionMode?: ToolExecutionMode;
	// 真正的实现：收到已校验的参数、可选 abort signal、可选的中间结果回调。
	execute: (params: P, signal?: AbortSignal, onUpdate?: ToolUpdateHandler) => Promise<ToolResult>;
}

export interface ToolResult {
	content: ContentBlock[]; // 塞回给模型看的内容块（通常是一段 text）
	isError?: boolean; // 标记这是一次失败结果；仍会正常回传给模型，只是打上失败标记
	terminate?: boolean; // 这个调用处理完后，整个 agent loop 应该停止（例如一个"结束任务"工具）
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
