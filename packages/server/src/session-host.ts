import type { AgentEvent, AgentSession } from "@mini-agent/core";
import type { AgentEventEnvelope, ClientCommand, ServerMessage, SessionSnapshot } from "@mini-agent/protocol";
import { activeSessionPath } from "./session-path.ts";
import {
	abortRun, startCompact, startPrompt, type ActiveOperation, type OperationContext,
	type ServerMessageSink,
} from "./session-operations.ts";

export type { ServerMessageSink } from "./session-operations.ts";

export interface SessionHostOptions {
	now?: () => number;
	onEvent?: (event: AgentEvent) => void | Promise<void>;
}

interface ClientSink {
	send: ServerMessageSink;
	paused: boolean;
	queue: ServerMessage[];
}

// SessionHost 长生命周期持有一个 AgentSession，与 socket 解耦：它把实时 AgentEvent
// 包成有序 envelope 广播给已 attach 的 sink；snapshot 在操作中途停在操作开始前的 leaf，
// 瞬时事件经 transientEvents 补齐，客户端重连后无重复无缺口。
export class SessionHost implements OperationContext {
	readonly session: AgentSession;
	readonly now: () => number;
	private readonly onEvent?: SessionHostOptions["onEvent"];
	private readonly clients = new Set<ClientSink>();
	private readonly unsubscribe: () => void;
	private lastSequence = -1;
	private operation?: ActiveOperation;
	private closed = false;

	constructor(session: AgentSession, options: SessionHostOptions = {}) {
		this.session = session;
		this.now = options.now ?? (() => performance.now());
		this.onEvent = options.onEvent;
		// 只订阅一次，socket 增减不改变与 session 的订阅关系。
		// listener 同步且绝不抛出：不给 Agent 施加 backpressure，也不让 rejection 杀死 run。
		this.unsubscribe = session.subscribe((event) => this.record(event));
	}

	getOperation(): ActiveOperation | undefined {
		return this.operation;
	}

	setOperation(operation: ActiveOperation | undefined): void {
		this.operation = operation;
	}

	attach(send: ServerMessageSink): () => void {
		const client: ClientSink = { send, paused: true, queue: [] };
		this.clients.add(client);
		// 顺序固定：先注册 paused client，再同步发 snapshot，最后 flush 期间排队的 live messages。
		if (!this.deliver(client, { type: "session.snapshot", snapshot: this.snapshot() }))
			return () => {};
		client.paused = false;
		const queued = client.queue;
		client.queue = [];
		for (const message of queued) {
			if (!this.deliver(client, message)) break;
		}
		return () => {
			this.clients.delete(client);
		};
	}

	handle(command: ClientCommand, reply: ServerMessageSink): void {
		if (this.closed) {
			this.reply(reply, {
				type: "protocol.error", requestId: command.requestId,
				code: "COMMAND_FAILED", message: "Session host is closed",
			});
			return;
		}
		if (command.type === "run.abort") {
			abortRun(this, command.requestId, reply);
			return;
		}
		const active = this.operation;
		if (active) {
			// 同一 command + requestId 的重发复用 in-flight operation；其余一律 RUN_ACTIVE，不排队。
			if (active.command === command.type && active.requestId === command.requestId) {
				active.replies.add(reply);
				this.reply(reply, {
					type: "command.accepted", requestId: command.requestId, command: command.type,
				});
				return;
			}
			this.reply(reply, {
				type: "protocol.error", requestId: command.requestId,
				code: "RUN_ACTIVE", message: `A ${active.command} operation is already active`,
			});
			return;
		}
		if (command.type === "prompt.submit") startPrompt(this, command, reply);
		else startCompact(this, command, reply);
	}

	snapshot(): SessionSnapshot {
		const operation = this.operation;
		const leafId = operation ? operation.baseLeafId : this.session.leafId;
		return {
			sessionId: this.session.sessionId,
			leafId,
			status: operation === undefined
				? "idle"
				: operation.command === "session.compact"
				? "compacting"
				: "running",
			entries: activeSessionPath(this.session.entries, leafId),
			transientEvents: operation ? structuredClone(operation.events) : [],
			// 尚无事件时钳到 0：protocol guard 要求非负整数。
			latestSequence: Math.max(0, this.lastSequence),
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		// server shutdown 是唯一允许 abort 的地方；普通 detach 不 abort。
		this.session.abort();
		await this.session.waitForIdle();
		// settle 回调在 waitForIdle 之后才跑完：等它把 completed/error 发出去再清场。
		await this.operation?.settled;
		this.unsubscribe();
		this.clients.clear();
	}

	private record(event: AgentEvent): void {
		const operation = this.operation;
		const elapsed = operation
			? Math.max(0, this.now() - operation.startedAt, operation.lastElapsedMs)
			: 0;
		const envelope: AgentEventEnvelope = {
			sessionId: this.session.sessionId,
			sequence: this.lastSequence + 1,
			elapsedMs: elapsed,
			event,
		};
		this.lastSequence = envelope.sequence;
		if (operation) {
			operation.lastElapsedMs = elapsed;
			operation.events.push(envelope);
		}
		this.broadcast({ type: "agent.event", envelope });
		this.notify(event);
	}

	private notify(event: AgentEvent): void {
		if (!this.onEvent) return;
		try {
			const result = this.onEvent(event);
			// observer 是 fire-and-forget：它的失败不属于这条 run。
			if (result instanceof Promise) result.catch(() => {});
		} catch {
			// observer 抛错不杀 run。
		}
	}

	private broadcast(message: ServerMessage): void {
		for (const client of [...this.clients]) {
			if (client.paused) client.queue.push(message);
			else this.deliver(client, message);
		}
	}

	// false = sink 抛错已 detach。坏 sink 只影响自己，绝不冒泡进 Agent listener。
	private deliver(client: ClientSink, message: ServerMessage): boolean {
		try {
			client.send(message);
			return true;
		} catch {
			this.clients.delete(client);
			return false;
		}
	}

	reply(sink: ServerMessageSink, message: ServerMessage): void {
		try {
			sink(message);
		} catch {
			// reply 通道失败不影响 session。
		}
	}
}
