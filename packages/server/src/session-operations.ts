import type { AgentSession } from "@mini-agent/core";
import type {
	AgentEventEnvelope, ClientCommand, ServerMessage,
} from "@mini-agent/protocol";

export type ServerMessageSink = (message: ServerMessage) => void;

export interface ActiveOperation {
	command: ClientCommand["type"];
	requestId: string;
	baseLeafId: string | null;
	startedAt: number;
	lastElapsedMs: number;
	events: AgentEventEnvelope[];
	replies: Set<ServerMessageSink>;
	settled: Promise<void>;
}

// SessionHost 的 operation 记账拆分在这里：host 持有 operation 引用，
// 本模块只做 begin/settle 与三种命令的启动，不碰 socket 分发。
export interface OperationContext {
	readonly session: AgentSession;
	readonly now: () => number;
	getOperation(): ActiveOperation | undefined;
	setOperation(operation: ActiveOperation | undefined): void;
	reply(sink: ServerMessageSink, message: ServerMessage): void;
}

export function beginOperation(
	ctx: OperationContext,
	command: ClientCommand["type"],
	requestId: string,
	reply: ServerMessageSink,
): ActiveOperation {
	const operation: ActiveOperation = {
		command,
		requestId,
		// 顺序固定：先存 base leaf，再开 operation clock，发 accepted，最后才启动 session 操作。
		baseLeafId: ctx.session.leafId,
		startedAt: ctx.now(),
		lastElapsedMs: 0,
		events: [],
		replies: new Set([reply]),
		settled: Promise.resolve(),
	};
	ctx.setOperation(operation);
	ctx.reply(reply, { type: "command.accepted", requestId, command });
	return operation;
}

export async function settleOperation<T>(
	ctx: OperationContext,
	operation: ActiveOperation,
	promise: Promise<T>,
	complete: (value: T) => ServerMessage,
): Promise<void> {
	try {
		const message = complete(await promise);
		for (const reply of operation.replies) ctx.reply(reply, message);
	} catch (error) {
		for (const reply of operation.replies) {
			ctx.reply(reply, {
				type: "protocol.error", requestId: operation.requestId,
				code: "COMMAND_FAILED",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	} finally {
		// 最后才清 operation：settle 前的 snapshot 仍应看到 running/compacting 视角。
		if (ctx.getOperation() === operation) ctx.setOperation(undefined);
	}
}

export function abortRun(
	ctx: OperationContext,
	requestId: string,
	reply: ServerMessageSink,
): void {
	const active = ctx.getOperation();
	if (!active || active.command !== "prompt.submit") {
		ctx.reply(reply, {
			type: "protocol.error", requestId,
			code: "NO_ACTIVE_RUN", message: "No active run to abort",
		});
		return;
	}
	ctx.reply(reply, { type: "command.accepted", requestId, command: "run.abort" });
	// 只发信号：真正的 terminal 状态由后续 AgentEvent / run_end entry 承载。
	ctx.session.abort();
	ctx.reply(reply, {
		type: "command.completed", requestId, command: "run.abort", result: {},
	});
}

export function startPrompt(
	ctx: OperationContext,
	command: Extract<ClientCommand, { type: "prompt.submit" }>,
	reply: ServerMessageSink,
): void {
	const operation = beginOperation(ctx, command.type, command.requestId, reply);
	// handle() 不阻塞 WebSocket message handler：操作在 settle 回调里收尾。
	operation.settled = settleOperation(
		ctx,
		operation,
		ctx.session.submit({ requestId: command.requestId, prompt: command.prompt }),
		(submission): ServerMessage => ({
			type: "command.completed", requestId: command.requestId,
			command: "prompt.submit", result: { submissionId: submission.id },
		}),
	);
}

export function startCompact(
	ctx: OperationContext,
	command: Extract<ClientCommand, { type: "session.compact" }>,
	reply: ServerMessageSink,
): void {
	const operation = beginOperation(ctx, command.type, command.requestId, reply);
	operation.settled = settleOperation(
		ctx,
		operation,
		ctx.session.compact(),
		(entry): ServerMessage => ({
			type: "command.completed", requestId: command.requestId,
			command: "session.compact",
			result: entry
				? { compacted: true, entryId: entry.id, tokensBefore: entry.tokensBefore }
				: { compacted: false },
		}),
	);
}
