import type {
	Message,
	StreamFn,
} from "@mini-agent/ai";
import type {
	BeforeToolCall,
	CommitToolIntent,
	ToolDef,
	ToolExecutionMode,
} from "./tool.ts";

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
}
