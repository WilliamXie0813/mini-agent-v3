import type {
	AssistantMessage,
	ContentBlock,
	Message,
	StreamContext,
	StreamFn,
	SystemSection,
	Tool,
	ToolResultMessage,
} from "@mini-agent/ai";
import type {
	BeforeToolCall,
	CommitToolIntent,
	ToolCall,
	ToolDef,
	ToolExecutionMode,
	ToolResult,
} from "./tool.ts";

// 阶段 10：调用模型前的最后替换缝——阈值压缩判定挂在这里（阶段 11 扩展系统复用）。
// 替换只影响本次请求的 context；transcript 本身不变。
export interface PrepareRequestContext {
	context: StreamContext;
	signal: AbortSignal;
}

export type PrepareRequest = (
	input: PrepareRequestContext,
) => StreamContext | Promise<StreamContext>;

// 阶段 10：provider 报结构化超窗（errorKind: "context_overflow"）后，
// 由编排层（AgentSession）压缩并决定是否重试。一次 run 最多调用一次——
// 第二次 overflow 正常结束为 error，不递归重试。
export interface RecoverContextOverflowContext {
	context: StreamContext;
	message: AssistantMessage;
	signal: AbortSignal;
}

export type RecoverContextOverflow = (
	input: RecoverContextOverflowContext,
) => boolean | Promise<boolean>;

export interface AfterToolCallContext {
	toolCall: ToolCall;
	tool?: ToolDef<any>; // 未找到 / 参数校验失败 / 被 block 时为 undefined
	args: Record<string, unknown>;
	result: ToolResult;
	isError: boolean;
	durationMs: number; // 只读：monotonic，覆盖它没有意义
	messages: readonly Message[];
}
export interface AfterToolCallResult {
	content?: ContentBlock[];
	isError?: boolean;
}
export type AfterToolCall = (
	context: AfterToolCallContext,
	signal?: AbortSignal,
) => AfterToolCallResult | void | Promise<AfterToolCallResult | void>;

export type TransformContext = (
	messages: readonly Message[],
	signal?: AbortSignal,
) => Message[] | Promise<Message[]>;

export interface FinishTurnContext {
	message: Message; // 本轮模型返回的 assistant 消息
	toolResults: ToolResultMessage[];
	messages: readonly Message[]; // 含本轮全部新增
	turn: number; // 0-based
}
export type FinishTurnResult = { action: "end" | "continue" };
export type FinishTurn = (
	context: FinishTurnContext,
	signal?: AbortSignal,
) => FinishTurnResult | void | Promise<FinishTurnResult | void>;

export interface PrepareNextTurnContext {
	messages: readonly Message[];
	turn: number; // 即将开始的轮次序号，>= 1
	signal: AbortSignal;
}
export interface PrepareNextTurnResult {
	sections?: SystemSection[];
	toolsAdded?: Tool[];
	toolsRemoved?: string[];
}
export type PrepareNextTurn = (
	context: PrepareNextTurnContext,
) => PrepareNextTurnResult | void | Promise<PrepareNextTurnResult | void>;

// 阶段 11：扩展系统的全部接入面。六个字段全部可选；
// AgentSession 只允许经 hooks 注入（AgentSessionOptions 把它们 Omit 掉）。
export interface SessionHooks {
	beforeToolCall?: BeforeToolCall;
	afterToolCall?: AfterToolCall;
	transformContext?: TransformContext;
	prepareRequest?: PrepareRequest;
	finishTurn?: FinishTurn;
	prepareNextTurnWithContext?: PrepareNextTurn;
}

export interface AgentOptions extends SessionHooks {
	// 新会话的组装层简写：仅当 messages 不含任何 system entry 时，
	// 用它生成 transcript 的 leading SystemMessage；已有 system 历史时该值被忽略。
	system: string;
	messages?: Message[];
	tools?: ToolDef<any>[];
	streamFn?: StreamFn;
	maxTurns?: number;
	toolExecution?: ToolExecutionMode;
	commitToolIntent?: CommitToolIntent;
	recoverContextOverflow?: RecoverContextOverflow;
}
