import type {
	Message,
	StreamFn,
} from "@mini-agent/ai";
import type {
	BeforeToolCall,
	ToolDef,
} from "./tool.ts";

export interface AgentOptions {
	system: string;
	messages?: Message[];
	tools?: ToolDef<any>[];
	streamFn?: StreamFn;
	maxTurns?: number;
	beforeToolCall?: BeforeToolCall;
}
