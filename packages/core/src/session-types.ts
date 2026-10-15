import type { Message, Tool } from "@mini-agent/ai";
import type { ToolResult } from "./tool.ts";

export const SESSION_VERSION = 1;

// 阶段 10：压缩只追加 entry，不删不改历史。firstKeptEntryId 是上下文投影边界，
// 指向 parent 的既有祖先；parent tree 本身不变。
export type CompactionReason = "manual" | "threshold" | "overflow";

export interface SessionHeader {
	type: "session";
	version: 1;
	id: string;
	createdAt: string;
}

export interface SessionEntryBase {
	id: string;
	parentId: string | null;
	createdAt: string;
}

export type SessionEntryData =
	| { type: "message"; message: Message; intentId?: string }
	| { type: "submission"; requestId: string; prompt: string }
	| {
			type: "tool_intent";
			submissionId: string;
			assistantEntryId: string;
			toolCallId: string;
			tool: Tool;
			args: Record<string, unknown>;
			replay: "safe" | "unsafe";
			sourceIndex: number;
	  }
	| { type: "tool_update"; intentId: string; partialResult: ToolResult }
	| {
			type: "tool_outcome";
			intentId: string;
			result: ToolResult;
			isError: boolean;
			durationMs?: number;
	  }
	| {
			type: "run_end";
			submissionId: string;
			status: "completed" | "error" | "aborted" | "interrupted";
	  }
	| {
			type: "compaction";
			reason: CompactionReason;
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
	  };

export type SessionEntry = SessionEntryBase & SessionEntryData;

export type SessionEntryOf<TType extends SessionEntryData["type"]> =
	SessionEntryBase & Extract<SessionEntryData, { type: TType }>;
