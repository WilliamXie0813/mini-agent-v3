import type {
	Message,
	StreamContext,
	StreamFn,
} from "@mini-agent/ai";
import type {
	BeforeToolCall,
	CommitToolIntent,
	ToolDef,
	ToolExecutionMode,
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

export interface AgentOptions {
	// 新会话的组装层简写：仅当 messages 不含任何 system entry 时，
	// 用它生成 transcript 的 leading SystemMessage；已有 system 历史时该值被忽略。
	system: string;
	messages?: Message[];
	tools?: ToolDef<any>[];
	streamFn?: StreamFn;
	maxTurns?: number;
	beforeToolCall?: BeforeToolCall;
	toolExecution?: ToolExecutionMode;
	commitToolIntent?: CommitToolIntent;
	prepareRequest?: PrepareRequest;
}
